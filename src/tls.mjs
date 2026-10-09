// How the gateway serves HTTPS (ASR.md §11). `tls` in the config:
//   absent / "auto"   our own self-signed certificate — unless we listen only on loopback (then a reverse proxy on this
//                     machine is in front and we speak plain HTTP to it)
//   "self"            our own self-signed certificate, always
//   null / "off"      plain HTTP: your own HTTPS reverse proxy is in front
//   { cert, key }     PEM files (e.g. a certificate for your domain)
// The self-signed certificate (selfcert.mjs: ECDSA P-256, SAN = the public address, 10 years) is kept in the data
// directory (self-cert.pem, self-key.pem), so its pin — "sha256:" + hex SHA-256 of the certificate (DER), what the App
// checks instead of certificate authorities — stays the same across restarts. The gateway makes a new one only when
// the old one is missing, broken, about to expire or made for another public address (then the connection line
// changes anyway); `new-token` and `connect-string` never replace it.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { makeSelfSigned, ensureSelfSigned, pinOf } from './selfcert.mjs'
import { matchOwner } from './lib/files.mjs'

export const SELF_CERT = 'self-cert.pem'
export const SELF_KEY = 'self-key.pem'

export function isLoopback(host) {
  if (host === null || host === undefined || host === '') return false
  const h = String(host).toLowerCase()
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h) || /^::ffff:127\.\d+\.\d+\.\d+$/.test(h)
}

/** 'off' | 'files' | 'self' for this configuration. */
export function tlsMode(config) {
  const t = config.tls
  if (t && typeof t === 'object') return 'files'
  if (t === 'self') return 'self'
  if (t === null || t === 'off') return 'off'
  return isLoopback(config.listen?.host) ? 'off' : 'self'
}

const firstPem = (pem) => (/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(pem) || [pem])[0]

/** Is this certificate signed by its own key (self-signed), as opposed to issued by a certificate authority? */
export function isSelfIssued(certPem) {
  try {
    const x = new crypto.X509Certificate(firstPem(certPem))
    return x.issuer === x.subject && x.verify(x.publicKey)
  } catch { return false }
}

/**
 * The gateway's own certificate in `dataDir`. `replace: false` (the CLI commands) keeps any working pair as it is and
 * only makes the first one, so a command run with other settings never pulls the certificate out from under the
 * running gateway.
 * @returns {{ certPem, keyPem, pin, created: boolean, reason: string|null, file: string }}
 */
export function selfCert(dataDir, { host = null, replace = true, now = Date.now() } = {}) {
  const certFile = path.join(dataDir, SELF_CERT), keyFile = path.join(dataDir, SELF_KEY)
  let current = null
  try { current = new crypto.X509Certificate(fs.readFileSync(certFile, 'utf8')) } catch { /* none yet */ }
  if (!replace && current) {
    try {
      const certPem = fs.readFileSync(certFile, 'utf8'), keyPem = fs.readFileSync(keyFile, 'utf8')
      if (current.checkPrivateKey(crypto.createPrivateKey(keyPem))) return { certPem, keyPem, pin: pinOf(current), created: false, reason: null, file: certFile }
    } catch { /* broken: make it below */ }
  }
  // A certificate made while the public address was unknown names no address. Phones pin it, so once someone has pasted
  // a line with it, it must not be replaced just because the address became known (whoami answering later).
  if (current && !current.subjectAltName) host = null
  const r = ensureSelfSigned({ dir: dataDir, host, now })
  if (r.created) { matchOwner(r.keyFile, dataDir); matchOwner(r.certFile, dataDir) }
  return { certPem: r.certPem, keyPem: r.keyPem, pin: r.pin, created: r.created, reason: r.reason, file: r.certFile }
}

/**
 * Everything the listener needs: { mode, cert?, key?, pin, selfIssued, created?, file? }.
 * `publicHost` is the address phones use (IP or name; null = not known, keep what we have).
 */
export function prepareTls(config, { publicHost = null, replace = true, log = () => {}, now = Date.now() } = {}) {
  const mode = tlsMode(config)
  if (mode === 'off') return { mode, pin: null, selfIssued: false }
  if (mode === 'files') {
    const read = (f, what) => {
      try { return fs.readFileSync(f, 'utf8') } catch (e) { throw new Error(`config: tls.${what} (${f}) cannot be read (${e.code || e.message})`) }
    }
    const cert = read(config.tls.cert, 'cert'), key = read(config.tls.key, 'key')
    return { mode, cert, key, pin: pinOf(firstPem(cert)), selfIssued: isSelfIssued(cert) }
  }
  if (!config.dataDir) {
    const c = makeSelfSigned({ host: publicHost })
    log('tls: no dataDir, so this self-signed certificate (and its pin) is new on every start')
    return { mode, cert: c.certPem, key: c.keyPem, pin: c.pin, selfIssued: true, created: true }
  }
  const c = selfCert(config.dataDir, { host: publicHost, replace, now })
  if (c.created) {
    log(c.reason === 'missing'
      ? `tls: made a self-signed certificate (${c.file})`
      : `tls: made a new self-signed certificate (the old one was ${c.reason}); its pin changed, so paste the new connection line into the App`)
  }
  return { mode, cert: c.certPem, key: c.keyPem, pin: c.pin, selfIssued: true, created: c.created, file: c.file }
}
