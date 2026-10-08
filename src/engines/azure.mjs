// Azure AI Speech, REST API for short audio (≤ 60 s):
//   POST https://<region>.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=zh-CN&format=simple
//   (or <endpoint>/speech/recognition/conversation/cognitiveservices/v1 for a resource endpoint such as
//    https://<name>.cognitiveservices.azure.com/stt)
//   header Ocp-Apim-Subscription-Key; Content-Type: audio/wav; codecs=audio/pcm; samplerate=16000.

import { AsrError } from '../errors.mjs'
import { httpRequest, statusToCode } from '../lib/http.mjs'

export const DEFAULT_LANGS = { zh: 'zh-CN', en: 'en-US' }
const PATH = '/speech/recognition/conversation/cognitiveservices/v1'

export function azureUrl(config) {
  if (config.endpoint) return config.endpoint.replace(/\/+$/, '') + PATH
  return `https://${config.region}.stt.speech.microsoft.com${PATH}`
}

export function mapAzureStatus(s) {
  if (s === 'NoMatch' || s === 'InitialSilenceTimeout' || s === 'BabbleTimeout') return 'empty'
  return 'engine-error'
}

export default {
  type: 'azure',
  kind: 'cloud',
  langs: ['zh', 'en'],
  maxSeconds: 60,

  validate(c) {
    if (!c.key || typeof c.key !== 'string') throw new Error('azure: key is required')
    if (!c.endpoint && !(typeof c.region === 'string' && /^[a-z0-9]+$/.test(c.region))) throw new Error('azure: region (e.g. eastasia) or endpoint is required')
    if (c.endpoint !== undefined && !/^https?:\/\//.test(c.endpoint)) throw new Error('azure: endpoint must be http(s)://…')
  },

  langsOf(c) { return Object.keys({ ...DEFAULT_LANGS, ...(c.languages || {}) }) },

  async recognize({ wav, lang, signal, config }) {
    const language = { ...DEFAULT_LANGS, ...(config.languages || {}) }[lang]
    if (!language) throw new AsrError('no-engine', `azure:no-lang-${lang}`)
    const u = new URL(azureUrl(config))
    u.searchParams.set('language', language)
    u.searchParams.set('format', 'simple')
    u.searchParams.set('profanity', config.profanity || 'raw')
    const r = await httpRequest(u.href, {
      method: 'POST', signal, body: wav,
      headers: {
        'Ocp-Apim-Subscription-Key': config.key,
        'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
        Accept: 'application/json',
      },
    })
    if (r.status === 200 && r.json && typeof r.json.RecognitionStatus === 'string') {
      if (r.json.RecognitionStatus === 'Success') return { text: typeof r.json.DisplayText === 'string' ? r.json.DisplayText : '' }
      throw new AsrError(mapAzureStatus(r.json.RecognitionStatus), `status:${r.json.RecognitionStatus}`)
    }
    if (r.status === 400) throw new AsrError('bad-audio', 'http-400')
    throw new AsrError(statusToCode(r.status), `http-${r.status}`)
  },
}
