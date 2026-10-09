// transcribeLocal (ASR.md §5.3) with fake programs: argument arrays (no shell), private temp files that are always
// deleted, kill on timeout and abort, result parsing per engine, error codes; plus the gateway's local adapters.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { transcribeLocal, LocalAsrError, resolveModel, buildArgs, parseOutput, tidy, asciiRelative, winShellLine } from '../src/engines/local.mjs'
import { toneWav, silentWav, tmpDir, startGateway, baseConfig, post, TOKEN, wavWithChunks, tonePcm } from './helpers.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const root = tmpDir('asr-local-')
const bins = {}
for (const k of ['sherpa', 'whisper', 'vosk']) {
  bins[k] = path.join(root, `fake-${k}.mjs`)
  fs.copyFileSync(path.join(HERE, 'fake-bin', 'fake-engine.mjs'), bins[k])
  fs.chmodSync(bins[k], 0o755)
}
const models = path.join(root, 'models')
const sv = path.join(models, 'sense-voice'); fs.mkdirSync(sv, { recursive: true })
fs.writeFileSync(path.join(sv, 'tokens.txt'), '<unk> 0\n<|zh|> 1\n<|en|> 2\n开 3\n'); fs.writeFileSync(path.join(sv, 'model.int8.onnx'), 'x')
const pf = path.join(models, 'paraformer'); fs.mkdirSync(pf)
fs.writeFileSync(path.join(pf, 'tokens.txt'), '<blank> 0\n开 1\n'); fs.writeFileSync(path.join(pf, 'model.onnx'), 'x')
const ggml = path.join(models, 'ggml-base.bin'); fs.writeFileSync(ggml, 'x')
const vk = path.join(models, 'vosk-small-cn'); fs.mkdirSync(vk)
const logFile = path.join(root, 'fake.log')
const readLog = () => JSON.parse(fs.readFileSync(logFile, 'utf8'))
const made = []
const work = () => { const d = tmpDir('asr-work-'); made.push(d); return d }
const leftovers = (d) => fs.readdirSync(d)
const env = (mode = 'ok') => ({ FAKE_MODE: mode, FAKE_LOG: logFile })
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const codeOf = async (p) => { try { await p; return 'resolved' } catch (e) { assert.ok(e instanceof LocalAsrError, String(e)); return e.code } }

test.after(() => { for (const d of [root, ...made]) fs.rmSync(d, { recursive: true, force: true }) })

test('sherpa-onnx SenseVoice: arguments, private temp file (0700 dir, 0600 file, canonical WAV), JSON on stdout, tidy text, cleanup', async () => {
  const dir = work()
  const r = await transcribeLocal({ engine: 'sherpa-onnx', bin: bins.sherpa, model: sv, wav: wavWithChunks(tonePcm(1)), lang: 'zh', threads: 3, tmpDir: dir, env: env() })
  assert.equal(r.text, '开放时间早上9点至下午5点。')
  assert.equal(r.lang, 'zh')
  assert.equal(typeof r.ms, 'number')
  const log = readLog()
  const file = log.argv.at(-1)
  assert.deepEqual(log.argv.slice(0, -1), [`--tokens=${path.join(sv, 'tokens.txt')}`, `--sense-voice-model=${path.join(sv, 'model.int8.onnx')}`,
    '--sense-voice-language=zh', '--sense-voice-use-itn=1', '--num-threads=3', '--debug=0'])
  assert.ok(file.startsWith(dir + path.sep) && /pocket-asr-[^/]+\/[0-9a-f]{24}\.wav$/.test(file))
  assert.equal(log.dirMode, 0o700)
  assert.equal(log.wavMode, 0o600)
  assert.equal(log.riff, 'RIFF/32000', 'extra chunks dropped: the program gets a canonical 44-byte header')
  assert.ok(log.cwd.endsWith(path.sep + path.basename(path.dirname(file))), 'the program runs inside the private directory')
  assert.deepEqual(leftovers(dir), [], 'temp directory removed after success')
  assert.equal(fs.existsSync(file), false)
})

