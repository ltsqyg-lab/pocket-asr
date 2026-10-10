// Configuration (ASR.md §6). JSON file; any string value "env:NAME" is read from the environment at startup and
// "file:/path" from a file (trimmed), so secrets never sit in the config. An engine may also name a
// "secretsFile": a JSON object merged into that engine's settings (e.g. an existing credentials file).
// Every key has a default (ASR.md §11): with no file at all, `node src/main.mjs` serves HTTPS on port 8444 with its own
// certificate, a token it makes on first start and the default local engine.

import fs from 'node:fs'
import { checkKeyEntry, LABEL_RE } from './auth.mjs'
import { LANGS } from './engines/index.mjs'

export const DEFAULT_LIMITS = {
  maxBytes: 8 * 1024 * 1024,
  maxSeconds: 240,
  perMinute: 12,
  concurrentPerCaller: 2,
  concurrent: 8,
  uploads: 16,          // request bodies being received at once (memory bound)
  silencePeak: 64,      // recordings whose loudest sample is below this are answered `empty` without an engine
  dayMinutes: 120,      // speech time per caller per day, unless its ticket says otherwise (0 = no cap; quota.mjs)
  monthMinutes: 1500,   // … per month
}
export const DEFAULT_TIMEZONE = 'Asia/Shanghai'   // where days and months of speech time start

const GATEWAY_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
export const DEFAULT_PORT = 8444                  // next to pocket-relay's 8443 on the same server
export const DEFAULT_GATEWAY_ID = 'my-asr'
export const DEFAULT_COORD_URL = 'https://pocket.pocketcli.net'
/**
 * The two Pocket services (ASR.md §11.5). `edition` sets where the gateway asks for its public address (coordUrl) and
 * where it downloads the speech model and engine program (models.json `editions`): the mainland China edition talks to
 * nothing outside mainland China. `pub` = each edition's coordination key, so a ticket configuration cannot pin the
 * other edition's key by mistake.
 */
export const EDITIONS = {
  intl: { coordUrl: DEFAULT_COORD_URL, pub: ['BLv9ISMLeI3tx3arobNAhCeYOFlF7DWmPGHh5zky1v0V2vLMLdeQIoFnJAmRkj_oU9i6Ml0Qoe2-v-xdEeRhqJ0'] },
  cn: { coordUrl: 'https://api.pocketcli.cn', pub: ['BKhhniVXB9NNhTXSRxobx4SWsho4vLGYCAcU32s9zP9mr-5Fj6_rScKjKmf7Kout2Un2nG1edVuFLngEsgtKUtI'] },
}
export const EDITION_NAMES = Object.keys(EDITIONS)
/** The edition whose coordination server is at this URL (same origin), or null. */
export function editionOfUrl(url) {
  let o
  try { o = new URL(String(url)).origin } catch { return null }
  return EDITION_NAMES.find((e) => new URL(EDITIONS[e].coordUrl).origin === o) ?? null
}
const TLS_WORDS = ['auto', 'self', 'off']
/** loadConfig's result carries this mark, so createGateway() does not load it a second time. */
export const LOADED = Symbol.for('pocket-asr.config')

/** Replace "env:NAME" / "file:/path" strings anywhere in the object (returns a new object). */
export function resolveSecrets(v, env = process.env, where = 'config') {
  if (typeof v === 'string') {
    const m = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(v)
    if (m) {
      if (env[m[1]] === undefined || env[m[1]] === '') throw new Error(`${where}: environment variable ${m[1]} is not set`)
      return env[m[1]]
    }
    const f = /^file:(.+)$/.exec(v)
    if (f) {
      try { return fs.readFileSync(f[1], 'utf8').trim() } catch { throw new Error(`${where}: cannot read ${f[1]}`) }
    }
    return v
  }
  if (Array.isArray(v)) return v.map((x, i) => resolveSecrets(x, env, `${where}[${i}]`))
  if (v && typeof v === 'object') {
    const out = {}
    for (const [k, x] of Object.entries(v)) out[k] = resolveSecrets(x, env, `${where}.${k}`)
    return out
  }
  return v
}

