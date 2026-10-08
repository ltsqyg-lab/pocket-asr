#!/usr/bin/env node
// Stand-in for sherpa-onnx-offline / whisper-cli / vosk-transcriber in tests. Behaviour from FAKE_MODE; it records
// what it was given (argv, cwd, file and directory permissions) to FAKE_LOG.
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const kind = path.basename(process.argv[1]).replace(/\.mjs$/, "")          // fake-sherpa | fake-whisper | fake-vosk (copies made by the tests)
const mode = process.env.FAKE_MODE || 'ok'
const wavArg = argv.find((a) => a.endsWith('.wav'))
const wav = wavArg && fs.existsSync(wavArg) ? fs.readFileSync(wavArg) : null
if (process.env.FAKE_LOG) {
  fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({
    kind, argv, cwd: process.cwd(), pid: process.pid,
    wavBytes: wav ? wav.length : null,
    wavMode: wavArg ? (fs.statSync(wavArg).mode & 0o777) : null,
    dirMode: wavArg ? (fs.statSync(path.dirname(wavArg)).mode & 0o777) : null,
    riff: wav ? wav.toString('latin1', 0, 4) + '/' + wav.readUInt32LE(40) : null,
  }))
}
if (mode === 'sleep') { setTimeout(() => {}, 60_000); }
else if (mode === 'crash') { process.stderr.write('model load failed\n'); process.exit(3) }
else if (kind === 'fake-sherpa') {
  process.stderr.write('OfflineRecognizerConfig(...)\nCreating recognizer ...\n')
  const json = JSON.stringify({ lang: '<|zh|>', emotion: '<|NEUTRAL|>', event: '<|Speech|>', text: mode === 'empty' ? '' : '开放时间 早上9点至下午5点。', timestamps: [0.1], tokens: ['开'], words: [] })
  process.stderr.write(`${wavArg}\n`)
  if (mode === 'stderr-json') process.stderr.write(json + '\n'); else process.stdout.write(json + '\n')
  process.stderr.write('----\nnum threads: 2\nElapsed seconds: 0.123 s\nReal time factor (RTF): 0.123 / 1.200 = 0.103\n')
} else if (kind === 'fake-whisper') {
  process.stdout.write(mode === 'empty' ? '[BLANK_AUDIO]\n' : ' 你好 世界\n[BLANK_AUDIO]\n')
} else if (kind === 'fake-vosk') {
  const i = argv.indexOf('-o')
  fs.writeFileSync(argv[i + 1], mode === 'empty' ? '\n' : '你 好 世 界\n')
}
