// ASR.md §4: only PCM, mono, 16 kHz, 16-bit; data size consistent with the body.

import test from 'node:test'
import assert from 'node:assert/strict'
import { parseWav, pcmToWav, peakAbs } from '../src/wav.mjs'
import { tonePcm, wavWithChunks } from './helpers.mjs'

const code = (fn) => { try { fn(); return null } catch (e) { return `${e.code}/${e.detail}` } }

function header({ tag = 1, channels = 1, rate = 16000, bits = 16, byteRate, blockAlign, dataSize, extra = Buffer.alloc(0) } = {}) {
  const ba = blockAlign ?? channels * bits / 8
  const br = byteRate ?? rate * ba
  const fmtBody = Buffer.alloc(16)
  fmtBody.writeUInt16LE(tag, 0); fmtBody.writeUInt16LE(channels, 2); fmtBody.writeUInt32LE(rate, 4)
  fmtBody.writeUInt32LE(br, 8); fmtBody.writeUInt16LE(ba, 12); fmtBody.writeUInt16LE(bits, 14)
  const fmt = Buffer.concat([Buffer.from('fmt ', 'latin1'), u32(16 + extra.length), fmtBody, extra])
  return (pcm) => {
    const data = Buffer.concat([Buffer.from('data', 'latin1'), u32(dataSize ?? pcm.length), pcm])
    const body = Buffer.concat([Buffer.from('WAVE', 'latin1'), fmt, data])
    return Buffer.concat([Buffer.from('RIFF', 'latin1'), u32(body.length), body])
  }
}
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b }

test('canonical WAV parses; samples and seconds are right; pcmToWav round-trips', () => {
  const pcm = tonePcm(1.5)
  const w = parseWav(pcmToWav(pcm))
  assert.equal(w.samples, 24000)
  assert.equal(w.seconds, 1.5)
  assert.ok(w.pcm.equals(pcm))
})

test('extra chunks (FLLR with an odd size + pad byte, LIST after data) are skipped', () => {
  const pcm = tonePcm(0.5)
  const w = parseWav(wavWithChunks(pcm))
  assert.ok(w.pcm.equals(pcm))
})

test('WAVE_FORMAT_EXTENSIBLE is accepted only with the PCM sub-format', () => {
  const ext = (sub) => {
    const e = Buffer.alloc(24)
    e.writeUInt16LE(22, 0); e.writeUInt16LE(16, 2); e.writeUInt32LE(4, 4)                // cbSize, validBits, channel mask
    e.writeUInt16LE(sub, 8); Buffer.from('000000001000800000aa00389b71', 'hex').copy(e, 10)
    return e
  }
  const pcm = tonePcm(0.2)
  assert.equal(parseWav(header({ tag: 0xfffe, extra: ext(1) })(pcm)).samples, 3200)
  assert.equal(code(() => parseWav(header({ tag: 0xfffe, extra: ext(3) })(pcm))), 'bad-audio/not-pcm')
})

test('every wrong format is bad-audio', () => {
  const pcm = tonePcm(0.2)
  assert.equal(code(() => parseWav(header({ rate: 8000 })(pcm))), 'bad-audio/rate')
  assert.equal(code(() => parseWav(header({ rate: 44100 })(pcm))), 'bad-audio/rate')
  assert.equal(code(() => parseWav(header({ channels: 2 })(pcm))), 'bad-audio/channels')
  assert.equal(code(() => parseWav(header({ bits: 8 })(pcm))), 'bad-audio/bits')
  assert.equal(code(() => parseWav(header({ bits: 24 })(pcm))), 'bad-audio/bits')
  assert.equal(code(() => parseWav(header({ tag: 3, bits: 32 })(pcm))), 'bad-audio/not-pcm')      // float
  assert.equal(code(() => parseWav(header({ byteRate: 16000 })(pcm))), 'bad-audio/fmt-inconsistent')
  assert.equal(code(() => parseWav(Buffer.from('not a wav at all, just some bytes padded out to length....'))), 'bad-audio/not-riff-wave')
  assert.equal(code(() => parseWav(Buffer.alloc(10))), 'bad-audio/short')
  assert.equal(code(() => parseWav('RIFF')), 'bad-audio/short')
})

test('data size must fit the body; a never-patched streaming header means "the rest"', () => {
  const pcm = tonePcm(0.2)
  assert.equal(code(() => parseWav(header({ dataSize: pcm.length + 100 })(pcm))), 'bad-audio/truncated')
  assert.equal(parseWav(header({ dataSize: 0xffffffff })(pcm)).samples, 3200)
  assert.equal(parseWav(header({ dataSize: 0 })(pcm)).samples, 3200)
  const odd = Buffer.concat([pcm, Buffer.from([7])])
  assert.equal(parseWav(header()(odd)).samples, 3200, 'a trailing half sample is dropped')
})

test('structure errors: data before fmt, missing data, a chunk running past the end', () => {
  const pcm = tonePcm(0.1)
  const good = pcmToWav(pcm)
  const swapped = Buffer.concat([good.subarray(0, 12), good.subarray(36), good.subarray(12, 36)])     // data chunk first
  assert.equal(code(() => parseWav(swapped)), 'bad-audio/data-before-fmt')
  assert.equal(code(() => parseWav(Buffer.concat([good.subarray(0, 36), Buffer.from('JUNK', 'latin1'), u32(4), Buffer.alloc(4)]))), 'bad-audio/no-data')
  assert.equal(code(() => parseWav(Buffer.concat([good.subarray(0, 36), Buffer.from('JUNK', 'latin1'), u32(9999), Buffer.alloc(8)]))), 'bad-audio/chunk-size')
})

test('peakAbs finds the loudest sample', () => {
  assert.equal(peakAbs(Buffer.alloc(100)), 0)
  assert.ok(peakAbs(tonePcm(0.1, { amp: 1000 })) >= 999)
  const b = Buffer.alloc(4); b.writeInt16LE(-32768, 2)
  assert.equal(peakAbs(b), 32768)
})
