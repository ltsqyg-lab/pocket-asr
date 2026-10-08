// Each cloud adapter against a local fake of its provider's protocol: request shape, auth header or signature
// (recomputed independently in the fake), error mapping, abort. No real provider is ever contacted.

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { startWsServer, startHttpFake } from './fakes/ws-server.mjs'
import { tonePcm } from './helpers.mjs'
import { pcmToWav } from '../src/wav.mjs'
import volcano, { mapVolcanoCode } from '../src/engines/volcano.mjs'
import alibaba, { popSignature, percentEncode, _tokens as aliTokens } from '../src/engines/alibaba.mjs'
import tencent, { tc3Authorization, mapTencentError } from '../src/engines/tencent.mjs'
import iflytek, { signedUrl } from '../src/engines/iflytek.mjs'
import openai from '../src/engines/openai.mjs'
import deepgram from '../src/engines/deepgram.mjs'
import azure from '../src/engines/azure.mjs'
import { ADAPTERS } from '../src/engines/index.mjs'

const pcm = tonePcm(1.2)
const wav = pcmToWav(pcm)
const args = (config, over = {}) => ({ pcm, wav, sampleRate: 16000, seconds: 1.2, lang: 'zh', signal: new AbortController().signal, config, uid: 'asr-uid', note: () => {}, ...over })
const codeOf = async (p) => { try { await p; return 'resolved' } catch (e) { return e.code || e.name } }
const hangs = () => new Promise(() => {})

test('every adapter follows the interface (type, kind, langs, validate, recognize) and rejects an empty config', () => {
  for (const [type, a] of Object.entries(ADAPTERS)) {
    assert.equal(a.type, type)
    assert.ok(['cloud', 'local'].includes(a.kind))
    assert.ok(Array.isArray(a.langs) && a.langs.length)
    assert.equal(typeof a.recognize, 'function')
    assert.throws(() => a.validate({}), Error, type)
  }
  assert.equal(Object.keys(ADAPTERS).length, 10)
})

// ---- Volcano ----------------------------------------------------------------------------------------------------
function volcFrame(type, flags, { seq, code, json }) {
  const body = json === undefined ? Buffer.alloc(0) : gzipSync(Buffer.from(JSON.stringify(json)))
  const parts = [Buffer.from([0x11, (type << 4) | flags, 0x11, 0])]
  if (flags & 1) { const b = Buffer.alloc(4); b.writeInt32BE(seq); parts.push(b) }
  if (code !== undefined) { const b = Buffer.alloc(4); b.writeInt32BE(code); parts.push(b) }
  const sz = Buffer.alloc(4); sz.writeUInt32BE(body.length); parts.push(sz, body)
  return Buffer.concat(parts)
}

async function volcFake({ errorCode, rejectStatus, silent } = {}) {
  const seen = { headers: null, request: null, audio: [], seqs: [], masked: true }
  const srv = await startWsServer((conn) => {
    seen.headers = conn.req.headers
    conn.onMessage = (data) => {
      const type = data[1] >> 4, flags = data[1] & 0x0f
      const seq = data.readInt32BE(4), size = data.readUInt32BE(8)
      const payload = gunzipSync(data.subarray(12, 12 + size))
      if (silent) return
      if (type === 0b0001) {
        seen.request = JSON.parse(payload.toString('utf8'))
        seen.seqs.push(seq)
        if (errorCode) return conn.send(volcFrame(0b1111, 0, { code: errorCode, json: { error: 'audio problem' } }))
        conn.send(volcFrame(0b1001, 0b0001, { seq: 1, json: { result: { text: '' } } }))
      } else if (type === 0b0010) {
        seen.audio.push(payload); seen.seqs.push(seq)
        if (flags === 0b0011) conn.send(volcFrame(0b1001, 0b0011, { seq: -seq, json: { result: { text: '打开 README' }, audio_info: { duration: 1200 } } }))
      }
      seen.masked = seen.masked && conn.masks.every(Boolean)
    }
  }, { reject: rejectStatus ? () => ({ status: rejectStatus, headers: { 'X-Tt-Logid': 'log123' } }) : null, extraHeaders: ['X-Tt-Logid: log-abc'] })
  return { srv, seen }
}

