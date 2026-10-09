// Tokens kept in the data directory (ASR.md §11): `<dataDir>/tokens.json` holds only the SHA-256 of each token and a
// label, exactly like `auth.tokens` in the config; the token itself is printed once (in a connection line) and never
// written anywhere. The first start makes one when no way to authenticate is configured; `node src/main.mjs new-token`
// adds more and `revoke-token` removes one. A running gateway notices changes within a second (no restart).

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { LABEL_RE } from './auth.mjs'
import { matchOwner } from './lib/files.mjs'

export const TOKENS_FILE = 'tokens.json'
const ABOUT = 'SHA-256 of each token of this gateway (the tokens themselves are never stored). Add one: node src/main.mjs new-token [label]; remove one: node src/main.mjs revoke-token <label>'

/** A new token: 32 random bytes, base64url (43 characters, safe in a URL). */
export function newTokenString() { return crypto.randomBytes(32).toString('base64url') }

const hashOf = (token) => crypto.createHash('sha256').update(String(token), 'utf8').digest('hex')

function parse(text) {
  const doc = JSON.parse(text)
  const list = Array.isArray(doc) ? doc : doc?.tokens
  if (!Array.isArray(list)) throw new Error('tokens.json: no "tokens" list')
  return list.filter((t) => t && LABEL_RE.test(t.label || '') && /^[0-9a-f]{64}$/i.test(t.sha256 || ''))
    .map((t) => ({ label: t.label, sha256: t.sha256.toLowerCase(), created: typeof t.created === 'string' ? t.created : undefined }))
}

/** The stored tokens ({label, sha256, created}); none when the file does not exist. */
export function readTokens(dataDir) {
  let text
  try { text = fs.readFileSync(path.join(dataDir, TOKENS_FILE), 'utf8') } catch (e) {
    if (e.code === 'ENOENT') return []
    throw new Error(`cannot read ${path.join(dataDir, TOKENS_FILE)} (${e.code || e.message})`)
  }
  return parse(text)
}

function writeTokens(dataDir, list) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const file = path.join(dataDir, TOKENS_FILE)
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ about: ABOUT, tokens: list }, null, 1) + '\n', { mode: 0o600 })
  matchOwner(tmp, dataDir)
  fs.renameSync(tmp, file)
}

// Two commands changing tokens.json at the same moment must not lose one's change: a lock directory (mkdir is atomic),
// taken over when older than 10 s (a command that died while holding it).
function withLock(dataDir, fn) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const lock = path.join(dataDir, '.tokens.lock')
  const t0 = Date.now()
  for (;;) {
    try { fs.mkdirSync(lock); break } catch (e) {
      if (e.code !== 'EEXIST') throw e
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) { fs.rmSync(lock, { recursive: true, force: true }); continue } } catch { continue }
      if (Date.now() - t0 > 5_000) throw new Error(`${TOKENS_FILE} is being changed by another command (lock ${lock})`)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
  try { return fn() } finally { fs.rmSync(lock, { recursive: true, force: true }) }
}

/** The first free label of the form token-N among `taken`. */
export function nextLabel(taken) {
  const used = new Set(taken)
  for (let i = 1; ; i++) if (!used.has(`token-${i}`)) return `token-${i}`
}

/**
 * Make a token and store its hash. `label` is optional (token-N); `reserved` are labels already used elsewhere
 * (the config's auth.tokens). Returns { label, token } — the only time the token exists outside the caller's memory.
 */
export function addToken(dataDir, { label, reserved = [], now = Date.now() } = {}) {
  return withLock(dataDir, () => {
    const list = readTokens(dataDir)
    const taken = [...reserved, ...list.map((t) => t.label)]
    const name = label ?? nextLabel(taken)
    if (!LABEL_RE.test(name)) throw new Error('a label is 1–64 printable characters')
    if (taken.includes(name)) throw new Error(`there is already a token labelled "${name}" (revoke it first, or pick another label)`)
    const token = newTokenString()
    list.push({ label: name, sha256: hashOf(token), created: new Date(now).toISOString() })
    writeTokens(dataDir, list)
    return { label: name, token }
  })
}

/** Remove the stored token with this label; false when there is none. */
export function removeToken(dataDir, label) {
  return withLock(dataDir, () => {
    const list = readTokens(dataDir)
    const rest = list.filter((t) => t.label !== label)
    if (rest.length === list.length) return false
    writeTokens(dataDir, rest)
    return true
  })
}

/**
 * Live view of tokens.json for the gateway: re-read when the file changes (checked at most every `minGapMs`).
 * A file that cannot be parsed keeps the previous list (and says so once); a deleted file means no stored tokens.
 */
export class TokenStore {
  constructor(dataDir, { now = () => Date.now(), minGapMs = 1000, log = () => {} } = {}) {
    this.file = path.join(dataDir, TOKENS_FILE)
    this.now = now
    this.minGapMs = minGapMs
    this.log = log
    this.sig = null
    this.checked = -Infinity
    this.list = []
    this.refresh()
  }

  /** [{ label, hash: Buffer }] as of the last check. */
  entries() {
    if (this.now() - this.checked >= this.minGapMs) this.refresh()
    return this.list
  }

  refresh() {
    this.checked = this.now()
    let st = null
    try { st = fs.statSync(this.file) } catch { /* no file */ }
    const sig = st ? `${st.ino}:${st.size}:${st.mtimeMs}` : 'none'
    if (sig === this.sig) return
    this.sig = sig
    if (!st) { if (this.list.length) this.log(`tokens: ${TOKENS_FILE} is gone, no stored tokens`); this.list = []; return }
    try {
      const next = parse(fs.readFileSync(this.file, 'utf8')).map((t) => ({ label: t.label, hash: Buffer.from(t.sha256, 'hex') }))
      const before = this.list.map((t) => t.label).join(',')
      this.list = next
      const after = next.map((t) => t.label).join(',')
      if (before !== after) this.log(`tokens: ${next.length} stored (${after.split(',').map((l) => l.replace(/[^\w.-]/g, '_').slice(0, 32)).join(' ') || '-'})`)
    } catch (e) {
      this.log(`tokens: ${TOKENS_FILE} unreadable (${(e.code || e.name || 'error').toString().slice(0, 40)}), keeping the previous list`)
    }
  }
}
