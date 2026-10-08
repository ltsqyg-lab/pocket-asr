// The gateway end to end over HTTP with a fake engine: routing, token and ticket auth, limits, audio rules,
// engine selection, timeouts, client aborts, revocations, key rotation, privacy of logs and error bodies.

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import {
  startGateway, baseConfig, fakeAdapter, toneWav, silentWav, post, TOKEN, coordKeys, newDevice, makeTicket, makeProof,
  signDoc, tmpDir,
} from './helpers.mjs'
import { AsrError } from '../src/errors.mjs'
import { hashToken } from '../src/auth.mjs'

const auth = { Authorization: `Bearer ${TOKEN}` }
const SECRET_TEXT = '机密的识别结果 secret transcript 4711'

test('info, healthz, 404, 405 and the base path', async () => {
  const fake = fakeAdapter()
  const g = await startGateway(baseConfig({ basePath: '/asr', default: { zh: 'fake' } }), { adapters: { fake } })
  try {
    for (const p of ['/v1/info', '/asr/v1/info']) {
      const r = await fetch(g.url + p)
      assert.equal(r.status, 200)
      const j = await r.json()
      assert.equal(j.service, 'pocket-asr')
      assert.equal(j.gatewayId, 'official')
      assert.deepEqual(j.auth, ['token'])
      assert.deepEqual(j.limits, { maxBytes: 8388608, maxSeconds: 240 })
      assert.deepEqual(j.engines, [{ id: 'fake', kind: 'cloud', langs: ['zh', 'en', 'auto'], maxSeconds: 240, default: true, defaultFor: ['zh', 'en', 'auto'] }])
    }
    assert.equal((await fetch(g.url + '/healthz')).status, 200)
    assert.equal((await fetch(g.url + '/nope')).status, 404)
    assert.equal((await fetch(g.url + '/v1/recognize')).status, 405)
    assert.equal((await fetch(g.url + '/v1/info', { method: 'POST', body: 'x' })).status, 405)
  } finally { await g.close() }
})

test('token auth: missing, wrong scheme, wrong token are 401; the right one works; only the hash is configured', async () => {
  const fake = fakeAdapter()
  const cfg = baseConfig()
  assert.ok(!JSON.stringify(cfg).includes(TOKEN), 'the config never holds the token itself')
  const g = await startGateway(cfg, { adapters: { fake } })
  try {
    const wav = toneWav(1)
    for (const h of [{}, { Authorization: 'Basic abc' }, { Authorization: 'Bearer wrong' }, { Authorization: `bearer ${TOKEN}` }, { Authorization: `PocketTicket x.y` }]) {
      const r = await post(g.url + '/v1/recognize?lang=zh', wav, h)
      assert.equal(r.status, 401, JSON.stringify(h))
      assert.equal(r.json.code, 'unauthorized')
    }
    assert.equal(fake.calls.length, 0, 'no engine call without auth')
    const ok = await post(g.url + '/v1/recognize?lang=zh', wav, auth)
    assert.equal(ok.status, 200)
    assert.equal(ok.json.ok, true)
    assert.equal(ok.json.text, '把 README 翻译成英文')
    assert.equal(ok.json.engine, 'fake')
    assert.equal(ok.json.seconds, 1)
    assert.equal(typeof ok.json.ms, 'number')
  } finally { await g.close() }
})

