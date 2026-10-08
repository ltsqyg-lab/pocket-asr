// Attack tests (phase 3 red team, 2026-10-08; BUILD-PLAN §5 items 7, 13, 14): stolen tickets, replays, the revocation
// endpoint as a CPU sink, request parameters aimed at the engines, and malformed audio. Each case either failed before
// the matching fix or pins down a protection (attack tests, October 2026).

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { coordKeys, newDevice, newKeyPair, makeTicket, makeProof, signDoc, fakeAdapter, baseConfig, startGateway, post, toneWav } from './helpers.mjs'

const ticketConfig = (coord, over = {}) => baseConfig({ auth: { ticket: { enabled: true, pinnedKeys: [coord.entry], accounts: ['*'] } }, ...over })

test('§5-7 a stolen ticket without the device key is useless, and cannot use up the owner\'s voice quota', async () => {
  const fake = fakeAdapter()
  const coord = coordKeys()
  const victim = newDevice({ acct: 'u_victim01' })
  const thief = newKeyPair()
  const g = await startGateway(ticketConfig(coord, { limits: { perMinute: 3, concurrentPerCaller: 1 } }), { adapters: { fake } })
  try {
    const u = g.url + '/v1/recognize?lang=zh'
    const wav = toneWav(1)
    const ticket = makeTicket(coord, victim)
    // the thief signs proofs with its own key: refused, and refused before the request counts against the account
    for (let i = 0; i < 6; i++) {
      const r = await post(u, wav, { Authorization: `PocketTicket ${ticket}`, 'X-Pocket-Proof': makeProof(thief, wav).header })
      assert.equal(r.status, 401)
    }
    assert.match(g.lines.at(-1), /code=unauthorized detail=bad-sig/)
    // a slow upload with a forged proof does not hold the account's only concurrent slot either
    const slow = fetch(u, { method: 'POST', duplex: 'half', headers: { 'Content-Type': 'audio/wav', Authorization: `PocketTicket ${ticket}`, 'X-Pocket-Proof': makeProof(thief, wav).header },
      body: new ReadableStream({ start(c) { c.enqueue(wav.subarray(0, 100)) } }) }).catch(() => null)
    await new Promise((r) => setTimeout(r, 100))
    // the owner still gets all three recognitions of the minute
    for (let i = 0; i < 3; i++) {
      const r = await post(u, wav, { Authorization: `PocketTicket ${ticket}`, 'X-Pocket-Proof': makeProof(victim, wav).header })
      assert.equal(r.status, 200, `owner's request ${i + 1}: ${r.text}`)
    }
    assert.equal(fake.calls.length, 3, 'the engine only ever saw the owner\'s audio')
    void slow
  } finally { await g.close() }
})

test('§5-14 a captured request cannot be replayed, re-aimed or reused with other audio', async () => {
  const fake = fakeAdapter()
  const coord = coordKeys()
  const dev = newDevice()
  const g = await startGateway(ticketConfig(coord), { adapters: { fake } })
  const other = await startGateway(ticketConfig(coord, { gatewayId: 'my-asr' }), { adapters: { fake } })
  try {
    const wav = toneWav(1)
    const ticket = makeTicket(coord, dev)
    const proof = makeProof(dev, wav)
    const h = { Authorization: `PocketTicket ${ticket}`, 'X-Pocket-Proof': proof.header }
    assert.equal((await post(g.url + '/v1/recognize?lang=zh', wav, h)).status, 200)
    const detail = () => g.lines.at(-1).match(/detail=(\S+)/)?.[1]
    assert.equal((await post(g.url + '/v1/recognize?lang=zh', wav, h)).status, 401)
    assert.equal(detail(), 'replay', 'the same request again')
    assert.equal((await post(g.url + '/v1/recognize?lang=en', toneWav(2), { ...h, 'X-Pocket-Proof': makeProof(dev, wav).header })).status, 401)
    assert.equal(detail(), 'body-mismatch', 'a fresh proof for one recording with another recording attached')
    assert.equal((await post(other.url + '/v1/recognize?lang=zh', wav, { Authorization: `PocketTicket ${ticket}`, 'X-Pocket-Proof': makeProof(dev, wav).header })).status, 401, 'another gateway (aud)')
    assert.equal(fake.calls.length, 1)
  } finally { await g.close(); await other.close() }
})

