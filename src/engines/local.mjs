// SPDX-License-Identifier: MIT
// This one file is MIT-licensed (see LICENSE-MIT); the rest of pocket-asr is AGPL-3.0-only. The Pocket desktop agent
// embeds it verbatim, so contributions to this file are accepted under MIT.
// Local speech recognition through an external program (ASR.md §5.3). Single file, zero dependencies, so the gateway,
// a Docker image and the Pocket desktop agent can all run the same code:
//
//   const { text, ms, lang } = await transcribeLocal({ engine, bin, model, wav, lang, threads, timeoutMs, tmpDir, signal, env })
//
//   engine  'sherpa-onnx' | 'whisper.cpp' | 'vosk'
//   bin     the program: sherpa-onnx-offline | whisper-cli | vosk-transcriber (or a wrapper taking the same flags)
//   model   sherpa-onnx: a model directory (tokens.txt + model.int8.onnx | model.onnx; SenseVoice or Paraformer is
//           detected) or { kind: 'sense-voice' | 'paraformer', model, tokens }; whisper.cpp: a ggml-*.bin file;
//           vosk: a model directory
//   wav     Buffer, 16 kHz mono 16-bit PCM WAV            lang     'zh' | 'en' | 'auto'
//   threads default 2                                       timeoutMs default 30 s + audio length
//   tmpDir  default os.tmpdir()                             signal   optional AbortSignal
//   env     optional extra environment for the program (e.g. a library directory on PATH on Windows)
//   onFallback  optional ({ reason }) => void: the cmd.exe start failed and the program is being started directly
//   launch  optional (bin, args, cwd) => { file, args, verbatim } | null: how to start it (tests); default launchFor
//
// The audio is written to a fresh private directory (0700, random names), the program runs with an argument array
// (no shell; on Windows through cmd.exe with every argument quoted, see winShellLine — and when that start fails, or
// ends non-zero without a result, once more directly), the directory is deleted in `finally`, the program (on Windows
// its whole process tree) is killed on timeout or abort. Errors are LocalAsrError with `code` in: no-engine, bad-audio,
// empty, engine-timeout, engine-error, aborted. Neither errors nor anything else here carry the recognised text or the
// audio.
//
// License: AGPL-3.0-only (part of pocket-asr).
//
// Revision 2 (2026-10-08): SenseVoice's <|yue|> (Cantonese) is reported as lang 'zh'.
// Revision 3 (2026-10-09): SenseVoice is never told 'en' — someone whose phone is in English but who speaks Chinese
//   got pinyin-like nonsense — so 'zh' stays 'zh' and everything else is 'auto' (it tells English apart by itself).
//   Windows: the program is started through cmd.exe (a bun-compiled parent that starts it directly waits ~3.4 s before
//   it runs, and it then decodes ~2.5× slower), and when a path has non-ASCII characters (sherpa-onnx 1.13.8 can't open
//   those, 8.3 short names included) it runs in the directory holding all its files and gets ASCII relative paths.
//   The cmd.exe start is new: if it cannot be started, or exits non-zero without printing a result, the program is
//   started directly once more (same arguments, directory and time limit; never after a timeout or an abort).
export const LOCAL_REVISION = 3

import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const LOCAL_ENGINES = ['sherpa-onnx', 'whisper.cpp', 'vosk']
const MAX_OUTPUT = 1024 * 1024
const SILENCE_PEAK = 64                       // |sample| below this everywhere = nothing was said

export class LocalAsrError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'LocalAsrError'
    this.code = code
    this.detail = detail
  }
}