test('sherpa-onnx Paraformer (model.onnx fallback), the object form, auto language, old versions printing JSON on stderr', async () => {
  const dir = work()
  await transcribeLocal({ engine: 'sherpa-onnx', bin: bins.sherpa, model: pf, wav: toneWav(1), lang: 'en', tmpDir: dir, env: env() })
  assert.deepEqual(readLog().argv.slice(0, -1), [`--tokens=${path.join(pf, 'tokens.txt')}`, `--paraformer=${path.join(pf, 'model.onnx')}`, '--num-threads=2', '--decoding-method=greedy_search', '--debug=0'])
  await transcribeLocal({ engine: 'sherpa-onnx', bin: bins.sherpa, model: { kind: 'sense-voice', model: path.join(sv, 'model.int8.onnx'), tokens: path.join(sv, 'tokens.txt') }, wav: toneWav(1), lang: 'auto', tmpDir: dir, env: env() })
  assert.ok(readLog().argv.includes('--sense-voice-language=auto'))
  const r = await transcribeLocal({ engine: 'sherpa-onnx', bin: bins.sherpa, model: sv, wav: toneWav(1), tmpDir: dir, env: env('stderr-json') })
  assert.equal(r.text, '开放时间早上9点至下午5点。')
  assert.deepEqual(leftovers(dir), [])
})

test('SenseVoice is never told "en" (Chinese speech then comes out as nonsense): zh stays zh, everything else is auto', async () => {
  const m = { kind: 'sense-voice', model: 'model.int8.onnx', tokens: 'tokens.txt' }
  const svLang = (lang) => buildArgs('sherpa-onnx', m, { file: 'a.wav', lang }).find((a) => a.startsWith('--sense-voice-language='))
  assert.equal(svLang('zh'), '--sense-voice-language=zh')
  for (const l of ['en', 'auto', undefined, 'yue', 'fr']) assert.equal(svLang(l), '--sense-voice-language=auto', String(l))
  const dir = work()
  await transcribeLocal({ engine: 'sherpa-onnx', bin: bins.sherpa, model: sv, wav: toneWav(1), lang: 'en', tmpDir: dir, env: env() })
  assert.ok(readLog().argv.includes('--sense-voice-language=auto'))
  assert.ok(!readLog().argv.some((a) => a.endsWith('=en')))
})

test('Windows: ASCII relative paths when a path has non-ASCII characters (sherpa-onnx cannot open those)', () => {
  const home = 'C:\\Users\\张三\\.pocket\\asr', mdl = `${home}\\models\\sense-voice-int8-2024`
  const files = [`${mdl}\\model.int8.onnx`, `${mdl}\\tokens.txt`, `${home}\\tmp\\pocket-asr-Ab12Cd\\0a1b2c.wav`, `${home}\\tmp\\pocket-asr-Ab12Cd\\0a1b2c.txt`]
  const r = asciiRelative(files)
  assert.equal(r.cwd, home, 'the deepest directory holding every file')
  assert.deepEqual(files.map(r.rel), ['models\\sense-voice-int8-2024\\model.int8.onnx', 'models\\sense-voice-int8-2024\\tokens.txt',
    'tmp\\pocket-asr-Ab12Cd\\0a1b2c.wav', 'tmp\\pocket-asr-Ab12Cd\\0a1b2c.txt'])
  assert.equal(r.rel('C:\\other'), 'C:\\other', 'paths it was not given are left alone')
  // Windows ignores case and accepts / as well
  const r2 = asciiRelative(['c:/users/张三/.pocket/asr/models/m/tokens.txt', 'C:\\Users\\张三\\.pocket\\asr\\tmp\\p\\a.wav'])
  assert.equal(r2.cwd.toLowerCase(), home.toLowerCase())
  assert.deepEqual(['c:/users/张三/.pocket/asr/models/m/tokens.txt', 'C:\\Users\\张三\\.pocket\\asr\\tmp\\p\\a.wav'].map(r2.rel), ['models\\m\\tokens.txt', 'tmp\\p\\a.wav'])
  // a model directory (Vosk) among the files; .. is resolved first
  const r3 = asciiRelative(['C:\\Users\\张三\\models\\vosk-cn', 'C:\\Users\\张三\\x\\..\\tmp\\p\\a.wav'])
  assert.deepEqual([r3?.cwd, r3?.rel('C:\\Users\\张三\\models\\vosk-cn'), r3?.rel('C:\\Users\\张三\\x\\..\\tmp\\p\\a.wav')], ['C:\\Users\\张三', 'models\\vosk-cn', 'tmp\\p\\a.wav'])
  const r4 = asciiRelative(['C:\\Users\\Zoë\\m\\tokens.txt', 'C:\\Users\\Zoë\\tmp\\a.wav'])
  assert.equal(r4.cwd, 'C:\\Users\\Zoë')
  assert.equal(asciiRelative(['C:\\pocket\\models\\m\\tokens.txt', 'C:\\pocket\\tmp\\a.wav']), null, 'all ASCII: absolute paths as before')
  assert.equal(asciiRelative(['C:\\Users\\张三\\m\\tokens.txt', 'D:\\tmp\\a.wav']), null, 'different drives: nothing helps')
  assert.equal(asciiRelative(['C:\\Users\\张三\\模型\\tokens.txt', 'C:\\Users\\张三\\tmp\\a.wav']), null, 'a non-ASCII name below the shared directory')
})

