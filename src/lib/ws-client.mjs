// Minimal RFC 6455 WebSocket client (ws:// and wss://), zero dependencies. Used by the Volcano and iFlytek adapters.
// Client frames are masked; incoming fragmented messages are reassembled; ping → pong; close is answered.

import crypto from 'node:crypto'
import net from 'node:net'
import tls from 'node:tls'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_MESSAGE = 16 * 1024 * 1024

export class WsHandshakeError extends Error {
  constructor(message, status = 0, headers = {}) { super(message); this.name = 'WsHandshakeError'; this.status = status; this.headers = headers }
}

/**
 * Open a WebSocket. Resolves with the connection once the server answered 101.
 * @param {string} url ws:// or wss://
 * @param {{ headers?: object, signal?: AbortSignal, timeoutMs?: number, ca?: string|Buffer }} [opts]
 */
export function connectWebSocket(url, opts = {}) {
  const u = new URL(url)
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return Promise.reject(new Error('ws url must be ws:// or wss://'))
  const secure = u.protocol === 'wss:'
  const port = Number(u.port) || (secure ? 443 : 80)
  const host = u.hostname.replace(/^\[|\]$/g, '')
  const key = crypto.randomBytes(16).toString('base64')
  const expectAccept = crypto.createHash('sha1').update(key + GUID).digest('base64')

  return new Promise((resolve, reject) => {
    let settled = false
    let conn = null
    const sock = secure
      ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, ca: opts.ca, ALPNProtocols: ['http/1.1'] })
      : net.connect({ host, port })
    const onAbort = () => fail(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    const fail = (err) => {
      try { sock.destroy() } catch { /* already gone */ }
      if (!settled) { settled = true; cleanup(); reject(err) } else if (conn) conn._closed(1006, err)
    }
    const cleanup = () => { clearTimeout(timer); opts.signal?.removeEventListener('abort', onAbort) }
    const timer = setTimeout(() => fail(new WsHandshakeError('handshake timeout')), opts.timeoutMs ?? 15000)
    if (opts.signal?.aborted) return onAbort()
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    sock.once(secure ? 'secureConnect' : 'connect', () => {
      const lines = [
        `GET ${u.pathname || '/'}${u.search} HTTP/1.1`,
        `Host: ${u.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        ...Object.entries(opts.headers || {}).map(([k, v]) => `${k}: ${v}`),
      ]
      sock.write(lines.join('\r\n') + '\r\n\r\n')
    })
    sock.on('error', (e) => fail(e))
    sock.on('close', () => { if (!settled) fail(new WsHandshakeError('connection closed during handshake')); else if (conn) conn._closed(1006) })

    let buf = Buffer.alloc(0)
    const onData = (chunk) => {
      if (conn) return conn._feed(chunk)
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
      const i = buf.indexOf('\r\n\r\n')
      if (i < 0) { if (buf.length > 65536) fail(new WsHandshakeError('handshake response too large')); return }
      const head = buf.subarray(0, i).toString('latin1').split('\r\n')
      const status = Number((/^HTTP\/1\.[01] (\d{3})/.exec(head[0]) || [])[1] || 0)
      const headers = {}
      for (const l of head.slice(1)) {
        const j = l.indexOf(':')
        if (j > 0) headers[l.slice(0, j).trim().toLowerCase()] = l.slice(j + 1).trim()
      }
      if (status !== 101) return fail(new WsHandshakeError(`HTTP ${status}`, status, headers))
      if (headers['sec-websocket-accept'] !== expectAccept) return fail(new WsHandshakeError('bad Sec-WebSocket-Accept', status, headers))
      settled = true
      cleanup()
      conn = new WsConnection(sock, headers, opts.signal)
      // Bytes that came with the 101 stay queued until the caller (resumed in a microtask) has set its handlers.
      conn._buf = Buffer.from(buf.subarray(i + 4))
      buf = Buffer.alloc(0)
      resolve(conn)
      if (conn._buf.length) setImmediate(() => conn._feed(Buffer.alloc(0)))
    }
    sock.on('data', onData)
  })
}

class WsConnection {
  constructor(sock, headers, signal) {
    this.sock = sock
    this.headers = headers
    this.onMessage = () => {}
    this.onClose = () => {}
    this._buf = Buffer.alloc(0)
    this._frags = []
    this._fragOp = 0
    this._closedFlag = false
    if (signal) {
      this._abort = () => this.terminate()
      if (signal.aborted) queueMicrotask(this._abort)
      else signal.addEventListener('abort', this._abort, { once: true })
      this._signal = signal
    }
  }

  get open() { return !this._closedFlag && !this.sock.destroyed }

  send(data) {
    if (!this.open) return false
    const isText = typeof data === 'string'
    const payload = isText ? Buffer.from(data, 'utf8') : Buffer.from(data)
    this.sock.write(frame(isText ? 0x1 : 0x2, payload))
    return true
  }

  close(code = 1000) {
    if (!this.open) return
    const p = Buffer.alloc(2); p.writeUInt16BE(code)
    try { this.sock.write(frame(0x8, p)) } catch { /* gone */ }
    setTimeout(() => this.terminate(), 1000).unref?.()
  }

  terminate() {
    try { this.sock.destroy() } catch { /* gone */ }
    this._closed(1006)
  }

  _closed(code, err) {
    if (this._closedFlag) return
    this._closedFlag = true
    this._signal?.removeEventListener('abort', this._abort)
    try { this.sock.destroy() } catch { /* gone */ }
    this.onClose(code, err)
  }

  _feed(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk
    while (this._buf.length >= 2) {
      const b = this._buf
      const fin = (b[0] & 0x80) !== 0
      const op = b[0] & 0x0f
      const masked = (b[1] & 0x80) !== 0
      let len = b[1] & 0x7f, off = 2
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4 }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10 }
      if (len > MAX_MESSAGE) return this.terminate()
      const maskLen = masked ? 4 : 0
      if (b.length < off + maskLen + len) return
      let payload = b.subarray(off + maskLen, off + maskLen + len)
      if (masked) {
        const m = b.subarray(off, off + 4)
        payload = Buffer.from(payload)
        for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3]
      }
      this._buf = b.subarray(off + maskLen + len)
      if (op === 0x9) { try { this.sock.write(frame(0xa, payload)) } catch { /* gone */ } continue }
      if (op === 0xa) continue
      if (op === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
        try { this.sock.write(frame(0x8, payload.subarray(0, 2))) } catch { /* gone */ }
        this._closed(code)
        return
      }
      if (op === 0x1 || op === 0x2) { this._fragOp = op; this._frags = [payload] }
      else if (op === 0x0) this._frags.push(payload)
      else continue
      if (fin) {
        const whole = this._frags.length === 1 ? this._frags[0] : Buffer.concat(this._frags)
        const isText = this._fragOp === 0x1
        this._frags = []
        try { this.onMessage(whole, isText) } catch (e) { this._closed(1011, e); return }
      }
    }
  }
}

function frame(op, payload) {
  const mask = crypto.randomBytes(4)
  let head
  if (payload.length < 126) head = Buffer.from([0x80 | op, 0x80 | payload.length])
  else if (payload.length < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 0x80 | 126; head.writeUInt16BE(payload.length, 2) }
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(payload.length), 2) }
  const masked = Buffer.alloc(payload.length)
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3]
  return Buffer.concat([head, mask, masked])
}
