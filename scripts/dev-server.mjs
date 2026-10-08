#!/usr/bin/env node
// Development / lab entry point: the normal gateway plus a `lab-echo` engine that needs no keys and no model
// (it answers with a fixed sentence and the audio length), so clients can be tested end to end.
//
//   node scripts/dev-server.mjs --config <file.json>

import { createGateway, VERSION } from '../src/server.mjs'
import { ADAPTERS } from '../src/engines/index.mjs'
import { ensureConfiguredModels } from '../src/models.mjs'

const labEcho = {
  type: 'lab-echo',
  kind: 'cloud',
  langs: ['zh', 'en', 'auto'],
  maxSeconds: 240,
  validate() {},
  async recognize({ seconds, lang, signal }) {
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, 150)
      signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) }, { once: true })
    })
    return lang === 'en' ? { text: `lab transcript of ${seconds.toFixed(1)} s` } : { text: `实验台识别结果,音频 ${seconds.toFixed(1)} 秒`, lang: lang === 'auto' ? 'zh' : lang }
  },
}

const i = process.argv.indexOf('--config')
const file = i >= 0 ? process.argv[i + 1] : process.env.ASR_CONFIG
if (!file) { process.stderr.write('usage: node scripts/dev-server.mjs --config <file.json>\n'); process.exit(2) }
await ensureConfiguredModels(file, { log: (m) => process.stdout.write(`${new Date().toISOString()} models ${m}\n`) })
const gw = createGateway(file, { adapters: { ...ADAPTERS, 'lab-echo': labEcho } })
const addr = await gw.listen()
const engines = [...gw.engines.values()].map((e) => `${e.id}(${e.type})`).join(' ')
process.stdout.write(`${new Date().toISOString()} pocket-asr ${VERSION} (lab) gw=${gw.config.gatewayId} listening ${gw.config.tls ? 'https' : 'http'}://${addr.address}:${addr.port} auth=${gw.auth.methods.join('+')} engines=${engines}\n`)
const stop = async () => { await gw.close(); process.exit(0) }
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
