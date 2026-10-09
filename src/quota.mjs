// Speech time per caller (ASR.md §6 "Speech time"): seconds of audio sent to an engine per day and per month, in the
// configured time zone (Beijing time by default). A ticket caller's caps come from its account's newest ticket
// (`asrQuota: {dayMin, monthMin}`, minutes, 0 = no cap); a field the ticket leaves out — and every static-token caller —
// gets limits.dayMinutes / limits.monthMinutes. The figures live in <dataDir>/usage.json (0600) so a restart does not
// reset them; the file holds a hash of each caller, never the account id or token label.
//
// License: AGPL-3.0-only.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { AsrError } from './errors.mjs'

const FILE = 'usage.json'
const SAVE_MS = 2000
const KEEP_TICKET_MS = 2 * 86_400_000     // tickets live at most a day: after two, any ticket shown is newer anyway
const MAX_CALLERS = 200_000

const minutes = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
/** The fields of a ticket's asrQuota the gateway uses; anything else is dropped. */
export function asrQuotaOf(q) {
  if (!q || typeof q !== 'object' || Array.isArray(q)) return null
  const out = {}
  if (minutes(q.dayMin) !== null) out.dayMin = q.dayMin
  if (minutes(q.monthMin) !== null) out.monthMin = q.monthMin
  return out
}

const tzWords = (tz) => (tz === 'Asia/Shanghai' ? { zh: '北京时间', en: 'Beijing time' } : { zh: `${tz} 时间`, en: `${tz} time` })
const enMinutes = (m) => `${m.toLocaleString('en-US')} minute${m === 1 ? '' : 's'}`

export class SpeechTime {
  /**
   * @param {{ timezone?: string, dayMinutes?: number, monthMinutes?: number, dataDir?: string|null,
   *           now?: () => number, log?: (line: string) => void }} opts  dayMinutes / monthMinutes: 0 = no cap
   */
  constructor({ timezone = 'Asia/Shanghai', dayMinutes = 120, monthMinutes = 1500, dataDir = null, now = () => Date.now(), log = () => {} } = {}) {
    this.tz = timezone
    this.dayMinutes = minutes(dayMinutes) ?? 0
    this.monthMinutes = minutes(monthMinutes) ?? 0
    this.file = dataDir ? path.join(dataDir, FILE) : null
    this.now = now
    this.log = log
    this.fmt = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    this.day = this.dayKey(now())
    this.month = this.day.slice(0, 7)
    this.used = new Map()                 // caller hash → { d: seconds today, m: seconds this month }
    this.tickets = new Map()              // caller hash → { iat, q } of the newest ticket seen
    this.timer = null
    this.dirty = false
    this.saving = false                   // only a gateway that serves writes the file (not `cli.mjs check` and the like)
    this._load()
  }

  /** The gateway is serving: from now on changes are written to the data directory. */
  start() {
    this.saving = true
    if (this.dirty) { this.dirty = false; this._dirty() }
  }

  dayKey(t) { return this.fmt.format(new Date(t)) }       // YYYY-MM-DD in the configured time zone
  keyOf(caller) { return crypto.createHash('sha256').update(`pocket-asr usage|${caller}`).digest('base64url').slice(0, 22) }

