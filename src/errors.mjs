// Error codes of the gateway API (ASR.md §2). `detail` is for the operator's log only: an internal or provider code,
// never audio, recognised text, keys, tokens, tickets or proofs.

export const STATUS = {
  'bad-audio': 400,
  'too-large': 413,
  'too-long': 413,
  'empty': 422,
  'unauthorized': 401,
  'rate': 429,
  'quota': 429,
  'busy': 503,
  'no-engine': 400,
  'engine-error': 502,
  'engine-timeout': 504,
  'bad-request': 400,
  'not-found': 404,
  'method': 405,
}

const MESSAGES = {
  'bad-audio': 'audio must be a WAV file: PCM, 16 kHz, mono, 16-bit',
  'too-large': 'audio file is too large',
  'too-long': 'audio is too long for this engine',
  'empty': 'no speech recognised',
  'unauthorized': 'missing or invalid credentials',
  'rate': 'too many requests, slow down',
  'quota': 'speech time used up for now',
  'busy': 'the gateway is busy, try again shortly',
  'no-engine': 'no engine for this language',
  'engine-error': 'the speech engine failed',
  'engine-timeout': 'the speech engine timed out',
  'bad-request': 'bad request',
  'not-found': 'not found',
  'method': 'method not allowed',
}

export class AsrError extends Error {
  /**
   * @param {string} code    one of STATUS
   * @param {string} [detail] short machine detail for the log (e.g. 'expired', 'provider:40000001', 'http-401')
   * @param {object} [extra]  { retryAfter } seconds; { body } more fields for the answer (e.g. `quota`: zh, en, quota)
   */
  constructor(code, detail, extra = {}) {
    super(MESSAGES[code] || code)
    this.name = 'AsrError'
    this.code = STATUS[code] ? code : 'engine-error'
    this.detail = detail ? cleanDetail(detail) : undefined
    this.retryAfter = extra.retryAfter
    this.body = extra.body && typeof extra.body === 'object' ? extra.body : null
  }
  get status() { return STATUS[this.code] || 500 }
  toJSON() { return { ok: false, code: this.code, message: this.message, ...(this.body ?? {}) } }
}

/** Provider codes and internal reasons go to the log: keep them short and inert. */
export function cleanDetail(s) {
  return String(s).replace(/[^A-Za-z0-9._:\-]/g, '_').slice(0, 80)
}