test('volcano: headers, gzip JSON request, 200 ms packets with a negative last sequence, masked frames, text', async () => {
  const { srv, seen } = await volcFake()
  try {
    const notes = []
    const cfg = { id: 'v', type: 'volcano', appId: 'app1', accessToken: 'acc1', url: srv.url('/api/v3/sauc/bigmodel_nostream'), hotWords: ['Claude Code', 'Codex'] }
    volcano.validate(cfg)
    const r = await volcano.recognize(args(cfg, { note: (s) => notes.push(s) }))
    assert.equal(r.text, '打开 README')
    assert.equal(seen.headers['x-api-app-key'], 'app1')
    assert.equal(seen.headers['x-api-access-key'], 'acc1')
    assert.equal(seen.headers['x-api-resource-id'], 'volc.seedasr.sauc.duration')
    assert.match(seen.headers['x-api-request-id'], /^[0-9a-f-]{36}$/)
    assert.deepEqual(seen.request.audio, { format: 'wav', codec: 'raw', rate: 16000, bits: 16, channel: 1 })
    assert.equal(seen.request.user.uid, 'asr-uid')
    assert.equal(seen.request.request.model_name, 'bigmodel')
    assert.deepEqual(JSON.parse(seen.request.request.corpus.context).hotwords, [{ word: 'Claude Code' }, { word: 'Codex' }])
    assert.ok(Buffer.concat(seen.audio).equals(wav), 'the whole WAV arrived, in order')
    assert.ok(seen.audio.slice(0, -1).every((p) => p.length === 6400), '200 ms packets')
    assert.deepEqual(seen.seqs.slice(0, 3), [1, 2, 3])
    assert.ok(seen.seqs.at(-1) < 0, 'last packet has a negative sequence')
    assert.ok(seen.masked, 'client frames are masked')
    assert.deepEqual(notes, ['logid:log-abc'])
  } finally { await srv.close() }
})

test('volcano: provider codes map to gateway codes; handshake refusal; abort', async () => {
  assert.equal(mapVolcanoCode(45000002), 'empty')
  assert.equal(mapVolcanoCode(45000081), 'bad-audio')
  assert.equal(mapVolcanoCode(55000031), 'busy')
  assert.equal(mapVolcanoCode(55000001), 'engine-error')
  for (const [code, want] of [[45000002, 'empty'], [55000031, 'busy']]) {
    const { srv } = await volcFake({ errorCode: code })
    try { assert.equal(await codeOf(volcano.recognize(args({ appId: 'a', accessToken: 'b', url: srv.url('/x') }))), want) } finally { await srv.close() }
  }
  const { srv: refused } = await volcFake({ rejectStatus: 403 })
  try { assert.equal(await codeOf(volcano.recognize(args({ appId: 'a', accessToken: 'b', url: refused.url('/x') }))), 'engine-error') } finally { await refused.close() }
  const { srv: silent } = await volcFake({ silent: true })
  try {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 100)
    assert.equal(await codeOf(volcano.recognize(args({ appId: 'a', accessToken: 'b', url: silent.url('/x') }, { signal: ac.signal }))), 'AbortError')
  } finally { await silent.close() }
})

// ---- Alibaba ----------------------------------------------------------------------------------------------------
test('alibaba: POP signature matches the official CreateToken example', () => {
  const p = { AccessKeyId: 'my_access_key_id', Action: 'CreateToken', Format: 'JSON', RegionId: 'cn-shanghai', SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: 'b924c8c3-6d03-4c5d-ad36-d984d3116788', SignatureVersion: '1.0', Timestamp: '2019-04-18T08:32:31Z', Version: '2019-02-28' }
  const r = popSignature(p, 'my_access_key_secret')
  assert.equal(r.stringToSign, 'GET&%2F&AccessKeyId%3Dmy_access_key_id%26Action%3DCreateToken%26Format%3DJSON%26RegionId%3Dcn-shanghai%26SignatureMethod%3DHMAC-SHA1%26SignatureNonce%3Db924c8c3-6d03-4c5d-ad36-d984d3116788%26SignatureVersion%3D1.0%26Timestamp%3D2019-04-18T08%253A32%253A31Z%26Version%3D2019-02-28')
  assert.equal(r.signature, 'hHq4yNsPitlfDJ2L0nQPdugdEzM=')
  assert.equal(percentEncode("a b*c~d!'()"), 'a%20b%2Ac~d%21%27%28%29')
})