// ---- audio ---------------------------------------------------------------------------------------------------
/** Validate a 16 kHz mono s16 PCM WAV and return its samples; LocalAsrError('bad-audio') otherwise. */
export function wavPcm(buf) {
  const bad = (why) => { throw new LocalAsrError('bad-audio', why) }
  if (!Buffer.isBuffer(buf) || buf.length < 44) bad('short')
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') bad('not-riff-wave')
  let pos = 12, fmt = false
  while (pos + 8 <= buf.length) {
    const id = buf.toString('latin1', pos, pos + 4), size = buf.readUInt32LE(pos + 4), body = pos + 8
    if (id === 'fmt ') {
      if (size < 16 || body + size > buf.length) bad('fmt-size')
      const tag = buf.readUInt16LE(body)
      const pcmTag = tag === 1 || (tag === 0xfffe && size >= 40 && buf.readUInt16LE(body + 24) === 1)
      if (!pcmTag || buf.readUInt16LE(body + 2) !== 1 || buf.readUInt32LE(body + 4) !== 16000 || buf.readUInt16LE(body + 14) !== 16) bad('format')
      fmt = true
    } else if (id === 'data') {
      if (!fmt) bad('data-before-fmt')
      const rest = buf.length - body
      let n = size === 0xffffffff || (size === 0 && rest > 0) ? rest : size
      if (n > rest) bad('truncated')
      n -= n % 2
      return buf.subarray(body, body + n)
    } else if (body + size > buf.length) bad('chunk-size')
    pos = body + size + (size & 1)
  }
  return bad('no-data')
}

function canonicalWav(pcm) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8, 'latin1')
  h.write('fmt ', 12, 'latin1'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36, 'latin1'); h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

function peak(pcm) {
  let p = 0
  for (let i = 0; i + 1 < pcm.length; i += 2) { const v = Math.abs(pcm.readInt16LE(i)); if (v > p) p = v }
  return p
}

// ---- models --------------------------------------------------------------------------------------------------
const isFile = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }
const isDir = (p) => { try { return fs.statSync(p).isDirectory() } catch { return false } }
const kindCache = new Map()

/** Find the files an engine needs; LocalAsrError('no-engine') when they are not there. */
export function resolveModel(engine, model) {
  const missing = (why) => { throw new LocalAsrError('no-engine', why) }
  if (engine === 'sherpa-onnx') {
    if (model && typeof model === 'object') {
      if (!['sense-voice', 'paraformer'].includes(model.kind)) missing('model-kind')
      if (!isFile(model.model) || !isFile(model.tokens)) missing('model-files')
      return { kind: model.kind, model: model.model, tokens: model.tokens }
    }
    if (typeof model !== 'string' || !isDir(model)) missing('model-dir')
    const tokens = path.join(model, 'tokens.txt')
    const onnx = ['model.int8.onnx', 'model.onnx'].map((f) => path.join(model, f)).find(isFile)
    if (!isFile(tokens) || !onnx) missing('model-files')
    let kind = kindCache.get(tokens)
    if (!kind) {
      // SenseVoice vocabularies contain the language tags; Paraformer's don't.
      kind = fs.readFileSync(tokens, 'utf8').includes('<|zh|>') ? 'sense-voice' : 'paraformer'
      kindCache.set(tokens, kind)
    }
    return { kind, model: onnx, tokens }
  }
  if (engine === 'whisper.cpp') {
    if (typeof model !== 'string' || !isFile(model)) missing('model-file')
    return { model }
  }
  if (engine === 'vosk') {
    if (typeof model !== 'string' || !isDir(model)) missing('model-dir')
    return { model }
  }
  return missing('unknown-engine')
}

/** Program arguments (an array) and how to read the result. */
export function buildArgs(engine, m, { file, outFile, lang, threads }) {
  const t = String(Math.max(1, Math.min(16, threads | 0 || 2)))
  if (engine === 'sherpa-onnx') {
    if (m.kind === 'sense-voice') {
      // never 'en': with it, Chinese speech comes out as English-looking nonsense; 'auto' recognises English as well
      const sv = lang === 'zh' ? 'zh' : 'auto'
      return [`--tokens=${m.tokens}`, `--sense-voice-model=${m.model}`, `--sense-voice-language=${sv}`,
        '--sense-voice-use-itn=1', `--num-threads=${t}`, '--debug=0', file]
    }
    return [`--tokens=${m.tokens}`, `--paraformer=${m.model}`, `--num-threads=${t}`, '--decoding-method=greedy_search', '--debug=0', file]
  }
  if (engine === 'whisper.cpp') {
    const args = ['-m', m.model, '-f', file, '-l', ['zh', 'en'].includes(lang) ? lang : 'auto', '-t', t, '-nt', '-np']
    if (lang === 'zh') args.push('--prompt', '以下是普通话的句子。')     // nudges whisper towards Simplified Chinese
    return args
  }
  return ['-m', m.model, '-i', file, '-o', outFile, '-t', 'txt', '--log-level', 'ERROR']   // vosk-transcriber
}

