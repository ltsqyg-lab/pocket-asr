// Model / engine installation: size + SHA-256 checks, mirror fallback, stalled sources, refusing unverified files,
// unpacking archives, and the manifest's own shape.

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { downloadVerified, extractArchive, installModel, installEngine, loadManifest, urlsFor } from '../src/models.mjs'
import { startHttpFake } from './fakes/ws-server.mjs'
import { tmpDir } from './helpers.mjs'

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')

test('downloadVerified: mirror 404 → upstream; size and hash checked; nothing left behind on failure', async () => {
  const payload = crypto.randomBytes(200_000)
  const hits = []
  const f = await startHttpFake(async (req) => {
    hits.push(req.url)
    if (req.url.startsWith('/mirror/')) return { status: 404, body: 'nope' }
    if (req.url === '/bad') return { body: Buffer.concat([payload.subarray(0, 1000), Buffer.from('tampered')]) }
    return { body: payload, headers: { 'Content-Type': 'application/octet-stream' } }
  })
  const dir = tmpDir()
  try {
    const dest = path.join(dir, 'm.bin')
    const r = await downloadVerified({ urls: [f.url('/mirror/m.bin'), f.url('/up/m.bin')], sha256: sha(payload), size: payload.length, dest })
    assert.equal(r.url, f.url('/up/m.bin'))
    assert.ok(fs.readFileSync(dest).equals(payload))
    assert.deepEqual(hits, ['/mirror/m.bin', '/up/m.bin'])
    await assert.rejects(downloadVerified({ urls: [f.url('/up/m.bin')], sha256: sha(Buffer.from('x')), size: payload.length, dest: path.join(dir, 'x') }), /SHA-256 mismatch/)
    await assert.rejects(downloadVerified({ urls: [f.url('/up/m.bin')], sha256: sha(payload), size: payload.length - 1, dest: path.join(dir, 'y') }), /larger than pinned size/)
    await assert.rejects(downloadVerified({ urls: [f.url('/bad')], sha256: sha(payload), size: payload.length, dest: path.join(dir, 'z') }), /size/)
    await assert.rejects(downloadVerified({ urls: [f.url('/up/m.bin')], sha256: null, size: payload.length, dest: path.join(dir, 'u') }), /refusing an unverified download/)
    assert.ok((await downloadVerified({ urls: [f.url('/up/m.bin')], sha256: null, size: payload.length, dest: path.join(dir, 'u'), allowUnverified: true })).sha256)
    assert.deepEqual(fs.readdirSync(dir).sort(), ['m.bin', 'u'], 'no .part files and no failed files')
  } finally { await f.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('downloadVerified: a source that stalls is abandoned for the next one', async () => {
  const payload = Buffer.from('model bytes')
  const f = await startHttpFake(async (req, body, res) => {
    if (req.url === '/stall') { res.writeHead(200); res.write('mo'); return new Promise(() => {}) }
    return { body: payload }
  })
  const dir = tmpDir()
  try {
    const t0 = Date.now()
    const r = await downloadVerified({ urls: [f.url('/stall'), f.url('/ok')], sha256: sha(payload), size: payload.length, dest: path.join(dir, 'm'), stallMs: 300 })
    assert.equal(r.url, f.url('/ok'))
    assert.ok(Date.now() - t0 < 5000)
    await assert.rejects(downloadVerified({ urls: [f.url('/stall')], sha256: sha(payload), size: payload.length, dest: path.join(dir, 'n'), stallMs: 200 }), /no data for/)
  } finally { await f.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('installModel / installEngine: archives unpacked into place, single files moved; existing targets left alone', async (t) => {
  const src = tmpDir()
  try {
    fs.mkdirSync(path.join(src, 'pkg', 'sherpa-onnx-test', 'bin'), { recursive: true })
    fs.writeFileSync(path.join(src, 'pkg', 'sherpa-onnx-test', 'bin', 'sherpa-onnx-offline'), '#!/bin/sh\necho hi\n')
    fs.mkdirSync(path.join(src, 'mdl', 'sherpa-onnx-sense-voice-test'), { recursive: true })
    fs.writeFileSync(path.join(src, 'mdl', 'sherpa-onnx-sense-voice-test', 'tokens.txt'), '<|zh|> 1\n')
    fs.writeFileSync(path.join(src, 'mdl', 'sherpa-onnx-sense-voice-test', 'model.int8.onnx'), 'x')
    execFileSync('tar', ['-cjf', path.join(src, 'engine.tar.bz2'), '-C', path.join(src, 'pkg'), 'sherpa-onnx-test'])
    execFileSync('tar', ['-cjf', path.join(src, 'model.tar.bz2'), '-C', path.join(src, 'mdl'), 'sherpa-onnx-sense-voice-test'])
  } catch { t.skip('tar with bzip2 not available'); return }
  fs.writeFileSync(path.join(src, 'ggml.bin'), 'ggml-model')
  const files = Object.fromEntries(['engine.tar.bz2', 'model.tar.bz2', 'ggml.bin'].map((n) => [n, fs.readFileSync(path.join(src, n))]))
  const f = await startHttpFake(async (req) => {
    const n = req.url.slice(1)
    return files[n] ? { body: files[n] } : { status: 404, body: '' }
  })
  const entry = (n, extra) => ({ file: n, url: f.url('/' + n), size: files[n].length, sha256: sha(files[n]), ...extra })
  const manifest = {
    mirrors: [],
    engines: { 'sherpa-onnx': { binaries: { 'test-plat': entry('engine.tar.bz2', { bin: 'bin/sherpa-onnx-offline' }) } } },
    models: { sv: entry('model.tar.bz2', { archive: true }), gg: entry('ggml.bin', { archive: false }) },
  }
  const dest = tmpDir()
  try {
    const bin = await installEngine('sherpa-onnx', path.join(dest, 'sherpa'), { manifest, platform: 'test-plat' })
    assert.equal(bin, path.join(dest, 'sherpa', 'bin', 'sherpa-onnx-offline'))
    assert.equal(fs.statSync(bin).mode & 0o111, 0o111, 'executable')
    const m = await installModel('sv', path.join(dest, 'models', 'sense-voice'), { manifest })
    assert.deepEqual(fs.readdirSync(m).sort(), ['model.int8.onnx', 'tokens.txt'])
    const g = await installModel('gg', path.join(dest, 'models', 'ggml-base.bin'), { manifest })
    assert.equal(fs.readFileSync(g, 'utf8'), 'ggml-model')
    fs.writeFileSync(path.join(dest, 'models', 'sense-voice', 'mine'), 'kept')
    await installModel('sv', path.join(dest, 'models', 'sense-voice'), { manifest })
    assert.ok(fs.existsSync(path.join(dest, 'models', 'sense-voice', 'mine')), 'an existing model is not replaced')
    assert.deepEqual(fs.readdirSync(path.join(dest, 'models')).filter((n) => n.startsWith('.install-')), [], 'work directories removed')
    await assert.rejects(installEngine('sherpa-onnx', path.join(dest, 'x'), { manifest, platform: 'other' }), /no prebuilt/)
    await assert.rejects(installModel('nope', path.join(dest, 'y'), { manifest }), /unknown model/)
  } finally { await f.close(); fs.rmSync(dest, { recursive: true, force: true }); fs.rmSync(src, { recursive: true, force: true }) }
  assert.ok(extractArchive)
})

test('models.json: every entry has a file, URL, size and a pinned SHA-256 with its source; mirror URLs are derived', () => {
  const m = loadManifest()
  const all = [...Object.values(m.models), ...Object.values(m.engines).flatMap((e) => Object.values(e.binaries))]
  assert.ok(all.length >= 12)
  for (const e of all) {
    assert.match(e.url, /^https:\/\//)
    assert.ok(Number.isInteger(e.size) && e.size > 0, e.file)
    assert.match(e.sha256, /^[0-9a-f]{64}$/, e.file)
    assert.ok(['github-release-digest', 'huggingface-lfs', 'computed'].includes(e.sha256Source), e.file)
  }
  for (const [id, x] of Object.entries(m.models)) assert.ok(m.engines[x.engine], `${id} names a known engine`)
  assert.deepEqual(urlsFor(m.models['sense-voice-int8'], m.mirrors), [
    'https://pocket.pocketcli.net/dl/asr/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2', m.models['sense-voice-int8'].url])
  assert.equal(Object.values(m.models).filter((x) => x.recommended).length, 1)
  // the recommended SenseVoice is the 2024-07-17 release: 2025-09-09 is a Cantonese fine-tune (Mandarin and English come
  // out tagged <|yue|>, without punctuation, English in capitals) — the same file the desktop agent pins (ASR_PINNED)
  const svm = m.models['sense-voice-int8']
  assert.deepEqual([svm.file, svm.size, svm.sha256], ['sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2', 163002883, '7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e'])
  assert.ok(!Object.values(m.models).some((x) => /2025-09-09/.test(x.file + x.url)), 'the Cantonese fine-tune is not offered')
})