test('engine selection: defaults per language, the engine parameter, no-engine', async () => {
  const zh = fakeAdapter('zhonly', ['zh'])
  const en = fakeAdapter('enonly', ['en'])
  zh.next = async () => ({ text: '中文' }); en.next = async () => ({ text: 'english' })
  const cfg = baseConfig({ engines: [{ id: 'a', type: 'zhonly' }, { id: 'b', type: 'enonly' }], default: { zh: 'a', en: 'b' } })
  const g = await startGateway(cfg, { adapters: { zhonly: zh, enonly: en } })
  try {
    const wav = toneWav(1)
    assert.equal((await post(g.url + '/v1/recognize?lang=zh', wav, auth)).json.engine, 'a')
    assert.equal((await post(g.url + '/v1/recognize?lang=en', wav, auth)).json.engine, 'b')
    assert.equal((await post(g.url + '/v1/recognize?lang=en&engine=a', wav, auth)).json.code, 'no-engine', 'a named engine that does not do the language')
    assert.equal((await post(g.url + '/v1/recognize?lang=zh&engine=zz', wav, auth)).json.code, 'no-engine')
    assert.equal((await post(g.url + '/v1/recognize?lang=auto', wav, auth)).json.code, 'no-engine', 'nobody does auto')
    assert.equal((await post(g.url + '/v1/recognize?lang=fr', wav, auth)).json.code, 'bad-request')
    assert.equal((await post(g.url + '/v1/recognize?lang=zh&engine=Bad!', wav, auth)).json.code, 'no-engine')
    const r = await post(g.url + '/v1/recognize', wav, auth)
    assert.equal(r.json.code, 'no-engine', 'lang defaults to auto')
  } finally { await g.close() }
})

test('audio rules: bad-audio, too-large (header and body), too-long (gateway and engine), empty (silence, short, engine)', async () => {
  const fake = fakeAdapter('fake', ['zh', 'en', 'auto'], 60)
  const g = await startGateway(baseConfig({ limits: { maxBytes: 8 * 1024 * 1024, maxSeconds: 200 } }), { adapters: { fake } })
  try {
    const u = g.url + '/v1/recognize?lang=zh'
    assert.equal((await post(u, Buffer.from('definitely not audio, but long enough to be looked at.....'), auth)).json.code, 'bad-audio')
    const r413 = await post(u, Buffer.alloc(9 * 1024 * 1024), auth)
    assert.equal(r413.status, 413)
    assert.equal(r413.json.code, 'too-large')
    // chunked body with no Content-Length that grows past the limit
    const chunked = await new Promise((resolve, reject) => {
      const req = http.request(u, { method: 'POST', headers: { ...auth, 'Transfer-Encoding': 'chunked' } }, (res) => {
        let s = ''; res.on('data', (d) => { s += d }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(s) }))
      })
      req.on('error', reject)
      for (let i = 0; i < 9; i++) req.write(Buffer.alloc(1024 * 1024))
      req.end()
    })
    assert.equal(chunked.status, 413)
    assert.equal((await post(u, toneWav(201), auth)).json.code, 'too-long')
    const engineMax = await post(u, toneWav(61), auth)
    assert.equal(engineMax.json.code, 'too-long', 'longer than this engine takes: no silent truncation')
    assert.equal((await post(u, silentWav(2), auth)).json.code, 'empty')
    assert.equal((await post(u, toneWav(0.05), auth)).json.code, 'empty')
    fake.next = async () => ({ text: '  ' })
    const e = await post(u, toneWav(1), auth)
    assert.equal(e.status, 422)
    assert.equal(e.json.code, 'empty')
    assert.equal(fake.calls.length, 1, 'only the last request reached the engine')
  } finally { await g.close() }
})