/**
 * Load and validate. `raw` is a parsed object or a path to a JSON file.
 * Does not insist on a way to authenticate: tokens may also live in the data directory (tokens.mjs), so createGateway()
 * checks that.
 * @returns {object} normalized config (engines still raw: buildEngines() validates them per adapter)
 */
export function loadConfig(raw, env = process.env) {
  if (raw && raw[LOADED]) return raw
  if (typeof raw === 'string') {
    try { raw = JSON.parse(fs.readFileSync(raw, 'utf8')) } catch (e) { throw new Error(`config: cannot read ${raw} (${e.message})`) }
  }
  if (!raw || typeof raw !== 'object') throw new Error('config: must be a JSON object')
  const c = resolveSecrets(raw, env)

  const ticketOn = c.auth?.ticket?.enabled === true
  // tickets are addressed to asr:<gatewayId>, so a gateway that takes them must say its id
  if (ticketOn && c.gatewayId === undefined) throw new Error('config: auth.ticket needs a "gatewayId" (tickets are addressed to asr:<gatewayId>)')
  const gatewayId = c.gatewayId ?? DEFAULT_GATEWAY_ID
  if (!GATEWAY_ID_RE.test(gatewayId)) throw new Error(`config: gatewayId must match ${GATEWAY_ID_RE}`)
  // host null = every address (IPv6 and IPv4)
  const listen = { host: null, port: DEFAULT_PORT, ...(c.listen || {}) }
  if (!Number.isInteger(listen.port) || listen.port < 0 || listen.port > 65535) throw new Error('config: listen.port must be 0–65535')
  if (listen.host !== null && (typeof listen.host !== 'string' || !listen.host)) throw new Error('config: listen.host must be an address (or null for all)')
  const tls = c.tls === undefined ? 'auto' : c.tls
  if (typeof tls === 'string' ? !TLS_WORDS.includes(tls) : tls !== null && (typeof tls !== 'object' || typeof tls.cert !== 'string' || typeof tls.key !== 'string')) {
    throw new Error('config: tls must be "auto", "self", "off" (or null), or { "cert": <file>, "key": <file> }')
  }
  if (c.basePath !== undefined && !/^(\/[A-Za-z0-9._-]+)*$/.test(c.basePath)) throw new Error('config: basePath must look like "/asr" (or "")')
  let publicUrl = null
  if (c.publicUrl !== undefined && c.publicUrl !== null && c.publicUrl !== '') {
    let u
    try { u = new URL(c.publicUrl) } catch { throw new Error('config: publicUrl must be a URL like https://203.0.113.7:8444') }
    if (u.protocol !== 'https:' || !u.hostname || u.username || u.password || u.search || u.hash) {
      throw new Error('config: publicUrl must be https://<host>[:<port>][/<path>] (the App only talks HTTPS)')
    }
    publicUrl = u.href.replace(/\/+$/, '')
  }
  // the edition: given, or the one whose coordination server coordUrl / auth.ticket.coordUrl names, else international
  const named = [c.coordUrl, c.auth?.ticket?.coordUrl].map((u) => (u ? editionOfUrl(u) : null)).filter(Boolean)
  const edition = c.edition ?? named[0] ?? 'intl'
  if (typeof edition !== 'string' || !EDITIONS[edition]) throw new Error(`config: edition must be ${EDITION_NAMES.map((e) => `"${e}"`).join(' or ')} (ASR_EDITION)`)
  const other = named.find((e) => e !== edition)
  if (other) throw new Error(`config: edition "${edition}" but coordUrl / auth.ticket.coordUrl names the coordination server of the "${other}" edition: remove it, or set edition "${other}"`)
  const coordUrl = c.coordUrl ?? EDITIONS[edition].coordUrl
  if (typeof coordUrl !== 'string' || !/^https?:\/\/[^/]/.test(coordUrl)) throw new Error('config: coordUrl must be http(s)://…')
  const timezone = c.timezone ?? DEFAULT_TIMEZONE
  try { if (typeof timezone !== 'string') throw 0; new Intl.DateTimeFormat('en-CA', { timeZone: timezone }) } catch { throw new Error(`config: timezone ${JSON.stringify(timezone)} is not an IANA time zone such as "Asia/Shanghai"`) }

  const auth = c.auth || {}
  const tokens = auth.tokens || []
  if (!Array.isArray(tokens)) throw new Error('config: auth.tokens must be a list')
  const labels = new Set()
  for (const t of tokens) {
    if (!t || !LABEL_RE.test(t.label || '')) throw new Error('config: every token needs a "label" (1–64 printable characters)')
    if (labels.has(t.label)) throw new Error(`config: duplicate token label "${t.label}"`)
    labels.add(t.label)
    if (!/^[0-9a-f]{64}$/i.test(t.sha256 || '')) throw new Error(`config: token "${t.label}" needs "sha256" = the token's SHA-256 in hex (never the token itself)`)
  }
  const ticket = auth.ticket || { enabled: false }
  if (ticket.enabled) {
    if (!Array.isArray(ticket.pinnedKeys) || !ticket.pinnedKeys.length) throw new Error('config: auth.ticket.enabled needs pinnedKeys')
    if (!ticket.pinnedKeys.every(checkKeyEntry)) throw new Error('config: a pinned key is malformed ({kid, pub, use, nbf, exp})')
    if (!ticket.pinnedKeys.some((k) => k.use.includes('ticket'))) throw new Error('config: no pinned key may sign tickets (use must include "ticket")')
    for (const e of EDITION_NAMES.filter((x) => x !== edition)) {
      if (ticket.pinnedKeys.some((k) => EDITIONS[e].pub.includes(k.pub))) throw new Error(`config: auth.ticket.pinnedKeys holds the key of the "${e}" edition, but this gateway is the "${edition}" edition`)
    }
    if (ticket.coordUrl !== undefined && !/^https?:\/\//.test(ticket.coordUrl)) throw new Error('config: auth.ticket.coordUrl must be http(s)://…')
    if (ticket.accounts !== undefined && (!Array.isArray(ticket.accounts) || ticket.accounts.some((a) => typeof a !== 'string' || !a))) {
      throw new Error('config: auth.ticket.accounts must be a list of account ids or ["*"]')
    }
  }

  const limits = { ...DEFAULT_LIMITS, ...(c.limits || {}) }
  for (const [k, v] of Object.entries(limits)) {
    if (!Number.isFinite(v) || v < 0) throw new Error(`config: limits.${k} must be a non-negative number`)
  }
  if (limits.maxBytes < 1024 || limits.maxBytes > 64 * 1024 * 1024) throw new Error('config: limits.maxBytes must be 1 KiB – 64 MiB')
  if (limits.maxSeconds <= 0 || limits.maxSeconds > 3600) throw new Error('config: limits.maxSeconds must be 1–3600')

  // engines: merge secretsFile, keep the rest for the adapters
  const engines = (Array.isArray(c.engines) ? c.engines : []).map((e, i) => {
    if (!e || typeof e !== 'object' || !e.secretsFile) return e
    let extra
    try { extra = JSON.parse(fs.readFileSync(e.secretsFile, 'utf8')) } catch { throw new Error(`config: engines[${i}].secretsFile cannot be read as JSON`) }
    const { secretsFile, ...rest } = e
    return { ...extra, ...rest }
  })

  const defaults = c.default || {}
  for (const [lang, id] of Object.entries(defaults)) {
    if (!LANGS.includes(lang)) throw new Error(`config: default.${lang}: language must be one of ${LANGS.join(', ')}`)
    if (!engines.some((e) => e && e.id === id)) throw new Error(`config: default.${lang} names an unknown engine "${id}"`)
  }

  return {
    [LOADED]: true,
    edition,
    gatewayId,
    listen,
    tls,
    publicUrl,
    coordUrl,
    timezone,
    basePath: c.basePath || '',
    dataDir: c.dataDir || null,
    auth: { tokens, ticket },
    engines,
    default: defaults,
    limits,
  }
}