async function aliFake(state) {
  return startHttpFake(async (req, body) => {
    const u = new URL(req.url, 'http://x')
    if (req.method === 'GET') {
      const q = Object.fromEntries(u.searchParams)
      const { Signature, ...rest } = q
      const want = crypto.createHmac('sha1', 'secret1&').update(popSignature(rest, 'secret1').stringToSign).digest('base64')
      state.tokenCalls++
      if (Signature !== want || q.Action !== 'CreateToken' || q.Version !== '2019-02-28' || q.AccessKeyId !== 'id1') return { status: 400, json: { Code: 'SignatureDoesNotMatch' } }
      state.token = `tok-${state.tokenCalls}`
      return { json: { Token: { Id: state.token, ExpireTime: Math.floor(Date.now() / 1000) + 3600 } } }
    }
    state.asr.push({ token: req.headers['x-nls-token'], q: Object.fromEntries(u.searchParams), ct: req.headers['content-type'], body })
    if (state.hang) return hangs()
    if (state.status) return { status: 400, json: { task_id: 't', result: '', status: state.status, message: 'x' } }
    if (req.headers['x-nls-token'] !== state.token) return { status: 403, json: { task_id: 't', result: '', status: 40000001, message: 'token invalid' } }
    return { json: { task_id: 't', result: '北京的天气。', status: 20000000, message: 'SUCCESS' } }
  })
}

test('alibaba: token via signed CreateToken (cached), raw PCM to the gateway with the right query, token refresh on 40000001', async () => {
  const state = { tokenCalls: 0, asr: [] }
  const f = await aliFake(state)
  aliTokens.clear()
  try {
    const cfg = { accessKeyId: 'id1', accessKeySecret: 'secret1', appkey: 'ak1', tokenEndpoint: f.url('/'), endpoint: f.url('/stream/v1/asr') }
    alibaba.validate(cfg)
    assert.deepEqual(alibaba.langsOf(cfg), ['zh'])
    assert.deepEqual(alibaba.langsOf({ ...cfg, appkey: undefined, appkeys: { zh: 'a', en: 'b' } }), ['zh', 'en'])
    assert.equal((await alibaba.recognize(args(cfg))).text, '北京的天气。')
    assert.equal((await alibaba.recognize(args(cfg))).text, '北京的天气。')
    assert.equal(state.tokenCalls, 1, 'the token is cached')
    const a = state.asr[0]
    assert.deepEqual(a.q, { appkey: 'ak1', format: 'pcm', sample_rate: '16000', enable_punctuation_prediction: 'true', enable_inverse_text_normalization: 'true' })
    assert.equal(a.ct, 'application/octet-stream')
    assert.ok(a.body.equals(pcm), 'raw PCM, no WAV header')
    state.token = 'rotated-on-the-server'
    assert.equal((await alibaba.recognize(args(cfg))).text, '北京的天气。', 'a rejected cached token is replaced once')
    assert.equal(state.tokenCalls, 2)
    state.status = 41010101
    assert.equal(await codeOf(alibaba.recognize(args(cfg))), 'bad-audio')
    state.status = 40000005
    assert.equal(await codeOf(alibaba.recognize(args(cfg))), 'busy')
    state.status = 0; state.hang = true
    const ac = new AbortController(); setTimeout(() => ac.abort(), 100)
    assert.equal(await codeOf(alibaba.recognize(args(cfg, { signal: ac.signal }))), 'AbortError')
    aliTokens.clear()
    assert.equal(await codeOf(alibaba.recognize(args({ ...cfg, accessKeySecret: 'wrong' }))), 'engine-error', 'bad credentials')
    assert.equal(await codeOf(alibaba.recognize(args(cfg, { lang: 'en' }))), 'no-engine')
  } finally { await f.close() }
})

// ---- Tencent ----------------------------------------------------------------------------------------------------
test('tencent: TC3 signature matches the official example', () => {
  const payload = '{"Limit": 1, "Filters": [{"Values": ["\\u672a\\u547d\\u540d"], "Name": "instance-name"}]}'
  const r = tc3Authorization({ secretId: 'AKIDz8krbsJ5yKBZQpn74WFkmLPx3EXAMPLE', secretKey: 'Gu5t9xGARNpq86cd98joQYCN3EXAMPLE', service: 'cvm', host: 'cvm.tencentcloudapi.com', timestamp: 1551113065, payload })
  assert.equal(r.canonicalRequest, 'POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:cvm.tencentcloudapi.com\n\ncontent-type;host\n35e9c5b0e3ae67532d3c9f17ead6c90222632e5b1ff7f6e89887f1398934f064')
  assert.equal(r.signature, '72e494ea809ad7a8c8f7a4507b9bddcbaa8e581f516e8da2f66e2c5a96525168')
  assert.equal(r.authorization, 'TC3-HMAC-SHA256 Credential=AKIDz8krbsJ5yKBZQpn74WFkmLPx3EXAMPLE/2019-02-25/cvm/tc3_request, SignedHeaders=content-type;host, Signature=72e494ea809ad7a8c8f7a4507b9bddcbaa8e581f516e8da2f66e2c5a96525168')
})