/** Pull the text out of what the program printed. */
/** sherpa-onnx-offline prints one JSON object per file ({"lang": "<|zh|>", "text": "…", …}); recent versions on stdout,
 * older ones on stderr. The last such object, or null. */
function sherpaJson(stdout, stderr) {
  for (const stream of [stdout, stderr]) {
    const lines = String(stream || '').split(/\r?\n/).filter((l) => l.trim().startsWith('{'))
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const j = JSON.parse(lines[i].trim())
        if (typeof j.text === 'string') return j
      } catch { /* not the result line */ }
    }
  }
  return null
}

export function parseOutput(engine, { stdout, stderr, outText }) {
  if (engine === 'sherpa-onnx') {
    const j = sherpaJson(stdout, stderr)
    if (!j) return { text: '' }
    const tag = /<\|(zh|en|yue)\|>/.exec(j.lang || '')?.[1]       // Cantonese is written Chinese too
    return { text: j.text, lang: tag === 'yue' ? 'zh' : tag }
  }
  if (engine === 'whisper.cpp') {
    const text = String(stdout || '').split(/\r?\n/).map((l) => l.replace(/^\s*\[[\d:.\s\->]+\]\s*/, '')).join(' ')
    return { text: text.replace(/\[[^\]\n]{1,40}\]/g, ' ') }       // [BLANK_AUDIO], [Music] …
  }
  return { text: String(outText ?? stdout ?? '') }
}

const CJK = '\\u3000-\\u303f\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef'
const BETWEEN_CJK = new RegExp(`([${CJK}])\\s+(?=[${CJK}])`, 'g')
export const tidy = (s) => String(s || '').replace(/<\|[^|>]{1,20}\|>/g, '').replace(/\s+/g, ' ').replace(BETWEEN_CJK, '$1').trim()

// ---- Windows -------------------------------------------------------------------------------------------------
const ASCII = /^[\x20-\x7e]*$/

/**
 * Windows: sherpa-onnx 1.13.8 can't open a file whose path has a non-ASCII character (a Chinese user name:
 * C:\Users\张三\…), and the 8.3 short name keeps those characters. So when a path has one, the program runs in the
 * deepest directory that contains every file it is given and gets ASCII relative paths. Returns { cwd, rel } (rel maps
 * each given path to its relative form), or null when every path is ASCII already or nothing helps (different
 * drives, or a non-ASCII name below that directory). `P` is path.win32 (a parameter so tests run anywhere).
 */
