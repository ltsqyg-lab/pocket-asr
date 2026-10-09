// Self-hosting without a domain (ASR.md §11): the self-signed certificate and its pin, the connection line, tokens
// kept in the data directory (made on first start, added and revoked while the gateway runs), the public address
// (coordination's whoami, the interfaces, a placeholder), and `node src/main.mjs` end to end in a child process with
// a client that pins the certificate the way the App does.

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import tls from 'node:tls'
import { spawn, execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { makeSelfSigned, pinOf } from '../src/selfcert.mjs'
import { tlsMode, isLoopback, isSelfIssued, selfCert, prepareTls, SELF_CERT, SELF_KEY } from '../src/tls.mjs'
import { connectString, parseConnectString, pinFor, isPublicIPv4, guessPublicIPv4, whoami, resolvePublic, banner, PLACEHOLDER_HOST } from '../src/connect.mjs'
import { addToken, readTokens, removeToken, nextLabel, TokenStore, TOKENS_FILE } from '../src/tokens.mjs'
import { loadConfig } from '../src/config.mjs'
import { createGateway } from '../src/server.mjs'
import { parseArgs, rawConfig, defaultEngine, prebuiltProblem } from '../src/main.mjs'
import { tmpDir, toneWav, fakeAdapter, baseConfig } from './helpers.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const MAIN = path.join(ROOT, 'src', 'main.mjs')
const made = []
const dir = (p) => { const d = tmpDir(p); made.push(d); return d }
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }) })

// ---- a client that pins the certificate, as the App does -------------------------------------------------------------
/** HTTP over TLS to 127.0.0.1:port, refusing any certificate but the pinned one (no CA, no host name check). */
function pinned(port, pin, reqPath, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false })
    sock.once('error', reject)
    sock.once('secureConnect', () => {
      const got = 'sha256:' + crypto.createHash('sha256').update(sock.getPeerX509Certificate().raw).digest('hex')
      if (got !== pin) { sock.destroy(); return reject(Object.assign(new Error('pin mismatch'), { got })) }
      const req = http.request({ createConnection: () => sock, method, path: reqPath, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
        let s = ''
        res.setEncoding('utf8')
        res.on('data', (d) => { s += d })
        res.on('end', () => { let json = null; try { json = JSON.parse(s) } catch { /* not json */ } resolve({ status: res.statusCode, json, text: s }) })
      })
      req.on('error', reject)
      req.end(body)
    })
  })
}

async function freePort() {
  const s = net.createServer()
  await new Promise((r) => s.listen(0, '127.0.0.1', r))
  const { port } = s.address()
  await new Promise((r) => s.close(r))
  return port
}

