// Deepgram pre-recorded transcription:
//   POST https://api.deepgram.com/v1/listen?model=…&language=…&smart_format=true&punctuate=true
//   Authorization: Token <key>; body: the WAV.

import { AsrError } from '../errors.mjs'
import { httpRequest, statusToCode } from '../lib/http.mjs'

export const DEFAULT_ENDPOINT = 'https://api.deepgram.com/v1/listen'
export const DEFAULT_MODELS = { zh: 'nova-3', en: 'nova-3', auto: 'nova-3' }
const LANGUAGE = { zh: 'zh-CN', en: 'en' }

export function mapDeepgramError(status) {
  if (status === 400 || status === 415) return 'bad-audio'
  return statusToCode(status)
}

export default {
  type: 'deepgram',
  kind: 'cloud',
  langs: ['zh', 'en', 'auto'],
  maxSeconds: 600,

  validate(c) {
    if (!c.apiKey || typeof c.apiKey !== 'string') throw new Error('deepgram: apiKey is required')
    if (c.models !== undefined && (typeof c.models !== 'object' || Array.isArray(c.models))) throw new Error('deepgram: models must be {zh, en, auto}')
    if (c.endpoint !== undefined && !/^https?:\/\//.test(c.endpoint)) throw new Error('deepgram: endpoint must be http(s)://…')
  },

  async recognize({ wav, lang, signal, config }) {
    const u = new URL(config.endpoint || DEFAULT_ENDPOINT)
    u.searchParams.set('model', { ...DEFAULT_MODELS, ...(config.models || {}) }[lang] || 'nova-3')
    if (lang === 'auto') u.searchParams.set('detect_language', 'true')
    else u.searchParams.set('language', LANGUAGE[lang])
    u.searchParams.set('smart_format', 'true')
    u.searchParams.set('punctuate', 'true')
    const r = await httpRequest(u.href, {
      method: 'POST', signal, body: wav,
      headers: { Authorization: `Token ${config.apiKey}`, 'Content-Type': 'audio/wav' },
    })
    if (r.status === 200) {
      const ch = r.json?.results?.channels?.[0]
      const text = ch?.alternatives?.[0]?.transcript
      if (typeof text !== 'string') throw new AsrError('engine-error', 'bad-response')
      const detected = typeof ch.detected_language === 'string' ? ch.detected_language.slice(0, 2) : undefined
      return { text, lang: detected === 'zh' || detected === 'en' ? detected : undefined }
    }
    const code = r.json?.err_code ? `:${String(r.json.err_code)}` : ''
    throw new AsrError(mapDeepgramError(r.status), `http-${r.status}${code}`)
  },
}
