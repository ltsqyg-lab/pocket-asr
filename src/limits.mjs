// Per-caller rate and concurrency limits plus a gateway-wide concurrency limit (ASR.md §6 "limits").
// A caller is a token label or a ticket account.

export class Limiter {
  constructor({ perMinute = 12, concurrentPerCaller = 2, concurrent = 8 } = {}, now = () => Date.now()) {
    this.perMinute = perMinute
    this.concurrentPerCaller = concurrentPerCaller
    this.concurrent = concurrent
    this.now = now
    this.windows = new Map()   // caller → [timestamps in the last minute]
    this.callers = new Map()   // caller → requests in progress
    this.active = 0            // engine calls in progress
  }

  /** Count one recognition against the caller's minute; { ok, retryAfter (s) }. */
  takeRate(caller) {
    if (!this.perMinute) return { ok: true }
    const t = this.now()
    const w = (this.windows.get(caller) || []).filter((x) => t - x < 60_000)
    if (w.length >= this.perMinute) {
      this.windows.set(caller, w)
      return { ok: false, retryAfter: Math.max(1, Math.ceil((60_000 - (t - w[0])) / 1000)) }
    }
    w.push(t)
    this.windows.set(caller, w)
    return { ok: true }
  }

  /** A request of this caller is in progress (upload + recognition); returns release() or null when over the limit. */
  enterCaller(caller) {
    const n = this.callers.get(caller) || 0
    if (this.concurrentPerCaller && n >= this.concurrentPerCaller) return null
    this.callers.set(caller, n + 1)
    return once(() => {
      const m = (this.callers.get(caller) || 1) - 1
      if (m > 0) this.callers.set(caller, m); else this.callers.delete(caller)
    })
  }

  /** An engine call is in progress; returns release() or null when the gateway is full. */
  enterEngine() {
    if (this.concurrent && this.active >= this.concurrent) return null
    this.active++
    return once(() => { this.active-- })
  }

  sweep() {
    const t = this.now()
    for (const [k, w] of this.windows) {
      const kept = w.filter((x) => t - x < 60_000)
      if (kept.length) this.windows.set(k, kept); else this.windows.delete(k)
    }
  }
}

function once(fn) { let done = false; return () => { if (!done) { done = true; fn() } } }