test('limits: per-minute rate (429 + Retry-After), per-caller concurrency (rate), gateway concurrency (busy)', async () => {
  const fake = fakeAdapter()
  let release
  const gate = new Promise((r) => { release = r })
  const cfg = baseConfig({
    auth: { tokens: [{ label: 'one', sha256: hashToken('tok-one') }, { label: 'two', sha256: hashToken('tok-two') }] },
    limits: { perMinute: 3, concurrentPerCaller: 1, concurrent: 1 },
  })
  const g = await startGateway(cfg, { adapters: { fake } })
  try {
    const u = g.url + '/v1/recognize?lang=zh'
    const wav = toneWav(1)
    fake.next = async () => { await gate; return { text: 'slow' } }
    const first = post(u, wav, { Authorization: 'Bearer tok-one' })
    await new Promise((r) => setTimeout(r, 100))
    const second = await post(u, wav, { Authorization: 'Bearer tok-one' })
    assert.equal(second.status, 429)
    assert.equal(second.json.code, 'rate')
    const other = await post(u, wav, { Authorization: 'Bearer tok-two' })
    assert.equal(other.status, 503)
    assert.equal(other.json.code, 'busy')
    assert.ok(Number(other.headers.get('retry-after')) >= 1)
    release()
    assert.equal((await first).status, 200)
    fake.next = async () => ({ text: 'ok' })
    // tok-one has used 1 of 3 this minute (the one refused for concurrency doesn't count)
    assert.equal((await post(u, wav, { Authorization: 'Bearer tok-one' })).status, 200)
    assert.equal((await post(u, wav, { Authorization: 'Bearer tok-one' })).status, 200)
    const limited = await post(u, wav, { Authorization: 'Bearer tok-one' })
    assert.equal(limited.status, 429)
    assert.ok(Number(limited.headers.get('retry-after')) >= 1)
    assert.equal((await post(u, wav, { Authorization: 'Bearer tok-two' })).status, 200, 'limits are per caller')
  } finally { await g.close() }
})

test('engine errors map to codes; an engine that hangs is cut at the deadline (engine-timeout, signal aborted)', async () => {
  const fake = fakeAdapter()
  const g = await startGateway(baseConfig(), { adapters: { fake }, deadlineMs: 300 })
  try {
    const u = g.url + '/v1/recognize?lang=zh'
    fake.next = async () => { throw new AsrError('busy', 'provider:55000031') }
    assert.equal((await post(u, toneWav(1), auth)).json.code, 'busy')
    fake.next = async () => { throw new Error('kaboom with ' + SECRET_TEXT) }
    const internal = await post(u, toneWav(1), auth)
    assert.equal(internal.status, 502)
    assert.equal(internal.json.code, 'engine-error')
    let sawAbort = false
    fake.next = ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { sawAbort = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) })
    })
    const t0 = Date.now()
    const r = await post(u, toneWav(1), auth)
    assert.equal(r.status, 504)
    assert.equal(r.json.code, 'engine-timeout')
    assert.ok(sawAbort, 'the adapter saw its signal abort')
    assert.ok(Date.now() - t0 < 3000)
    assert.ok(!g.lines.join('\n').includes(SECRET_TEXT), 'exception messages never reach the log')
  } finally { await g.close() }
})

test('a client that goes away aborts the engine call and is logged as aborted', async () => {
  const fake = fakeAdapter()
  let aborted
  const sawAbort = new Promise((r) => { aborted = r })
  fake.next = ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted(true); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) })
  })
  const g = await startGateway(baseConfig(), { adapters: { fake } })
  try {
    const wav = toneWav(1)
    const req = http.request(g.url + '/v1/recognize?lang=zh', { method: 'POST', headers: { ...auth, 'Content-Length': wav.length } })
    req.on('error', () => {})
    req.end(wav)
    await new Promise((r) => setTimeout(r, 150))
    req.destroy()
    assert.equal(await Promise.race([sawAbort, new Promise((r) => setTimeout(() => r(false), 2000))]), true)
    await new Promise((r) => setTimeout(r, 50))
    assert.ok(g.lines.some((l) => / code=aborted/.test(l)))
  } finally { await g.close() }
})

