#!/usr/bin/env node
// pocket-asr command line (ASR.md §11).
//
//   node src/main.mjs [--config <file>]       start the gateway; prints the connection line for the App
//   node src/main.mjs new-token [label]        one more token: prints a complete connection line (the token only there)
//   node src/main.mjs connect-string           the connection line without a token (tokens are kept only as hashes)
//   node src/main.mjs tokens                   token labels: the config's and the data directory's
//   node src/main.mjs revoke-token <label>     remove a token kept in the data directory
//   node src/main.mjs --health                 exit 0 when this gateway answers /healthz (container health checks)
//   node src/main.mjs --version
//
// No configuration is needed. On first start the gateway makes a self-signed certificate (the App pins it, so no
// domain and no certificate authority are involved), makes a token, and installs local recognition (sherpa-onnx +
// SenseVoice, Chinese and English; about 190 MB, every file checked against its pinned SHA-256) into the data
// directory; then it serves HTTPS on port 8444 and prints one line to paste into the App.
// Config file: --config, else ASR_CONFIG, else /etc/pocket-asr/asr.json when it exists. These variables override it:
//   ASR_DATA_DIR    dataDir      (default /var/lib/pocket-asr)
//   ASR_PORT        listen.port  (default 8444)
//   ASR_PUBLIC_URL  publicUrl    (default: the Pocket coordination server tells us our IP, GET /v2/whoami)
//   ASR_TLS         tls          auto | self | off
//   ASR_EDITION     edition      intl (default) | cn: the mainland China edition asks https://api.pocketcli.cn for its
//                   address and downloads only from https://api.pocketcli.cn/dl/asr/ (ASR.md §11.5)
//   ASR_COORD_URL   coordUrl     (default: the edition's, https://pocket.pocketcli.net)
//   ASR_DAY_MINUTES, ASR_MONTH_MINUTES   limits.dayMinutes / monthMinutes: speech time per caller (default 120 / 1500;
//                   0 = no cap)
//   ASR_SHERPA_BIN  the sherpa-onnx-offline program for the default local engine (else the image's, else installed)
//   ASR_COMMAND     how to run these commands on this machine, shown in the output (e.g. "sudo pocket-asr")
//
// License: AGPL-3.0-only.

import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config.mjs'
import { createGateway, VERSION, installFatalHandlers } from './server.mjs'
import { readTokens, addToken, removeToken } from './tokens.mjs'
import { prepareTls, tlsMode } from './tls.mjs'
import { resolvePublic, banner, writeConnectFile } from './connect.mjs'
import { installEngine, installModel, ensureConfiguredModels, loadManifest, platformKey, progressLogger } from './models.mjs'

export const DEFAULT_DATA_DIR = '/var/lib/pocket-asr'
export const DEFAULT_CONFIG_FILE = '/etc/pocket-asr/asr.json'
export const DEFAULT_MODEL = 'sense-voice-int8'
const IMAGE_SHERPA = '/opt/sherpa/bin/sherpa-onnx-offline'      // the Docker image's engine program
const TLS_WORDS = ['auto', 'self', 'off']

const USAGE = `usage:
  node src/main.mjs [--config <file>]       start the gateway (no file needed)
  node src/main.mjs new-token [label]        another token; prints a complete connection line
  node src/main.mjs connect-string           the connection line without a token
  node src/main.mjs tokens                   list token labels
  node src/main.mjs revoke-token <label>     remove a token kept in the data directory
  node src/main.mjs --health | --version
Models and engine programs: node src/cli.mjs models | install-model | install-engine | check | transcribe`

class UsageError extends Error {}
const stamp = () => new Date().toISOString()
const inDocker = () => fs.existsSync('/.dockerenv')

export function parseArgs(argv) {
  const o = { cmd: null, args: [], config: null, health: false, version: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--config') { o.config = argv[++i]; if (!o.config) throw new UsageError('--config needs a file') }
    else if (a.startsWith('--config=')) o.config = a.slice(9)
    else if (a === '--health') o.health = true
    else if (a === '--version') o.version = true
    else if (a === '--help' || a === '-h' || (a === 'help' && !o.cmd)) o.help = true
    else if (a.startsWith('--')) throw new UsageError(`unknown option ${a}`)
    else if (!o.cmd) o.cmd = a
    else o.args.push(a)
  }
  o.cmd ??= 'start'
  return o
}

