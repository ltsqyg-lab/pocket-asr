// The two editions (ASR.md §11.5): ASR_EDITION=cn asks only the mainland China coordination server for its address and
// downloads only from the mainland mirror (never GitHub / Hugging Face); the international edition stays the default.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadConfig, EDITIONS, editionOfUrl } from '../src/config.mjs'
import { rawConfig, defaultEngine } from '../src/main.mjs'
import { resolvePublic } from '../src/connect.mjs'
import { loadManifest, sources, urlsFor, installEngine, installModel, ensureConfiguredModels } from '../src/models.mjs'
import { createGateway } from '../src/server.mjs'
import { baseConfig, tmpDir, coordKeys, fakeAdapter } from './helpers.mjs'

const MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.mjs')
const CN = 'https://api.pocketcli.cn', INTL = 'https://pocket.pocketcli.net'

test('configuration: international by default; ASR_EDITION=cn sets the mainland coordination server; contradictions refused', async () => {
  assert.deepEqual([loadConfig(baseConfig()).edition, loadConfig(baseConfig()).coordUrl], ['intl', INTL])
  const cn = loadConfig(baseConfig({ edition: 'cn' }))
  assert.deepEqual([cn.edition, cn.coordUrl], ['cn', CN])
  assert.equal(rawConfig(null, { ASR_EDITION: 'cn', ASR_DATA_DIR: '/tmp/x' }).edition, 'cn')
  // the official mainland gateway names its coordination server only for tickets: cn
  const lab = coordKeys().entry
  assert.equal(loadConfig(baseConfig({ auth: { ticket: { enabled: true, coordUrl: CN, pinnedKeys: [lab] } } })).edition, 'cn')
  assert.equal(loadConfig(baseConfig({ coordUrl: `${CN}/` })).edition, 'cn')
  assert.equal(loadConfig(baseConfig({ edition: 'cn', coordUrl: 'http://127.0.0.1:9' })).coordUrl, 'http://127.0.0.1:9', 'a lab may point anywhere')
  for (const [over, re] of [
    [{ edition: 'eu' }, /edition must be/],
    [{ edition: 'cn', coordUrl: INTL }, /"intl" edition/],
    [{ edition: 'intl', coordUrl: CN }, /"cn" edition/],
    [{ edition: 'cn', auth: { ticket: { enabled: true, coordUrl: CN, pinnedKeys: [{ ...lab, pub: EDITIONS.intl.pub[0] }] } } }, /key of the "intl" edition/],
  ]) assert.throws(() => loadConfig(baseConfig(over)), re, JSON.stringify(over))
  assert.deepEqual([editionOfUrl(CN), editionOfUrl(INTL), editionOfUrl('https://x.example')], ['cn', 'intl', null])
  const gw = createGateway(baseConfig({ edition: 'cn' }), { adapters: { fake: fakeAdapter() }, log: () => {} })
  assert.equal(gw.info().edition, 'cn')
  await gw.close()
})

test('download sources: cn = only the mainland mirror for every model and program; intl = mirror then upstream', () => {
  const m = loadManifest()
  const cn = sources(m, { edition: 'cn' })
  assert.deepEqual(cn, { mirrors: [`${CN}/dl/asr/`], upstream: false })
  assert.deepEqual(sources(m, { edition: 'intl' }), { mirrors: [`${INTL}/dl/asr/`], upstream: true })
  assert.deepEqual(sources(m), { mirrors: m.mirrors, upstream: true }, 'no edition: as before')
  assert.deepEqual(sources(m, { edition: 'cn', mirrors: ['https://mine.example/'] }), { mirrors: ['https://mine.example/'], upstream: false })
  assert.throws(() => sources(m, { edition: 'mars' }), /unknown edition/)
  const all = [...Object.values(m.models), ...Object.values(m.engines).flatMap((e) => Object.values(e.binaries))]
  for (const e of all) {
    const urls = urlsFor(e, cn.mirrors, cn)
    assert.deepEqual(urls, [`${CN}/dl/asr/${encodeURIComponent(e.file)}`], e.file)
  }
  const sv = m.models['sense-voice-int8']
  assert.deepEqual(urlsFor(sv, ...[sources(m, { edition: 'intl' })].flatMap((s) => [s.mirrors, s])), [`${INTL}/dl/asr/${sv.file}`, sv.url])
})