test('Windows: the cmd.exe line quotes every argument; anything cmd.exe would still read means a direct start', () => {
  const bin = 'C:\\Users\\张三\\.pocket\\asr\\sherpa-onnx\\bin\\sherpa-onnx-offline.exe'
  assert.equal(winShellLine(bin, ['--tokens=models\\m\\tokens.txt', '--num-threads=2', 'tmp\\p\\a.wav'], 'C:\\Users\\张三\\.pocket\\asr'),
    `""${bin}" "--tokens=models\\m\\tokens.txt" "--num-threads=2" "tmp\\p\\a.wav""`)
  assert.ok(winShellLine('C:\\a b & c\\x.exe', ['^!()<>|&', 'd e'], 'C:\\a b & c'), 'cmd.exe specials are plain text inside quotes (/v:off: ! too)')
  for (const bad of ['say "hi"', '100%', '%PATH%', 'C:\\dir\\', 'a\nb', 'a\rb', '']) assert.equal(winShellLine('C:\\x.exe', ['--x', bad], 'C:\\'), null, JSON.stringify(bad))
  assert.equal(winShellLine('C:\\50%\\x.exe', ['a'], 'C:\\'), null, 'the program path too')
  assert.equal(winShellLine('C:\\x.exe', ['a'], '\\\\server\\share\\asr'), null, 'cmd.exe refuses a UNC working directory')
})

test('the cmd.exe start falls back to a direct start: launcher cannot start / exits non-zero without a result → run directly; results, timeouts and aborts are never retried', { skip: process.platform === 'win32' && 'needs /bin/sh as the stand-in launcher' }, async () => {
  const dir = work()
  const seen = []
  const base = { engine: 'sherpa-onnx', bin: bins.sherpa, model: sv, wav: toneWav(1), lang: 'zh', tmpDir: dir, env: env(), onFallback: (x) => seen.push(x.reason) }
  const sh = (script) => () => ({ file: '/bin/sh', args: ['-c', script] })          // stands in for cmd.exe
  // the launcher ran but the program never did (cmd.exe: "not recognized", mangled arguments …) → the program directly
  fs.rmSync(logFile, { force: true })
  const r1 = await transcribeLocal({ ...base, launch: sh('echo "The system cannot find the path specified." >&2; exit 1') })
  assert.equal(r1.text, '开放时间早上9点至下午5点。')
  assert.deepEqual(seen, ['exit-1'])
  assert.ok(fs.existsSync(logFile) && readLog().argv.includes('--sense-voice-language=zh'), 'the retry ran the program itself, same arguments')
  // the launcher cannot be started at all → the program directly
  const r2 = await transcribeLocal({ ...base, launch: () => ({ file: path.join(root, 'no-such-cmd.exe'), args: ['/c', 'x'] }) })
  assert.equal(r2.text, '开放时间早上9点至下午5点。')
  assert.equal(seen.at(-1), 'spawn-ENOENT')
  // what the program itself reported is final: a result with a non-zero exit, an empty result ("didn't catch that")
  fs.rmSync(logFile, { force: true })
  assert.equal(await codeOf(transcribeLocal({ ...base, launch: sh(`echo '{"lang": "<|zh|>", "text": "x"}'; exit 2`) })), 'engine-error')
  assert.equal(await codeOf(transcribeLocal({ ...base, launch: sh(`echo '{"lang": "<|zh|>", "text": ""}'`) })), 'empty')
  assert.equal(fs.existsSync(logFile), false, 'not retried')
  assert.equal(seen.length, 2)
  // a timeout or an abort through the launcher: not retried, the launcher is killed
  const t0 = Date.now()
  assert.equal(await codeOf(transcribeLocal({ ...base, timeoutMs: 400, launch: sh('sleep 30') })), 'engine-timeout')
  assert.ok(Date.now() - t0 < 5000)
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 300)
  assert.equal(await codeOf(transcribeLocal({ ...base, signal: ac.signal, launch: sh('sleep 30') })), 'aborted')
  assert.equal(fs.existsSync(logFile), false, 'no direct retry after a timeout or an abort')
  assert.equal(seen.length, 2)
  // a launcher returning null = started directly (what every platform but Windows does)
  const r3 = await transcribeLocal({ ...base, launch: () => null })
  assert.equal(r3.text, '开放时间早上9点至下午5点。')
  assert.equal(seen.length, 2)
  assert.deepEqual(leftovers(dir), [], 'temp directories removed every time')
})