/** The config file in use, if any. */
export function configFile(given, env) {
  if (given) return given
  if (env.ASR_CONFIG) return env.ASR_CONFIG
  return fs.existsSync(DEFAULT_CONFIG_FILE) ? DEFAULT_CONFIG_FILE : null
}

/** The file's settings (or none) with the ASR_* overrides and a data directory. */
export function rawConfig(file, env) {
  let raw = {}
  if (file) {
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { throw new Error(`config: cannot read ${file} (${e.message})`) }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`config: ${file} must hold a JSON object`)
  }
  raw = { ...raw }
  if (env.ASR_DATA_DIR) raw.dataDir = env.ASR_DATA_DIR
  if (raw.dataDir === undefined || raw.dataDir === null || raw.dataDir === '') raw.dataDir = DEFAULT_DATA_DIR
  if (env.ASR_PORT) {
    const p = Number(env.ASR_PORT)
    if (!Number.isInteger(p) || p < 0 || p > 65535) throw new Error('ASR_PORT must be a port number')
    raw.listen = { ...(raw.listen || {}), port: p }
  }
  if (env.ASR_PUBLIC_URL) raw.publicUrl = env.ASR_PUBLIC_URL
  if (env.ASR_TLS) {
    if (!TLS_WORDS.includes(env.ASR_TLS)) throw new Error(`ASR_TLS must be one of ${TLS_WORDS.join(', ')}`)
    raw.tls = env.ASR_TLS
  }
  if (env.ASR_COORD_URL) raw.coordUrl = env.ASR_COORD_URL
  if (env.ASR_EDITION) raw.edition = env.ASR_EDITION
  for (const [name, key] of [['ASR_DAY_MINUTES', 'dayMinutes'], ['ASR_MONTH_MINUTES', 'monthMinutes']]) {
    if (env[name] === undefined || env[name] === '') continue
    const n = Number(env[name])
    if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a number of minutes (0 = no cap)`)
    raw.limits = { ...(raw.limits || {}), [key]: n }
  }
  return raw
}

function load(raw, env) {
  const cfg = loadConfig(raw, env)
  cfg.dataDir = path.resolve(cfg.dataDir)
  return cfg
}

// Commands that recognise nothing must not need the engines' keys (env: values) to be present.
const withoutEngines = (raw) => ({ ...raw, engines: [], default: {} })

export function ensureDataDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK)
  } catch (e) {
    throw new Error(`the data directory ${dir} is not writable (${e.code || e.message}): run as a user who may write it, or pick another with ASR_DATA_DIR`)
  }
}

/** Why the prebuilt sherpa-onnx cannot run on this machine (null = it can). */
export function prebuiltProblem({ platform = process.platform, key = platformKey() } = {}) {
  if (platform === 'linux') {
    let glibc
    try { glibc = process.report.getReport().header.glibcVersionRuntime } catch { /* unknown */ }
    if (!glibc) return 'this Linux has no glibc (Alpine, or the slim image)'
  }
  if (!loadManifest().engines['sherpa-onnx']?.binaries?.[key]) return `no prebuilt sherpa-onnx for ${key}`
  return null
}

/**
 * No engine configured: local recognition with sherpa-onnx + SenseVoice (zh / en / auto). The program is the image's
 * (or ASR_SHERPA_BIN), else installed into <dataDir>/sherpa-onnx; the model goes to <dataDir>/models/sense-voice-int8.
 */
export async function defaultEngine(dataDir, { env = process.env, log = () => {}, installs = { installEngine, installModel }, edition = null } = {}) {
  let bin = env.ASR_SHERPA_BIN || (fs.existsSync(IMAGE_SHERPA) ? IMAGE_SHERPA : null)
  if (!bin) {
    const why = prebuiltProblem()
    if (why) throw new Error(`no engine is configured, and the default local engine cannot run here (${why}): configure an engine (README → Engines and models)`)
    const dir = path.join(dataDir, 'sherpa-onnx')
    if (!fs.existsSync(dir)) log('installing the speech engine program sherpa-onnx (first start only)')
    bin = await installs.installEngine('sherpa-onnx', dir, { log, edition, onProgress: progressLogger(log) })
  }
  const model = path.join(dataDir, 'models', DEFAULT_MODEL)
  if (!fs.existsSync(model)) log(`installing the speech model ${DEFAULT_MODEL}, about 160 MB (first start only)`)
  await installs.installModel(DEFAULT_MODEL, model, { log, edition, onProgress: progressLogger(log) })
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length
  return { id: 'local', type: 'sherpa-onnx', bin, model, threads: Math.max(1, Math.min(4, cores)) }
}

/** Memory this process may use: the container's limit when there is one, else the machine's. */
function memoryBytes() {
  const total = os.totalmem()
  let limit = 0
  try { limit = process.constrainedMemory?.() || 0 } catch { /* older Node */ }
  return limit > 0 && limit < total ? limit : total
}

// ---- start --------------------------------------------------------------------------------------------------------
async function start(o, env, io) {
  installFatalHandlers()
  const log = (m) => io.out(`${stamp()} ${m}`)
  const raw = rawConfig(configFile(o.config, env), env)
  let cfg = load(raw, env)
  ensureDataDir(cfg.dataDir)
  if (!cfg.engines.length) {
    log('no engine configured: local recognition with sherpa-onnx + SenseVoice (Chinese and English)')
    raw.engines = [await defaultEngine(cfg.dataDir, { env, log, edition: cfg.edition })]
    raw.default = {}
    // every recognition runs one engine process holding the model (about 0.5 GB): one at a time on a 1 GB server
    if (raw.limits?.concurrent === undefined) raw.limits = { ...(raw.limits || {}), concurrent: memoryBytes() < 1.8 * 2 ** 30 ? 1 : 2 }
    cfg = load(raw, env)
  }
  await ensureConfiguredModels(cfg, { log: (m) => log(`models ${m}`), onProgress: progressLogger(log) })

  const stored = readTokens(cfg.dataDir)
  const firstToken = !cfg.auth.tokens.length && !stored.length && !cfg.auth.ticket.enabled
  const mode = tlsMode(cfg)
  // the line is for people who connect with a token or to our own HTTPS; a ticket-only gateway behind a proxy (the
  // official one) has nothing to print and never asks for its address
  const showLine = firstToken || cfg.auth.tokens.length > 0 || stored.length > 0 || mode !== 'off'
  const pub = showLine ? await resolvePublic(cfg, { log }) : null
  const tls = prepareTls(cfg, { publicHost: pub?.host ?? null, log })
  const gw = createGateway(cfg, { tls, allowNoAuth: firstToken })
  const addr = await gw.listen()
  let made = null
  try {
    made = firstToken ? addToken(cfg.dataDir) : null      // after listen: a start that fails earlier loses no token
    if (made) gw.tokenStore.refresh()
  } catch (e) { await gw.close(); throw e }

  const engines = [...gw.engines.values()].map((e) => `${e.id}(${e.type}:${e.langs.join('/')})`).join(' ')
  const where = addr.address.includes(':') ? `[${addr.address}]` : addr.address
  io.out(`${stamp()} pocket-asr ${VERSION} edition=${cfg.edition} gw=${cfg.gatewayId} listening ${mode === 'off' ? 'http' : 'https'}://${where}:${addr.port} auth=${gw.auth.methods.join('+') || '-'} engines=${engines}${tls.pin ? ` tls=${mode} pin=${tls.pin}` : ''}`)
  if (mode === 'off' && !cfg.listen.host) log('note: plain HTTP on every address — only behind your own HTTPS reverse proxy')
  if (showLine) {
    if (pub.source !== 'config' && cfg.listen.port === 0) pub.port = addr.port
    const b = banner({ pub, tls, token: made?.token, label: made?.label, docker: inDocker(), edition: cfg.edition, cmd: env.ASR_COMMAND || undefined })
    io.out(b.text)
    try { writeConnectFile(cfg.dataDir, b.bare) } catch (e) { log(`could not write connect.txt (${e.code || e.message})`) }
  }
  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    await gw.close()
    process.exit(0)
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  return gw
}

