#!/usr/bin/env node
// pocket-asr helper commands.
//
//   node src/cli.mjs token [label]                    new random token; prints it once plus the config entry (hash only)
//   node src/cli.mjs check <config.json>              load the config, validate every engine, print what /v1/info will say
//   node src/cli.mjs models                           list installable models and engine programs
//   node src/cli.mjs install-model <id> <target>      download + verify + unpack a model (target = directory, or file for ggml)
//   node src/cli.mjs install-engine <engine> <dir>    download + verify + unpack an engine program for this platform
//   node src/cli.mjs transcribe <config.json> <file.wav> [lang] [engine]   one recognition through the configured engines
//
// Add --allow-unverified to install a file that has no pinned SHA-256 (not recommended).

import crypto from 'node:crypto'
import fs from 'node:fs'
import { hashToken } from './auth.mjs'
import { loadManifest, installModel, installEngine, platformKey } from './models.mjs'

const [cmd, ...rest] = process.argv.slice(2)
const flags = new Set(rest.filter((a) => a.startsWith('--')))
const args = rest.filter((a) => !a.startsWith('--'))
const out = (s) => process.stdout.write(s + '\n')

async function main() {
  if (cmd === 'token') {
    const label = args[0] || 'my phone'
    const token = crypto.randomBytes(32).toString('base64url')
    out(`token (shown once — put it into the Pocket App, Settings → Voice → My own gateway):\n\n  ${token}\n`)
    out(`config entry for auth.tokens:\n\n  ${JSON.stringify({ label, sha256: hashToken(token) })}\n`)
    return
  }
  if (cmd === 'check') {
    const { createGateway } = await import('./server.mjs')
    const gw = createGateway(args[0])
    out(JSON.stringify(gw.info(), null, 2))
    await gw.close()
    return
  }
  if (cmd === 'models') {
    const m = loadManifest()
    out(`this platform: ${platformKey()}\n\nmodels:`)
    for (const [id, x] of Object.entries(m.models)) out(`  ${id.padEnd(20)} ${x.engine.padEnd(12)} ${String(Math.round(x.size / 1048576)).padStart(4)} MB  ${x.langs.join('/').padEnd(10)} ${x.recommended ? '(recommended) ' : ''}${x.title}`)
    out('\nengine programs:')
    for (const [id, e] of Object.entries(m.engines)) out(`  ${id.padEnd(12)} ${Object.keys(e.binaries).join(', ') || '—'}  ${e.howto}`)
    return
  }
  if (cmd === 'install-model') {
    if (args.length < 2) throw new Error('usage: install-model <id> <target>')
    const p = await installModel(args[0], args[1], { log: out, allowUnverified: flags.has('--allow-unverified') })
    out(p)
    return
  }
  if (cmd === 'install-engine') {
    if (args.length < 2) throw new Error('usage: install-engine <engine> <dir>')
    const bin = await installEngine(args[0], args[1], { log: out, allowUnverified: flags.has('--allow-unverified') })
    out(bin)
    return
  }
  if (cmd === 'transcribe') {
    const { createGateway } = await import('./server.mjs')
    const { parseWav, pcmToWav } = await import('./wav.mjs')
    const { pickEngine } = await import('./engines/index.mjs')
    const gw = createGateway(args[0])
    try {
      const w = parseWav(fs.readFileSync(args[1]))
      const lang = args[2] || 'auto'
      const e = pickEngine(gw.engines, gw.config.default, lang, args[3] || null)
      if (!e) throw new Error(`no engine for ${lang}`)
      const t0 = Date.now()
      const r = await e.adapter.recognize({ pcm: w.pcm, wav: pcmToWav(w.pcm), sampleRate: 16000, seconds: w.seconds, lang, signal: AbortSignal.timeout(30_000 + w.seconds * 1000), config: e.config, uid: 'cli' })
      out(JSON.stringify({ engine: e.id, ms: Date.now() - t0, ...r }))
    } finally { await gw.close() }
    return
  }
  out('commands: token | check | models | install-model | install-engine | transcribe   (see the top of src/cli.mjs)')
  process.exitCode = 2
}

main().catch((e) => { process.stderr.write(`pocket-asr: ${e.message}\n`); process.exit(1) })
