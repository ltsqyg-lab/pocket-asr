// Caller authentication (ASR.md §3):
//   static tokens   Authorization: Bearer <token>          (config and <dataDir>/tokens.json keep only SHA-256 hashes +
//                                                           a label per token)
//   Pocket tickets  Authorization: PocketTicket <ticket>    + X-Pocket-Proof: <b64u(a)>.<b64u(s)>
// Tickets are checked offline with coordination keys (pinned, then refreshed from keys.json signed by a trusted key),
// the proof binds the request body, nonces are single-use for 10 minutes, and signed revocation documents cut off
// tickets issued before a device was suspended or removed (same rules as the relay, RELAY.md §3.3).

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { AsrError } from './errors.mjs'
import {
  PocketError, verifyTicket, verifyAsrProofHead, splitProof, verifyKeysDoc, verifyCoordDoc, checkAddr, DID_RE, unb64u, checkPub, b64u,
} from './pcrypto.mjs'

const NONCE_TTL = 10 * 60_000
const NONCE_MAX = 200_000
const KEYS_EVERY = 6 * 3_600_000
const KEYS_ON_UNKNOWN_MIN_GAP = 10 * 60_000
const REVOCATION_POLL = 60_000
const CUTOFF_KEEP = 48 * 3_600_000
const GONE_KEEP = 180 * 86_400_000
const LABEL_RE = /^[^\u0000-\u001f\u007f]{1,64}$/

