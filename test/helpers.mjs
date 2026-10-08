// Shared test helpers: audio, coordination test keys (generated per run, never the vectors' keys), tickets and
// proofs, a fake engine, and a gateway on an ephemeral port.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGateway } from '../src/server.mjs'
import { pcmToWav } from '../src/wav.mjs'
import { sigInput, b64u } from '../src/pcrypto.mjs'
import { hashToken } from '../src/auth.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** vectors.json: ASR_VECTORS, the monorepo's docs/protocol, or a vendored copy next to the tests. */
export function loadVectors() {
  const candidates = [process.env.ASR_VECTORS, path.join(HERE, '..', '..', 'docs', 'protocol', 'vectors.json'), path.join(HERE, 'vectors.json')]
  for (const f of candidates) if (f && fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'))
  throw new Error('vectors.json not found (set ASR_VECTORS)')
}

// ---- audio --------------------------------------------------------------------------------------------------------
export function tonePcm(seconds, { freq = 440, amp = 8000 } = {}) {
  const n = Math.round(seconds * 16000)
  const b = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * freq * i) / 16000)), i * 2)
  return b
}
export const toneWav = (seconds, o) => pcmToWav(tonePcm(seconds, o))
export const silentWav = (seconds) => pcmToWav(Buffer.alloc(Math.round(seconds * 16000) * 2))

/** A WAV with extra chunks before and after the data, like some recorders write. */
export function wavWithChunks(pcm) {
  const fmt = Buffer.alloc(24)
  fmt.write('fmt ', 0, 'latin1'); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(1, 10)
  fmt.writeUInt32LE(16000, 12); fmt.writeUInt32LE(32000, 16); fmt.writeUInt16LE(2, 20); fmt.writeUInt16LE(16, 22)
  const fllr = Buffer.concat([Buffer.from('FLLR', 'latin1'), u32le(3), Buffer.from([0, 0, 0, 0])])   // odd size + pad byte
  const data = Buffer.concat([Buffer.from('data', 'latin1'), u32le(pcm.length), pcm])
  const list = Buffer.concat([Buffer.from('LIST', 'latin1'), u32le(4), Buffer.from('INFO', 'latin1')])
  const body = Buffer.concat([Buffer.from('WAVE', 'latin1'), fmt, fllr, data, list])
  return Buffer.concat([Buffer.from('RIFF', 'latin1'), u32le(body.length), body])
}
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }

// ---- keys, tickets, proofs ------------------------------------------------------------------------------------------
export function newKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' })
  const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])
  return { privateKey, pub, pubB64: b64u(pub), sign: (msg) => crypto.sign('sha256', msg, { key: privateKey, dsaEncoding: 'ieee-p1363' }) }
}

export function coordKeys(now = Date.now()) {
  const k = newKeyPair()
  const entry = { kid: 'lab-c1', pub: k.pubB64, use: ['keys', 'ticket', 'netmap', 'revocations', 'purge'], nbf: now - 86_400_000, exp: now + 365 * 86_400_000 }
  return { ...k, entry }
}

export function signDoc(label, key, payload) {
  const p = Buffer.from(JSON.stringify(payload), 'utf8')
  return { p: b64u(p), s: b64u(key.sign(sigInput(label, p))) }
}

let devCounter = 0
export function newDevice({ acct = 'u_lab0001', kind = 'phone' } = {}) {
  const k = newKeyPair()
  devCounter++
  const id = crypto.createHash('sha256').update(`dev${devCounter}${Math.random()}`).digest('base64url').slice(0, 16)
  return { ...k, id, acct, kind, addr: `100.64.1.${devCounter % 250 + 1}` }
}

export function makeTicket(coord, dev, { aud = 'asr:official', iat = Date.now(), exp = iat + 6 * 3_600_000, kid = coord.entry.kid, acct = dev.acct, ...over } = {}) {
  const doc = signDoc('ticket', coord, {
    v: 1, t: 'ticket', kid, iss: 'pocket.test', aud, acct, dev: dev.id, addr: dev.addr, kind: dev.kind,
    sig: dev.pubB64, peers: [], iat, exp, ...over,
  })
  return `${doc.p}.${doc.s}`
}

export function makeProof(dev, body, { aud = 'asr:official', ts = Date.now(), nonce = b64u(crypto.randomBytes(16)), bodySha } = {}) {
  const a = Buffer.from(JSON.stringify({ v: 1, t: 'asr-auth', aud, ts, nonce, bodySha: bodySha ?? b64u(crypto.createHash('sha256').update(body).digest()) }))
  return { header: `${b64u(a)}.${b64u(dev.sign(sigInput('asr-auth', a)))}`, nonce }
}

// ---- fake engine ----------------------------------------------------------------------------------------------------
/** Adapter whose behaviour each test sets: fake.next = async (args) => ({ text }) */
export function fakeAdapter(type = 'fake', langs = ['zh', 'en', 'auto'], maxSeconds = 240) {
  const a = {
    type, kind: 'cloud', langs, maxSeconds, calls: [],
    validate() {},
    next: async () => ({ text: '把 README 翻译成英文' }),
    async recognize(args) { a.calls.push(args); return a.next(args) },
  }
  return a
}

// ---- gateway --------------------------------------------------------------------------------------------------------
export const TOKEN = 'test-token-' + crypto.randomBytes(8).toString('hex')

export function baseConfig(over = {}) {
  return {
    gatewayId: 'official',
    listen: { host: '127.0.0.1', port: 0 },
    auth: { tokens: [{ label: 'my phone', sha256: hashToken(TOKEN) }] },
    engines: [{ id: 'fake', type: 'fake' }],
    limits: {},
    ...over,
  }
}

export async function startGateway(config, opts = {}) {
  const lines = []
  const gw = createGateway(config, { log: (l) => lines.push(l), ...opts })
  const addr = await gw.listen()
  return { gw, lines, url: `http://127.0.0.1:${addr.port}`, close: () => gw.close() }
}

export async function post(url, body, headers = {}) {
  const res = await fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'audio/wav', ...headers } })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers }
}

export function tmpDir(prefix = 'asr-test-') { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)) }
