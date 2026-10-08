// Pocket protocol v1 verification for the ASR gateway: strict base64url, P-256 ECDSA (r || s),
// coordination-signed documents, tickets and the `asr-auth` proof of possession.
// Spec: docs/protocol/E2EE.md §3, §12, §13 and ASR.md §3. Only verification lives here; the gateway signs nothing.
// Zero dependencies (node:crypto). Error codes are the protocol's (E2EE.md Appendix A) and go to logs only.

import crypto from 'node:crypto'

export class PocketError extends Error {
  constructor(code, detail) { super(detail ? `${code}: ${detail}` : code); this.code = code }
}
const fail = (code, detail) => { throw new PocketError(code, detail) }

// ---- encodings (E2EE §3.1) --------------------------------------------------------------------------------
const B64U_RE = /^[A-Za-z0-9_-]*$/
export const b64u = (buf) => Buffer.from(buf).toString('base64url')

/** Strict base64url: no padding or whitespace, canonical trailing bits; optional exact byte length. */
export function unb64u(s, len) {
  if (typeof s !== 'string' || !B64U_RE.test(s) || s.length % 4 === 1) fail('bad-b64u')
  const b = Buffer.from(s, 'base64url')
  if (b.toString('base64url') !== s) fail('bad-b64u')
  if (len !== undefined && b.length !== len) fail('bad-b64u', `expected ${len} bytes`)
  return b
}

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
export function fromUtf8(buf) { try { return UTF8.decode(buf) } catch { return fail('bad-utf8') } }

/** A JSON object from UTF-8 bytes (no BOM; an object at the top level). */
export function parseJson(buf, max) {
  if (max !== undefined && buf.length > max) fail('too-large')
  let v
  try { v = JSON.parse(fromUtf8(buf)) } catch (e) { if (e instanceof PocketError) throw e; fail('bad-json') }
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail('bad-json')
  return v
}

export const sha256 = (...parts) => crypto.createHash('sha256').update(Buffer.concat(parts)).digest()
const isInt = (v, min = 0) => Number.isSafeInteger(v) && v >= min
const isStr = (v, max = 4096) => typeof v === 'string' && v.length <= max

// ---- P-256 (E2EE §3.2, §3.3) ------------------------------------------------------------------------------
const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn
const big = (buf) => (buf.length ? BigInt('0x' + buf.toString('hex')) : 0n)
const mod = (a, m) => { const r = a % m; return r < 0n ? r + m : r }

/** Uncompressed SEC1 point, 65 bytes, coordinates below p, on the curve. */
export function checkPub(pub) {
  if (!Buffer.isBuffer(pub) || pub.length !== 65 || pub[0] !== 4) fail('bad-key')
  const x = big(pub.subarray(1, 33)), y = big(pub.subarray(33))
  if (x >= P || y >= P) fail('bad-key')
  if (mod(y * y, P) !== mod(x * x * x - 3n * x + B, P)) fail('bad-key')
  return pub
}

const keyCache = new Map()   // b64u point → KeyObject (points are checked before they get here)
function publicKeyOf(pub) {
  const id = pub.toString('base64url')
  let k = keyCache.get(id)
  if (!k) {
    k = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) }, format: 'jwk' })
    if (keyCache.size > 4096) keyCache.clear()
    keyCache.set(id, k)
  }
  return k
}

/** ECDSA P-256 / SHA-256 over `msg`; signature is r || s (64 bytes); r and s must be in [1, n−1]. */
export function ecdsaVerify(pub, msg, sig) {
  if (!Buffer.isBuffer(sig) || sig.length !== 64) return false
  const r = big(sig.subarray(0, 32)), s = big(sig.subarray(32))
  if (r === 0n || s === 0n || r >= N || s >= N) return false
  try { checkPub(pub) } catch { return false }
  try { return crypto.verify('sha256', msg, { key: publicKeyOf(pub), dsaEncoding: 'ieee-p1363' }, sig) } catch { return false }
}

// ---- domain separation (E2EE §3.4) ------------------------------------------------------------------------
export const PFX = 'pocket/v1 '
const ZERO = Buffer.from([0])
const u32be = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }
export const sigInput = (label, h, c = Buffer.alloc(0)) =>
  Buffer.concat([Buffer.from(PFX + label, 'utf8'), ZERO, u32be(h.length), h, c])

// ---- identifiers (E2EE §3.7) ------------------------------------------------------------------------------
export const DID_RE = /^[A-Za-z0-9_-]{16}$/
export function checkAddr(a) {
  const m = typeof a === 'string' && /^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a)
  if (!m) return false
  const o = m.slice(1).map(Number)
  if (m.slice(1).some((s) => s.length > 1 && s[0] === '0') || o.some((x) => x > 255)) return false
  return o[0] >= 64 && o[0] <= 127
}
const KINDS = ['phone', 'computer']

// ---- coordination documents (E2EE §12) --------------------------------------------------------------------
export const SKEW_MS = 5 * 60_000
const HOUR = 3_600_000

/** keys = [{ kid, pub (b64u), use: [...], nbf, exp }] */
function coordKey(keys, kid, use, now) {
  const k = Array.isArray(keys) ? keys.find((x) => x && x.kid === kid) : undefined
  if (!k) fail('unknown-key')
  if (!Array.isArray(k.use) || !k.use.includes(use) || !isInt(k.nbf) || !isInt(k.exp)
    || now < k.nbf - SKEW_MS || now > k.exp + SKEW_MS) fail('key-not-valid')
  return unb64u(k.pub, 65)
}

