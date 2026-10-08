// Tencent Cloud ASR (腾讯云 语音识别), one-sentence recognition (一句话识别):
//   API 3.0 action SentenceRecognition, version 2019-06-14, https://asr.tencentcloudapi.com, TC3-HMAC-SHA256;
//   base64 WAV in the JSON body (SourceType 1); ≤ 60 s, ≤ 3 MB.

import crypto from 'node:crypto'
import { AsrError } from '../errors.mjs'
import { httpRequest, statusToCode } from '../lib/http.mjs'

const SERVICE = 'asr'
const ACTION = 'SentenceRecognition'
const VERSION = '2019-06-14'
const CONTENT_TYPE = 'application/json; charset=utf-8'
export const DEFAULT_ENDPOINT = 'https://asr.tencentcloudapi.com'
export const DEFAULT_ENGINES = { zh: '16k_zh', en: '16k_en', auto: '16k_zh-PY' }

const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex')
const hmac = (key, s) => crypto.createHmac('sha256', key).update(s).digest()

/** TC3-HMAC-SHA256 (Tencent Cloud API 3.0 signature v3) for a POST with an empty query string. */
export function tc3Authorization({ secretId, secretKey, service, host, timestamp, payload, contentType = CONTENT_TYPE }) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10)
  const canonicalRequest = ['POST', '/', '', `content-type:${contentType}\nhost:${host}\n`, 'content-type;host', sha256hex(payload)].join('\n')
  const scope = `${date}/${service}/tc3_request`
  const stringToSign = ['TC3-HMAC-SHA256', String(timestamp), scope, sha256hex(canonicalRequest)].join('\n')
  const kDate = hmac(`TC3${secretKey}`, date)
  const kService = hmac(kDate, service)
  const kSigning = hmac(kService, 'tc3_request')
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex')
  return {
    canonicalRequest, stringToSign, signature,
    authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${scope}, SignedHeaders=content-type;host, Signature=${signature}`,
  }
}

export function mapTencentError(code) {
  const c = String(code || '')
  if (/^(RequestLimitExceeded|LimitExceeded)/.test(c)) return 'busy'
  if (c === 'InvalidParameterValue.ErrorVoicedataTooLong') return 'too-long'
  if (/^InvalidParameterValue\.(ErrorInvalidVoiceFormat|ErrorInvalidVoicedata|ErrorVoicedataTooShort)/.test(c)) return 'bad-audio'
  return 'engine-error'
}

export default {
  type: 'tencent',
  kind: 'cloud',
  langs: ['zh', 'en', 'auto'],
  maxSeconds: 60,

  validate(c) {
    if (!c.secretId || !c.secretKey) throw new Error('tencent: secretId and secretKey are required')
    if (c.engines !== undefined && (typeof c.engines !== 'object' || Array.isArray(c.engines))) throw new Error('tencent: engines must be {zh, en, auto}')
  },

  langsOf(c) { return Object.keys({ ...DEFAULT_ENGINES, ...(c.engines || {}) }).filter((l) => ({ ...DEFAULT_ENGINES, ...(c.engines || {}) })[l]) },

  async recognize({ wav, lang, signal, config }) {
    const engines = { ...DEFAULT_ENGINES, ...(config.engines || {}) }
    const engine = engines[lang]
    if (!engine) throw new AsrError('no-engine', `tencent:no-engine-${lang}`)
    const endpoint = config.endpoint || DEFAULT_ENDPOINT
    const host = new URL(endpoint).host
    const payload = JSON.stringify({
      EngSerViceType: engine, SourceType: 1, VoiceFormat: 'wav',
      Data: wav.toString('base64'), DataLen: wav.length,
      ConvertNumMode: 1, FilterDirty: 0, FilterModal: 0, FilterPunc: 0, WordInfo: 0,
    })
    const timestamp = Math.floor(Date.now() / 1000)
    const { authorization } = tc3Authorization({ secretId: config.secretId, secretKey: config.secretKey, service: SERVICE, host, timestamp, payload })
    const headers = {
      Authorization: authorization, 'Content-Type': CONTENT_TYPE,
      'X-TC-Action': ACTION, 'X-TC-Version': VERSION, 'X-TC-Timestamp': String(timestamp),
    }
    if (config.region) headers['X-TC-Region'] = config.region
    const r = await httpRequest(endpoint, { method: 'POST', headers, body: payload, signal })
    const resp = r.json?.Response
    if (resp?.Error) throw new AsrError(mapTencentError(resp.Error.Code), `provider:${resp.Error.Code}`)
    if (r.status !== 200 || !resp) throw new AsrError(statusToCode(r.status), `http-${r.status}`)
    return { text: typeof resp.Result === 'string' ? resp.Result : '' }
  },
}