// ---- the other commands ---------------------------------------------------------------------------------------------
/** Settings, public address and certificate for printing a line (never replaces the gateway's certificate). */
async function lineParts(o, env, io) {
  const cfg = load(withoutEngines(rawConfig(configFile(o.config, env), env)), env)
  ensureDataDir(cfg.dataDir)
  const pub = await resolvePublic(cfg, { log: (m) => io.err(m) })
  const tls = prepareTls(cfg, { publicHost: pub.host, replace: false, log: (m) => io.err(m) })
  return { cfg, pub, tls }
}

async function newToken(o, env, io) {
  if (o.args.length > 1) throw new UsageError('new-token takes one label (put it in quotes if it has spaces)')
  const { cfg, pub, tls } = await lineParts(o, env, io)
  const made = addToken(cfg.dataDir, { label: o.args[0], reserved: cfg.auth.tokens.map((t) => t.label) })
  io.out(banner({ pub, tls, token: made.token, label: made.label, docker: inDocker(), edition: cfg.edition, cmd: env.ASR_COMMAND || undefined }).text)
  io.out('A running gateway accepts the new token within a second (no restart).')
  io.out('正在运行的网关一秒内就认这个新令牌,不用重启。')
  return 0
}

async function connectString(o, env, io) {
  const { cfg, pub, tls } = await lineParts(o, env, io)
  io.out(banner({ pub, tls, docker: inDocker(), edition: cfg.edition, cmd: env.ASR_COMMAND || undefined }).text)
  return 0
}