test('§5-13 the revocation endpoint is rate-capped for the whole gateway', async () => {
  const coord = coordKeys()
  const evil = coordKeys()
  const g = await startGateway(ticketConfig(coord), { adapters: { fake: fakeAdapter() } })
  try {
    const forged = JSON.stringify(signDoc('revocations', evil, { v: 1, t: 'revocations', kid: coord.entry.kid, at: Date.now(), acct: 'u_x', since: 0, next: 1, items: [] }))
    const codes = []
    for (let i = 0; i < 125; i++) codes.push((await fetch(g.url + '/v1/revocations', { method: 'POST', body: forged })).status)
    assert.ok(codes.slice(0, 120).every((c) => c === 400), 'forged documents are refused')
    assert.deepEqual(codes.slice(120), [429, 429, 429, 429, 429], 'and after 120 in a minute nothing more is even parsed')
  } finally { await g.close() }
})

test('§5-13 request parameters and malformed audio never reach an engine or crash the gateway', async () => {
  const fake = fakeAdapter()
  const coord = coordKeys()
  const dev = newDevice()
  const g = await startGateway(ticketConfig(coord, { limits: { perMinute: 1000, concurrentPerCaller: 10 } }), { adapters: { fake } })
  try {
    const ticket = makeTicket(coord, dev)
    const send = (q, body) => post(`${g.url}/v1/recognize${q}`, body, { Authorization: `PocketTicket ${ticket}`, 'X-Pocket-Proof': makeProof(dev, body).header })
    const wav = toneWav(1)
    for (const q of ['?lang=zh&engine=../../bin/sh', '?lang=zh&engine=fake;rm', '?lang=zh&engine=' + 'a'.repeat(40), '?lang=xx', '?lang=zh%00', '?lang=zh&lang=en&engine=FAKE']) {
      const r = await send(q, wav)
      assert.equal(r.status, 400, `${q} → ${r.status}`)
    }
    const riff = (chunks) => { const body = Buffer.concat([Buffer.from('WAVE', 'latin1'), ...chunks]); const h = Buffer.alloc(8); h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(body.length, 4); return Buffer.concat([h, body]) }
    const chunk = (id, size, payload = Buffer.alloc(0)) => { const h = Buffer.alloc(8); h.write(id, 0, 'latin1'); h.writeUInt32LE(size, 4); return Buffer.concat([h, payload]) }
    const fmt = (over = {}) => { const b = Buffer.alloc(16); b.writeUInt16LE(over.tag ?? 1, 0); b.writeUInt16LE(over.ch ?? 1, 2); b.writeUInt32LE(over.rate ?? 16000, 4); b.writeUInt32LE(32000, 8); b.writeUInt16LE(2, 12); b.writeUInt16LE(16, 14); return chunk('fmt ', 16, b) }
    const bad = [
      crypto.randomBytes(2000), Buffer.alloc(44), riff([chunk('JUNK', 0xffffffff)]), riff([fmt(), chunk('data', 0xfffffff0, Buffer.alloc(100))]),
      riff([chunk('data', 4, Buffer.alloc(4)), fmt()]), riff([fmt({ tag: 3 }), chunk('data', 3200, Buffer.alloc(3200))]), riff([fmt({ ch: 2 }), chunk('data', 3200, Buffer.alloc(3200))]),
      riff([fmt({ rate: 8000 }), chunk('data', 3200, Buffer.alloc(3200))]), riff([fmt(), fmt(), chunk('data', 3200, Buffer.alloc(3200))]),
      riff([...Array(2000).fill(chunk('LIST', 0)), fmt()]),
    ]
    for (const body of bad) {
      const r = await send('?lang=zh', body)
      assert.ok([400, 413, 422].includes(r.status), `malformed audio → ${r.status} ${r.text}`)
    }
    assert.equal(fake.calls.length, 0, 'no malformed request reached the engine')
    assert.equal((await send('?lang=zh', wav)).status, 200, 'still serving')
  } finally { await g.close() }
})
