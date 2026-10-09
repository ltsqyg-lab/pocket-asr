// The connection line (ASR.md §11.2) — everything the App needs to reach this gateway, in one line to paste:
//
//   pocket-asr://<host>:<port>[/<path>]?pin=sha256:<hex>&token=<token>
//
// host = IPv4, [IPv6] or a domain; pin = "sha256:" + lowercase hex SHA-256 of the gateway's certificate (DER) — the
// App accepts exactly that certificate instead of asking the system's certificate authorities (left out for a domain
// with a publicly trusted certificate); token = a static token (left out by `connect-string`: only hashes are kept).
// The public address comes from `publicUrl` (ASR_PUBLIC_URL), else from the Pocket coordination server's
// `GET /v2/whoami` → {ip}, else from this machine's network interfaces.

import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { isLoopback } from './tls.mjs'
import { DEFAULT_COORD_URL } from './config.mjs'
import { PIN_RE } from './selfcert.mjs'

export const CONNECT_FILE = 'connect.txt'

export const formatHost = (h) => (net.isIPv6(h) ? `[${h}]` : h)

/** Build the line; `pin` and `token` are optional. */
export function connectString({ host, port, path: p = '', pin, token }) {
  if (pin && !PIN_RE.test(pin)) throw new Error('pin must be "sha256:" + 64 lowercase hex digits')
  const q = []
  if (pin) q.push(`pin=${pin}`)
  if (token) q.push(`token=${encodeURIComponent(token)}`)
  return `pocket-asr://${formatHost(host)}:${port}${p || ''}${q.length ? `?${q.join('&')}` : ''}`
}

/**
 * Read a line back (tests; the App has its own parser). Returns { host, port, path, pin, token, baseUrl }.
 * Unknown query parameters are ignored, as the App ignores them.
 */
export function parseConnectString(s) {
  const m = /^pocket-asr:\/\/(\[[0-9a-fA-F:.]+\]|[^/:?#\s[\]]+):(\d{1,5})(\/[^?#\s]*)?(?:\?([^#\s]*))?$/.exec(String(s).trim())
  if (!m) throw new Error('not a pocket-asr:// line')
  const host = m[1].startsWith('[') ? m[1].slice(1, -1) : m[1]
  const port = Number(m[2])
  if (!(port >= 1 && port <= 65535)) throw new Error('bad port')
  const p = (m[3] || '').replace(/\/+$/, '')
  const q = new URLSearchParams(m[4] || '')
  const pin = q.get('pin')
  if (pin !== null && !PIN_RE.test(pin)) throw new Error('bad pin')
  return { host, port, path: p, pin, token: q.get('token'), baseUrl: `https://${formatHost(host)}:${port}${p}` }
}

/** Unicast addresses others can reach (not private, CGNAT, link-local, loopback, documentation or multicast). */
export function isPublicIPv4(ip) {
  if (!net.isIPv4(ip)) return false
  const [a, b, c] = ip.split('.').map(Number)
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false
  if (a === 100 && b >= 64 && b <= 127) return false        // CGNAT (and Tailscale)
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  if (a === 198 && b === 51 && c === 100) return false
  if (a === 203 && b === 0 && c === 113) return false
  return true
}

/** A public IPv4 address of this machine, if one of its interfaces has one (not inside a container behind NAT). */
export function guessPublicIPv4(ifaces = os.networkInterfaces()) {
  for (const list of Object.values(ifaces || {})) {
    for (const a of list || []) if ((a.family === 'IPv4' || a.family === 4) && !a.internal && isPublicIPv4(a.address)) return a.address
  }
  return null
}

function getJson(url, { family, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const mod = u.protocol === 'http:' ? http : https
    const req = mod.get(u, { family, timeout: timeoutMs, headers: { Accept: 'application/json', 'User-Agent': 'pocket-asr' } }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (d) => { body += d; if (body.length > 4096) req.destroy(new Error('too-large')) })
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { answered: true }))
        try { resolve(JSON.parse(body)) } catch { reject(Object.assign(new Error('bad-json'), { answered: true })) }
      })
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
  })
}

/**
 * Ask coordination which address our requests come from. IPv4 first (phones on IPv4-only networks are common), then
 * whatever the system picks. Direct connection on purpose: through a proxy we would learn the proxy's address.
 * @returns {Promise<string|null>}
 */
export async function whoami(coordUrl = DEFAULT_COORD_URL, { timeoutMs = 5000, log = () => {} } = {}) {
  const url = `${String(coordUrl).replace(/\/+$/, '')}/v2/whoami`
  let last = 'error'
  for (const family of [4, 0]) {
    try {
      const j = await getJson(url, { family, timeoutMs })
      let ip = typeof j?.ip === 'string' ? j.ip.trim() : ''
      if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(ip)) ip = ip.slice(7)
      if (net.isIP(ip)) return ip
      last = 'bad-answer'
      break
    } catch (e) {
      last = e?.code || e?.message || 'error'
      if (e?.answered) break               // the server answered: asking over IPv6 instead would not change that
    }
  }
  log(`public address: ${url} gave no address (${String(last).slice(0, 40)})`)
  return null
}

