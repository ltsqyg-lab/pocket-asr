// Minimal WebSocket server for the provider fakes (Volcano, iFlytek). Test-only.

import http from 'node:http'
import https from 'node:https'
import crypto from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/**
 * @param {(conn, req) => void} onConnection   conn: { send(buf|string), close(code), onMessage(data, isText), onClose(), req }
 * @param {{ reject?: (req) => ({ status, headers }) | null }} [opts]  answer the upgrade with an HTTP error instead
 */
export async function startWsServer(onConnection, opts = {}) {
  const reply = (req, res) => { res.writeHead(426); res.end() }
  const server = opts.tls ? https.createServer(opts.tls, reply) : http.createServer(reply)
  const sockets = new Set()
  server.on('upgrade', (req, sock) => {
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
    const rej = opts.reject?.(req)
    if (rej) {
      const head = [`HTTP/1.1 ${rej.status} Rejected`, ...Object.entries(rej.headers || {}).map(([k, v]) => `${k}: ${v}`), 'Content-Length: 0', '', '']
      sock.end(head.join('\r\n'))
      return
    }
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + GUID).digest('base64')
    sock.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, ...(opts.extraHeaders || []), '', ''].join('\r\n'))
    const conn = {
      req,
      onMessage: () => {},
      onClose: () => {},
      send(data) {
        if (sock.destroyed) return
        const isText = typeof data === 'string'
        const p = isText ? Buffer.from(data) : data
        let head
        if (p.length < 126) head = Buffer.from([0x80 | (isText ? 1 : 2), p.length])
        else if (p.length < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | (isText ? 1 : 2); head[1] = 126; head.writeUInt16BE(p.length, 2) }
        else { head = Buffer.alloc(10); head[0] = 0x80 | (isText ? 1 : 2); head[1] = 127; head.writeBigUInt64BE(BigInt(p.length), 2) }
        sock.write(Buffer.concat([head, p]))
      },
      close(code = 1000) { const p = Buffer.alloc(2); p.writeUInt16BE(code); if (!sock.destroyed) sock.end(Buffer.concat([Buffer.from([0x88, 2]), p])) },
      destroy() { sock.destroy() },
      masks: [],
    }
    let buf = Buffer.alloc(0)
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      while (buf.length >= 2) {
        const op = buf[0] & 0x0f
        const masked = (buf[1] & 0x80) !== 0
        let len = buf[1] & 0x7f, off = 2
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4 }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10 }
        if (buf.length < off + (masked ? 4 : 0) + len) return
        conn.masks.push(masked)
        let p = buf.subarray(off + (masked ? 4 : 0), off + (masked ? 4 : 0) + len)
        if (masked) { const m = buf.subarray(off, off + 4); p = Buffer.from(p); for (let i = 0; i < p.length; i++) p[i] ^= m[i & 3] }
        buf = buf.subarray(off + (masked ? 4 : 0) + len)
        if (op === 0x8) { sock.end(); return }
        if (op === 0x1 || op === 0x2) conn.onMessage(p, op === 0x1)
      }
    })
    sock.on('close', () => conn.onClose())
    sock.on('error', () => {})
    onConnection(conn, req)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: (path = '/') => `${opts.tls ? 'wss' : 'ws'}://127.0.0.1:${server.address().port}${path}`,
    port: server.address().port,
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()) }),
  }
}

/** Plain HTTP fake: handler(req, body) → { status, json?, body?, headers? } (may be async / may hang on a signal). */
export async function startHttpFake(handler) {
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = Buffer.concat(chunks)
    let r
    try { r = await handler(req, body, res) } catch (e) { r = { status: 500, json: { error: String(e.message) } } }
    if (!r || res.headersSent || res.destroyed) return
    const payload = r.json !== undefined ? Buffer.from(JSON.stringify(r.json)) : Buffer.isBuffer(r.body) ? r.body : Buffer.from(r.body || '')
    res.writeHead(r.status || 200, { 'Content-Type': r.json !== undefined ? 'application/json' : 'text/plain', ...(r.headers || {}) })
    res.end(payload)
  })
  const sockets = new Set()
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: (path = '/') => `http://127.0.0.1:${server.address().port}${path}`,
    host: `127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()) }),
  }
}