test('whisper.cpp and Vosk: arguments and output parsing', async () => {
  const dir = work()
  const w = await transcribeLocal({ engine: 'whisper.cpp', bin: bins.whisper, model: ggml, wav: toneWav(1), lang: 'zh', threads: 4, tmpDir: dir, env: env() })
  assert.equal(w.text, '你好世界')
  const wl = readLog()
  assert.deepEqual(wl.argv, ['-m', ggml, '-f', wl.argv[3], '-l', 'zh', '-t', '4', '-nt', '-np', '--prompt', '以下是普通话的句子。'])
  await transcribeLocal({ engine: 'whisper.cpp', bin: bins.whisper, model: ggml, wav: toneWav(1), lang: 'auto', tmpDir: dir, env: env() })
  assert.deepEqual(readLog().argv.slice(4, 6), ['-l', 'auto'])
  const v = await transcribeLocal({ engine: 'vosk', bin: bins.vosk, model: vk, wav: toneWav(1), lang: 'zh', tmpDir: dir, env: env() })
  assert.equal(v.text, '你好世界', 'spaces between Chinese characters removed')
  const vl = readLog()
  assert.deepEqual([vl.argv[0], vl.argv[1], vl.argv[2], vl.argv[4], vl.argv.slice(6)], ['-m', vk, '-i', '-o', ['-t', 'txt', '--log-level', 'ERROR']])
  assert.match(vl.argv[5], /\.txt$/)
  assert.deepEqual(leftovers(dir), [])
})

test('timeout kills the program and still deletes the audio', async () => {
  const dir = work()
  const t0 = Date.now()
  assert.equal(await codeOf(transcribeLocal({ engine: 'sherpa-onnx', bin: bins.sherpa, model: sv, wav: toneWav(1), timeoutMs: 600, tmpDir: dir, env: env('sleep') })), 'engine-timeout')
  assert.ok(Date.now() - t0 < 5000)
  const { pid } = readLog()
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(alive(pid), false, 'the program is gone')
  assert.deepEqual(leftovers(dir), [])
})

test('abort kills the program and still deletes the audio; an already aborted signal never starts it', async () => {
  const dir = work()
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 400)
  assert.equal(await codeOf(transcribeLocal({ engine: 'whisper.cpp', bin: bins.whisper, model: ggml, wav: toneWav(1), tmpDir: dir, signal: ac.signal, env: env('sleep') })), 'aborted')
  const { pid } = readLog()
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(alive(pid), false)
  assert.deepEqual(leftovers(dir), [])
  fs.rmSync(logFile, { force: true })
  assert.equal(await codeOf(transcribeLocal({ engine: 'whisper.cpp', bin: bins.whisper, model: ggml, wav: toneWav(1), tmpDir: dir, signal: AbortSignal.abort(), env: env() })), 'aborted')
  assert.equal(fs.existsSync(logFile), false)
})