test('privacy: logs and error bodies carry no text, audio, token, ticket or proof', async () => {
  const fake = fakeAdapter()
  fake.next = async () => ({ text: SECRET_TEXT })
  const coord = coordKeys()
  const dev = newDevice()
  const cfg = baseConfig({
    auth: { tokens: [{ label: 'phone', sha256: hashToken(TOKEN) }], ticket: { enabled: true, pinnedKeys: [coord.entry], accounts: ['*'] } },
  })
  const g = await startGateway(cfg, { adapters: { fake } })
  try {
    const wav = toneWav(1)
    const ok = await post(g.url + '/v1/recognize?lang=zh', wav, auth)
    assert.equal(ok.json.text, SECRET_TEXT)
    const ticket = makeTicket(coord, dev)
    const proof = makeProof(dev, wav)
    const okT = await post(g.url + '/v1/recognize?lang=zh', wav, { Authorization: `PocketTicket ${ticket}`, 'X-Pocket-Proof': proof.header })
    assert.equal(okT.status, 200)
    const replay = await post(g.url + '/v1/recognize?lang=zh', wav, { Authorization: `PocketTicket ${ticket}`, 'X-Pocket-Proof': proof.header })
    assert.equal(replay.status, 401)
    fake.next = async () => { throw new AsrError('engine-error', 'provider:500') }
    const err = await post(g.url + '/v1/recognize?lang=zh', wav, auth)
    const all = g.lines.join('\n') + ok.text.replace(SECRET_TEXT, '') + okT.text.replace(SECRET_TEXT, '') + replay.text + err.text
    for (const needle of [SECRET_TEXT, '机密', TOKEN, ticket.slice(0, 40), ticket.split('.')[1], proof.header.slice(0, 40), proof.nonce, wav.subarray(100, 140).toString('base64')]) {
      assert.ok(!all.includes(needle), `leaked: ${needle.slice(0, 20)}`)
    }
    assert.match(g.lines[0], /caller=token:phone engine=fake sec=1\.00 chars=\d+ ms=\d+ code=ok/)
    assert.match(g.lines[1], /caller=acct:u_lab0001 /)
    assert.match(g.lines[2], /code=unauthorized detail=replay/)
  } finally { await g.close() }
})

test('tickets: valid, wrong gateway, expired, unknown key, other account, body mismatch, stale proof, missing proof', async () => {
  const fake = fakeAdapter()
  const coord = coordKeys()
  const evil = coordKeys()
  const dev = newDevice({ acct: 'u_mine0001' })
  const cfg = baseConfig({ gatewayId: 'my-asr', auth: { ticket: { enabled: true, pinnedKeys: [coord.entry], accounts: ['u_mine0001'] } } })
  const g = await startGateway(cfg, { adapters: { fake } })
  try {
    const u = g.url + '/v1/recognize?lang=zh'
    const wav = toneWav(1)
    const send = (ticket, proofOpts = {}, body = wav) => post(u, body, { Authorization: `PocketTicket ${ticket}`, 'X-Pocket-Proof': makeProof(dev, wav, { aud: 'asr:my-asr', ...proofOpts }).header })
    const good = makeTicket(coord, dev, { aud: 'asr:my-asr' })
    assert.equal((await send(good)).status, 200)
    const detail = async (p) => { const r = await p; assert.equal(r.status, 401); return g.lines.at(-1).match(/detail=(\S+)/)[1] }
    assert.equal(await detail(send(makeTicket(coord, dev, { aud: 'asr:official' }))), 'wrong-aud')
    assert.equal(await detail(send(makeTicket(coord, dev, { aud: 'asr:my-asr', iat: Date.now() - 7 * 3600e3, exp: Date.now() - 3600e3 }))), 'expired')
    assert.equal(await detail(send(makeTicket(evil, dev, { aud: 'asr:my-asr', kid: 'evil-1' }))), 'unknown-key')
    assert.equal(await detail(send(makeTicket(evil, dev, { aud: 'asr:my-asr' }))), 'bad-sig', 'same kid, another key')
    assert.equal(await detail(send(makeTicket(coord, newDevice({ acct: 'u_else0001' }), { aud: 'asr:my-asr' }))), 'wrong-account')
    assert.equal(await detail(send(good, {}, toneWav(1.1))), 'body-mismatch')
    assert.equal(await detail(send(good, { ts: Date.now() - 6 * 60_000 })), 'stale')
    assert.equal(await detail(send(good, { aud: 'asr:official' })), 'bad-proof')
    const noProof = await post(u, wav, { Authorization: `PocketTicket ${good}` })
    assert.equal(noProof.status, 401)
    assert.equal(fake.calls.length, 1)
  } finally { await g.close() }
})

