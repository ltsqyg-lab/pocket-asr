// vectors.json is the contract (E2EE.md §17): every case relevant to the ASR gateway, valid and invalid, with the
// exact error code. The gateway's own code is under test here, not the generator.

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {
  unb64u, sigInput, ecdsaVerify, checkPub, verifyKeysDoc, verifyTicket, verifyCoordDoc, verifyAsrProof, splitProof, PocketError,
} from '../src/pcrypto.mjs'
import { Auth } from '../src/auth.mjs'
import { loadVectors } from './helpers.mjs'

const v = loadVectors()
const errorOf = (fn) => { try { fn(); return null } catch (e) { if (e instanceof PocketError) return e.code; throw e } }
const pattern = (n) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = i % 251; return b }
const keys = () => verifyKeysDoc(v.coord.keys.document, v.coord.keys.pinned, v.about.now)

test('base64url: valid round trips and every invalid spelling is bad-b64u', () => {
  for (const x of v.encoding.b64u) assert.equal(unb64u(x.b64u).toString('hex'), x.hex)
  for (const s of v.encoding.b64uInvalid) assert.equal(errorOf(() => unb64u(s)), 'bad-b64u', JSON.stringify(s))
})

test('SigInput bytes', () => {
  const x = v.encoding.sigInput
  assert.equal(sigInput(x.label, unb64u(x.h), unb64u(x.c)).toString('hex'), x.bytesHex)
})

test('ECDSA: RFC 6979 sample verifies; r = 0, s = n, DER are rejected; bad public keys are rejected', () => {
  const d = Buffer.from(v.ecdsa.rfc6979.d, 'hex')
  const e = crypto.createECDH('prime256v1'); e.setPrivateKey(d)
  assert.ok(ecdsaVerify(e.getPublicKey(), Buffer.from('sample'), Buffer.from(v.ecdsa.rfc6979.sig, 'hex')))
  for (const x of v.ecdsa.invalidSignatures) assert.equal(ecdsaVerify(unb64u(x.pub), unb64u(x.message), unb64u(x.sig)), false, x.name)
  for (const x of v.ecdsa.invalidPublicKeys) assert.equal(errorOf(() => checkPub(unb64u(x.pub))), 'bad-key', x.name)
})

test('coordination keys document verifies with the pinned key and yields both keys', () => {
  assert.deepEqual(keys().map((k) => k.kid), ['test-c1', 'test-c2'])
  const forged = { ...v.coord.keys.document, sigs: [{ kid: 'test-c1', s: v.coord.keys.document.sigs[0].s.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) }] }
  assert.equal(errorOf(() => verifyKeysDoc(forged, v.coord.keys.pinned, v.about.now)), 'bad-sig')
  assert.equal(errorOf(() => verifyKeysDoc(v.coord.keys.document, [], v.about.now)), 'bad-sig', 'nothing trusted, nothing adopted')
})

test('tickets: the valid one and every invalid case with its code', () => {
  const t = v.coord.ticket
  const T = verifyTicket(t.valid.ticket, { keys: keys(), aud: t.valid.aud, now: t.valid.now, acct: '*' })
  assert.equal(T.dev, v.devices.phoneA.id)
  assert.deepEqual(T, t.valid.payload)
  for (const x of t.invalid) {
    assert.equal(errorOf(() => verifyTicket(x.ticket, { keys: keys(), aud: 'hk1', now: t.valid.now, acct: '*', ...x.options })), x.error, x.name)
  }
})

test('asr-auth proof: valid with the 3200-byte body, body-mismatch with one byte more, and the usual failures', () => {
  const a = v.coord.asrAuth
  const T = verifyTicket(a.ticket, { keys: keys(), aud: a.aud, now: a.now })
  const sha = (n) => crypto.createHash('sha256').update(pattern(n)).digest()
  assert.ok(verifyAsrProof({ T, ...a.proof, bodySha: sha(a.body.length) }, { aud: a.aud, now: a.now }).nonce)
  assert.equal(errorOf(() => verifyAsrProof({ T, ...a.proof, bodySha: sha(a.badBodyLength) }, { aud: a.aud, now: a.now })), a.badBodyError)
  assert.equal(errorOf(() => verifyAsrProof({ T, ...a.proof, bodySha: sha(a.body.length) }, { aud: 'asr:other', now: a.now })), 'bad-proof', 'proof for another gateway')
  assert.equal(errorOf(() => verifyAsrProof({ T, ...a.proof, bodySha: sha(a.body.length) }, { aud: a.aud, now: a.now + 6 * 60_000 })), 'stale')
  const other = { ...T, sig: v.devices.phoneB.sig }
  assert.equal(errorOf(() => verifyAsrProof({ T: other, ...a.proof, bodySha: sha(a.body.length) }, { aud: a.aud, now: a.now })), 'bad-sig', 'stolen ticket, wrong key')
  assert.equal(errorOf(() => verifyTicket(a.ticket, { keys: keys(), aud: 'asr:my-asr', now: a.now })), 'wrong-aud')
  assert.equal(errorOf(() => splitProof('no-dot')), 'bad-proof')
})

test('label confusion: a netmap document checked as a purge order fails with bad-format; revocations verify', () => {
  assert.equal(errorOf(() => verifyCoordDoc('purge', v.coord.netmap.doc, keys(), v.about.now)), v.coord.labelConfusion.error)
  assert.equal(verifyCoordDoc('revocations', v.coord.revocations.doc, keys(), v.coord.revocations.payload.at).t, 'revocations')
  assert.equal(errorOf(() => verifyCoordDoc('ticket', v.coord.revocations.doc, keys(), v.coord.revocations.payload.at)), 'bad-format')
})

test('Auth end to end on the vectors: header check, body check, nonce replay, wrong body, revocation cut-off', () => {
  const a = v.coord.asrAuth
  let now = a.now
  const auth = new Auth({ ticket: { enabled: true, pinnedKeys: v.coord.keys.pinned, accounts: ['*'] } }, { gatewayId: 'official', now: () => now })
  auth.adoptKeysDoc(v.coord.keys.document)
  const headers = { authorization: `PocketTicket ${a.ticket}`, 'x-pocket-proof': `${a.proof.a}.${a.proof.s}` }
  const sha = (n) => crypto.createHash('sha256').update(pattern(n)).digest()
  const who = auth.checkHeaders(headers)
  assert.equal(who.caller, `acct:${v.about.account}`)
  assert.throws(() => auth.checkBody(auth.checkHeaders(headers), sha(a.badBodyLength)), (e) => e.code === 'unauthorized' && e.detail === 'body-mismatch')
  auth.checkBody(who, sha(a.body.length))
  assert.throws(() => auth.checkBody(auth.checkHeaders(headers), sha(a.body.length)), (e) => e.code === 'unauthorized' && e.detail === 'replay')
  // a self-hosted gateway bound to another account
  const bound = new Auth({ ticket: { enabled: true, pinnedKeys: v.coord.keys.pinned, accounts: ['u_other0001'] } }, { gatewayId: 'official', now: () => now })
  bound.adoptKeysDoc(v.coord.keys.document)
  assert.throws(() => bound.checkHeaders(headers), (e) => e.detail === 'wrong-account')
  // revocations: phone A (100.64.0.11) cut off at payload.at — its ticket was issued earlier
  now = v.coord.revocations.payload.at
  assert.equal(auth.applyRevocations(v.coord.revocations.doc), 2)
  assert.throws(() => auth.checkHeaders(headers), (e) => e.detail === 'revoked')
  assert.equal(auth.applyRevocations(v.coord.revocations.doc), 0, 'applying the same document again changes nothing')
})