test('tencent: SentenceRecognition request (signed, base64 WAV, engine per language) and error mapping', async () => {
  const seen = []
  let reply = null
  const f = await startHttpFake(async (req, body) => {
    const ts = Number(req.headers['x-tc-timestamp'])
    const want = tc3Authorization({ secretId: 'sid', secretKey: 'skey', service: 'asr', host: req.headers.host, timestamp: ts, payload: body.toString('utf8') }).authorization
    const j = JSON.parse(body.toString('utf8'))
    seen.push({ ok: req.headers.authorization === want, action: req.headers['x-tc-action'], version: req.headers['x-tc-version'], region: req.headers['x-tc-region'], j })
    if (reply === 'hang') return hangs()
    if (reply) return { json: { Response: { Error: { Code: reply, Message: 'm' }, RequestId: 'r' } } }
    return { json: { Response: { Result: '腾讯云识别。', AudioDuration: 1200, WordSize: 0, RequestId: 'r1' } } }
  })
  try {
    const cfg = { secretId: 'sid', secretKey: 'skey', endpoint: f.url('/'), region: 'ap-shanghai' }
    tencent.validate(cfg)
    assert.equal((await tencent.recognize(args(cfg))).text, '腾讯云识别。')
    await tencent.recognize(args(cfg, { lang: 'en' }))
    const [a, b] = seen
    assert.ok(a.ok, 'TC3 signature verified by the fake')
    assert.equal(a.action, 'SentenceRecognition'); assert.equal(a.version, '2019-06-14'); assert.equal(a.region, 'ap-shanghai')
    assert.equal(a.j.EngSerViceType, '16k_zh'); assert.equal(b.j.EngSerViceType, '16k_en')
    assert.equal(a.j.SourceType, 1); assert.equal(a.j.VoiceFormat, 'wav'); assert.equal(a.j.DataLen, wav.length)
    assert.ok(Buffer.from(a.j.Data, 'base64').equals(wav))
    for (const [code, want] of [['InvalidParameterValue.ErrorVoicedataTooLong', 'too-long'], ['RequestLimitExceeded', 'busy'],
      ['InvalidParameterValue.ErrorInvalidVoiceFormat', 'bad-audio'], ['AuthFailure.SignatureFailure', 'engine-error'], ['FailedOperation.UserHasNoAmount', 'engine-error']]) {
      assert.equal(mapTencentError(code), want)
      reply = code
      assert.equal(await codeOf(tencent.recognize(args(cfg))), want)
    }
    reply = 'hang'
    const ac = new AbortController(); setTimeout(() => ac.abort(), 100)
    assert.equal(await codeOf(tencent.recognize(args(cfg, { signal: ac.signal }))), 'AbortError')
  } finally { await f.close() }
})

