#!/usr/bin/env node
// pocket-asr — speech-recognition gateway for Pocket (ASR.md). Zero npm dependencies, Node 22+.
//
//   GET  /v1/info                         public: engines, auth methods, limits
//   POST /v1/recognize?lang=&engine=      WAV body (16 kHz mono s16) → { ok, text, lang, engine, seconds, ms }
//   POST /v1/revocations                  signed revocation document (ticket auth only)
//   GET  /healthz
//
// Audio and text live in memory for one request; logs carry no audio, text, tokens, tickets or proofs.
// The command line (start, new-token, connect-string, …) is src/main.mjs; `node src/server.mjs --config x` still works.
// License: AGPL-3.0-only.

import http from 'node:http'
import https from 'node:https'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { loadConfig } from './config.mjs'
import { buildEngines, pickEngine, LANGS } from './engines/index.mjs'
import { Auth } from './auth.mjs'
import { TokenStore } from './tokens.mjs'
import { prepareTls } from './tls.mjs'
import { Limiter } from './limits.mjs'
import { SpeechTime } from './quota.mjs'
import { parseWav, pcmToWav, peakAbs } from './wav.mjs'
import { AsrError, cleanDetail } from './errors.mjs'
import { tidyText, charCount } from './text.mjs'
import { isAbort } from './lib/http.mjs'
import { PocketError } from './pcrypto.mjs'

export const VERSION = '1.1.1'
// what /v1/info says: major.minor only, so the exact build is not advertised (`--version` prints the full one)
export const PUBLIC_VERSION = VERSION.split('.').slice(0, 2).join('.')
const MAX_REVOCATION_DOC = 1024 * 1024
// Revocation documents are signed, but checking one costs a JSON parse of up to 1 MiB plus a signature check: cap the
// rate (whole gateway) so a public /v1/revocations cannot be used to burn CPU. Coordination pushes a few per minute.
const REVOCATIONS_PER_MIN = 120

class ClientGone extends Error { constructor() { super('client went away'); this.name = 'ClientGone' } }

