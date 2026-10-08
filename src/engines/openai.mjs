// OpenAI speech to text, or any compatible endpoint:
//   POST <baseUrl>/audio/transcriptions   (multipart: file, model, language?, response_format=json)
// `baseUrl` follows the OpenAI SDK convention and includes the version path (default https://api.openai.com/v1),
// so compatible services are configured the same way (e.g. https://api.groq.com/openai/v1).

import { AsrError } from '../errors.mjs'
import { httpRequest, statusToCode } from '../lib/http.mjs'

export const DEFAULT_BASE = 'https://api.openai.com/v1'
export const DEFAULT_MODEL = 'gpt-4o-transcribe'

export function mapOpenaiError(status, err) {
  const code = String(err?.code || err?.type || '')
  if (status === 429) return code === 'insufficient_quota' ? 'engine-error' : 'busy'
  if (status === 400 || status === 415) return /too_short|invalid_value|unsupported|audio|file/i.test(code + ' ' + (err?.param || '')) ? 'bad-audio' : 'engine-error'
  if (status === 413) return 'too-long'
  return statusToCode(status)
}

export default {
  type: 'openai',
  kind: 'cloud',
  langs: ['zh', 'en', 'auto'],
  maxSeconds: 600,

  validate(c) {
    if (!c.apiKey || typeof c.apiKey !== 'string') throw new Error('openai: apiKey is required')
    if (c.baseUrl !== undefined && !/^https?:\/\//.test(c.baseUrl)) throw new Error('openai: baseUrl must be http(s)://…')
    if (c.model !== undefined && typeof c.model !== 'string') throw new Error('openai: model must be a string')
  },

  async recognize({ wav, lang, signal, config }) {
    const fd = new FormData()
    fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav')
    fd.append('model', config.model || DEFAULT_MODEL)
    if (lang === 'zh' || lang === 'en') fd.append('language', lang)
    fd.append('response_format', 'json')
    if (config.prompt) fd.append('prompt', String(config.prompt).slice(0, 1000))
    const headers = { Authorization: `Bearer ${config.apiKey}` }
    if (config.organization) headers['OpenAI-Organization'] = config.organization
    if (config.project) headers['OpenAI-Project'] = config.project
    const base = (config.baseUrl || DEFAULT_BASE).replace(/\/+$/, '')
    const r = await httpRequest(`${base}/audio/transcriptions`, { method: 'POST', headers, body: fd, signal })
    if (r.status === 200 && typeof r.json?.text === 'string') return { text: r.json.text }
    const err = r.json?.error
    throw new AsrError(mapOpenaiError(r.status, err), `http-${r.status}${err?.code ? `:${err.code}` : ''}`)
  },
}
