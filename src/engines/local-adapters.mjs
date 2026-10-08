// Gateway adapters for the three local engines: thin wrappers around transcribeLocal (local.mjs).

import fs from 'node:fs'
import { transcribeLocal, resolveModel, LocalAsrError } from './local.mjs'
import { AsrError } from '../errors.mjs'
import { abortError } from '../lib/http.mjs'

const CODE = { 'no-engine': 'engine-error', 'bad-audio': 'bad-audio', 'empty': 'empty', 'engine-timeout': 'engine-timeout', 'engine-error': 'engine-error' }

function make(type, langsFor) {
  return {
    type,
    kind: 'local',
    langs: ['zh', 'en', 'auto'],
    maxSeconds: 240,

    validate(c) {
      if (typeof c.bin !== 'string' || !fs.existsSync(c.bin)) throw new Error(`${type}: program not found (bin)`)
      try { resolveModel(type, c.model) } catch (e) { throw new Error(`${type}: model not usable (${e.detail || e.code})`) }
      if (c.threads !== undefined && !(Number.isInteger(c.threads) && c.threads >= 1 && c.threads <= 16)) throw new Error(`${type}: threads must be 1–16`)
      if (c.langs !== undefined && (!Array.isArray(c.langs) || !c.langs.length || c.langs.some((l) => !['zh', 'en', 'auto'].includes(l)))) {
        throw new Error(`${type}: langs must list zh / en / auto`)
      }
    },

    langsOf(c) { return Array.isArray(c.langs) && c.langs.length ? c.langs : langsFor(c) },

    async recognize({ wav, lang, signal, config }) {
      try {
        const r = await transcribeLocal({
          engine: type, bin: config.bin, model: config.model, wav, lang, threads: config.threads ?? 2,
          tmpDir: config.tmpDir, signal, env: config.env, silencePeak: 0,
        })
        return { text: r.text, lang: r.lang }
      } catch (e) {
        if (e instanceof LocalAsrError) {
          if (e.code === 'aborted') throw abortError()
          throw new AsrError(CODE[e.code] || 'engine-error', `local:${e.detail || e.code}`)
        }
        throw e
      }
    },
  }
}

export const sherpaOnnx = make('sherpa-onnx', (c) => {
  try { return resolveModel('sherpa-onnx', c.model).kind === 'sense-voice' ? ['zh', 'en', 'auto'] : ['zh'] } catch { return ['zh'] }
})
export const whisperCpp = make('whisper.cpp', () => ['zh', 'en', 'auto'])
export const vosk = make('vosk', () => ['zh'])          // a Vosk model is one language: say which in "langs"