function tokens(o, env, io) {
  const cfg = load(withoutEngines(rawConfig(configFile(o.config, env), env)), env)
  const stored = readTokens(cfg.dataDir)
  for (const t of cfg.auth.tokens) io.out(`config  ${t.label}`)
  for (const t of stored) io.out(`stored  ${t.label}${t.created ? `  (made ${t.created})` : ''}`)
  if (!cfg.auth.tokens.length && !stored.length) io.out('no tokens')
  return 0
}

function revokeToken(o, env, io) {
  if (o.args.length !== 1) throw new UsageError('revoke-token takes the label of one token (see: tokens)')
  const label = o.args[0]
  const cfg = load(withoutEngines(rawConfig(configFile(o.config, env), env)), env)
  if (removeToken(cfg.dataDir, label)) {
    io.out(`revoked "${label}": a running gateway refuses it within a second`)
    return 0
  }
  if (cfg.auth.tokens.some((t) => t.label === label)) throw new Error(`"${label}" is in the config file: delete it there and restart the gateway`)
  throw new Error(`no stored token is labelled "${label}" (see: tokens)`)
}

function health(o, env) {
  const cfg = load(withoutEngines(rawConfig(configFile(o.config, env), env)), env)
  const h = cfg.listen.host
  const host = !h || h === '0.0.0.0' || h === '::' ? '127.0.0.1' : h
  return new Promise((resolve) => {
    const req = (tlsMode(cfg) === 'off' ? http : https).get(
      { host, port: cfg.listen.port, path: `${cfg.basePath}/healthz`, rejectUnauthorized: false, timeout: 4000 },
      (res) => { res.resume(); resolve(res.statusCode === 200 ? 0 : 1) })
    req.on('error', () => resolve(1))
    req.on('timeout', () => { req.destroy(); resolve(1) })
  })
}

/**
 * Run a command. Resolves with the exit code; `start` resolves once the gateway listens (with the gateway) and keeps
 * the process running.
 */
export async function cli(argv = process.argv.slice(2), env = process.env, io = {
  out: (s) => process.stdout.write(s + '\n'),
  err: (s) => process.stderr.write(s + '\n'),
}) {
  const fail = (code, msg) => { io.err(`pocket-asr: ${msg}`); process.exitCode = code; return code }
  let o
  try { o = parseArgs(argv) } catch (e) { io.err(USAGE); return fail(2, e.message) }
  if (o.help) { io.out(USAGE); return 0 }
  if (o.version) { io.out(`pocket-asr ${VERSION}`); return 0 }
  try {
    if (o.health) { const c = await health(o, env); process.exitCode = c; return c }
    if (o.cmd === 'start') return await start(o, env, io)
    if (o.cmd === 'new-token') return await newToken(o, env, io)
    if (o.cmd === 'connect-string') return await connectString(o, env, io)
    if (o.cmd === 'tokens') return tokens(o, env, io)
    if (o.cmd === 'revoke-token') return revokeToken(o, env, io)
    io.err(USAGE)
    return fail(2, `unknown command "${o.cmd}"`)
  } catch (e) {
    if (e instanceof UsageError) { io.err(USAGE); return fail(2, e.message) }
    // a gateway that cannot start because of its configuration: 78 (EX_CONFIG) tells supervisors not to hurry
    return fail(o.cmd === 'start' ? 78 : 1, e.message)
  }
}

// The exit code is set on process.exitCode and the process ends by itself, so piped output is never cut short.
const self = fileURLToPath(import.meta.url)
if (process.argv[1] && path.resolve(process.argv[1]) === self) cli()