// ---- iFlytek ----------------------------------------------------------------------------------------------------
test('iflytek: signed URL, frames 0/1/2 with base64 PCM, results joined in order; provider codes; abort', async () => {
  const seen = { frames: [], authOk: null, query: null }
  let mode = 'ok'
  const srv = await startWsServer((conn) => {
    const u = new URL(conn.req.url, 'http://x')
    const q = Object.fromEntries(u.searchParams)
    seen.query = q
    const origin = Buffer.from(q.authorization, 'base64').toString('utf8')
    const sig = /signature="([^"]+)"/.exec(origin)?.[1]
    const want = crypto.createHmac('sha256', 'apisecret').update(`host: ${q.host}\ndate: ${q.date}\nGET ${u.pathname} HTTP/1.1`).digest('base64')
    seen.authOk = sig === want && /api_key="apikey"/.test(origin) && /algorithm="hmac-sha256"/.test(origin) && /headers="host date request-line"/.test(origin)
    conn.onMessage = (data) => {
      const m = JSON.parse(data.toString('utf8'))
      seen.frames.push(m)
      if (mode === 'hang') return
      if (m.data.status === 0 && mode !== 'ok') return conn.send(JSON.stringify({ code: Number(mode), message: 'err', sid: 'iat-err' }))
      if (m.data.status === 2) {
        conn.send(JSON.stringify({ code: 0, message: 'success', sid: 'iat-1', data: { status: 1, result: { sn: 1, ls: false, ws: [{ cw: [{ w: '讯飞', sc: 0 }] }, { cw: [{ w: '听写', sc: 0 }] }] } } }))
        conn.send(JSON.stringify({ code: 0, message: 'success', sid: 'iat-1', data: { status: 2, result: { sn: 2, ls: true, ws: [{ cw: [{ w: '。', sc: 0 }] }] } } }))
      }
    }
  })
  try {
    const cfg = { appId: 'app9', apiKey: 'apikey', apiSecret: 'apisecret', url: srv.url('/v2/iat'), frameIntervalMs: 0 }
    iflytek.validate(cfg)
    const notes = []
    const r = await iflytek.recognize(args(cfg, { note: (s) => notes.push(s) }))
    assert.equal(r.text, '讯飞听写。')
    assert.ok(seen.authOk, 'URL signature verified by the fake')
    assert.ok(Math.abs(Date.parse(seen.query.date) - Date.now()) < 60_000)
    const [first, ...rest] = seen.frames
    assert.equal(first.common.app_id, 'app9')
    assert.deepEqual(first.business, { language: 'zh_cn', domain: 'iat', vad_eos: 10000, ptt: 1, accent: 'mandarin' })
    assert.equal(first.data.status, 0)
    assert.equal(first.data.format, 'audio/L16;rate=16000')
    assert.ok(rest.slice(0, -1).every((m) => m.data.status === 1 && !m.common))
    assert.equal(rest.at(-1).data.status, 2)
    const audio = Buffer.concat(seen.frames.map((m) => Buffer.from(m.data.audio || '', 'base64')))
    assert.ok(audio.equals(pcm), 'raw PCM in 1280-byte frames')
    assert.equal(Buffer.from(first.data.audio, 'base64').length, 1280)
    assert.ok(notes.includes('sid:iat-1'))
    seen.frames = []
    await iflytek.recognize(args(cfg, { lang: 'en' }))
    assert.equal(seen.frames[0].business.language, 'en_us')
    assert.equal(seen.frames[0].business.accent, undefined)
    mode = '11201'
    assert.equal(await codeOf(iflytek.recognize(args(cfg))), 'busy')
    mode = '10165'
    assert.equal(await codeOf(iflytek.recognize(args(cfg))), 'engine-error')
    mode = 'hang'
    const ac = new AbortController(); setTimeout(() => ac.abort(), 100)
    assert.equal(await codeOf(iflytek.recognize(args(cfg, { signal: ac.signal }))), 'AbortError')
    assert.equal(await codeOf(iflytek.recognize(args(cfg, { lang: 'auto' }))), 'no-engine')
  } finally { await srv.close() }
  const s = signedUrl('wss://iat-api.xfyun.cn/v2/iat', { apiKey: 'k', apiSecret: 's' }, 'Wed, 10 Jul 2019 07:35:43 GMT')
  assert.equal(new URL(s.url).searchParams.get('host'), 'iat-api.xfyun.cn')
  assert.equal(s.signature, crypto.createHmac('sha256', 's').update('host: iat-api.xfyun.cn\ndate: Wed, 10 Jul 2019 07:35:43 GMT\nGET /v2/iat HTTP/1.1').digest('base64'))
})