  /** First instant after `t` whose key differs (binary search; handles odd offsets and DST). */
  nextBoundary(t, keyOf, span) {
    const k = keyOf(t)
    let lo = t, hi = t + span
    if (keyOf(hi) === k) return hi
    while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (keyOf(mid) === k) lo = mid; else hi = mid }
    return hi
  }

  /** A new day or month starts the counters again. */
  roll() {
    const d = this.dayKey(this.now()), m = d.slice(0, 7)
    if (d === this.day) return
    const newMonth = m !== this.month
    for (const [k, u] of this.used) {
      u.d = 0
      if (newMonth) u.m = 0
      if (!u.m) this.used.delete(k)
    }
    this.day = d
    this.month = m
    const old = this.now() - KEEP_TICKET_MS
    for (const [k, t] of this.tickets) if (t.iat < old) this.tickets.delete(k)
    this._dirty()
  }

  /** A ticket was accepted: the newest one an account has shown sets its caps, whichever device holds it. */
  observe(who) {
    if (who?.kind !== 'ticket' || !Number.isSafeInteger(who.T?.iat)) return
    const k = this.keyOf(who.caller)
    const cur = this.tickets.get(k)
    if (cur && cur.iat >= who.T.iat) return
    this.tickets.set(k, { iat: who.T.iat, q: asrQuotaOf(who.T.asrQuota) })
    this._dirty()
  }

  /** Caps in seconds (0 = no cap) for a caller. */
  caps(who) {
    let q = null
    if (who?.kind === 'ticket') q = this.tickets.get(this.keyOf(who.caller))?.q ?? asrQuotaOf(who.T?.asrQuota)
    const day = q?.dayMin ?? this.dayMinutes, month = q?.monthMin ?? this.monthMinutes
    return { day: Math.round(day * 60), month: Math.round(month * 60) }
  }

  /** Seconds used and caps: { day: {used, cap}, month: {used, cap} }. */
  usage(who) {
    this.roll()
    const u = this.used.get(this.keyOf(who.caller)) || { d: 0, m: 0 }
    const c = this.caps(who)
    const r = (s) => Math.round(s * 10) / 10
    return { day: { used: r(u.d), cap: c.day }, month: { used: r(u.m), cap: c.month } }
  }

  /** Throw `quota` (429, Retry-After, a sentence in Chinese and English) when the day's or the month's time is used up. */
  check(who) {
    const u = this.usage(who)
    const over = (x) => x.cap > 0 && x.used >= x.cap
    const now = this.now()
    const tz = tzWords(this.tz)
    if (over(u.month)) {
      const m = Math.round(u.month.cap / 60)
      const retryAfter = Math.max(1, Math.ceil((this.nextBoundary(now, (x) => this.dayKey(x).slice(0, 7), 32 * 86_400_000) - now) / 1000))
      throw new AsrError('quota', 'month', {
        retryAfter,
        body: { zh: `这个月的语音识别用完了(每月 ${m} 分钟),下个月 1 号恢复`, en: `Speech recognition is used up for this month (${enMinutes(m)} a month). It resets on the 1st.`, retryAfter, quota: u },
      })
    }
    if (over(u.day)) {
      const m = Math.round(u.day.cap / 60)
      const retryAfter = Math.max(1, Math.ceil((this.nextBoundary(now, (x) => this.dayKey(x), 27 * 3_600_000) - now) / 1000))
      throw new AsrError('quota', 'day', {
        retryAfter,
        body: { zh: `今天的语音识别用完了(每天 ${m} 分钟),${tz.zh} 0 点恢复`, en: `Speech recognition is used up for today (${enMinutes(m)} a day). It resets at midnight ${tz.en}.`, retryAfter, quota: u },
      })
    }
  }

  /** Count audio that went to an engine (every recognition that reached one, whatever its result). */
  charge(who, seconds) {
    if (!(seconds > 0)) return
    this.roll()
    const k = this.keyOf(who.caller)
    let u = this.used.get(k)
    if (!u) {
      if (this.used.size >= MAX_CALLERS) return       // a flood of callers must not grow this without end
      u = { d: 0, m: 0 }
      this.used.set(k, u)
    }
    u.d += seconds
    u.m += seconds
    this._dirty()
  }

  // ---- persistence ---------------------------------------------------------------------------------------------
  _dirty() {
    if (!this.file) return
    this.dirty = true
    if (this.timer || !this.saving) return
    this.timer = setTimeout(() => { this.timer = null; this.flush() }, SAVE_MS)
    this.timer.unref?.()
  }

  flush() {
    if (!this.file || !this.dirty || !this.saving) return
    this.dirty = false
    const doc = {
      v: 1, day: this.day, month: this.month,
      used: Object.fromEntries([...this.used].map(([k, u]) => [k, [Math.round(u.d * 100) / 100, Math.round(u.m * 100) / 100]])),
      tickets: Object.fromEntries([...this.tickets].map(([k, t]) => [k, [t.iat, t.q?.dayMin ?? null, t.q?.monthMin ?? null]])),
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
      const tmp = `${this.file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(doc), { mode: 0o600 })
      fs.renameSync(tmp, this.file)
    } catch (e) { this.dirty = true; this.log(`speech time not saved ${e.code || ''}`) }
  }

  _load() {
    if (!this.file) return
    let doc
    try { doc = JSON.parse(fs.readFileSync(this.file, 'utf8')) } catch { return }   // none yet, or unreadable: start empty
    if (!doc || doc.v !== 1 || typeof doc.day !== 'string' || typeof doc.month !== 'string') return
    for (const [k, v] of Object.entries(doc.used || {})) {
      if (!Array.isArray(v) || this.used.size >= MAX_CALLERS) continue
      const d = Number(v[0]) || 0, m = Number(v[1]) || 0
      if (d >= 0 && m >= 0) this.used.set(k, { d, m })
    }
    for (const [k, v] of Object.entries(doc.tickets || {})) {
      if (!Array.isArray(v) || !Number.isSafeInteger(v[0])) continue
      this.tickets.set(k, { iat: v[0], q: asrQuotaOf({ dayMin: v[1] ?? undefined, monthMin: v[2] ?? undefined }) })
    }
    this.day = doc.day
    this.month = doc.month
    this.roll()                                // the file is from yesterday or last month: start those counters again
  }

  close() {
    clearTimeout(this.timer)
    this.timer = null
    this.flush()
  }
}