/** A `{p, s}` document signed by a coordination key whose `use` contains `label`; returns the payload object. */
export function verifyCoordDoc(label, doc, keys, now) {
  if (!doc || typeof doc !== 'object') fail('bad-format')
  const p = unb64u(doc.p), D = parseJson(p, 1_048_576)
  if (D.v !== 1 || D.t !== label) fail('bad-format')
  if (!ecdsaVerify(coordKey(keys, D.kid, label, now), sigInput(label, p), unb64u(doc.s, 64))) fail('bad-sig')
  return D
}

/** keys.json `{p, sigs: [{kid, s}]}`: accepted when one signature verifies with a key we already trust. */
export function verifyKeysDoc(doc, trusted, now) {
  if (!doc || typeof doc !== 'object') fail('bad-format')
  const p = unb64u(doc.p), D = parseJson(p, 1_048_576)
  if (D.v !== 1 || D.t !== 'keys' || !Array.isArray(D.keys)) fail('bad-format')
  const ok = (Array.isArray(doc.sigs) ? doc.sigs : []).some((x) => {
    try { return ecdsaVerify(coordKey(trusted, x.kid, 'keys', now), sigInput('keys', p), unb64u(x.s, 64)) } catch { return false }
  })
  if (!ok) fail('bad-sig')
  for (const k of D.keys) {
    if (!k || !isStr(k.kid, 64) || !Array.isArray(k.use) || !isInt(k.nbf) || !isInt(k.exp)) fail('bad-format')
    checkPub(unb64u(k.pub, 65))
  }
  return D.keys
}

/** Ticket = `b64u(payload).b64u(sig)`, label `ticket` (E2EE §12.2). `acct` undefined or '*' = any account. */
export function verifyTicket(ticket, { keys, aud, now, acct }) {
  const parts = typeof ticket === 'string' && ticket.length <= 8192 ? ticket.split('.') : []
  if (parts.length !== 2) fail('bad-ticket')
  const T = verifyCoordDoc('ticket', { p: parts[0], s: parts[1] }, keys, now)
  if (!isStr(T.aud, 64) || T.aud !== aud) fail('wrong-aud')
  if (!isInt(T.iat, 1) || !isInt(T.exp, 1) || T.exp <= T.iat || T.exp - T.iat > 24 * HOUR) fail('bad-ticket')
  if (now < T.iat - SKEW_MS || now > T.exp + SKEW_MS) fail('expired')
  if (acct !== undefined && acct !== '*' && T.acct !== acct) fail('wrong-account')
  if (!isStr(T.acct, 128) || !T.acct || !checkAddr(T.addr) || !DID_RE.test(T.dev ?? '') || !KINDS.includes(T.kind)
    || !Array.isArray(T.peers) || !T.peers.every(checkAddr)) fail('bad-ticket')
  checkPub(unb64u(T.sig, 65))
  return T
}

/**
 * ASR proof of possession (ASR.md §3, E2EE §13): `X-Pocket-Proof: <b64u(a)>.<b64u(s)>`,
 * a = {v:1, t:"asr-auth", aud, ts, nonce (16 B), bodySha}, s by the ticket's device key over SigInput("asr-auth", a).
 * Pass the already verified ticket payload `T`. Nonce replay is the caller's job (record it only after this returns).
 */
export function verifyAsrProof({ T, a, s, bodySha }, { aud, now }) {
  const ab = unb64u(a), A = parseJson(ab, 4096)
  if (A.v !== 1 || A.t !== 'asr-auth' || A.aud !== aud) fail('bad-proof')
  if (!isInt(A.ts, 1) || Math.abs(now - A.ts) > SKEW_MS) fail('stale')
  unb64u(A.nonce, 16)
  if (A.bodySha !== b64u(bodySha)) fail('body-mismatch')
  if (!ecdsaVerify(unb64u(T.sig, 65), sigInput('asr-auth', ab), unb64u(s, 64))) fail('bad-sig')
  return { nonce: A.nonce, ts: A.ts }
}

/**
 * The part of the ASR proof that does not need the body: shape, gateway, time, nonce format and the device's signature.
 * The gateway checks it before reading the body and before counting the request against the account's rate and
 * concurrency, so someone holding a stolen ticket but not the device key cannot use them up; it then compares
 * `bodySha` with the body it received. Returns the parsed `a`.
 */
export function verifyAsrProofHead({ T, a, s }, { aud, now }) {
  const ab = unb64u(a), A = parseJson(ab, 4096)
  if (A.v !== 1 || A.t !== 'asr-auth' || A.aud !== aud) fail('bad-proof')
  if (!isInt(A.ts, 1) || Math.abs(now - A.ts) > SKEW_MS) fail('stale')
  unb64u(A.nonce, 16)
  if (typeof A.bodySha !== 'string') fail('bad-proof')
  if (!ecdsaVerify(unb64u(T.sig, 65), sigInput('asr-auth', ab), unb64u(s, 64))) fail('bad-sig')
  return A
}

/** Split the proof header `<b64u(a)>.<b64u(s)>`. */
export function splitProof(header) {
  const parts = typeof header === 'string' && header.length <= 8192 ? header.split('.') : []
  if (parts.length !== 2) fail('bad-proof')
  return { a: parts[0], s: parts[1] }
}