test('revocations: a signed document cuts off tickets issued before nbf; later tickets work; forged documents are refused', async () => {
  const fake = fakeAdapter()
  const coord = coordKeys()
  const evil = coordKeys()
  const dev = newDevice()
  const dir = tmpDir()
  const cfg = baseConfig({ dataDir: dir, auth: { ticket: { enabled: true, pinnedKeys: [coord.entry] } } })
  const g = await startGateway(cfg, { adapters: { fake } })
  try {
    const u = g.url + '/v1/recognize?lang=zh'
    const wav = toneWav(1)
    const send = (ticket) => post(u, wav, { Authorization: `PocketTicket ${ticket}`, 'X-Pocket-Proof': makeProof(dev, wav).header })
    const old = makeTicket(coord, dev, { iat: Date.now() - 60_000 })
    assert.equal((await send(old)).status, 200)
    const nbf = Date.now() - 1000
    const doc = signDoc('revocations', coord, { v: 1, t: 'revocations', kid: coord.entry.kid, at: Date.now(), acct: dev.acct, since: 0, next: 1, items: [{ addr: dev.addr, dev: dev.id, nbf, at: Date.now() }] })
    const forged = signDoc('revocations', evil, { v: 1, t: 'revocations', kid: coord.entry.kid, at: Date.now(), acct: dev.acct, since: 0, next: 1, items: [{ addr: '100.64.9.9', dev: dev.id, nbf, at: Date.now() }] })
    const bad = await fetch(g.url + '/v1/revocations', { method: 'POST', body: JSON.stringify(forged) })
    assert.equal(bad.status, 400)
    const r = await fetch(g.url + '/v1/revocations', { method: 'POST', body: JSON.stringify(doc) })
    assert.deepEqual(await r.json(), { ok: true, applied: 1 })
    assert.equal((await send(old)).status, 401)
    assert.equal((await send(makeTicket(coord, dev, { iat: Date.now() }))).status, 200, 'a ticket issued after the cut-off works')
    assert.ok(fs.existsSync(path.join(dir, 'revocations.json')), 'cut-offs are written to the data directory')
  } finally { await g.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('revocations persist across a restart when the data directory stays', async () => {
  const fake = fakeAdapter()
  const coord = coordKeys()
  const dev = newDevice()
  const dir = tmpDir()
  const cfg = baseConfig({ dataDir: dir, auth: { ticket: { enabled: true, pinnedKeys: [coord.entry] } } })
  const doc = signDoc('revocations', coord, { v: 1, t: 'revocations', kid: coord.entry.kid, at: Date.now(), acct: dev.acct, since: 0, next: 1, items: [{ addr: dev.addr, dev: dev.id, nbf: Date.now(), at: Date.now() }] })
  const g = await startGateway(cfg, { adapters: { fake } })
  await fetch(g.url + '/v1/revocations', { method: 'POST', body: JSON.stringify(doc) })
  await g.close()
  const g2 = await startGateway(cfg, { adapters: { fake } })
  try {
    const wav = toneWav(1)
    const r = await post(g2.url + '/v1/recognize?lang=zh', wav, { Authorization: `PocketTicket ${makeTicket(coord, dev, { iat: Date.now() - 5000 })}`, 'X-Pocket-Proof': makeProof(dev, wav).header })
    assert.equal(r.status, 401)
  } finally { await g2.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('key rotation: keys.json signed by a trusted key is adopted (on an unknown kid); an untrusted one is not', async () => {
  const fake = fakeAdapter()
  const c1 = coordKeys()
  const c2 = coordKeys(); c2.entry.kid = 'lab-c2'
  const rogue = coordKeys(); rogue.entry.kid = 'lab-c9'
  const dev = newDevice()
  let served = null
  const fakeFetch = async (url) => {
    assert.equal(url, 'https://coord.test/.well-known/pocket/keys.json')
    return new Response(JSON.stringify(served), { status: 200 })
  }
  const keysDoc = (signer, keys) => {
    const p = Buffer.from(JSON.stringify({ v: 1, t: 'keys', at: Date.now(), keys }))
    return { p: p.toString('base64url'), sigs: [{ kid: signer.entry.kid, s: signer.sign(Buffer.concat([Buffer.from('pocket/v1 keys'), Buffer.from([0]), u32be(p.length), p])).toString('base64url') }] }
  }
  const cfg = baseConfig({ auth: { ticket: { enabled: true, pinnedKeys: [c1.entry], coordUrl: 'https://coord.test' } } })
  const g = await startGateway(cfg, { adapters: { fake }, fetch: fakeFetch })
  try {
    const wav = toneWav(1)
    const send = (t) => post(g.url + '/v1/recognize?lang=zh', wav, { Authorization: `PocketTicket ${t}`, 'X-Pocket-Proof': makeProof(dev, wav).header })
    served = keysDoc(rogue, [rogue.entry])
    assert.equal((await send(makeTicket(rogue, dev))).status, 401)
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(await g.gw.auth.refreshKeys({ force: true, reason: 'test' }), false, 'signed by an unknown key: refused')
    served = keysDoc(c1, [c1.entry, c2.entry])
    assert.equal(await g.gw.auth.refreshKeys({ force: true, reason: 'test' }), true)
    assert.equal((await send(makeTicket(c2, dev))).status, 200, 'tickets from the new key work')
    assert.equal((await send(makeTicket(c1, dev))).status, 200, 'the old key still works while listed')
  } finally { await g.close() }
})
const u32be = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }

test('TLS listener (self-signed test certificate)', async (t) => {
  const dir = tmpDir()
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1',
      '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' })
  } catch { t.skip('openssl not available'); return }
  const fake = fakeAdapter()
  const g = await startGateway(baseConfig({ tls: { cert: path.join(dir, 'c.pem'), key: path.join(dir, 'k.pem') } }), { adapters: { fake } })
  try {
    const port = g.gw.server.address().port
    const body = await new Promise((resolve, reject) => {
      https.get({ host: '127.0.0.1', port, path: '/v1/info', ca: fs.readFileSync(path.join(dir, 'c.pem')) }, (res) => {
        let s = ''; res.on('data', (d) => { s += d }); res.on('end', () => resolve(JSON.parse(s)))
      }).on('error', reject)
    })
    assert.equal(body.service, 'pocket-asr')
  } finally { await g.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('startup refuses configs without auth, with a plain token, unknown engines or bad defaults', async () => {
  const { createGateway } = await import('../src/server.mjs')
  const adapters = { fake: fakeAdapter() }
  assert.throws(() => createGateway({ gatewayId: 'x', engines: [{ id: 'fake', type: 'fake' }] }, { adapters }), /authenticate/)
  assert.throws(() => createGateway(baseConfig({ auth: { tokens: [{ label: 'a', sha256: 'plain-token' }] } }), { adapters }), /sha256/)
  assert.throws(() => createGateway(baseConfig({ engines: [{ id: 'x', type: 'nope' }] }), { adapters }), /unknown type/)
  assert.throws(() => createGateway(baseConfig({ default: { zh: 'missing' } }), { adapters }), /unknown engine/)
  assert.throws(() => createGateway(baseConfig({ auth: { ticket: { enabled: true, pinnedKeys: [] } } }), { adapters }), /pinnedKeys/)
  const zhOnly = { zo: fakeAdapter('zo', ['zh']) }
  assert.throws(() => createGateway(baseConfig({ engines: [{ id: 'z', type: 'zo' }], default: { en: 'z' } }), { adapters: zhOnly }), /doesn't do en/)
  assert.ok(crypto)   // keep import used
})
