// Small fetch wrapper for the cloud adapters: honours the request's AbortSignal, caps the response size and turns
// network failures into `engine-error` (details for the log only). Aborts propagate unchanged so the gateway can tell
// a timeout from a client that went away.

import { AsrError } from '../errors.mjs'

const MAX_RESPONSE = 4 * 1024 * 1024

export function isAbort(e) {
  return !!e && (e.name === 'AbortError' || e.name === 'TimeoutError' || e.code === 'ABORT_ERR')
}

/**
 * @returns {Promise<{ status: number, headers: Headers, text: string, json: any }>}  json is null when the body isn't JSON
 */
export async function httpRequest(url, { method = 'GET', headers = {}, body, signal, maxBytes = MAX_RESPONSE } = {}) {
  let res
  try {
    res = await fetch(url, { method, headers, body, signal, redirect: 'error' })
  } catch (e) {
    if (isAbort(e) || signal?.aborted) throw abortError()
    const code = e?.cause?.code || e?.code || 'network'
    throw new AsrError('engine-error', `connect:${code}`)
  }
  const chunks = []
  let size = 0
  try {
    if (res.body) {
      for await (const chunk of res.body) {
        size += chunk.length
        if (size > maxBytes) throw new AsrError('engine-error', 'response-too-large')
        chunks.push(Buffer.from(chunk))
      }
    }
  } catch (e) {
    if (e instanceof AsrError) throw e
    if (isAbort(e) || signal?.aborted) throw abortError()
    throw new AsrError('engine-error', 'read-failed')
  }
  const text = Buffer.concat(chunks).toString('utf8')
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = null }
  return { status: res.status, headers: res.headers, text, json }
}

export function abortError() {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}

/** Map an HTTP status from a provider to a gateway code (provider's own body codes refine this in each adapter). */
export function statusToCode(status) {
  if (status === 429) return 'busy'
  if (status === 408 || status === 504) return 'engine-timeout'
  if (status === 413) return 'too-long'
  return 'engine-error'
}