/** A stand-in for the coordination server's GET /v2/whoami. */
async function fakeCoord(answer = { ip: '203.0.113.7' }) {
  const hits = []
  const srv = http.createServer((req, res) => {
    hits.push(req.url)
    if (req.url !== '/v2/whoami') { res.writeHead(404); return res.end() }
    const body = typeof answer === 'function' ? answer(req) : answer
    if (body === 404) { res.writeHead(404); return res.end('{}') }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(typeof body === 'string' ? body : JSON.stringify(body))
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${srv.address().port}`, hits, close: () => new Promise((r) => srv.close(r)) }
}

// ---- the copy of relay/src/selfcert.mjs ------------------------------------------------------------------------------
test('src/selfcert.mjs is relay/src/selfcert.mjs byte for byte (in the Pocket monorepo)', (t) => {
  const relay = path.join(ROOT, '..', 'relay', 'src', 'selfcert.mjs')
  if (!fs.existsSync(relay)) { t.skip('not inside the Pocket monorepo'); return }
  const same = fs.readFileSync(relay).equals(fs.readFileSync(path.join(ROOT, 'src', 'selfcert.mjs')))
  assert.ok(same, 'asr/src/selfcert.mjs differs from relay/src/selfcert.mjs — sync it: cp relay/src/selfcert.mjs asr/src/selfcert.mjs')
})

// ---- connection line -------------------------------------------------------------------------------------------------
test('connection line: IPv4, [IPv6], a domain without pin, a path; round trip; malformed lines refused', () => {
  const pin = 'sha256:' + 'ab'.repeat(32)
  const tok = crypto.randomBytes(32).toString('base64url')
  const a = connectString({ host: '203.0.113.7', port: 8444, pin, token: tok })
  assert.equal(a, `pocket-asr://203.0.113.7:8444?pin=${pin}&token=${tok}`)
  assert.deepEqual(parseConnectString(a), { host: '203.0.113.7', port: 8444, path: '', pin, token: tok, baseUrl: 'https://203.0.113.7:8444' })
  const b = connectString({ host: '2001:db8::7', port: 8444, pin })
  assert.equal(b, `pocket-asr://[2001:db8::7]:8444?pin=${pin}`)
  assert.equal(parseConnectString(b).baseUrl, 'https://[2001:db8::7]:8444')
  assert.equal(parseConnectString(b).token, null)
  const c = connectString({ host: 'asr.example.com', port: 443, path: '/asr', token: tok })
  assert.equal(c, `pocket-asr://asr.example.com:443/asr?token=${tok}`)
  assert.deepEqual(parseConnectString(c + '&later=1'), { host: 'asr.example.com', port: 443, path: '/asr', pin: null, token: tok, baseUrl: 'https://asr.example.com:443/asr' })
  assert.throws(() => connectString({ host: 'h', port: 1, pin: 'sha1:abc' }), /pin/)
  for (const bad of ['https://h:1', 'pocket-asr://h', 'pocket-asr://h:0', 'pocket-asr://h:1?pin=sha256:XYZ', `pocket-asr://h:1?pin=sha256:${'AB'.repeat(32)}`]) {
    assert.throws(() => parseConnectString(bad), Error, bad)
  }
})

test('pin rules: our own or any self-signed certificate always; a CA certificate only on an IP; none behind a proxy', () => {
  const self = { mode: 'self', pin: 'sha256:' + '1'.repeat(64), selfIssued: true }
  const ca = { mode: 'files', pin: 'sha256:' + '2'.repeat(64), selfIssued: false }
  assert.equal(pinFor(self, '203.0.113.7'), self.pin)
  assert.equal(pinFor(self, 'asr.example.com'), self.pin)
  assert.equal(pinFor(self, null), self.pin)
  assert.equal(pinFor(ca, 'asr.example.com'), null, 'renewals of a publicly trusted certificate keep working')
  assert.equal(pinFor(ca, '203.0.113.7'), ca.pin)
  assert.equal(pinFor({ mode: 'off', pin: null }, 'asr.example.com'), null)
})

// ---- certificate -----------------------------------------------------------------------------------------------------
test('tls modes: auto = own certificate unless on loopback; self / off / null / files as written', () => {
  const m = (tls, host = null) => tlsMode({ tls, listen: { host, port: 1 } })
  assert.equal(m('auto'), 'self')
  assert.equal(m(undefined, '0.0.0.0'), 'self')
  assert.equal(m('auto', '127.0.0.1'), 'off')
  assert.equal(m('auto', '::1'), 'off')
  assert.equal(m('self', '127.0.0.1'), 'self')
  assert.equal(m('off'), 'off')
  assert.equal(m(null), 'off')
  assert.equal(m({ cert: 'a', key: 'b' }), 'files')
  assert.ok(isLoopback('localhost') && isLoopback('127.1.2.3') && !isLoopback('10.0.0.1') && !isLoopback(null))
})

test('own certificate: made once in the data directory (key 0600), same pin on every start, never replaced by commands', () => {
  const d = dir('asr-cert-')
  const a = selfCert(d, { host: '203.0.113.7' })
  assert.equal(a.created, true)
  assert.match(a.pin, /^sha256:[0-9a-f]{64}$/)
  assert.equal(a.pin, pinOf(a.certPem))
  assert.equal(fs.statSync(path.join(d, SELF_KEY)).mode & 0o777, 0o600)
  const x = new crypto.X509Certificate(a.certPem)
  assert.equal(x.checkIP('203.0.113.7'), '203.0.113.7')
  assert.ok(isSelfIssued(a.certPem))
  const b = selfCert(d, { host: '203.0.113.7' })
  assert.equal(b.created, false)
  assert.equal(b.pin, a.pin, 'restarts keep the pin')
  // a command run with another address must not pull the certificate out from under the running gateway
  const c = selfCert(d, { host: '198.51.100.9', replace: false })
  assert.equal(c.pin, a.pin)
  // the gateway itself moves to the new address (the connection line changes anyway)
  const e = selfCert(d, { host: '198.51.100.9' })
  assert.equal(e.created, true)
  assert.notEqual(e.pin, a.pin)
  assert.equal(e.reason, 'host-changed')
})

test('own certificate made while the address was unknown is kept once the address is known (phones already pin it)', () => {
  const d = dir('asr-cert-')
  const a = selfCert(d, { host: null })
  assert.equal(new crypto.X509Certificate(a.certPem).subjectAltName, undefined)
  const b = selfCert(d, { host: '203.0.113.7' })
  assert.equal(b.created, false)
  assert.equal(b.pin, a.pin)
})

test('prepareTls: off, files (pin of the leaf), self without a data directory (ephemeral)', () => {
  const d = dir('asr-files-')
  const c = makeSelfSigned({ host: '127.0.0.1' })
  fs.writeFileSync(path.join(d, 'c.pem'), c.certPem)
  fs.writeFileSync(path.join(d, 'k.pem'), c.keyPem)
  const files = prepareTls(loadConfig(baseConfig({ tls: { cert: path.join(d, 'c.pem'), key: path.join(d, 'k.pem') } })))
  assert.equal(files.mode, 'files')
  assert.equal(files.pin, c.pin)
  assert.equal(files.selfIssued, true)
  assert.equal(prepareTls(loadConfig(baseConfig())).mode, 'off', 'loopback + auto = plain HTTP behind a proxy')
  const lines = []
  const eph = prepareTls(loadConfig(baseConfig({ tls: 'self' })), { log: (m) => lines.push(m) })
  assert.equal(eph.mode, 'self')
  assert.match(lines.join(), /new on every start/)
  assert.throws(() => prepareTls(loadConfig(baseConfig({ tls: { cert: path.join(d, 'missing.pem'), key: path.join(d, 'k.pem') } }))), /tls.cert/)
})

// ---- tokens in the data directory ----------------------------------------------------------------------------------
test('stored tokens: only hashes on disk (0600), unique labels, token-N labels, removal', () => {
  const d = dir('asr-tok-')
  const a = addToken(d)
  assert.equal(a.label, 'token-1')
  assert.match(a.token, /^[A-Za-z0-9_-]{43}$/)
  const b = addToken(d, { label: 'my phone' })
  const c = addToken(d, { reserved: ['token-2'] })
  assert.equal(c.label, 'token-3')
  const text = fs.readFileSync(path.join(d, TOKENS_FILE), 'utf8')
  for (const t of [a, b, c]) assert.ok(!text.includes(t.token), 'the token itself is never written')
  assert.equal(fs.statSync(path.join(d, TOKENS_FILE)).mode & 0o777, 0o600)
  const list = readTokens(d)
  assert.deepEqual(list.map((t) => t.label), ['token-1', 'my phone', 'token-3'])
  assert.equal(list[0].sha256, crypto.createHash('sha256').update(a.token).digest('hex'))
  assert.throws(() => addToken(d, { label: 'my phone' }), /already/)
  assert.throws(() => addToken(d, { label: 'x', reserved: ['x'] }), /already/)
  assert.throws(() => addToken(d, { label: '' }), /label/)
  assert.equal(removeToken(d, 'my phone'), true)
  assert.equal(removeToken(d, 'my phone'), false)
  assert.deepEqual(readTokens(d).map((t) => t.label), ['token-1', 'token-3'])
  assert.equal(nextLabel(['token-1', 'token-3']), 'token-2')
  assert.deepEqual(readTokens(dir('asr-tok-')), [], 'no file = no tokens')
})

test('the gateway takes tokens added and drops tokens revoked while it runs; a broken file keeps the last good list', async () => {
  const d = dir('asr-live-')
  const first = addToken(d)
  const lines = []
  const fake = fakeAdapter()
  const gw = createGateway({ ...baseConfig({ auth: {} }), dataDir: d }, { adapters: { fake }, tokenReloadMs: 0, log: (l) => lines.push(l) })
  const addr = await gw.listen()
  const u = `http://127.0.0.1:${addr.port}/v1/recognize?lang=zh`
  const say = (tok) => fetch(u, { method: 'POST', body: toneWav(1), headers: { 'Content-Type': 'audio/wav', Authorization: `Bearer ${tok}` } }).then((r) => r.status)
  try {
    assert.deepEqual(gw.info().auth, ['token'])
    assert.equal(await say(first.token), 200)
    const second = addToken(d, { label: 'tablet' })
    assert.equal(await say(second.token), 200, 'no restart needed')
    removeToken(d, 'tablet')
    assert.equal(await say(second.token), 401)
    assert.equal(await say(first.token), 200)
    fs.writeFileSync(path.join(d, TOKENS_FILE), '{ not json')
    assert.equal(await say(first.token), 200, 'a file being edited by hand does not lock everyone out')
    assert.match(lines.join('\n'), /unreadable/)
    fs.rmSync(path.join(d, TOKENS_FILE))
    assert.equal(await say(first.token), 401, 'tokens.json deleted = no stored tokens')
    assert.deepEqual(gw.info().auth, [])
    assert.ok(!lines.join('\n').includes(first.token), 'tokens never reach the log')
  } finally { await gw.close() }
  // throttled: changes are noticed at most once per interval
  const store = new TokenStore(d, { minGapMs: 60_000 })
  addToken(d, { label: 'late' })
  assert.equal(store.entries().length, 0)
  store.refresh()
  assert.equal(store.entries().length, 1)
})

// ---- public address --------------------------------------------------------------------------------------------------
test('public address: publicUrl, coordination whoami (IPv4 first, mapped IPv6 unwrapped), interfaces, unknown', async () => {
  assert.ok(isPublicIPv4('8.8.8.8') && isPublicIPv4('43.129.75.199'))
  for (const ip of ['10.1.2.3', '172.20.0.2', '192.168.1.5', '100.100.1.1', '127.0.0.1', '169.254.1.1', '0.0.0.0', '224.0.0.1', '203.0.113.7', '::1']) assert.equal(isPublicIPv4(ip), false, ip)
  const ifaces = { lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }], eth0: [{ family: 'IPv4', address: '172.17.0.3', internal: false }], eth1: [{ family: 'IPv6', address: '2001:db8::1', internal: false }, { family: 'IPv4', address: '43.129.75.199', internal: false }] }
  assert.equal(guessPublicIPv4(ifaces), '43.129.75.199')
  assert.equal(guessPublicIPv4({ eth0: [{ family: 'IPv4', address: '172.17.0.3', internal: false }] }), null, 'inside a container: no guess')

  const coord = await fakeCoord()
  try {
    assert.equal(await whoami(coord.url), '203.0.113.7')
    const cfg = loadConfig(baseConfig({ listen: { host: null, port: 8444 }, coordUrl: coord.url }))
    assert.deepEqual(await resolvePublic(cfg, { ifaces: {} }), { host: '203.0.113.7', port: 8444, path: '', source: 'whoami' })
    const viaUrl = loadConfig(baseConfig({ listen: { host: null, port: 8444 }, publicUrl: 'https://asr.example.com/v', coordUrl: coord.url }))
    const before = coord.hits.length
    assert.deepEqual(await resolvePublic(viaUrl), { host: 'asr.example.com', port: 443, path: '/v', source: 'config' })
    assert.equal(coord.hits.length, before, 'publicUrl set: coordination is not asked')
    const behind = loadConfig(baseConfig({ coordUrl: coord.url }))   // 127.0.0.1
    assert.equal((await resolvePublic(behind)).source, 'none', 'on loopback only publicUrl can say it')
    assert.equal(coord.hits.length, before)
  } finally { await coord.close() }

  const mapped = await fakeCoord({ ip: '::ffff:198.51.100.4' })
  const junk = await fakeCoord('{"ip":"203.0.113.7\\n<script>"}')
  const gone = await fakeCoord(404)
  try {
    assert.equal(await whoami(mapped.url), '198.51.100.4')
    const logs = []
    assert.equal(await whoami(junk.url, { log: (m) => logs.push(m) }), null, 'anything but an IP address is ignored')
    assert.equal(await whoami(gone.url), null, 'not deployed yet')
    assert.match(logs.join(), /gave no address/)
    const cfg = loadConfig(baseConfig({ listen: { host: null, port: 8444 }, coordUrl: gone.url }))
    assert.deepEqual(await resolvePublic(cfg, { ifaces }), { host: '43.129.75.199', port: 8444, path: '', source: 'interface' })
    assert.deepEqual(await resolvePublic(cfg, { ifaces: {} }), { host: null, port: 8444, path: '', source: 'none' })
  } finally { await mapped.close(); await junk.close(); await gone.close() }
})