/**
 * Where phones reach this gateway: { host (null when unknown), port, path, source: config|whoami|interface|none }.
 * Behind a reverse proxy on this machine (listening on loopback) only `publicUrl` can say it.
 */
export async function resolvePublic(config, { port = config.listen.port, whoamiImpl = whoami, ifaces, log = () => {} } = {}) {
  if (config.publicUrl) {
    const u = new URL(config.publicUrl)
    const host = u.hostname.startsWith('[') ? u.hostname.slice(1, -1) : u.hostname
    return { host, port: Number(u.port || 443), path: u.pathname.replace(/\/+$/, ''), source: 'config' }
  }
  if (isLoopback(config.listen.host)) return { host: null, port, path: '', source: 'none' }
  const ip = await whoamiImpl(config.coordUrl || DEFAULT_COORD_URL, { log })
  if (ip) return { host: ip, port, path: '', source: 'whoami' }
  const guess = guessPublicIPv4(ifaces)
  if (guess) return { host: guess, port, path: '', source: 'interface' }
  return { host: null, port, path: '', source: 'none' }
}

/** Should the line carry a pin? Always for our own or any self-signed certificate, and for any certificate on an IP. */
export function pinFor(tls, host) {
  if (!tls || tls.mode === 'off' || !tls.pin) return null
  if (tls.selfIssued || !host || net.isIP(host)) return tls.pin
  return null       // a domain with a certificate from a public authority: the App checks it the usual way (renewals keep working)
}

export const PLACEHOLDER_HOST = '<this-server-public-IP>'

/**
 * The line plus what to tell the operator, in English and Chinese. `bare` is the same line without the token (what
 * connect.txt gets).
 * @returns {{ line: string, bare: string, text: string }}
 */
export function banner({ pub, tls, token, label, docker = false, cmd = 'node src/main.mjs' }) {
  const host = pub.host || PLACEHOLDER_HOST
  const parts = { host, port: pub.port, path: pub.path, pin: pinFor(tls, pub.host) }
  const line = connectString({ ...parts, token })
  const bare = connectString(parts)
  const run = docker ? `docker exec pocket-asr ${cmd}` : cmd
  const out = ['', '─'.repeat(72), '', `  ${line}`, '']
  if (token) {
    out.push('  In the Pocket App: Settings → Voice transcription → My own gateway, paste this line.')
    out.push('  在 Pocket App:我的 → 语音识别方式 → 自建语音网关,粘贴这一行。', '')
    out.push(`  The token in it (${label}) is shown only this once: only its hash is stored. Another one: ${run} new-token [label]`)
    out.push(`  其中的令牌(${label})只显示这一次,数据目录里只存了它的哈希。再要一个:${run} new-token [标签]`)
  } else {
    out.push(`  This line has no token: tokens are stored only as hashes. A complete line: ${run} new-token [label]`)
    out.push(`  这一行没有令牌(数据目录里只存令牌的哈希)。要完整的一行:${run} new-token [标签]`)
  }
  if (!pub.host) {
    out.push('')
    if (pub.source === 'none' && tls?.mode === 'off') {
      out.push('  Set publicUrl (ASR_PUBLIC_URL) to your reverse proxy\'s https:// address and restart.')
      out.push('  请把 publicUrl(或 ASR_PUBLIC_URL)设成反向代理的 https:// 地址,然后重启。')
    } else {
      out.push(`  This server's public IP address could not be found: replace ${PLACEHOLDER_HOST} with it, or set ASR_PUBLIC_URL=https://<IP>:${pub.port} and restart.`)
      out.push(`  没查到这台服务器的公网 IP:把 ${PLACEHOLDER_HOST} 换成它,或者设 ASR_PUBLIC_URL=https://<IP>:${pub.port} 后重启。`)
    }
  } else if (pub.source === 'interface') {
    out.push('', `  (${pub.host} is this machine's own interface address; if phones reach it differently, set ASR_PUBLIC_URL.)`)
    out.push(`  (${pub.host} 取自本机网卡;手机要经别的地址才能连上时,请设 ASR_PUBLIC_URL。)`)
  }
  if (tls?.mode !== 'off') {
    out.push('', `  Allow TCP port ${pub.port} in this server's firewall / security group.`)
    out.push(`  在这台服务器的防火墙 / 安全组里放行 TCP ${pub.port} 端口。`)
  }
  out.push('', '─'.repeat(72), '')
  return { line, bare, text: out.join('\n') }
}

/** <dataDir>/connect.txt: the line without a token (never a secret on disk). */
export function writeConnectFile(dataDir, line) {
  const file = path.join(dataDir, CONNECT_FILE)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, line + '\n', { mode: 0o644 })
  fs.renameSync(tmp, file)
  return file
}
