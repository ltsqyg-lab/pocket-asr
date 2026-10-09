// Download, verify (size + SHA-256) and unpack the speech models and engine programs listed in models.json.
// Zero dependencies; archives are unpacked with the system's `tar` (bsdtar on macOS / Windows 10+, GNU tar + bzip2
// on Linux) or `unzip`, always with an argument array. Mirrors are tried first, then the upstream URL.
// The Pocket desktop agent can reuse downloadVerified / extractArchive / installModel as they are.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const MANIFEST_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'models.json')

export function loadManifest(file = MANIFEST_FILE) { return JSON.parse(fs.readFileSync(file, 'utf8')) }

export function platformKey(platform = process.platform, arch = process.arch) { return `${platform}-${arch}` }

const exists = (p) => { try { fs.statSync(p); return true } catch { return false } }

/** Candidate URLs: every mirror base + the file name, then the upstream URL. */
export function urlsFor(entry, mirrors = []) {
  return [...mirrors.filter(Boolean).map((m) => m.replace(/\/*$/, '/') + encodeURIComponent(entry.file)), entry.url].filter(Boolean)
}

/**
 * Stream a file to `dest` while hashing it; keep it only when size and SHA-256 match.
 * @returns {Promise<{ url, sha256, size }>}
 */
export async function downloadVerified({ urls, sha256, size, dest, signal, onProgress, allowUnverified = false, fetchImpl = globalThis.fetch, stallMs = 30_000 }) {
  if (!sha256 && !allowUnverified) throw new Error('no SHA-256 is pinned for this file; refusing an unverified download')
  if (sha256 && !/^[0-9a-f]{64}$/.test(sha256)) throw new Error('pinned SHA-256 is malformed')
  const errors = []
  for (const url of urls) {
    const part = `${dest}.part`
    // a source that stops sending for `stallMs` is given up for the next one
    const stall = new AbortController()
    let timer = setTimeout(() => stall.abort(), stallMs)
    const poke = () => { clearTimeout(timer); timer = setTimeout(() => stall.abort(), stallMs) }
    const both = signal ? AbortSignal.any([signal, stall.signal]) : stall.signal
    try {
      const res = await fetchImpl(url, { signal: both, redirect: 'follow' })
      if (res.status !== 200 || !res.body) throw new Error(`HTTP ${res.status}`)
      const h = crypto.createHash('sha256')
      let n = 0
      const fd = fs.openSync(part, 'w', 0o644)
      try {
        for await (const chunk of res.body) {
          poke()
          n += chunk.length
          if (size && n > size) throw new Error('larger than pinned size')
          h.update(chunk)
          fs.writeSync(fd, chunk)
          onProgress?.(n, size)
        }
      } finally { fs.closeSync(fd) }
      if (size && n !== size) throw new Error(`size ${n} ≠ pinned ${size}`)
      const got = h.digest('hex')
      if (sha256 && got !== sha256) throw new Error('SHA-256 mismatch')
      fs.renameSync(part, dest)
      return { url, sha256: got, size: n }
    } catch (e) {
      try { fs.rmSync(part, { force: true }) } catch { /* nothing */ }
      if (signal?.aborted) throw e
      errors.push(`${new URL(url).host}: ${stall.signal.aborted ? `no data for ${Math.round(stallMs / 1000)} s` : (e?.cause?.code || e.message)}`)
    } finally { clearTimeout(timer) }
  }
  throw new Error(`download failed (${errors.join('; ') || 'no URL to download from'})`)
}

function runTool(cmd, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, signal })
    let err = ''
    child.stderr.on('data', (d) => { if (err.length < 4000) err += d })
    child.on('error', (e) => reject(new Error(`${cmd}: ${e.code || e.message}`)))
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.trim().slice(0, 300)}`))))
  })
}

/** Unpack .tar.bz2 / .tar.gz / .tgz / .zip into destDir. */
export async function extractArchive(file, destDir, { signal } = {}) {
  fs.mkdirSync(destDir, { recursive: true })
  if (/\.zip$/i.test(file) && process.platform === 'linux') return runTool('unzip', ['-q', file, '-d', destDir], signal)
  return runTool('tar', ['-xf', file, '-C', destDir], signal)
}

/** After unpacking, the payload is the archive's single top-level directory (or the directory itself). */
function payloadDir(dir) {
  const items = fs.readdirSync(dir).filter((n) => !n.startsWith('.') && n !== '__MACOSX')
  if (items.length === 1 && fs.statSync(path.join(dir, items[0])).isDirectory()) return path.join(dir, items[0])
  return dir
}

/**
 * Install model `id` at `target` (a directory for archives, a file path for single-file models such as ggml).
 * Does nothing when `target` already exists.
 */
export async function installModel(id, target, { manifest = loadManifest(), mirrors, log = () => {}, signal, fetchImpl, allowUnverified, onProgress } = {}) {
  const m = manifest.models?.[id]
  if (!m) throw new Error(`unknown model "${id}"`)
  if (exists(target)) return target
  const parent = path.dirname(path.resolve(target))
  fs.mkdirSync(parent, { recursive: true })
  const work = fs.mkdtempSync(path.join(parent, '.install-'))
  try {
    const file = path.join(work, path.basename(m.file))
    log(`downloading ${id} (${Math.round(m.size / 1048576)} MB)`)
    await downloadVerified({ urls: urlsFor(m, mirrors ?? manifest.mirrors), sha256: m.sha256, size: m.size, dest: file, signal, fetchImpl, allowUnverified, onProgress })
    if (!m.archive) {
      fs.renameSync(file, target)
    } else {
      const out = path.join(work, 'x')
      await extractArchive(file, out, { signal })
      fs.renameSync(payloadDir(out), target)
    }
    log(`installed ${id} at ${target}`)
    return target
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

/**
 * Install an engine program for this platform into destDir; returns the program path.
 */
export async function installEngine(engine, destDir, { manifest = loadManifest(), platform = platformKey(), mirrors, log = () => {}, signal, fetchImpl, allowUnverified, onProgress } = {}) {
  const b = manifest.engines?.[engine]?.binaries?.[platform]
  if (!b) throw new Error(`no prebuilt ${engine} for ${platform}: ${manifest.engines?.[engine]?.howto || 'build it from source'}`)
  const bin = path.join(destDir, b.bin)
  if (exists(bin)) return bin
  const parent = path.dirname(path.resolve(destDir))
  fs.mkdirSync(parent, { recursive: true })
  const work = fs.mkdtempSync(path.join(parent, '.install-'))
  try {
    const file = path.join(work, path.basename(b.file))
    log(`downloading ${engine} ${platform} (${Math.round(b.size / 1048576)} MB)`)
    await downloadVerified({ urls: urlsFor(b, mirrors ?? manifest.mirrors), sha256: b.sha256, size: b.size, dest: file, signal, fetchImpl, allowUnverified, onProgress })
    const out = path.join(work, 'x')
    await extractArchive(file, out, { signal })
    if (exists(destDir)) fs.rmSync(destDir, { recursive: true, force: true })
    fs.renameSync(payloadDir(out), destDir)
    if (!exists(bin)) throw new Error(`${b.bin} is not in the archive`)
    if (process.platform !== 'win32') fs.chmodSync(bin, 0o755)
    log(`installed ${engine} at ${destDir}`)
    return bin
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

/**
 * Gateway start-up: for each local engine with `"install": { "model": "<id>" }` whose model path is missing,
 * download it from the manifest (used by the `local` Docker image on first start). `config` is a file path or the
 * config object.
 */
export async function ensureConfiguredModels(config, { log = () => {}, fetchImpl, onProgress } = {}) {
  let raw = config
  if (typeof config === 'string') {
    try { raw = JSON.parse(fs.readFileSync(config, 'utf8')) } catch { return }
  }
  for (const e of Array.isArray(raw?.engines) ? raw.engines : []) {
    const id = e?.install?.model
    if (!id || typeof e.model !== 'string' || exists(e.model)) continue
    await installModel(id, e.model, { log, fetchImpl, mirrors: e.install.mirrors, onProgress })
  }
}

/** A progress callback that logs every `step` percent of a download (for logs that nobody watches live). */
export function progressLogger(log, step = 10) {
  let next = step, last = 0
  return (n, size) => {
    if (!size) return
    if (n < last) next = step                 // the next source starts from the beginning
    last = n
    const pct = Math.floor((n * 100) / size)
    if (pct >= next && pct < 100) { log(`  ${pct}% of ${Math.round(size / 1048576)} MB`); next = (Math.floor(pct / step) + 1) * step }
  }
}