// ---- OpenAI -----------------------------------------------------------------------------------------------------
test('openai: multipart transcription request; error mapping; abort', async () => {
  const seen = []
  let reply = null
  const f = await startHttpFake(async (req, body) => {
    const form = await new Response(body, { headers: { 'content-type': req.headers['content-type'] } }).formData()
    const file = form.get('file')
    seen.push({ path: req.url, auth: req.headers.authorization, org: req.headers['openai-organization'], model: form.get('model'), language: form.get('language'),
      fmt: form.get('response_format'), name: file?.name, type: file?.type, bytes: file ? Buffer.from(await file.arrayBuffer()) : null })
    if (reply === 'hang') return hangs()
    if (reply) return { status: reply.status, json: { error: { message: 'Incorrect API key provided: sk-ab***xyz', type: 'x', code: reply.code } } }
    return { json: { text: 'Translate the README.' } }
  })
  try {
    const cfg = { apiKey: 'sk-test', baseUrl: f.url('/v1/'), organization: 'org1' }
    openai.validate(cfg)
    assert.equal((await openai.recognize(args(cfg, { lang: 'en' }))).text, 'Translate the README.')
    await openai.recognize(args({ ...cfg, model: 'whisper-1' }, { lang: 'auto' }))
    const [a, b] = seen
    assert.equal(a.path, '/v1/audio/transcriptions')
    assert.equal(a.auth, 'Bearer sk-test'); assert.equal(a.org, 'org1')
    assert.equal(a.model, 'gpt-4o-transcribe'); assert.equal(a.language, 'en'); assert.equal(a.fmt, 'json')
    assert.equal(a.name, 'audio.wav'); assert.equal(a.type, 'audio/wav'); assert.ok(a.bytes.equals(wav))
    assert.equal(b.model, 'whisper-1'); assert.equal(b.language, null, 'auto: no language field')
    for (const [r, want] of [[{ status: 401, code: 'invalid_api_key' }, 'engine-error'], [{ status: 429, code: 'rate_limit_exceeded' }, 'busy'],
      [{ status: 429, code: 'insufficient_quota' }, 'engine-error'], [{ status: 400, code: 'audio_too_short' }, 'bad-audio'], [{ status: 500, code: null }, 'engine-error']]) {
      reply = r
      const e = await openai.recognize(args(cfg)).catch((x) => x)
      assert.equal(e.code, want, JSON.stringify(r))
      assert.ok(!String(e.detail).includes('sk-'), 'provider messages (which may echo key fragments) never reach the detail')
    }
    reply = 'hang'
    const ac = new AbortController(); setTimeout(() => ac.abort(), 100)
    assert.equal(await codeOf(openai.recognize(args(cfg, { signal: ac.signal }))), 'AbortError')
  } finally { await f.close() }
})

// ---- Deepgram ---------------------------------------------------------------------------------------------------
test('deepgram: WAV body, Token auth, model and language per request; detect_language for auto; error mapping', async () => {
  const seen = []
  let reply = null
  const f = await startHttpFake(async (req, body) => {
    const u = new URL(req.url, 'http://x')
    seen.push({ path: u.pathname, q: Object.fromEntries(u.searchParams), auth: req.headers.authorization, ct: req.headers['content-type'], body })
    if (reply === 'hang') return hangs()
    if (reply) return { status: reply, json: { err_code: 'INVALID_AUTH', err_msg: 'Invalid credentials.', request_id: 'r' } }
    return { json: { metadata: { request_id: 'r' }, results: { channels: [{ alternatives: [{ transcript: 'hello world', confidence: 0.9 }], detected_language: 'en' }] } } }
  })
  try {
    const cfg = { apiKey: 'dg-key', endpoint: f.url('/v1/listen'), models: { zh: 'nova-2' } }
    deepgram.validate(cfg)
    const r = await deepgram.recognize(args(cfg))
    assert.equal(r.text, 'hello world')
    await deepgram.recognize(args(cfg, { lang: 'auto' }))
    const [a, b] = seen
    assert.equal(a.path, '/v1/listen')
    assert.deepEqual(a.q, { model: 'nova-2', language: 'zh-CN', smart_format: 'true', punctuate: 'true' })
    assert.equal(a.auth, 'Token dg-key'); assert.equal(a.ct, 'audio/wav'); assert.ok(a.body.equals(wav))
    assert.equal(b.q.detect_language, 'true'); assert.equal(b.q.language, undefined); assert.equal(b.q.model, 'nova-3')
    assert.equal((await deepgram.recognize(args(cfg, { lang: 'auto' }))).lang, 'en')
    for (const [status, want] of [[401, 'engine-error'], [402, 'engine-error'], [429, 'busy'], [400, 'bad-audio'], [503, 'engine-error']]) {
      reply = status
      assert.equal(await codeOf(deepgram.recognize(args(cfg))), want, String(status))
    }
    reply = 'hang'
    const ac = new AbortController(); setTimeout(() => ac.abort(), 100)
    assert.equal(await codeOf(deepgram.recognize(args(cfg, { signal: ac.signal }))), 'AbortError')
  } finally { await f.close() }
})

