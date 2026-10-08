// Engine registry: config "type" → adapter (ASR.md §5.1).

import volcano from './volcano.mjs'
import alibaba from './alibaba.mjs'
import tencent from './tencent.mjs'
import iflytek from './iflytek.mjs'
import openai from './openai.mjs'
import deepgram from './deepgram.mjs'
import azure from './azure.mjs'
import { sherpaOnnx, whisperCpp, vosk } from './local-adapters.mjs'

export const ADAPTERS = Object.fromEntries(
  [volcano, alibaba, tencent, iflytek, openai, deepgram, azure, sherpaOnnx, whisperCpp, vosk].map((a) => [a.type, a]),
)

export const LANGS = ['zh', 'en', 'auto']
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/

/**
 * Build engine instances from the config list.
 * @returns {Map<string, {id, type, kind, langs: string[], maxSeconds: number, adapter, config}>}
 */
export function buildEngines(list, { adapters = ADAPTERS, gatewayMaxSeconds = 240 } = {}) {
  if (!Array.isArray(list) || !list.length) throw new Error('config: "engines" must list at least one engine')
  const out = new Map()
  for (const c of list) {
    if (!c || typeof c !== 'object') throw new Error('config: every engine must be an object')
    if (!ID_RE.test(c.id || '')) throw new Error(`config: engine id "${c.id}" must match ${ID_RE}`)
    if (out.has(c.id)) throw new Error(`config: duplicate engine id "${c.id}"`)
    const adapter = adapters[c.type]
    if (!adapter) throw new Error(`config: engine "${c.id}" has unknown type "${c.type}" (known: ${Object.keys(adapters).join(', ')})`)
    adapter.validate(c)
    const langs = (adapter.langsOf ? adapter.langsOf(c) : adapter.langs).filter((l) => LANGS.includes(l) && adapter.langs.includes(l))
    if (!langs.length) throw new Error(`config: engine "${c.id}" supports none of ${LANGS.join(', ')}`)
    let maxSeconds = Math.min(adapter.maxSeconds, gatewayMaxSeconds)
    if (c.maxSeconds !== undefined) {
      if (!(Number.isFinite(c.maxSeconds) && c.maxSeconds > 0)) throw new Error(`config: engine "${c.id}" maxSeconds must be a positive number`)
      maxSeconds = Math.min(maxSeconds, c.maxSeconds)
    }
    out.set(c.id, { id: c.id, type: c.type, kind: adapter.kind, langs, maxSeconds, adapter, config: c })
  }
  return out
}

/** Which engine answers `lang` (optionally a named one): `no-engine` when none fits. */
export function pickEngine(engines, defaults, lang, wanted) {
  if (wanted) {
    const e = engines.get(wanted)
    return e && e.langs.includes(lang) ? e : null
  }
  const d = defaults?.[lang] && engines.get(defaults[lang])
  if (d && d.langs.includes(lang)) return d
  for (const e of engines.values()) if (e.langs.includes(lang)) return e
  return null
}
