// iFlytek Open Platform voice dictation (讯飞开放平台 语音听写 流式版 WebAPI v2):
//   wss://iat-api.xfyun.cn/v2/iat?authorization=…&date=…&host=…   (HMAC-SHA256 signed URL)
//   JSON text frames: status 0 (with common + business), 1 (audio), 2 (end); base64 PCM, 1280 bytes per frame; ≤ 60 s.

import crypto from 'node:crypto'
import { connectWebSocket, WsHandshakeError } from '../lib/ws-client.mjs'
import { AsrError } from '../errors.mjs'
import { abortError } from '../lib/http.mjs'

export const DEFAULT_URL = 'wss://iat-api.xfyun.cn/v2/iat'
export const DEFAULT_LANGS = { zh: 'zh_cn', en: 'en_us' }
const FRAME_BYTES = 1280
const FORMAT = 'audio/L16;rate=16000'

/** Signed connection URL (date = RFC 1123 in GMT). */
export function signedUrl(url, { apiKey, apiSecret }, date = new Date().toUTCString()) {
  const u = new URL(url)
  const origin = `host: ${u.host}\ndate: ${date}\nGET ${u.pathname} HTTP/1.1`
  const signature = crypto.createHmac('sha256', apiSecret).update(origin).digest('base64')
  const authOrigin = `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`
  const authorization = Buffer.from(authOrigin, 'utf8').toString('base64')
  const qs = new URLSearchParams({ authorization, date, host: u.host })
  return { url: `${u.origin}${u.pathname}?${qs}`, signature, authorization }
}

export function mapIflytekCode(code) {
  const c = Number(code) || 0
  if (c === 11201) return 'busy'
  return 'engine-error'
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(abortError())
  if (!ms) return resolve()
  const onAbort = () => { clearTimeout(t); reject(abortError()) }
  const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
  signal?.addEventListener('abort', onAbort, { once: true })
})

export default {
  type: 'iflytek',
  kind: 'cloud',
  langs: ['zh', 'en'],
  maxSeconds: 60,

  validate(c) {
    if (!c.appId || !c.apiKey || !c.apiSecret) throw new Error('iflytek: appId, apiKey and apiSecret are required')
    if (c.url !== undefined && !/^wss?:\/\//.test(c.url)) throw new Error('iflytek: url must be ws:// or wss://')
  },

  langsOf(c) { return Object.keys({ ...DEFAULT_LANGS, ...(c.languages || {}) }) },

  async recognize({ pcm, lang, signal, config, note }) {
    const language = { ...DEFAULT_LANGS, ...(config.languages || {}) }[lang]
    if (!language) throw new AsrError('no-engine', `iflytek:no-lang-${lang}`)
    const { url } = signedUrl(config.url || DEFAULT_URL, config)
    let ws
    try {
      ws = await connectWebSocket(url, { signal, timeoutMs: 15000 })
    } catch (e) {
      if (signal?.aborted || e.name === 'AbortError') throw abortError()
      if (e instanceof WsHandshakeError && e.status) throw new AsrError(e.status === 429 ? 'busy' : 'engine-error', `http-${e.status}`)
      throw new AsrError('engine-error', `connect:${e.code || 'failed'}`)
    }
    const business = { language, domain: config.domain || 'iat', vad_eos: 10000, ptt: 1 }
    if (lang === 'zh') business.accent = config.accent || 'mandarin'
    const interval = config.frameIntervalMs ?? 10

    return await new Promise((resolve, reject) => {
      const parts = []
      let done = false
      const finish = (err, val) => { if (done) return; done = true; ws.terminate(); if (err) reject(err); else resolve(val) }
      ws.onClose = () => finish(signal?.aborted ? abortError() : new AsrError('engine-error', 'closed-early'))
      ws.onMessage = (data) => {
        let m
        try { m = JSON.parse(data.toString('utf8')) } catch { return finish(new AsrError('engine-error', 'bad-frame')) }
        if (m.sid) note?.(`sid:${m.sid}`)
        if (m.code !== 0) return finish(new AsrError(mapIflytekCode(m.code), `provider:${m.code}`))
        const r = m.data?.result
        if (r && Array.isArray(r.ws)) {
          const piece = r.ws.map((w) => (Array.isArray(w.cw) && w.cw[0] && typeof w.cw[0].w === 'string' ? w.cw[0].w : '')).join('')
          parts[Number(r.sn) || parts.length + 1] = piece
        }
        if (m.data?.status === 2) finish(null, { text: parts.filter((x) => typeof x === 'string').join('') })
      }
      ;(async () => {
        try {
          for (let off = 0, first = true; ; off += FRAME_BYTES, first = false) {
            if (done) return
            const chunk = pcm.subarray(off, off + FRAME_BYTES)
            const last = off + FRAME_BYTES >= pcm.length
            const data = { status: first ? 0 : 1, format: FORMAT, encoding: 'raw', audio: chunk.toString('base64') }
            ws.send(JSON.stringify(first ? { common: { app_id: config.appId }, business, data } : { data }))
            if (last) break
            await sleep(interval, signal)
          }
          ws.send(JSON.stringify({ data: { status: 2, format: FORMAT, encoding: 'raw', audio: '' } }))
        } catch (e) { finish(e) }
      })()
    })
  },
}
