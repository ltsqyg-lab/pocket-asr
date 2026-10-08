// Configuration (ASR.md §6). JSON file; any string value "env:NAME" is read from the environment at startup and
// "file:/path" from a file (trimmed), so secrets never sit in the config. An engine may also name a
// "secretsFile": a JSON object merged into that engine's settings (e.g. an existing credentials file).

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
}

const GATEWAY_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

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
 * @returns {object} normalized config (engines still raw: buildEngines() validates them per adapter)
 */
export function loadConfig(raw, env = process.env) {
  if (typeof raw === 'string') {
    try { raw = JSON.parse(fs.readFileSync(raw, 'utf8')) } catch (e) { throw new Error(`config: cannot read ${raw} (${e.message})`) }
  }
  if (!raw || typeof raw !== 'object') throw new Error('config: must be a JSON object')
  const c = resolveSecrets(raw, env)

  if (!GATEWAY_ID_RE.test(c.gatewayId || '')) throw new Error(`config: gatewayId must match ${GATEWAY_ID_RE}`)
  const listen = { host: '127.0.0.1', port: 8080, ...(c.listen || {}) }
  if (!Number.isInteger(listen.port) || listen.port < 0 || listen.port > 65535) throw new Error('config: listen.port must be 0–65535')
  if (c.tls && (typeof c.tls.cert !== 'string' || typeof c.tls.key !== 'string')) throw new Error('config: tls needs "cert" and "key" file paths (or null)')
  if (c.basePath !== undefined && !/^(\/[A-Za-z0-9._-]+)*$/.test(c.basePath)) throw new Error('config: basePath must look like "/asr" (or "")')

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
    if (ticket.coordUrl !== undefined && !/^https?:\/\//.test(ticket.coordUrl)) throw new Error('config: auth.ticket.coordUrl must be http(s)://…')
    if (ticket.accounts !== undefined && (!Array.isArray(ticket.accounts) || ticket.accounts.some((a) => typeof a !== 'string' || !a))) {
      throw new Error('config: auth.ticket.accounts must be a list of account ids or ["*"]')
    }
  }
  if (!tokens.length && !ticket.enabled) throw new Error('config: enable at least one way to authenticate (auth.tokens or auth.ticket)')

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
    gatewayId: c.gatewayId,
    listen,
    tls: c.tls || null,
    basePath: c.basePath || '',
    dataDir: c.dataDir || null,
    auth: { tokens, ticket },
    engines,
    default: defaults,
    limits,
  }
}
