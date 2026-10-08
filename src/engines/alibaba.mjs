// Alibaba Cloud Intelligent Speech Interaction (阿里云 智能语音交互), one-sentence recognition (一句话识别) RESTful API:
//   POST https://nls-gateway-<region>.aliyuncs.com/stream/v1/asr?appkey=…&format=pcm&sample_rate=16000
//   header X-NLS-Token: <token>; body: raw PCM; ≤ 60 s.
// The token comes from the POP API CreateToken (HMAC-SHA1 RPC signature) and is cached until shortly before it expires.

import crypto from 'node:crypto'
import { AsrError } from '../errors.mjs'
import { httpRequest, statusToCode } from '../lib/http.mjs'

const tokens = new Map()   // accessKeyId|tokenEndpoint → { id, exp (ms) }

/** POP percent-encoding: RFC 3986 unreserved characters stay, everything else is %XX (space = %20, * = %2A). */
export function percentEncode(s) {
  return encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

/** RPC-style signature: Base64(HMAC-SHA1(secret + "&", METHOD & %2F & percentEncode(sorted canonical query))). */
export function popSignature(params, secret, method = 'GET') {
  const canonical = Object.keys(params).sort().map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`).join('&')
  const stringToSign = `${method}&${percentEncode('/')}&${percentEncode(canonical)}`
  return { canonical, stringToSign, signature: crypto.createHmac('sha1', `${secret}&`).update(stringToSign).digest('base64') }
}

const isIntl = (region) => !/^cn-/.test(region)
export const gatewayUrl = (region) => `https://nls-gateway-${region}.aliyuncs.com/stream/v1/asr`
export const tokenUrl = (region) => (isIntl(region) ? `https://nls-meta.${region}.aliyuncs.com/` : 'https://nls-meta.cn-shanghai.aliyuncs.com/')

function langsOf(c) {
  if (c.appkeys) return Object.keys(c.appkeys).filter((l) => ['zh', 'en', 'auto'].includes(l) && c.appkeys[l])
  return Array.isArray(c.langs) && c.langs.length ? c.langs : ['zh']
}

function appkeyFor(config, lang) {
  if (!langsOf(config).includes(lang)) return null
  return config.appkeys ? config.appkeys[lang] : config.appkey
}

async function getToken(config, signal, fresh = false) {
  const region = config.region || 'cn-shanghai'
  const endpoint = config.tokenEndpoint || tokenUrl(region)
  const cacheKey = `${config.accessKeyId}|${endpoint}`
  const hit = tokens.get(cacheKey)
  if (!fresh && hit && hit.exp - Date.now() > 300_000) return { id: hit.id, cached: true }
  const params = {
    AccessKeyId: config.accessKeyId,
    Action: 'CreateToken',
    Format: 'JSON',
    RegionId: isIntl(region) ? region : 'cn-shanghai',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: crypto.randomUUID(),
    SignatureVersion: '1.0',
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Version: '2019-02-28',
  }
  const { canonical, signature } = popSignature(params, config.accessKeySecret)
  const r = await httpRequest(`${endpoint}?${canonical}&Signature=${percentEncode(signature)}`, { signal })
  const t = r.json?.Token
  if (r.status !== 200 || !t || typeof t.Id !== 'string' || !Number.isFinite(t.ExpireTime)) {
    throw new AsrError(r.status === 429 ? 'busy' : 'engine-error', `token:${r.json?.Code || `http-${r.status}`}`)
  }
  tokens.set(cacheKey, { id: t.Id, exp: t.ExpireTime * 1000 })
  return { id: t.Id, cached: false }
}

export function mapAlibabaStatus(status) {
  const s = Number(status) || 0
  if (s === 40000005) return 'busy'
  if (s === 41010100 || s === 41010101 || s === 40000003) return 'bad-audio'
  if (s === 40000004) return 'engine-timeout'
  return 'engine-error'
}

export default {
  type: 'alibaba',
  kind: 'cloud',
  langs: ['zh', 'en', 'auto'],
  maxSeconds: 60,

  validate(c) {
    if (!c.accessKeyId || !c.accessKeySecret) throw new Error('alibaba: accessKeyId and accessKeySecret are required')
    if (!c.appkey && !(c.appkeys && typeof c.appkeys === 'object')) throw new Error('alibaba: appkey (or appkeys {zh, en}) is required')
    if (c.region !== undefined && !/^[a-z]{2}-[a-z0-9-]+$/.test(c.region)) throw new Error('alibaba: bad region')
  },

  /** An appkey belongs to one project (one language model): offer only the languages the config names. */
  langsOf,

  async recognize({ pcm, lang, signal, config }) {
    const appkey = appkeyFor(config, lang)
    if (!appkey) throw new AsrError('no-engine', `alibaba:no-appkey-${lang}`)
    const base = config.endpoint || gatewayUrl(config.region || 'cn-shanghai')
    const qs = new URLSearchParams({
      appkey, format: 'pcm', sample_rate: '16000',
      enable_punctuation_prediction: 'true', enable_inverse_text_normalization: 'true',
    })
    for (let attempt = 0; ; attempt++) {
      const tok = await getToken(config, signal, attempt > 0)
      const r = await httpRequest(`${base}?${qs}`, {
        method: 'POST', signal, body: pcm,
        headers: { 'X-NLS-Token': tok.id, 'Content-Type': 'application/octet-stream' },
      })
      const st = Number(r.json?.status) || 0
      if (st === 20000000) return { text: typeof r.json.result === 'string' ? r.json.result : '' }
      if (st === 40000001 && tok.cached && attempt === 0) continue        // cached token rejected: fetch a new one once
      if (st) throw new AsrError(mapAlibabaStatus(st), `provider:${st}`)
      throw new AsrError(statusToCode(r.status), `http-${r.status}`)
    }
  },
}

export const _tokens = tokens   // tests