test('banner: the line, App path and firewall note in English and Chinese; token shown once; placeholder when unknown', () => {
  const t = { mode: 'self', pin: 'sha256:' + 'c'.repeat(64), selfIssued: true }
  const tok = 'T'.repeat(43)
  const a = banner({ pub: { host: '203.0.113.7', port: 8444, path: '', source: 'whoami' }, tls: t, token: tok, label: 'token-1' })
  assert.equal(a.line, `pocket-asr://203.0.113.7:8444?pin=${t.pin}&token=${tok}`)
  assert.equal(a.bare, `pocket-asr://203.0.113.7:8444?pin=${t.pin}`)
  for (const s of ['Settings → Voice transcription → My own gateway', '我的 → 语音识别方式 → 自建语音网关', 'TCP port 8444', 'TCP 8444', 'shown only this once', 'new-token']) assert.ok(a.text.includes(s), s)
  const b = banner({ pub: { host: '203.0.113.7', port: 8444, path: '', source: 'whoami' }, tls: t })
  assert.ok(!b.text.includes('token='), 'no token, no token parameter')
  assert.match(b.text, /no token: tokens are stored only as hashes/)
  const c = banner({ pub: { host: null, port: 8444, path: '', source: 'none' }, tls: t, token: tok, label: 'token-1', docker: true })
  assert.ok(c.line.startsWith(`pocket-asr://${PLACEHOLDER_HOST}:8444?pin=`))
  assert.match(c.text, /ASR_PUBLIC_URL=https:\/\/<IP>:8444/)
  assert.match(c.text, /docker exec pocket-asr node src\/main\.mjs new-token/)
  const d = banner({ pub: { host: null, port: 8444, path: '', source: 'none' }, tls: { mode: 'off', pin: null } })
  assert.match(d.text, /reverse proxy's https:\/\/ address/)
  assert.ok(!d.text.includes('firewall'), 'behind a proxy the proxy owns the port')
})

// ---- command line pieces -----------------------------------------------------------------------------------------------
test('command line: arguments, environment overrides, default engine without downloads', async () => {
  assert.deepEqual(parseArgs([]), { cmd: 'start', args: [], config: null, health: false, version: false, help: false })
  assert.deepEqual(parseArgs(['new-token', 'my phone', '--config', 'a.json']), { cmd: 'new-token', args: ['my phone'], config: 'a.json', health: false, version: false, help: false })
  assert.equal(parseArgs(['--health']).health, true)
  assert.throws(() => parseArgs(['--nope']), /unknown option/)
  const r = rawConfig(null, { ASR_DATA_DIR: '/tmp/x', ASR_PORT: '9444', ASR_PUBLIC_URL: 'https://203.0.113.7:9444', ASR_TLS: 'self', ASR_COORD_URL: 'http://c' })
  assert.deepEqual(r, { dataDir: '/tmp/x', listen: { port: 9444 }, publicUrl: 'https://203.0.113.7:9444', tls: 'self', coordUrl: 'http://c' })
  assert.equal(rawConfig(null, {}).dataDir, '/var/lib/pocket-asr')
  assert.throws(() => rawConfig(null, { ASR_TLS: 'yes' }), /ASR_TLS/)
  assert.throws(() => rawConfig(null, { ASR_PORT: 'x' }), /ASR_PORT/)
  const d = dir('asr-def-')
  const f = path.join(d, 'asr.json')
  fs.writeFileSync(f, JSON.stringify({ listen: { host: '127.0.0.1', port: 1 }, dataDir: '/srv/asr' }))
  assert.deepEqual(rawConfig(f, { ASR_PORT: '2' }).listen, { host: '127.0.0.1', port: 2 }, 'the variables win over the file')
  assert.equal(rawConfig(f, {}).dataDir, '/srv/asr')

  const calls = []
  const installs = {
    installEngine: async (e, to) => { calls.push(['engine', e, to]); return path.join(to, 'bin', 'sherpa-onnx-offline') },
    installModel: async (m, to) => { calls.push(['model', m, to]); return to },
  }
  const viaEnv = await defaultEngine(d, { env: { ASR_SHERPA_BIN: '/opt/x/sherpa-onnx-offline' }, installs })
  assert.equal(viaEnv.bin, '/opt/x/sherpa-onnx-offline')
  assert.equal(viaEnv.model, path.join(d, 'models', 'sense-voice-int8'))
  assert.deepEqual(calls, [['model', 'sense-voice-int8', path.join(d, 'models', 'sense-voice-int8')]])
  if (!prebuiltProblem() && !fs.existsSync('/opt/sherpa/bin/sherpa-onnx-offline')) {
    calls.length = 0
    const inst = await defaultEngine(d, { env: {}, installs })
    assert.equal(inst.bin, path.join(d, 'sherpa-onnx', 'bin', 'sherpa-onnx-offline'))
    assert.equal(calls[0][0], 'engine')
  }
  assert.match(prebuiltProblem({ platform: 'darwin', key: 'sunos-x64' }), /no prebuilt sherpa-onnx for sunos-x64/)
})

// ---- node src/main.mjs, end to end -------------------------------------------------------------------------------------
function cleanEnv(extra) {
  const env = { ...process.env, ...extra }
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'ASR_CONFIG', 'ASR_PUBLIC_URL', 'ASR_TLS']) if (!(k in extra)) delete env[k]
  return env
}