test('cn edition: the first start\'s downloads and the address lookup go only to api.pocketcli.cn', async (t) => {
  const dir = tmpDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const asked = []
  const fetchImpl = async (url) => { asked.push(String(url)); return new Response('no', { status: 404 }) }
  const installs = {
    installEngine: (e, d, o) => installEngine(e, d, { ...o, fetchImpl }),
    installModel: (id, target, o) => installModel(id, target, { ...o, fetchImpl }),
  }
  // the engine program is found where the image keeps it, so only the model is downloaded
  const fakeBin = path.join(dir, 'sherpa')
  fs.writeFileSync(fakeBin, '')
  await assert.rejects(defaultEngine(dir, { env: { ASR_SHERPA_BIN: fakeBin }, installs, edition: 'cn' }), /download failed \(api\.pocketcli\.cn: HTTP 404\)/)
  // and without it, the program first
  await assert.rejects(defaultEngine(dir, { env: {}, installs, edition: 'cn' }), /download failed/)
  assert.ok(asked.length >= 2)
  for (const u of asked) assert.equal(new URL(u).origin, CN, u)
  assert.ok(asked.some((u) => u.includes('sense-voice')) && asked.some((u) => u.includes('sherpa-onnx-v')), asked.join(' '))
  // a configured engine with "install": cn too
  asked.length = 0
  const cfg = loadConfig(baseConfig({ edition: 'cn', engines: [{ id: 'p', type: 'sherpa-onnx', bin: fakeBin, model: path.join(dir, 'm', 'para'), install: { model: 'paraformer-zh-small' } }] }))
  await assert.rejects(ensureConfiguredModels(cfg, { fetchImpl }), /download failed/)
  assert.deepEqual(asked, [`${CN}/dl/asr/sherpa-onnx-paraformer-zh-small-2024-03-09.tar.bz2`])
  // where it asks for its public address
  const whoamiAt = []
  await resolvePublic(loadConfig(baseConfig({ edition: 'cn', listen: { host: null, port: 8444 } })), { ifaces: {}, whoamiImpl: async (u) => { whoamiAt.push(u); return '203.0.113.7' } })
  assert.deepEqual(whoamiAt, [CN])
})

test('cn edition as a process: nothing but api.pocketcli.cn is contacted before it gives up on a download', async (t) => {
  const dir = tmpDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const log = path.join(dir, 'calls.log')
  const pre = path.join(dir, 'pre.mjs')
  // every outbound request of the process (fetch for downloads, https.get / http.get for the address lookup) is written
  // down here and answered locally
  fs.writeFileSync(pre, `import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { EventEmitter } from 'node:events'
const note = (u) => fs.appendFileSync(${JSON.stringify(log)}, String(u) + '\\n')
globalThis.fetch = async (url) => { note(url); return new Response('no', { status: 404 }) }
for (const [mod, proto] of [[http, 'http:'], [https, 'https:']]) {
  const fake = (u) => {
    note(typeof u === 'string' || u instanceof URL ? new URL(u).href : proto + '//' + (u.host || u.hostname) + (u.path || '/'))
    const req = new EventEmitter()
    req.destroy = () => {}; req.end = () => {}; req.setTimeout = () => req
    setImmediate(() => req.emit('error', Object.assign(new Error('refused here'), { code: 'ECONNREFUSED' })))
    return req
  }
  mod.get = fake; mod.request = fake
}
`)
  const env = { PATH: process.env.PATH, ASR_EDITION: 'cn', ASR_DATA_DIR: path.join(dir, 'data'), ASR_PORT: '0' }
  const child = spawn(process.execPath, ['--import', pre, MAIN], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => child.kill('SIGKILL'))
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { out += d })
  const code = await new Promise((resolve) => child.on('close', resolve))
  assert.equal(code, 78, out)
  assert.match(out, /download failed \(api\.pocketcli\.cn: HTTP 404\)/)
  const urls = fs.readFileSync(log, 'utf8').trim().split('\n')
  assert.ok(urls.some((u) => u.includes('/dl/asr/sherpa-onnx-v')), urls.join(' '))
  for (const u of urls) assert.equal(new URL(u).origin, CN, u)
})
