// Configuration loading: env: / file: secrets, secretsFile, validation of auth, engines, defaults and limits;
// plus the limiter on its own.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig, resolveSecrets, DEFAULT_LIMITS } from '../src/config.mjs'
import { Limiter } from '../src/limits.mjs'
import { hashToken } from '../src/auth.mjs'
import { buildEngines, pickEngine } from '../src/engines/index.mjs'
import { baseConfig, tmpDir, coordKeys, fakeAdapter } from './helpers.mjs'

test('env: and file: values are resolved at startup; missing ones stop the start', () => {
  const dir = tmpDir()
  try {
    fs.writeFileSync(path.join(dir, 'k'), '  secret-from-file\n')
    const r = resolveSecrets({ a: 'env:ASR_T1', b: ['x', `file:${path.join(dir, 'k')}`], c: { d: 'plain' } }, { ASR_T1: 'from-env' })
    assert.deepEqual(r, { a: 'from-env', b: ['x', 'secret-from-file'], c: { d: 'plain' } })
    assert.throws(() => resolveSecrets({ a: 'env:NOPE_NOT_SET' }, {}), /NOPE_NOT_SET is not set/)
    assert.throws(() => resolveSecrets({ a: `file:${path.join(dir, 'missing')}` }, {}), /cannot read/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('secretsFile merges a JSON credentials file into the engine (explicit settings win)', () => {
  const dir = tmpDir()
  try {
    const f = path.join(dir, 'volc.json')
    fs.writeFileSync(f, JSON.stringify({ appId: 'from-file', accessToken: 'tok', resourceId: 'r1' }))
    const c = loadConfig(baseConfig({ engines: [{ id: 'v', type: 'volcano', secretsFile: f, resourceId: 'r2' }] }))
    assert.deepEqual(c.engines[0], { appId: 'from-file', accessToken: 'tok', resourceId: 'r2', id: 'v', type: 'volcano' })
    assert.throws(() => loadConfig(baseConfig({ engines: [{ id: 'v', type: 'volcano', secretsFile: path.join(dir, 'nope') }] })), /secretsFile/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('validation: gateway id, auth, token entries, ticket keys, defaults, limits, listen', () => {
  const ok = loadConfig(baseConfig())
  assert.deepEqual(ok.limits, DEFAULT_LIMITS)
  assert.equal(ok.listen.host, '127.0.0.1')
  assert.throws(() => loadConfig(baseConfig({ gatewayId: 'Bad Id' })), /gatewayId/)
  assert.throws(() => loadConfig(baseConfig({ auth: {} })), /authenticate/)
  assert.throws(() => loadConfig(baseConfig({ auth: { tokens: [{ label: '', sha256: hashToken('x') }] } })), /label/)
  assert.throws(() => loadConfig(baseConfig({ auth: { tokens: [{ label: 'a', sha256: hashToken('x') }, { label: 'a', sha256: hashToken('y') }] } })), /duplicate/)
  assert.throws(() => loadConfig(baseConfig({ auth: { ticket: { enabled: true, pinnedKeys: [{ kid: 'c1', pub: 'AAAA', use: ['ticket'], nbf: 0, exp: 1 }] } } })), /malformed/)
  const k = coordKeys()
  assert.throws(() => loadConfig(baseConfig({ auth: { ticket: { enabled: true, pinnedKeys: [{ ...k.entry, use: ['netmap'] }] } } })), /sign tickets/)
  assert.ok(loadConfig(baseConfig({ auth: { ticket: { enabled: true, pinnedKeys: [k.entry], accounts: ['u_1'] } } })))
  assert.throws(() => loadConfig(baseConfig({ auth: { ticket: { enabled: true, pinnedKeys: [k.entry], accounts: [''] } } })), /accounts/)
  assert.throws(() => loadConfig(baseConfig({ default: { fr: 'fake' } })), /language/)
  assert.throws(() => loadConfig(baseConfig({ limits: { maxBytes: 10 } })), /maxBytes/)
  assert.throws(() => loadConfig(baseConfig({ limits: { perMinute: -1 } })), /non-negative/)
  assert.throws(() => loadConfig(baseConfig({ listen: { port: 70000 } })), /port/)
  assert.throws(() => loadConfig(baseConfig({ tls: { cert: 'a' } })), /tls/)
  assert.throws(() => loadConfig(baseConfig({ basePath: 'asr' })), /basePath/)
})

test('engine registry: ids, unknown types, maxSeconds capped by adapter and gateway, language picking', () => {
  const adapters = { a: fakeAdapter('a', ['zh'], 60), b: fakeAdapter('b', ['zh', 'en'], 600) }
  const e = buildEngines([{ id: 'x', type: 'a' }, { id: 'y', type: 'b', maxSeconds: 100 }], { adapters, gatewayMaxSeconds: 240 })
  assert.equal(e.get('x').maxSeconds, 60)
  assert.equal(e.get('y').maxSeconds, 100)
  assert.equal(pickEngine(e, {}, 'zh').id, 'x')
  assert.equal(pickEngine(e, { zh: 'y' }, 'zh').id, 'y')
  assert.equal(pickEngine(e, {}, 'en').id, 'y')
  assert.equal(pickEngine(e, {}, 'auto'), null)
  assert.equal(pickEngine(e, {}, 'zh', 'x').id, 'x')
  assert.equal(pickEngine(e, {}, 'en', 'x'), null)
  assert.throws(() => buildEngines([{ id: 'x', type: 'a' }, { id: 'x', type: 'b' }], { adapters }), /duplicate/)
  assert.throws(() => buildEngines([{ id: 'X!', type: 'a' }], { adapters }), /must match/)
  assert.throws(() => buildEngines([], { adapters }), /at least one/)
  assert.throws(() => buildEngines([{ id: 'x', type: 'a', maxSeconds: -1 }], { adapters }), /maxSeconds/)
})

test('limiter: sliding minute with Retry-After; concurrency slots are released exactly once', () => {
  let t = 1_000_000
  const l = new Limiter({ perMinute: 2, concurrentPerCaller: 1, concurrent: 2 }, () => t)
  assert.ok(l.takeRate('a').ok); t += 10_000
  assert.ok(l.takeRate('a').ok)
  const r = l.takeRate('a')
  assert.equal(r.ok, false); assert.equal(r.retryAfter, 50)
  assert.ok(l.takeRate('b').ok, 'per caller')
  t += 50_001
  assert.ok(l.takeRate('a').ok, 'the oldest left the window')
  const rel = l.enterCaller('a')
  assert.equal(l.enterCaller('a'), null)
  rel(); rel()
  assert.ok(l.enterCaller('a'), 'released once, not twice')
  const e1 = l.enterEngine(), e2 = l.enterEngine()
  assert.equal(l.enterEngine(), null)
  e1(); e1()
  assert.ok(l.enterEngine())
  assert.equal(l.active, 2)
  e2()
  t += 120_000
  l.sweep()
  assert.equal(l.windows.size, 0)
})