/** Start `node src/main.mjs` and wait until it has printed the connection line (or listening, for no-line setups). */
function startMain(env, { args = [], until = /pocket-asr:\/\/\S+/ } = {}) {
  const child = spawn(process.execPath, [MAIN, ...args], { env: cleanEnv(env), stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { err += d })
  const ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no ${until} in 20 s\nstdout:\n${out}\nstderr:\n${err}`)), 20_000)
    const check = () => { if (until.test(out) && /listening/.test(out)) { clearTimeout(t); resolve() } }
    child.stdout.on('data', check)
    child.on('exit', (code) => { clearTimeout(t); reject(new Error(`exited ${code}\nstdout:\n${out}\nstderr:\n${err}`)) })
  })
  return {
    child, ready, get out() { return out }, get err() { return err },
    stop: () => new Promise((r) => { if (child.exitCode !== null) return r(); child.once('exit', r); child.kill('SIGTERM') }),
  }
}

/** One command, asynchronously (the fake coordination server lives in this process and must keep answering). */
function run(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [MAIN, ...args], { env: cleanEnv(env), encoding: 'utf8', timeout: 30_000 }, (e, out, err) => {
      resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, out: String(out || ''), err: String(err || '') })
    })
  })
}

const lineIn = (text) => (/pocket-asr:\/\/\S+/.exec(text) || [null])[0]

test('node src/main.mjs with no configuration: certificate, first token, line, pinned HTTPS, new-token, revoke, restart', async () => {
  const data = dir('asr-zero-')
  // the default local engine without downloads: a stand-in program and a SenseVoice-shaped model directory
  const bin = path.join(data, 'fake-sherpa.mjs')
  fs.copyFileSync(path.join(HERE, 'fake-bin', 'fake-engine.mjs'), bin)
  fs.chmodSync(bin, 0o755)
  const model = path.join(data, 'models', 'sense-voice-int8')
  fs.mkdirSync(model, { recursive: true })
  fs.writeFileSync(path.join(model, 'tokens.txt'), '<unk> 0\n<|zh|> 1\n<|en|> 2\n开 3\n')
  fs.writeFileSync(path.join(model, 'model.int8.onnx'), 'x')
  const coord = await fakeCoord()
  const port = await freePort()
  const env = { ASR_DATA_DIR: data, ASR_PORT: String(port), ASR_COORD_URL: coord.url, ASR_SHERPA_BIN: bin }

  const g = startMain(env)
  try {
    await g.ready
    const line = lineIn(g.out)
    const L = parseConnectString(line)
    assert.equal(L.host, '203.0.113.7', 'the address coordination saw')
    assert.equal(L.port, port)
    assert.match(L.pin, /^sha256:[0-9a-f]{64}$/)
    assert.match(L.token, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(coord.hits.filter((h) => h === '/v2/whoami').length, 1)
    for (const s of ['Settings → Voice transcription → My own gateway', '我的 → 语音识别方式 → 自建语音网关', `TCP port ${port}`]) assert.ok(g.out.includes(s), s)
    assert.ok(g.out.includes(`pin=${L.pin}`) && /tls=self/.test(g.out))
    // on disk: the certificate the gateway serves, the token's hash only, the line without the token
    assert.equal(pinOf(fs.readFileSync(path.join(data, SELF_CERT), 'utf8')), L.pin)
    const stored = fs.readFileSync(path.join(data, TOKENS_FILE), 'utf8')
    assert.ok(!stored.includes(L.token) && stored.includes(crypto.createHash('sha256').update(L.token).digest('hex')))
    assert.equal(fs.readFileSync(path.join(data, 'connect.txt'), 'utf8'), line.replace(/&token=.*$/, '') + '\n')
    assert.equal(fs.statSync(data).mode & 0o777, 0o700)

    // the App's view: pin the certificate, read /v1/info, recognise with the token
    const info = await pinned(port, L.pin, '/v1/info')
    assert.equal(info.status, 200)
    assert.deepEqual(info.json.auth, ['token'])
    assert.equal(info.json.engines[0].id, 'local')
    assert.deepEqual(info.json.engines[0].langs, ['zh', 'en', 'auto'])
    const wav = toneWav(1)
    const ok = await pinned(port, L.pin, '/v1/recognize?lang=zh', { method: 'POST', body: wav, headers: { 'Content-Type': 'audio/wav', 'Content-Length': wav.length, Authorization: `Bearer ${L.token}` } })
    assert.equal(ok.status, 200, ok.text)
    assert.equal(ok.json.text, '开放时间早上9点至下午5点。')
    await assert.rejects(pinned(port, 'sha256:' + '0'.repeat(64), '/v1/info'), /pin mismatch/, 'another certificate is refused')
    const noTok = await pinned(port, L.pin, '/v1/recognize?lang=zh', { method: 'POST', body: wav, headers: { 'Content-Type': 'audio/wav', 'Content-Length': wav.length } })
    assert.equal(noTok.status, 401)

    // another token while it runs, then revoke it
    const nt = await run(['new-token', 'my tablet'], env)
    assert.equal(nt.code, 0, nt.err)
    const L2 = parseConnectString(lineIn(nt.out))
    assert.equal(L2.pin, L.pin, 'same certificate')
    assert.notEqual(L2.token, L.token)
    assert.match(nt.out, /my tablet/)
    await new Promise((r) => setTimeout(r, 1100))
    const say = (tok) => pinned(port, L.pin, '/v1/recognize?lang=zh', { method: 'POST', body: wav, headers: { 'Content-Type': 'audio/wav', 'Content-Length': wav.length, Authorization: `Bearer ${tok}` } }).then((r) => r.status)
    assert.equal(await say(L2.token), 200, 'taken without a restart')
    assert.equal((await run(['new-token', 'my tablet'], env)).code, 1, 'labels are unique')
    const list = await run(['tokens'], env)
    assert.match(list.out, /stored {2}token-1/)
    assert.match(list.out, /stored {2}my tablet/)
    assert.equal((await run(['revoke-token', 'my tablet'], env)).code, 0)
    await new Promise((r) => setTimeout(r, 1100))
    assert.equal(await say(L2.token), 401, 'dropped without a restart')
    assert.equal(await say(L.token), 200)
    assert.equal((await run(['revoke-token', 'nobody'], env)).code, 1)

    const cs = await run(['connect-string'], env)
    assert.equal(cs.code, 0)
    assert.equal(lineIn(cs.out), line.replace(/&token=.*$/, ''), 'connect-string: the same line without a token')
    assert.match(cs.out, /new-token/)
    assert.equal((await run(['--health'], env)).code, 0)
    assert.match((await run(['--version'], env)).out, /^pocket-asr \d+\.\d+\.\d+/)
  } finally { await g.stop() }
  assert.equal((await run(['--health'], env)).code, 1, 'stopped: unhealthy')

  // restart: no new token, same pin, the line says how to get a token
  const g2 = startMain(env)
  try {
    await g2.ready
    const again = parseConnectString(lineIn(g2.out))
    assert.equal(again.pin, parseConnectString(fs.readFileSync(path.join(data, 'connect.txt'), 'utf8')).pin)
    assert.equal(again.token, null)
    assert.match(g2.out, /This line has no token/)
    assert.deepEqual(readTokens(data).map((t) => t.label), ['token-1'])
  } finally { await g2.stop(); await coord.close() }
})

test('node src/main.mjs: coordination unreachable → placeholder; behind a proxy; the official setup prints nothing and asks nobody', async () => {
  const coord = await fakeCoord(404)
  const d1 = dir('asr-nocoord-')
  const cfg1 = path.join(d1, 'asr.json')
  fs.writeFileSync(cfg1, JSON.stringify({ engines: [{ id: 'echo', type: 'openai', apiKey: 'sk-test', baseUrl: 'http://127.0.0.1:9/v1' }] }))
  // an interface address could be found on a machine with a public IP; this test only wants the "unknown" path
  const g = startMain({ ASR_DATA_DIR: d1, ASR_PORT: String(await freePort()), ASR_COORD_URL: coord.url }, { args: ['--config', cfg1] })
  try {
    await g.ready
    const line = lineIn(g.out)
    if (line.includes(PLACEHOLDER_HOST)) {
      assert.match(g.out, /could not be found/)
      assert.match(g.out, /没查到这台服务器的公网 IP/)
    } else {
      assert.match(g.out, /this machine's own interface address/)
    }
  } finally { await g.stop() }

  // behind a reverse proxy on this machine: plain HTTP on loopback, the line from publicUrl, no whoami
  const d2 = dir('asr-proxy-')
  const cfg2 = path.join(d2, 'asr.json')
  const p2 = await freePort()
  fs.writeFileSync(cfg2, JSON.stringify({ listen: { host: '127.0.0.1', port: p2 }, publicUrl: 'https://asr.example.com', engines: [{ id: 'echo', type: 'openai', apiKey: 'sk-test' }] }))
  const before = coord.hits.length
  const h = startMain({ ASR_DATA_DIR: d2, ASR_COORD_URL: coord.url }, { args: ['--config', cfg2] })
  try {
    await h.ready
    assert.match(h.out, /listening http:\/\/127\.0\.0\.1/)
    const L = parseConnectString(lineIn(h.out))
    assert.deepEqual([L.host, L.port, L.pin], ['asr.example.com', 443, null], 'a domain behind a proxy: the App checks the proxy\'s certificate the usual way')
    assert.ok(L.token)
    assert.equal((await fetch(`http://127.0.0.1:${p2}/v1/info`)).status, 200)
    assert.ok(!fs.existsSync(path.join(d2, SELF_CERT)), 'no certificate of our own')
  } finally { await h.stop() }
  assert.equal(coord.hits.length, before)

  // the official gateway's shape: tickets only, plain HTTP on loopback → no token, no line, no certificate, no whoami
  const d3 = dir('asr-official-')
  const cfg3 = path.join(d3, 'asr.json')
  const p3 = await freePort()
  const k = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' })
  const pub = Buffer.concat([Buffer.from([4]), Buffer.from(k.x, 'base64url'), Buffer.from(k.y, 'base64url')]).toString('base64url')
  fs.writeFileSync(cfg3, JSON.stringify({
    gatewayId: 'official', listen: { host: '127.0.0.1', port: p3 }, tls: null, basePath: '', dataDir: d3,
    auth: { tokens: [], ticket: { enabled: true, pinnedKeys: [{ kid: 'c1', pub, use: ['keys', 'ticket', 'revocations'], nbf: 0, exp: 0 }], accounts: ['*'] } },
    engines: [{ id: 'volcano', type: 'openai', apiKey: 'sk-test' }],
  }))
  const o = startMain({ ASR_COORD_URL: coord.url }, { args: ['--config', cfg3], until: /listening/ })
  try {
    await o.ready
    assert.match(o.out, /auth=ticket /)
    assert.ok(!/pocket-asr:\/\//.test(o.out), 'nothing to paste')
    assert.ok(!fs.existsSync(path.join(d3, TOKENS_FILE)) && !fs.existsSync(path.join(d3, SELF_CERT)) && !fs.existsSync(path.join(d3, 'connect.txt')))
    const info = await (await fetch(`http://127.0.0.1:${p3}/v1/info`)).json()
    assert.deepEqual(info.auth, ['ticket'])
  } finally { await o.stop(); await coord.close() }
  assert.equal(coord.hits.length, before, 'never asked for its address')
})