export function hashToken(token) { return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex') }

/** Validate a pinned / published coordination key entry. */
export function checkKeyEntry(k) {
  if (!k || typeof k !== 'object' || typeof k.kid !== 'string' || !k.kid || k.kid.length > 64) return false
  if (!Array.isArray(k.use) || !Number.isSafeInteger(k.nbf) || !Number.isSafeInteger(k.exp)) return false
  try { checkPub(unb64u(k.pub, 65)) } catch { return false }
  return true
}

export class Auth {
  /**
   * @param {object} cfg  config.auth
   * @param {{ gatewayId: string, dataDir?: string|null, now?: () => number, fetch?: typeof fetch, log?: (line: string) => void,
   *           tokenStore?: { entries(): { label: string, hash: Buffer }[] } }} opts  tokenStore: tokens kept in the data directory
   */
  constructor(cfg = {}, { gatewayId, dataDir = null, now = () => Date.now(), fetch: fetchImpl = globalThis.fetch, log = () => {}, tokenStore = null } = {}) {
    this.aud = `asr:${gatewayId}`
    this.now = now
    this.fetch = fetchImpl
    this.log = log
    this.dataDir = dataDir
    this.cfgTokens = (cfg.tokens || []).map((t) => ({ label: t.label, hash: Buffer.from(t.sha256, 'hex') }))
    this.tokenStore = tokenStore
    const tk = cfg.ticket || {}
    this.ticketOn = tk.enabled === true
    this.coordUrl = (tk.coordUrl || '').replace(/\/+$/, '')
    this.keysUrl = tk.keysUrl || (this.coordUrl ? `${this.coordUrl}/.well-known/pocket/keys.json` : '')
    this.pinned = Array.isArray(tk.pinnedKeys) ? tk.pinnedKeys.filter(checkKeyEntry) : []
    this.keys = this.pinned
    this.accounts = Array.isArray(tk.accounts) && tk.accounts.length ? tk.accounts : ['*']
    this.revocationsOn = this.ticketOn && tk.revocations !== false
    this.nonces = new Map()                 // nonce → expiry
    this.cutoffs = new Map()                // addr → { nbf, gone, at }
    this.cursors = {}                       // acct → feed cursor
    this.lastKeysFetch = 0
    this.timers = []
    if (this.ticketOn) this._loadState()
  }

  /** The config's tokens plus the ones in the data directory (re-read when tokens.json changes). */
  get tokens() { return this.tokenStore ? [...this.cfgTokens, ...this.tokenStore.entries()] : this.cfgTokens }

  get methods() {
    const m = []
    if (this.ticketOn) m.push('ticket')
    if (this.tokens.length) m.push('token')
    return m
  }

  /**
   * Header-time check (before the body is read).
   * @returns {{ kind: 'token'|'ticket', caller: string, T?: object, proof?: {a, s} }}
   */
  checkHeaders(headers) {
    const h = String(headers.authorization || '')
    const sp = h.indexOf(' ')
    const scheme = sp > 0 ? h.slice(0, sp) : ''
    const cred = sp > 0 ? h.slice(sp + 1).trim() : ''
    const tokens = scheme === 'Bearer' ? this.tokens : []
    if (scheme === 'Bearer' && tokens.length && cred) {
      const got = crypto.createHash('sha256').update(cred, 'utf8').digest()
      let hit = null
      for (const t of tokens) if (crypto.timingSafeEqual(got, t.hash) && !hit) hit = t
      if (hit) return { kind: 'token', caller: `token:${hit.label}` }
      throw new AsrError('unauthorized', 'token')
    }
    if (scheme === 'PocketTicket' && this.ticketOn && cred) {
      let T
      try {
        T = verifyTicket(cred, { keys: this.keys, aud: this.aud, now: this.now() })
      } catch (e) {
        if (e instanceof PocketError) {
          if (e.code === 'unknown-key') this.refreshKeys({ reason: 'unknown-key' }).catch(() => {})
          throw new AsrError('unauthorized', e.code)
        }
        throw e
      }
      if (!this.accounts.includes('*') && !this.accounts.includes(T.acct)) throw new AsrError('unauthorized', 'wrong-account')
      const cut = this.cutoffs.get(T.addr)
      if (cut && (cut.gone || T.iat < cut.nbf)) throw new AsrError('unauthorized', 'revoked')
      // the proof is checked here, before the body is read and before the request counts against the account's rate and
      // concurrency: a stolen ticket without the device key could otherwise keep the owner's voice input busy (red team
      // 2026-10-08). Only the body hash waits for the body (checkBody).
      let A
      try { A = verifyAsrProofHead({ T, ...splitProof(headers['x-pocket-proof']) }, { aud: this.aud, now: this.now() }) } catch (e) {
        if (e instanceof PocketError) throw new AsrError('unauthorized', e.code)
        throw e
      }
      if ((this.nonces.get(A.nonce) ?? 0) > this.now()) throw new AsrError('unauthorized', 'replay')
      return { kind: 'ticket', caller: `acct:${T.acct}`, T, A }
    }
    throw new AsrError('unauthorized', scheme ? `scheme-${scheme.slice(0, 16)}` : 'missing')
  }

  /** Body-time check for ticket callers: the proof must cover these exact bytes; then the nonce is spent. */
  checkBody(ctx, bodySha) {
    if (ctx.kind !== 'ticket') return
    if (ctx.A.bodySha !== b64u(bodySha)) throw new AsrError('unauthorized', 'body-mismatch')
    const r = { nonce: ctx.A.nonce }
    const t = this.now()
    const seen = this.nonces.get(r.nonce)
    if (seen && seen > t) throw new AsrError('unauthorized', 'replay')
    if (this.nonces.size >= NONCE_MAX) {
      this.sweep()
      if (this.nonces.size >= NONCE_MAX) throw new AsrError('busy', 'nonce-cache-full')
    }
    this.nonces.set(r.nonce, t + NONCE_TTL)
  }

  // ---- coordination keys ----------------------------------------------------------------------------------------
  _trusted() {
    const byKid = new Map()
    for (const k of [...this.pinned, ...this.keys]) byKid.set(k.kid, k)
    return [...byKid.values()]
  }

  /** Fetch keys.json and adopt it when a key we already trust signed it (E2EE §12.1). */
  async refreshKeys({ reason = 'timer', force = false } = {}) {
    if (!this.ticketOn || !this.keysUrl || !this.fetch) return false
    const t = this.now()
    if (!force && reason === 'unknown-key' && t - this.lastKeysFetch < KEYS_ON_UNKNOWN_MIN_GAP) return false
    this.lastKeysFetch = t
    try {
      const res = await this.fetch(this.keysUrl, { signal: AbortSignal.timeout(10_000), redirect: 'error' })
      if (res.status !== 200) { this.log(`keys refresh failed status=${res.status}`); return false }
      const doc = JSON.parse(await res.text())
      return this.adoptKeysDoc(doc, 'fetched')
    } catch (e) {
      this.log(`keys refresh failed ${e instanceof PocketError ? e.code : (e?.cause?.code || e?.name || 'error')}`)
      return false
    }
  }

  adoptKeysDoc(doc, how = 'given') {
    const keys = verifyKeysDoc(doc, this._trusted(), this.now()).filter(checkKeyEntry)
    if (!keys.length) throw new PocketError('bad-format', 'no keys')
    const before = this.keys.map((k) => k.kid).join(',')
    this.keys = keys
    const after = keys.map((k) => k.kid).join(',')
    if (before !== after) this.log(`coordination keys ${how}: ${after}`)
    this._save('keys.json', doc)
    return true
  }

  // ---- revocations (E2EE §12.4, RELAY.md §3.3) -------------------------------------------------------------------
  /** Verify and apply a signed revocation document; returns how many entries changed. */
  applyRevocations(doc) {
    const D = verifyCoordDoc('revocations', doc, this.keys, this.now())
    if (typeof D.acct !== 'string' || !Array.isArray(D.items)) throw new PocketError('bad-format')
    let n = 0
    for (const it of D.items) {
      if (!it || !checkAddr(it.addr) || !DID_RE.test(it.dev || '') || !Number.isSafeInteger(it.nbf)) continue
      const cur = this.cutoffs.get(it.addr) || { nbf: 0, gone: false, at: 0 }
      const next = { nbf: Math.max(cur.nbf, it.nbf), gone: cur.gone || it.gone === true, at: Math.max(cur.at, Number(it.at) || this.now()) }
      if (next.nbf !== cur.nbf || next.gone !== cur.gone) n++
      this.cutoffs.set(it.addr, next)
    }
    if (Number.isSafeInteger(D.next) && D.next >= 0) this.cursors[D.acct] = Math.max(this.cursors[D.acct] || 0, D.next)
    if (n) this._saveRevocations()
    return n
  }

  async pollRevocations() {
    if (!this.revocationsOn || !this.coordUrl || !this.fetch || this.accounts.includes('*')) return 0
    let total = 0
    for (const acct of this.accounts) {
      try {
        const qs = new URLSearchParams({ acct, since: String(this.cursors[acct] || 0) })
        const res = await this.fetch(`${this.coordUrl}/v2/relay/revocations?${qs}`, { signal: AbortSignal.timeout(10_000), redirect: 'error' })
        if (res.status !== 200) continue
        total += this.applyRevocations(JSON.parse(await res.text()))
      } catch (e) {
        this.log(`revocation poll failed ${e instanceof PocketError ? e.code : (e?.cause?.code || e?.name || 'error')}`)
      }
    }
    return total
  }

  // ---- housekeeping ---------------------------------------------------------------------------------------------
  sweep() {
    const t = this.now()
    for (const [k, exp] of this.nonces) if (exp <= t) this.nonces.delete(k)
    let changed = false
    for (const [addr, c] of this.cutoffs) {
      if ((c.gone && t - c.at > GONE_KEEP) || (!c.gone && t - c.nbf > CUTOFF_KEEP && c.nbf < t)) { this.cutoffs.delete(addr); changed = true }
    }
    if (changed) this._saveRevocations()
  }

  start() {
    if (!this.ticketOn) return
    const jitter = (ms) => ms + Math.floor(Math.random() * ms * 0.1)
    if (this.keysUrl) {
      const t = setTimeout(() => this.refreshKeys({ reason: 'start' }), 2000); t.unref?.(); this.timers.push(t)
      const iv = setInterval(() => this.refreshKeys({ reason: 'timer' }), jitter(KEYS_EVERY)); iv.unref?.(); this.timers.push(iv)
    }
    if (this.revocationsOn && !this.accounts.includes('*')) {
      const iv = setInterval(() => this.pollRevocations(), jitter(REVOCATION_POLL)); iv.unref?.(); this.timers.push(iv)
      const t = setTimeout(() => this.pollRevocations(), 3000); t.unref?.(); this.timers.push(t)
    }
  }

  stop() { for (const t of this.timers) { clearTimeout(t); clearInterval(t) } this.timers = [] }

  // ---- persistence (optional dataDir) ---------------------------------------------------------------------------
  _loadState() {
    if (!this.dataDir) return
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(this.dataDir, 'keys.json'), 'utf8'))
      this.adoptKeysDoc(doc, 'restored')
    } catch { /* none yet, or no longer trusted: keep the pinned keys */ }
    try {
      const s = JSON.parse(fs.readFileSync(path.join(this.dataDir, 'revocations.json'), 'utf8'))
      for (const [addr, c] of Object.entries(s.cutoffs || {})) {
        if (checkAddr(addr) && Number.isSafeInteger(c.nbf)) this.cutoffs.set(addr, { nbf: c.nbf, gone: c.gone === true, at: Number(c.at) || 0 })
      }
      if (s.cursors && typeof s.cursors === 'object') this.cursors = s.cursors
    } catch { /* none yet */ }
  }

  _saveRevocations() { this._save('revocations.json', { cutoffs: Object.fromEntries(this.cutoffs), cursors: this.cursors }) }

  _save(name, obj) {
    if (!this.dataDir) return
    try {
      fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 })
      const file = path.join(this.dataDir, name)
      const tmp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 })
      fs.renameSync(tmp, file)
    } catch (e) { this.log(`state save failed ${name} ${e.code || ''}`) }
  }
}

export { LABEL_RE }