test('errors: crash → engine-error, empty result → empty, silence → empty without running, missing pieces → no-engine, bad WAV → bad-audio', async () => {
  const dir = work()
  assert.equal(await codeOf(transcribeLocal({ engine: 'sherpa-onnx', bin: bins.sherpa, model: sv, wav: toneWav(1), tmpDir: dir, env: env('crash') })), 'engine-error')
  assert.equal(await codeOf(transcribeLocal({ engine: 'sherpa-onnx', bin: bins.sherpa, model: sv, wav: toneWav(1), tmpDir: dir, env: env('empty') })), 'empty')
  assert.equal(await codeOf(transcribeLocal({ engine: 'whisper.cpp', bin: bins.whisper, model: ggml, wav: toneWav(1), tmpDir: dir, env: env('empty') })), 'empty', '[BLANK_AUDIO] only')
  fs.rmSync(logFile, { force: true })
  assert.equal(await codeOf(transcribeLocal({ engine: 'sherpa-onnx', bin: bins.sherpa, model: sv, wav: silentWav(2), tmpDir: dir, env: env() })), 'empty')
  assert.equal(fs.existsSync(logFile), false, 'silence never reaches the program')
  assert.equal(await codeOf(transcribeLocal({ engine: 'sherpa-onnx', bin: path.join(root, 'nope'), model: sv, wav: toneWav(1), tmpDir: dir })), 'no-engine')
  assert.equal(await codeOf(transcribeLocal({ engine: 'sherpa-onnx', bin: bins.sherpa, model: path.join(root, 'nope'), wav: toneWav(1), tmpDir: dir })), 'no-engine')
  assert.equal(await codeOf(transcribeLocal({ engine: 'whisper.cpp', bin: bins.whisper, model: sv /* a dir, not a file */, wav: toneWav(1), tmpDir: dir })), 'no-engine')
  assert.equal(await codeOf(transcribeLocal({ engine: 'kaldi', bin: bins.sherpa, model: sv, wav: toneWav(1) })), 'no-engine')
  assert.equal(await codeOf(transcribeLocal({ engine: 'vosk', bin: bins.vosk, model: vk, wav: Buffer.from('nope') })), 'bad-audio')
  assert.deepEqual(leftovers(dir), [])
})

test('no shell: a temp directory with spaces and $(…) is passed literally', async () => {
  const evil = path.join(work(), 'a b $(touch PWNED) `touch PWNED2`; touch PWNED3')
  fs.mkdirSync(evil)
  const r = await transcribeLocal({ engine: 'sherpa-onnx', bin: bins.sherpa, model: sv, wav: toneWav(1), tmpDir: evil, env: env() })
  assert.ok(r.text)
  assert.ok(readLog().argv.at(-1).startsWith(evil))
  for (const d of [evil, path.dirname(evil), process.cwd(), root]) for (const f of ['PWNED', 'PWNED2', 'PWNED3']) assert.equal(fs.existsSync(path.join(d, f)), false)
})

test('real sherpa-onnx 1.13.8 output (captured on macOS arm64) parses: SenseVoice tags Cantonese as Chinese, Paraformer has no tag', () => {
  const fx = (n) => fs.readFileSync(path.join(HERE, 'fixtures', n), 'utf8')
  const sv = parseOutput('sherpa-onnx', { stdout: fx('sherpa-1.13.8-sense-voice.stdout'), stderr: fx('sherpa-1.13.8-sense-voice.stderr') })
  assert.equal(sv.text, '把这个文件翻译成英文然后提交件码')
  assert.equal(sv.lang, 'zh')
  const pf = parseOutput('sherpa-onnx', { stdout: fx('sherpa-1.13.8-paraformer.stdout'), stderr: fx('sherpa-1.13.8-paraformer.stderr') })
  assert.equal(pf.text, '把这个文件翻译成英文然后提交代码')
  assert.equal(pf.lang, undefined)
  assert.equal(parseOutput('sherpa-onnx', { stdout: '', stderr: fx('sherpa-1.13.8-paraformer.stderr') + fx('sherpa-1.13.8-paraformer.stdout') }).text,
    '把这个文件翻译成英文然后提交代码', 'the same line on stderr (older versions)')
})