// ---- Azure ------------------------------------------------------------------------------------------------------
test('azure: short-audio REST request (key header, WAV content type, language) and status mapping', async () => {
  const seen = []
  let reply = { status: 200, json: { RecognitionStatus: 'Success', DisplayText: '微软识别。', Offset: 100, Duration: 1000 } }
  const f = await startHttpFake(async (req, body) => {
    const u = new URL(req.url, 'http://x')
    seen.push({ path: u.pathname, q: Object.fromEntries(u.searchParams), key: req.headers['ocp-apim-subscription-key'], ct: req.headers['content-type'], accept: req.headers.accept, body })
    if (reply === 'hang') return hangs()
    return reply
  })
  try {
    const cfg = { key: 'az-key', endpoint: f.url('/stt') }
    azure.validate(cfg)
    assert.throws(() => azure.validate({ key: 'k' }), /region/)
    assert.equal((await azure.recognize(args(cfg))).text, '微软识别。')
    const a = seen[0]
    assert.equal(a.path, '/stt/speech/recognition/conversation/cognitiveservices/v1')
    assert.deepEqual(a.q, { language: 'zh-CN', format: 'simple', profanity: 'raw' })
    assert.equal(a.key, 'az-key'); assert.equal(a.ct, 'audio/wav; codecs=audio/pcm; samplerate=16000'); assert.equal(a.accept, 'application/json')
    assert.ok(a.body.equals(wav))
    await azure.recognize(args(cfg, { lang: 'en' }))
    assert.equal(seen[1].q.language, 'en-US')
    for (const [r, want] of [[{ status: 200, json: { RecognitionStatus: 'NoMatch' } }, 'empty'], [{ status: 200, json: { RecognitionStatus: 'InitialSilenceTimeout' } }, 'empty'],
      [{ status: 200, json: { RecognitionStatus: 'Error' } }, 'engine-error'], [{ status: 401, body: '' }, 'engine-error'], [{ status: 429, body: '' }, 'busy'], [{ status: 400, body: '' }, 'bad-audio']]) {
      reply = r
      assert.equal(await codeOf(azure.recognize(args(cfg))), want, JSON.stringify(r))
    }
    reply = 'hang'
    const ac = new AbortController(); setTimeout(() => ac.abort(), 100)
    assert.equal(await codeOf(azure.recognize(args(cfg, { signal: ac.signal }))), 'AbortError')
    assert.equal(await codeOf(azure.recognize(args(cfg, { lang: 'auto' }))), 'no-engine')
  } finally { await f.close() }
})

// ---- the WebSocket client over TLS (what Volcano and iFlytek use in production) ------------------------------------
test('ws client: wss:// with a custom CA, untrusted certificate refused, a bad Sec-WebSocket-Accept refused', async (t) => {
  const { execFileSync } = await import('node:child_process')
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { tmpDir } = await import('./helpers.mjs')
  const { connectWebSocket } = await import('../src/lib/ws-client.mjs')
  const dir = tmpDir()
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1',
      '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' })
  } catch { t.skip('openssl not available'); return }
  const tls = { key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }
  const srv = await startWsServer((conn) => {
    conn.onMessage = (data, isText) => { conn.send(isText ? `echo:${data}` : data) }
  }, { tls })
  try {
    const ws = await connectWebSocket(srv.url('/x'), { ca: tls.cert, timeoutMs: 5000 })
    const got = new Promise((resolve) => { ws.onMessage = (d, isText) => resolve({ d: d.toString(), isText }) })
    ws.send('hello')
    assert.deepEqual(await got, { d: 'echo:hello', isText: true })
    ws.close()
    await assert.rejects(connectWebSocket(srv.url('/x'), { timeoutMs: 5000 }), /self[- ]signed|certificate/i, 'without the CA the server is not trusted')
  } finally { await srv.close() }
  // a server that answers the upgrade with the wrong accept key
  const bad = await (await import('node:net')).createServer((s) => {
    s.once('data', () => s.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: bogus\r\n\r\n'))
  })
  await new Promise((r) => bad.listen(0, '127.0.0.1', r))
  try {
    await assert.rejects(connectWebSocket(`ws://127.0.0.1:${bad.address().port}/`, { timeoutMs: 3000 }), /Sec-WebSocket-Accept/)
  } finally { bad.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})