const logSafe = (s) => String(s).replace(/[\s=\u0000-\u001f\u007f"]/g, '_').slice(0, 80)

/**
 * @param {object} rawConfig  parsed config object (or a path, or loadConfig()'s result)
 * @param {{ log?: Function, now?: Function, fetch?: Function, adapters?: object, env?: object,
 *           tls?: object, publicHost?: string, allowNoAuth?: boolean, tokenReloadMs?: number }} [opts]
 *   tls: prepareTls()'s result (else listen() prepares it); publicHost: the name for a new self-signed certificate;
 *   allowNoAuth: start even though no way to authenticate exists yet (main.mjs makes the first token right after listen)
 */
export function createGateway(rawConfig, opts = {}) {
  const config = loadConfig(rawConfig, opts.env)
  const log = opts.log || ((line) => process.stdout.write(line + '\n'))
  const now = opts.now || (() => Date.now())
  const stamp = () => new Date(now()).toISOString()
  const engines = buildEngines(config.engines, { adapters: opts.adapters, gatewayMaxSeconds: config.limits.maxSeconds })
  for (const [lang, id] of Object.entries(config.default)) {
    if (!engines.get(id).langs.includes(lang)) throw new Error(`config: default.${lang} = "${id}" but that engine doesn't do ${lang}`)
  }
  // tokens made by `node src/main.mjs new-token` live in <dataDir>/tokens.json and are picked up without a restart
  const tokenStore = config.dataDir
    ? new TokenStore(config.dataDir, { now, minGapMs: opts.tokenReloadMs ?? 1000, log: (m) => log(`${stamp()} ${m}`) })
    : null
  const auth = new Auth(config.auth, {
    gatewayId: config.gatewayId, dataDir: config.dataDir, now, fetch: opts.fetch, log: (m) => log(`${stamp()} auth ${m}`), tokenStore,
  })
  if (!opts.allowNoAuth && !auth.methods.length) {
    throw new Error('config: enable at least one way to authenticate: auth.tokens, a token from `node src/main.mjs new-token` (kept in dataDir), or auth.ticket')
  }
  const limiter = new Limiter(config.limits, now)
  const limits = config.limits
  // speech time per caller per day and month (ASR.md §6): from the account's newest ticket, else these limits
  const speech = new SpeechTime({ timezone: config.timezone, dayMinutes: limits.dayMinutes, monthMinutes: limits.monthMinutes,
    dataDir: config.dataDir, now, log: (m) => log(`${stamp()} ${m}`) })
  let uploads = 0

  // the engine that answers each language when the request names none (configured default, else the first that fits)
  const effective = Object.fromEntries(LANGS.map((l) => [l, pickEngine(engines, config.default, l, null)?.id]).filter(([, id]) => id))
  const defaultsFor = (id) => Object.entries(effective).filter(([, e]) => e === id).map(([l]) => l)
  const info = () => ({
    service: 'pocket-asr',
    version: PUBLIC_VERSION,
    gatewayId: config.gatewayId,
    engines: [...engines.values()].map((e) => {
      const d = defaultsFor(e.id)
      return { id: e.id, kind: e.kind, langs: e.langs, maxSeconds: e.maxSeconds, default: d.length > 0, defaultFor: d }
    }),
    auth: auth.methods,
    limits: { maxBytes: limits.maxBytes, maxSeconds: limits.maxSeconds },
  })

  const uidOf = (caller) => 'asr-' + crypto.createHash('sha256').update(`pocket/v1 asr uid|${config.gatewayId}|${caller}`).digest('base64url').slice(0, 22)

  function send(res, status, obj, headers = {}) {
    if (res.headersSent || res.destroyed) return
    const body = Buffer.from(JSON.stringify(obj))
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    })
    res.end(body)
  }

  /**
   * Read the body up to `max` bytes. Over the limit, or when we answer early, the rest is drained (bounded) so the
   * client can read our answer instead of hitting a reset while it is still sending.
   */
  function readBody(req, max) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0, over = false, done = false
      const finish = (fn) => { if (!done) { done = true; fn() } }
      req.on('data', (c) => {
        if (over) return
        size += c.length
        if (size > max) { over = true; return finish(() => reject(new AsrError('too-large'))) }
        chunks.push(c)
      })
      req.on('end', () => finish(() => resolve(Buffer.concat(chunks))))
      req.on('aborted', () => finish(() => reject(new ClientGone())))
      req.on('error', () => finish(() => reject(new ClientGone())))
      req.on('close', () => { if (!req.complete) finish(() => reject(new ClientGone())) })
    })
  }

  // We answered before reading the whole body: keep reading (bounded) and discard it, so the client — which
  // usually reads the answer only after it finished sending — sees our status instead of a reset connection.
  function drain(req) {
    if (req.complete || req.destroyed) return
    let size = 0
    const cap = limits.maxBytes + 1024 * 1024
    const t = setTimeout(() => req.socket?.destroy(), 30_000)
    t.unref?.()
    req.on('data', (c) => { size += c.length; if (size > cap) req.socket?.destroy() })
    req.on('end', () => clearTimeout(t))
    req.on('close', () => clearTimeout(t))
    req.resume()
  }

  async function recognize(req, res, url) {
    const t0 = now()
    const f = { caller: '-', engine: '-', sec: 0, chars: 0, code: 'ok', detail: '', notes: [] }
    const gone = new AbortController()
    res.on('close', () => { if (!res.writableFinished) gone.abort() })
    let releaseCaller = null, releaseEngine = null
    try {
      const lang = url.searchParams.get('lang') || 'auto'
      if (!LANGS.includes(lang)) throw new AsrError('bad-request', 'lang')
      const wanted = url.searchParams.get('engine') || null
      if (wanted !== null && !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(wanted)) throw new AsrError('no-engine', 'engine-param')

      const who = auth.checkHeaders(req.headers)
      f.caller = who.caller
      speech.observe(who)
      speech.check(who)                                  // time used up: refused before the audio is read
      const cl = req.headers['content-length']
      if (cl !== undefined && !(Number(cl) <= limits.maxBytes)) throw new AsrError('too-large', 'content-length')
      releaseCaller = limiter.enterCaller(who.caller)
      if (!releaseCaller) throw new AsrError('rate', 'concurrent', { retryAfter: 2 })
      const rate = limiter.takeRate(who.caller)          // only requests that may proceed count against the minute
      if (!rate.ok) throw new AsrError('rate', 'per-minute', { retryAfter: rate.retryAfter })
      if (limits.uploads && uploads >= limits.uploads) throw new AsrError('busy', 'uploads', { retryAfter: 2 })

      uploads++
      let body
      try { body = await readBody(req, limits.maxBytes) } finally { uploads-- }
      auth.checkBody(who, crypto.createHash('sha256').update(body).digest())

      const w = parseWav(body)
      f.sec = w.seconds
      if (w.seconds > limits.maxSeconds) throw new AsrError('too-long', 'gateway-max')
      if (w.samples < 1600 || (limits.silencePeak > 0 && peakAbs(w.pcm) < limits.silencePeak)) throw new AsrError('empty', 'silence')
      const engine = pickEngine(engines, config.default, lang, wanted)
      if (!engine) throw new AsrError('no-engine', wanted ? 'engine-lang' : `lang-${lang}`)
      f.engine = engine.id
      if (w.seconds > engine.maxSeconds) throw new AsrError('too-long', `engine-max-${engine.maxSeconds}`)
      releaseEngine = limiter.enterEngine()
      if (!releaseEngine) throw new AsrError('busy', 'concurrent', { retryAfter: 2 })
      // once more (a request of the same caller may have used the time up meanwhile), then the audio counts: every
      // recognition that reaches an engine, whatever comes back, so cutting the connection or failing on purpose
      // does not buy engine time
      speech.check(who)
      speech.charge(who, w.seconds)

      const deadline = AbortSignal.timeout(opts.deadlineMs ?? 30_000 + Math.ceil(w.seconds * 1000))   // ASR.md §2
      const signal = AbortSignal.any([gone.signal, deadline])
      let r
      try {
        r = await engine.adapter.recognize({
          pcm: w.pcm, wav: pcmToWav(w.pcm), sampleRate: w.sampleRate, seconds: w.seconds, lang, signal,
          config: engine.config, uid: uidOf(who.caller), note: (s) => { if (f.notes.length < 4) f.notes.push(cleanDetail(s)) },
        })
      } catch (e) {
        if (gone.signal.aborted) throw new ClientGone()
        if (deadline.aborted || isAbort(e)) throw new AsrError('engine-timeout', 'deadline')
        throw e
      }
      const text = tidyText(r?.text)
      if (!text) throw new AsrError('empty', 'engine-empty')
      f.chars = charCount(text)
      const outLang = r.lang === 'zh' || r.lang === 'en' ? r.lang : lang
      send(res, 200, { ok: true, text, lang: outLang, engine: engine.id, seconds: Math.round(w.seconds * 100) / 100, ms: now() - t0 })
    } catch (e) {
      if (e instanceof ClientGone) {
        f.code = 'aborted'
      } else if (e instanceof AsrError) {
        f.code = e.code
        f.detail = e.detail || ''
        drain(req, res)
        send(res, e.status, e.toJSON(), e.retryAfter ? { 'Retry-After': String(e.retryAfter) } : {})
      } else {
        f.code = 'engine-error'
        f.detail = `internal:${cleanDetail(e?.code || e?.name || 'error')}`
        drain(req, res)
        send(res, 502, new AsrError('engine-error').toJSON())
      }
    } finally {
      releaseEngine?.()
      releaseCaller?.()
      log(`${stamp()} recognize gw=${config.gatewayId} caller=${logSafe(f.caller)} engine=${f.engine} sec=${f.sec.toFixed(2)} chars=${f.chars} ms=${now() - t0} code=${f.code}`
        + (f.detail ? ` detail=${f.detail}` : '') + (f.notes.length ? ` notes=${f.notes.join(',')}` : ''))
    }
  }

  let revHits = []
  async function revocations(req, res) {
    if (!auth.ticketOn) return send(res, 404, new AsrError('not-found').toJSON())
    const t = now()
    revHits = revHits.filter((x) => t - x < 60_000)
    if (revHits.length >= REVOCATIONS_PER_MIN) {
      log(`${stamp()} revocations rejected detail=rate`)
      drain(req, res)
      return send(res, 429, new AsrError('rate', 'revocations').toJSON(), { 'Retry-After': '60' })
    }
    revHits.push(t)
    let body
    try { body = await readBody(req, MAX_REVOCATION_DOC) } catch (e) {
      if (e instanceof AsrError) { drain(req, res); return send(res, e.status, e.toJSON()) }
      return
    }
    try {
      const n = auth.applyRevocations(JSON.parse(body.toString('utf8')))
      log(`${stamp()} revocations applied=${n}`)
      send(res, 200, { ok: true, applied: n })
    } catch (e) {
      const code = e instanceof PocketError ? e.code : 'bad-json'
      log(`${stamp()} revocations rejected detail=${cleanDetail(code)}`)
      send(res, 400, { ok: false, code: 'bad-request', message: 'invalid revocation document' })
    }
  }

  function handler(req, res) {
    let url
    try { url = new URL(req.url, 'http://gateway') } catch { return send(res, 400, new AsrError('bad-request').toJSON()) }
    let p = url.pathname
    const base = config.basePath
    if (base && (p === base || p.startsWith(base + '/'))) p = p.slice(base.length) || '/'
    if (p === '/v1/recognize') {
      if (req.method !== 'POST') { drain(req, res); return send(res, 405, new AsrError('method').toJSON(), { Allow: 'POST' }) }
      return recognize(req, res, url).catch(() => send(res, 502, new AsrError('engine-error').toJSON()))
    }
    if (p === '/v1/info') {
      if (req.method !== 'GET' && req.method !== 'HEAD') { drain(req, res); return send(res, 405, new AsrError('method').toJSON(), { Allow: 'GET' }) }
      return send(res, 200, info(), { 'Cache-Control': 'public, max-age=60' })
    }
    if (p === '/v1/revocations') {
      if (req.method !== 'POST') { drain(req, res); return send(res, 405, new AsrError('method').toJSON(), { Allow: 'POST' }) }
      return revocations(req, res).catch(() => send(res, 500, { ok: false, code: 'bad-request', message: 'error' }))
    }
    if (p === '/healthz') return send(res, 200, { ok: true })
    drain(req, res)
    return send(res, 404, new AsrError('not-found').toJSON())
  }

  let server = null
  let tls = opts.tls || null
  const sweeper = setInterval(() => { limiter.sweep(); auth.sweep() }, 60_000)
  sweeper.unref?.()

  return {
    config, engines, auth, limiter, speech, handler, info, tokenStore,
    /** How it serves: { mode: off|files|self, pin, selfIssued, … } (after listen(), or when given in opts.tls). */
    get tls() { return tls },
    /** Start listening; resolves with the bound address. */
    listen(port = config.listen.port, host = config.listen.host ?? undefined) {
      tls ||= prepareTls(config, { publicHost: opts.publicHost, log: (m) => log(`${stamp()} ${m}`) })
      server = tls.mode === 'off'
        ? http.createServer(handler)
        : https.createServer({ cert: tls.cert, key: tls.key }, handler)
      server.headersTimeout = 30_000
      server.requestTimeout = 300_000
      server.keepAliveTimeout = 5_000
      auth.start()
      speech.start()
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => { server.off('error', reject); resolve(server.address()) })
      })
    },
    get server() { return server },
    async close() {
      clearInterval(sweeper)
      auth.stop()
      speech.close()
      if (!server) return
      await new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.() })
    },
  }
}

// ---- command line ------------------------------------------------------------------------------------------------
// Last line of defence: an exception in some callback is logged (no audio or text is ever in these errors) and the
// gateway keeps serving; more than 20 in a minute means the state is broken, so exit for the supervisor to restart it.
let fatalBurst = []
function fatal(kind, e) {
  process.stderr.write(`${new Date().toISOString()} ${kind} ${cleanDetail(e?.code || e?.name || 'error')}\n`)
  const t = Date.now()
  fatalBurst = fatalBurst.filter((x) => t - x < 60_000)
  fatalBurst.push(t)
  if (fatalBurst.length > 20) { process.stderr.write('pocket-asr: too many unexpected errors in a minute, exiting\n'); process.exit(1) }
}

export function installFatalHandlers() {
  process.on('uncaughtException', (e) => fatal('uncaught-exception', e))
  process.on('unhandledRejection', (e) => fatal('unhandled-rejection', e))
}

// `node src/server.mjs [--config file]` is the same as `node src/main.mjs [--config file]` (the official deployment's
// systemd unit runs this file).
const self = fileURLToPath(import.meta.url)
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  import('./main.mjs').then((m) => m.cli(['start', ...process.argv.slice(2)]))
}