test('node src/server.mjs --config still starts the gateway (the official systemd unit)', async () => {
  const d = dir('asr-legacy-')
  const f = path.join(d, 'asr.json')
  const p = await freePort()
  fs.writeFileSync(f, JSON.stringify({ gatewayId: 'g', listen: { host: '127.0.0.1', port: p }, tls: null, dataDir: d,
    auth: { tokens: [{ label: 'a', sha256: crypto.createHash('sha256').update('t').digest('hex') }] }, engines: [{ id: 'o', type: 'openai', apiKey: 'sk-test' }] }))
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.mjs'), '--config', f], { env: cleanEnv({ ASR_COORD_URL: 'http://127.0.0.1:9' }), stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    let out = ''
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(out)), 15_000)
      child.stdout.on('data', (x) => { out += x; if (/listening http:\/\/127\.0\.0\.1:/.test(out)) { clearTimeout(t); resolve() } })
      child.on('exit', (c) => reject(new Error(`exit ${c}: ${out}`)))
    })
    assert.equal((await fetch(`http://127.0.0.1:${p}/healthz`)).status, 200)
  } finally { child.kill('SIGTERM') }
})

test('node src/cli.mjs check reads the config as main.mjs does (defaults, ASR_* variables, the default engine, no token yet)', async () => {
  const d = dir('asr-check-')
  const cli = (args, env) => new Promise((resolve) => {
    execFile(process.execPath, [path.join(ROOT, 'src', 'cli.mjs'), ...args], { env: cleanEnv(env), encoding: 'utf8' }, (e, out, err) => resolve({ code: e ? e.code : 0, out, err }))
  })
  const none = await cli(['check'], { ASR_DATA_DIR: d })
  assert.equal(none.code, 0, none.err)
  assert.match(none.out, /no engines configured: node src\/main\.mjs uses local recognition/)
  const f = path.join(d, 'asr.json')
  fs.writeFileSync(f, JSON.stringify({ engines: [{ id: 'o', type: 'openai', apiKey: 'sk-test' }] }))
  const one = await cli(['check', f], { ASR_DATA_DIR: d, ASR_PORT: '9555' })
  assert.equal(one.code, 0, one.err)
  assert.match(one.out, /no token yet/)
  assert.equal(JSON.parse(one.out.slice(one.out.indexOf('{'))).engines[0].id, 'o')
  assert.deepEqual(fs.readdirSync(d), ['asr.json'], 'check writes nothing (no certificate, no token)')
  fs.writeFileSync(f, JSON.stringify({ tls: 'bogus' }))
  assert.equal((await cli(['check', f], { ASR_DATA_DIR: d })).code, 1)
})