test('real output of the pinned SenseVoice (2024-07-17, sherpa-onnx 1.13.8 on macOS arm64): punctuation, <|zh|> / <|en|>, English as written', () => {
  const fx = (n) => fs.readFileSync(path.join(HERE, 'fixtures', n), 'utf8')
  const zh = parseOutput('sherpa-onnx', { stdout: fx('sherpa-1.13.8-sense-voice-2024.stdout'), stderr: fx('sherpa-1.13.8-sense-voice-2024.stderr') })
  assert.deepEqual([tidy(zh.text), zh.lang], ['帮我把项目里的测试全部跑一遍，然后告诉我结果。', 'zh'])
  const en = parseOutput('sherpa-onnx', { stdout: fx('sherpa-1.13.8-sense-voice-2024-en.stdout'), stderr: fx('sherpa-1.13.8-sense-voice-2024-en.stderr') })
  assert.deepEqual([tidy(en.text), en.lang], ['Please run all the tests in this project and tell me the result.', 'en'])
})

test('helpers: model kind detection, argument builder, output parser, tidy', () => {
  assert.equal(resolveModel('sherpa-onnx', sv).kind, 'sense-voice')
  assert.equal(resolveModel('sherpa-onnx', pf).kind, 'paraformer')
  assert.throws(() => resolveModel('sherpa-onnx', { kind: 'zipformer', model: 'x', tokens: 'y' }), (e) => e.code === 'no-engine')
  assert.deepEqual(buildArgs('whisper.cpp', { model: 'm' }, { file: 'f', lang: 'fr', threads: 99 }).slice(4, 8), ['-l', 'auto', '-t', '16'])
  assert.equal(parseOutput('sherpa-onnx', { stdout: 'noise\n{"lang":"<|en|>","text":"Hello."}\n', stderr: '' }).lang, 'en')
  assert.equal(parseOutput('whisper.cpp', { stdout: '[00:00:00.000 --> 00:00:02.000]  hi there\n' }).text.trim(), 'hi there')
  assert.equal(tidy(' 你 好 <|zh|>  hello   world 。'), '你好 hello world 。')
})

test('gateway with a local engine (sherpa-onnx adapter around transcribeLocal)', async () => {
  const cfg = baseConfig({ engines: [{ id: 'local', type: 'sherpa-onnx', bin: bins.sherpa, model: sv, threads: 2, env: env() }], default: { zh: 'local' } })
  const g = await startGateway(cfg)
  try {
    const info = await (await fetch(g.url + '/v1/info')).json()
    assert.deepEqual(info.engines[0], { id: 'local', kind: 'local', langs: ['zh', 'en', 'auto'], maxSeconds: 240, default: true, defaultFor: ['zh', 'en', 'auto'] })
    const r = await post(g.url + '/v1/recognize?lang=zh', toneWav(1), { Authorization: `Bearer ${TOKEN}` })
    assert.equal(r.status, 200)
    assert.equal(r.json.text, '开放时间早上9点至下午5点。')
    assert.equal(r.json.lang, 'zh')
    g.gw.engines.get('local').config.env = env('crash')
    const e = await post(g.url + '/v1/recognize?lang=zh', toneWav(1), { Authorization: `Bearer ${TOKEN}` })
    assert.equal(e.json.code, 'engine-error')
    assert.match(g.lines.at(-1), /detail=local:exit-3/)
  } finally { await g.close() }
  assert.throws(() => startGatewaySync({ engines: [{ id: 'l', type: 'sherpa-onnx', bin: path.join(root, 'missing'), model: sv }] }), /program not found/)
  assert.throws(() => startGatewaySync({ engines: [{ id: 'l', type: 'vosk', bin: bins.vosk, model: path.join(root, 'missing') }] }), /model not usable/)
})

import { createGateway } from '../src/server.mjs'
function startGatewaySync(over) { return createGateway(baseConfig(over)) }
