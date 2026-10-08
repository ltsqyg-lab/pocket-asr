// WAV validation (ASR.md §4): RIFF/WAVE, PCM (format 1), mono, 16000 Hz, 16-bit, data size consistent with the body.
// Unknown chunks (LIST, FLLR, JUNK …) are skipped. WAVE_FORMAT_EXTENSIBLE is accepted only when its sub-format is PCM
// (it is the same format 1 audio, as written by some recorders).

import { AsrError } from './errors.mjs'

export const SAMPLE_RATE = 16000
export const BYTES_PER_SECOND = SAMPLE_RATE * 2
const PCM_GUID_TAIL = Buffer.from('000000001000800000aa00389b71', 'hex')   // KSDATAFORMAT_SUBTYPE_PCM after the format tag

const bad = (why) => { throw new AsrError('bad-audio', why) }

/**
 * @param {Buffer} buf  the whole request body
 * @returns {{ pcm: Buffer, sampleRate: number, seconds: number, samples: number }}  pcm = little-endian Int16 samples
 */
export function parseWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) bad('short')
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') bad('not-riff-wave')
  let pos = 12
  let fmt = null
  while (pos + 8 <= buf.length) {
    const id = buf.toString('latin1', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    const body = pos + 8
    if (id === 'fmt ') {
      if (fmt) bad('two-fmt')
      if (size < 16 || body + size > buf.length) bad('fmt-size')
      const tag = buf.readUInt16LE(body)
      const channels = buf.readUInt16LE(body + 2)
      const rate = buf.readUInt32LE(body + 4)
      const byteRate = buf.readUInt32LE(body + 8)
      const blockAlign = buf.readUInt16LE(body + 12)
      const bits = buf.readUInt16LE(body + 14)
      if (tag === 0xfffe) {
        if (size < 40 || buf.readUInt16LE(body + 16) < 22) bad('extensible-size')
        if (buf.readUInt16LE(body + 24) !== 1 || !buf.subarray(body + 26, body + 40).equals(PCM_GUID_TAIL)) bad('not-pcm')
        if (buf.readUInt16LE(body + 18) !== 16) bad('valid-bits')
      } else if (tag !== 1) bad('not-pcm')
      if (channels !== 1) bad('channels')
      if (rate !== SAMPLE_RATE) bad('rate')
      if (bits !== 16) bad('bits')
      if (blockAlign !== 2 || byteRate !== BYTES_PER_SECOND) bad('fmt-inconsistent')
      fmt = true
    } else if (id === 'data') {
      if (!fmt) bad('data-before-fmt')
      const rest = buf.length - body
      let n
      if (size === 0xffffffff || (size === 0 && rest > 0)) n = rest            // header never patched (streaming writer)
      else if (size > rest) bad('truncated')
      else n = size
      n -= n % 2
      const pcm = buf.subarray(body, body + n)
      const samples = n / 2
      return { pcm, sampleRate: SAMPLE_RATE, samples, seconds: samples / SAMPLE_RATE }
    } else if (body + size > buf.length) {
      bad('chunk-size')
    }
    pos = body + size + (size & 1)
  }
  return bad(fmt ? 'no-data' : 'no-fmt')
}

/** Canonical 44-byte-header WAV around 16 kHz mono s16 PCM (what the cloud adapters send). */
export function pcmToWav(pcm, sampleRate = SAMPLE_RATE) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8, 'latin1')
  h.write('fmt ', 12, 'latin1'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36, 'latin1'); h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

/** Largest absolute sample value (0 … 32768); used to skip the engine for silent recordings. */
export function peakAbs(pcm) {
  let peak = 0
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const v = pcm.readInt16LE(i)
    const a = v < 0 ? -v : v
    if (a > peak) { peak = a; if (peak >= 32767) break }
  }
  return peak
}