export function asciiRelative(paths, P = path.win32) {
  const abs = paths.map((p) => P.resolve(p))
  if (abs.every((p) => ASCII.test(p))) return null
  const key = (s) => s.toLowerCase().replace(/\//g, '\\')            // Windows names ignore case
  const all = abs.map((p) => { const root = P.parse(p).root; return { root, parts: p.slice(root.length).split(/[\\/]+/).filter(Boolean) } })
  if (all.some((x) => key(x.root) !== key(all[0].root))) return null
  let n = Math.min(...all.map((x) => x.parts.length - 1))           // directories only, never a file's own name
  for (let i = 0; i < n; i++) if (all.some((x) => key(x.parts[i]) !== key(all[0].parts[i]))) { n = i; break }
  const rels = all.map((x) => x.parts.slice(n).join('\\'))
  if (rels.some((r) => !r || !ASCII.test(r))) return null
  const map = new Map(paths.map((p, i) => [p, rels[i]]))
  return { cwd: all[0].root + all[0].parts.slice(0, n).join('\\'), rel: (p) => (map.has(p) ? map.get(p) : p) }
}

/**
 * Windows: the command line for `cmd.exe /d /v:off /s /c <line>` (node's own `shell: true` form) that runs `bin` with
 * `args`, every one of them quoted — or null when cmd.exe would still read something inside the quotes (" or %),
 * an argument ends in a backslash (the program would read \" as a quote), has a control character, or the working
 * directory is a UNC path (cmd.exe refuses those). Then the program is started directly. Through cmd.exe a
 * bun-compiled parent starts it as fast as node does (measured: 1.3 s instead of 5.1–5.5 s for the same clip).
 */
export function winShellLine(bin, args, cwd) {
  const all = [bin, ...args]
  if (all.some((a) => typeof a !== 'string' || !a || /["%\x00-\x1f\x7f]/.test(a) || a.endsWith('\\')) || /^[\\/]{2}/.test(cwd || '')) return null
  return `"${all.map((a) => `"${a}"`).join(' ')}"`
}

const winSystem32 = () => path.join(process.env.SystemRoot || process.env.WINDIR || process.env.windir || 'C:\\Windows', 'System32')

/** How the program is started: on Windows through cmd.exe ({ file, args, verbatim }), elsewhere — or when the line
 * can't be built — directly (null). */
export function launchFor(bin, args, cwd) {
  if (process.platform !== 'win32') return null
  const line = winShellLine(bin, args, cwd)
  return line ? { file: path.join(winSystem32(), 'cmd.exe'), args: ['/d', '/v:off', '/s', '/c', line], verbatim: true } : null
}

/** Did the program leave a result (even an empty one)? Then a non-zero exit is the program's own, not the launcher's. */
function leftResult(engine, r, outFile) {
  if (engine === 'sherpa-onnx') return !!sherpaJson(r.stdout, r.stderr)
  if (engine === 'whisper.cpp') return /\S/.test(r.stdout)
  return isFile(outFile)
}

// ---- running the program -------------------------------------------------------------------------------------
function childEnv(extra) {
  const env = { ...process.env }
  if (extra && typeof extra === 'object') {
    for (const [k, v] of Object.entries(extra)) {
      if (process.platform === 'win32') for (const e of Object.keys(env)) if (e.toLowerCase() === k.toLowerCase()) delete env[e]
      env[k] = String(v)
    }
  }
  return env
}

/** Run `bin args` — directly, or through `via` ({ file, args, verbatim }: cmd.exe on Windows). */
function run(bin, args, { timeoutMs, signal, env, cwd, via }) {
  return new Promise((resolve, reject) => {
    const posix = process.platform !== 'win32'
    let child
    try {
      const opts = { cwd, env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: posix }
      child = via ? spawn(via.file, via.args, { ...opts, windowsVerbatimArguments: !!via.verbatim }) : spawn(bin, args, opts)
    } catch (e) {
      return reject(new LocalAsrError('no-engine', `spawn-${e.code || 'failed'}`))
    }
    const out = [], err = []
    let outLen = 0, errLen = 0, why = null, finished = false
    const kill = (reason) => {
      if (why || finished) return
      why = reason
      const plain = () => { try { child.kill() } catch { /* gone */ } }
      try {
        if (posix) process.kill(-child.pid, 'SIGKILL')
        else if (via && child.pid) {
          // cmd.exe and the program under it: kill the tree (child.kill() would stop only cmd.exe)
          const k = spawn(path.join(winSystem32(), 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
          k.on('error', plain)
          k.on('close', (code) => { if (code !== 0) plain() })
        } else plain()
      } catch { try { child.kill('SIGKILL') } catch { /* gone */ } }
    }
    const timer = setTimeout(() => kill('timeout'), timeoutMs)
    const onAbort = () => kill('abort')
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }) }
    child.stdout.on('data', (d) => { if (outLen < MAX_OUTPUT) { out.push(d); outLen += d.length } })
    child.stderr.on('data', (d) => { if (errLen < MAX_OUTPUT) { err.push(d); errLen += d.length } })
    child.on('error', (e) => {
      if (finished) return
      finished = true
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort)
      reject(new LocalAsrError(why === 'abort' ? 'aborted' : 'no-engine', `spawn-${e.code || 'failed'}`))
    })
    child.on('close', (code, sig) => {
      if (finished) return
      finished = true
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort)
      if (why === 'timeout') return reject(new LocalAsrError('engine-timeout'))
      if (why === 'abort') return reject(new LocalAsrError('aborted'))
      resolve({ code, signal: sig, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
    })
  })
}

// ---- the entry point ------------------------------------------------------------------------------------------
export async function transcribeLocal({ engine, bin, model, wav, lang = 'auto', threads = 2, timeoutMs, tmpDir, signal, env, silencePeak = SILENCE_PEAK, onFallback, launch = launchFor } = {}) {
  const t0 = Date.now()
  if (!LOCAL_ENGINES.includes(engine)) throw new LocalAsrError('no-engine', 'unknown-engine')
  if (signal?.aborted) throw new LocalAsrError('aborted')
  const pcm = wavPcm(wav)
  if (pcm.length < 3200 || (silencePeak > 0 && peak(pcm) < silencePeak)) throw new LocalAsrError('empty', 'silence')   // < 0.1 s or silent
  if (typeof bin !== 'string' || !isFile(bin)) throw new LocalAsrError('no-engine', 'bin-missing')
  const m = resolveModel(engine, model)
  const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30_000 + Math.ceil(pcm.length / 32)
  const dir = fs.mkdtempSync(path.join(tmpDir || os.tmpdir(), 'pocket-asr-'))
  try {
    try { fs.chmodSync(dir, 0o700) } catch { /* Windows: per-user temp directory */ }
    const name = crypto.randomBytes(12).toString('hex')
    const file = path.join(dir, `${name}.wav`)
    const outFile = path.join(dir, `${name}.txt`)
    fs.writeFileSync(file, canonicalWav(pcm), { mode: 0o600, flag: 'wx' })
    let cwd = dir, mp = m, fileArg = file, outArg = outFile
    const near = process.platform === 'win32' ? asciiRelative([m.model, m.tokens, file, outFile].filter((p) => typeof p === 'string')) : null
    if (near) {
      cwd = near.cwd
      mp = { ...m, model: near.rel(m.model), ...(typeof m.tokens === 'string' ? { tokens: near.rel(m.tokens) } : {}) }
      fileArg = near.rel(file); outArg = near.rel(outFile)
    }
    const args = buildArgs(engine, mp, { file: fileArg, outFile: outArg, lang, threads })
    const via = launch ? launch(bin, args, cwd) : null
    let r = null, fallback = null
    try {
      r = await run(bin, args, { timeoutMs: limit, signal, env, cwd, via })
    } catch (e) {
      if (!via || !(e instanceof LocalAsrError) || e.code !== 'no-engine') throw e      // timeouts and aborts: never again
      fallback = e.detail || 'spawn-failed'
    }
    if (via && !fallback && r.code !== 0 && !leftResult(engine, r, outFile)) fallback = `exit-${r.code ?? r.signal}`
    if (fallback) {
      // the cmd.exe start is new (2026-10-09) and not proven on every machine: the way it was done before, once more
      try { onFallback?.({ reason: fallback }) } catch { /* the caller's logging */ }
      r = await run(bin, args, { timeoutMs: limit, signal, env, cwd, via: null })
    }
    if (r.code !== 0) throw new LocalAsrError('engine-error', `exit-${r.code ?? r.signal}`)
    const outText = engine === 'vosk' && isFile(outFile) ? fs.readFileSync(outFile, 'utf8') : undefined
    const res = parseOutput(engine, { stdout: r.stdout, stderr: r.stderr, outText })
    const text = tidy(res.text)
    if (!text) throw new LocalAsrError('empty')
    return { text, ms: Date.now() - t0, lang: res.lang }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
