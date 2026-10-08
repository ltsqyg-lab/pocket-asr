// Volcano Engine (火山引擎) Doubao big-model speech recognition, "nostream" mode:
//   wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream
// One WSS connection: a gzip JSON request frame, then the WAV in 200 ms packets (last packet with a negative sequence),
// then the server's final frame carries the whole text. Binary framing as in the provider's sauc examples.

import crypto from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { connectWebSocket, WsHandshakeError } from '../lib/ws-client.mjs'
import { AsrError } from '../errors.mjs'
import { abortError } from '../lib/http.mjs'

export const DEFAULT_URL = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream'
export const DEFAULT_RESOURCE_ID = 'volc.seedasr.sauc.duration'

const MSG = { CLIENT_FULL: 0b0001, CLIENT_AUDIO: 0b0010, SERVER_FULL: 0b1001, SERVER_ERROR: 0b1111 }
const FLAG = { POS_SEQ: 0b0001, NEG_WITH_SEQ: 0b0011 }
const SER_JSON = 0b0001
const COMP_GZIP = 0b0001
const SEGMENT_BYTES = 6400            // 200 ms of 16 kHz mono s16

export function clientFrame(type, flags, seq, payload) {
  const body = gzipSync(payload)
  const head = Buffer.from([0x11, (type << 4) | flags, (SER_JSON << 4) | COMP_GZIP, 0x00])
  const meta = Buffer.alloc(8)
  meta.writeInt32BE(seq, 0)
  meta.writeUInt32BE(body.length, 4)
  return Buffer.concat([head, meta, body])
}

export function parseServerFrame(buf) {
  if (buf.length < 4) throw new Error('short frame')
  const headerSize = (buf[0] & 0x0f) * 4
  const type = buf[1] >> 4
  const flags = buf[1] & 0x0f
  const serialization = buf[2] >> 4
  const compression = buf[2] & 0x0f
  let off = headerSize
  const out = { type, flags, seq: 0, last: false, code: 0, msg: null }
  if (flags & 0x01) { out.seq = buf.readInt32BE(off); off += 4 }
  if (flags & 0x02) out.last = true
  if (flags & 0x04) off += 4                      // event number (unused here)
  let size = 0
  if (type === MSG.SERVER_FULL) { size = buf.readUInt32BE(off); off += 4 }
  else if (type === MSG.SERVER_ERROR) { out.code = buf.readInt32BE(off); size = buf.readUInt32BE(off + 4); off += 8 }
  if (!size) return out
  let payload = buf.subarray(off, off + size)
  if (compression === COMP_GZIP) payload = gunzipSync(payload)
  const text = payload.toString('utf8')
  if (serialization === SER_JSON) { try { out.msg = JSON.parse(text) } catch { out.msg = null } }
  return out
}

/** Provider code → gateway code (provider codes only reach the log). */
export function mapVolcanoCode(code) {
  const c = Number(code) || 0
  if (c === 45000002) return 'empty'
  if (c >= 45000000 && c < 46000000) return 'bad-audio'
  if (c === 55000031) return 'busy'
  return 'engine-error'
}

export default {
  type: 'volcano',
  kind: 'cloud',
  langs: ['zh', 'en', 'auto'],
  maxSeconds: 240,

  validate(c) {
    if (!c.appId || typeof c.appId !== 'string') throw new Error('volcano: appId is required')
    if (!c.accessToken || typeof c.accessToken !== 'string') throw new Error('volcano: accessToken is required')
    if (c.resourceId !== undefined && typeof c.resourceId !== 'string') throw new Error('volcano: resourceId must be a string')
    if (c.url !== undefined && !/^wss?:\/\//.test(c.url)) throw new Error('volcano: url must be ws:// or wss://')
    if (c.hotWords !== undefined && (!Array.isArray(c.hotWords) || c.hotWords.some((w) => typeof w !== 'string') || c.hotWords.length > 200)) {
      throw new Error('volcano: hotWords must be a list of strings')
    }
  },

  async recognize({ wav, signal, config, uid, note }) {
    const request = { model_name: 'bigmodel', enable_itn: true, enable_punc: true, enable_ddc: true, show_utterances: false, result_type: 'full' }
    const hot = (config.hotWords || []).filter(Boolean)
    if (hot.length) request.corpus = { context: JSON.stringify({ hotwords: hot.map((word) => ({ word })) }) }
    const full = { user: { uid: String(uid || 'pocket-asr') }, audio: { format: 'wav', codec: 'raw', rate: 16000, bits: 16, channel: 1 }, request }

    let ws
    try {
      ws = await connectWebSocket(config.url || DEFAULT_URL, {
        signal,
        timeoutMs: 15000,
        headers: {
          'X-Api-App-Key': config.appId,
          'X-Api-Access-Key': config.accessToken,
          'X-Api-Resource-Id': config.resourceId || DEFAULT_RESOURCE_ID,
          'X-Api-Request-Id': crypto.randomUUID(),
          'X-Api-Sequence': '-1',
        },
      })
    } catch (e) {
      if (signal?.aborted || e.name === 'AbortError') throw abortError()
      if (e instanceof WsHandshakeError && e.status) {
        if (e.headers['x-tt-logid']) note?.(`logid:${e.headers['x-tt-logid']}`)
        throw new AsrError(e.status === 429 ? 'busy' : 'engine-error', `http-${e.status}`)
      }
      throw new AsrError('engine-error', `connect:${e.code || 'failed'}`)
    }
    if (ws.headers['x-tt-logid']) note?.(`logid:${ws.headers['x-tt-logid']}`)

    return await new Promise((resolve, reject) => {
      let started = false
      let lastText = ''
      let seq = 1
      let done = false
      const finish = (err, val) => {
        if (done) return
        done = true
        ws.terminate()
        if (err) reject(err); else resolve(val)
      }
      ws.onClose = () => finish(signal?.aborted ? abortError() : new AsrError('engine-error', 'closed-early'))
      ws.onMessage = (data) => {
        let r
        try { r = parseServerFrame(data) } catch { return finish(new AsrError('engine-error', 'bad-frame')) }
        if (r.type === MSG.SERVER_ERROR || r.code !== 0) return finish(new AsrError(mapVolcanoCode(r.code), `provider:${r.code}`))
        const text = r.msg?.result?.text
        if (typeof text === 'string') lastText = text
        if (!started) {
          started = true
          for (let off = 0; off < wav.length; off += SEGMENT_BYTES) {
            const end = Math.min(off + SEGMENT_BYTES, wav.length)
            const last = end >= wav.length
            ws.send(clientFrame(MSG.CLIENT_AUDIO, last ? FLAG.NEG_WITH_SEQ : FLAG.POS_SEQ, last ? -seq : seq, wav.subarray(off, end)))
            if (!last) seq++
          }
          return
        }
        if (r.last) finish(null, { text: lastText })
      }
      ws.send(clientFrame(MSG.CLIENT_FULL, FLAG.POS_SEQ, seq++, Buffer.from(JSON.stringify(full))))
    })
  },
}
