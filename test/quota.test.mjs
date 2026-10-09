// Speech time per caller (security review 2026-10-09, M3; ASR.md §6): seconds of audio per day and per month in Beijing
// time, caps from the account's newest ticket (`asrQuota`), else the configured defaults; 429 with Retry-After and a
// sentence in Chinese and English; kept across restarts; every recognition that reaches an engine counts.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import {
  startGateway, baseConfig, fakeAdapter, toneWav, silentWav, post, TOKEN, coordKeys, newDevice, makeTicket, makeProof, tmpDir,
} from './helpers.mjs'
import { hashToken } from '../src/auth.mjs'
import { AsrError } from '../src/errors.mjs'
import { SpeechTime, asrQuotaOf } from '../src/quota.mjs'
import { VERSION } from '../src/server.mjs'
import { loadConfig } from '../src/config.mjs'
import { rawConfig } from '../src/main.mjs'

const HOUR = 3_600_000, DAY = 86_400_000
// 2026-10-09 10:00 in Beijing (02:00 UTC): 14 hours to midnight there
const T0 = Date.UTC(2026, 9, 9, 2, 0, 0)

/** A gateway that takes tickets, on a clock the test moves. */
async function ticketGateway(over = {}, { dataDir } = {}) {
  const clock = { t: T0 }
  const coord = coordKeys(T0)
  const fake = fakeAdapter()
  const cfg = baseConfig({ ...(dataDir ? { dataDir } : {}), auth: { tokens: [{ label: 'my phone', sha256: hashToken(TOKEN) }], ticket: { enabled: true, pinnedKeys: [coord.entry] } }, ...over })
  const g = await startGateway(cfg, { adapters: { fake }, now: () => clock.t })
  const send = (dev, wav, ticketOpts = {}) => {
    const ticket = makeTicket(coord, dev, { iat: clock.t - 60_000, exp: clock.t + 6 * HOUR, ...ticketOpts })
    return post(`${g.url}/v1/recognize?lang=zh`, wav, { Authorization: `PocketTicket ${ticket}`, 'X-Pocket-Proof': makeProof(dev, wav, { ts: clock.t }).header })
  }
  return { g, fake, coord, clock, send, cfg }
}

test('a ticket\'s asrQuota caps the account per day: 429 with Retry-After to midnight in Beijing and a sentence in both languages', async () => {
  const { g, fake, clock, send } = await ticketGateway()
  try {
    const dev = newDevice({ acct: 'u_quota01' })
    const quota = { asrQuota: { dayMin: 1, monthMin: 3 } }
    const clip = toneWav(30)
    assert.equal((await send(dev, clip, quota)).status, 200)
    assert.equal((await send(dev, clip, quota)).status, 200)
    const r = await send(dev, clip, quota)
    assert.equal(r.status, 429)
    assert.equal(r.json.code, 'quota')
    assert.equal(r.headers.get('retry-after'), String(14 * 3600))
    assert.equal(r.json.retryAfter, 14 * 3600)
    assert.equal(r.json.zh, '今天的语音识别用完了(每天 1 分钟),北京时间 0 点恢复')
    assert.equal(r.json.en, 'Speech recognition is used up for today (1 minute a day). It resets at midnight Beijing time.')
    assert.deepEqual(r.json.quota, { day: { used: 60, cap: 60 }, month: { used: 60, cap: 180 } })
    assert.equal(fake.calls.length, 2, 'the refused request never reached the engine')
    assert.match(g.lines.at(-1), /caller=acct:u_quota01 engine=- sec=0\.00 chars=0 ms=\d+ code=quota detail=day/, 'refused before the audio was read')
    // another account is not affected
    assert.equal((await send(newDevice({ acct: 'u_quota02' }), clip, quota)).status, 200)
    // the next day in Beijing (not in UTC) the day starts again; the month goes on
    clock.t = T0 + 13 * HOUR
    assert.equal((await send(dev, clip, quota)).status, 429, '23:00 in Beijing: still the same day')
    clock.t = T0 + 14 * HOUR + 1000
    assert.equal((await send(dev, clip, quota)).status, 200, 'after midnight in Beijing')
    assert.equal((await send(dev, clip, quota)).status, 200)
    clock.t = T0 + 2 * DAY
    assert.equal((await send(dev, clip, quota)).status, 200)
    assert.equal((await send(dev, clip, quota)).status, 200)
    // 3 minutes this month: refused until the 1st of November in Beijing, whatever the day says
    const m = await send(dev, clip, quota)
    assert.equal(m.status, 429)
    assert.equal(m.json.zh, '这个月的语音识别用完了(每月 3 分钟),下个月 1 号恢复')
    assert.equal(m.json.en, 'Speech recognition is used up for this month (3 minutes a month). It resets on the 1st.')
    const toNov = (Date.UTC(2026, 9, 31, 16, 0, 0) - clock.t) / 1000
    assert.equal(Number(m.headers.get('retry-after')), toNov)
    clock.t = T0 + 3 * DAY
    assert.equal((await send(dev, clip, quota)).status, 429, 'a new day does not lift a month that is used up')
    clock.t = Date.UTC(2026, 9, 31, 16, 0, 1)
    assert.equal((await send(dev, clip, quota)).status, 200, 'November in Beijing')
  } finally { await g.close() }
})

test('caps come from the account\'s newest ticket, whichever device shows it; without asrQuota the configured defaults; 0 = no cap', async () => {
  const { g, send } = await ticketGateway({ limits: { dayMinutes: 1, monthMinutes: 100 } })
  try {
    const clip = toneWav(40)
    // no asrQuota in the ticket: limits.dayMinutes (1 minute)
    const solo = newDevice({ acct: 'u_quota10' })
    assert.equal((await send(solo, clip)).status, 200)
    assert.equal((await send(solo, clip)).status, 200)
    assert.equal((await send(solo, clip)).status, 429)
    // two devices of one account: the phone still holds an old ticket with a large cap, the computer just renewed with
    // a small one; once the newer ticket has been seen, both are held to it
    const phone = newDevice({ acct: 'u_quota11' }), mac = newDevice({ acct: 'u_quota11', kind: 'computer' })
    const big = { asrQuota: { dayMin: 100 } }, small = { asrQuota: { dayMin: 1 } }
    assert.equal((await send(phone, clip, { ...big, iat: T0 - 2 * HOUR })).status, 200)
    assert.equal((await send(mac, clip, { ...small, iat: T0 - HOUR })).status, 200)
    assert.equal((await send(phone, clip, { ...big, iat: T0 - 2 * HOUR })).status, 429, 'the older ticket no longer counts')
    assert.equal((await send(phone, clip, { ...big, iat: T0 - 3 * HOUR })).status, 429, 'an even older one changes nothing')
    // a newer ticket raising the cap takes effect for everyone
    assert.equal((await send(phone, clip, { asrQuota: { dayMin: 0, monthMin: 0 }, iat: T0 - 1000 })).status, 200)
    assert.equal((await send(mac, clip, { ...small, iat: T0 - HOUR })).status, 200, '0 = no cap, for the whole account')
    // a field the ticket leaves out comes from the configuration
    const half = newDevice({ acct: 'u_quota12' })
    assert.equal((await send(half, clip, { asrQuota: { monthMin: 50 } })).status, 200)
    assert.equal((await send(half, clip, { asrQuota: { monthMin: 50 } })).status, 200)
    assert.equal((await send(half, clip, { asrQuota: { monthMin: 50 } })).status, 429, 'dayMinutes from the configuration')
  } finally { await g.close() }
})

test('static tokens get the configured caps, each token on its own', async () => {
  const fake = fakeAdapter()
  const cfg = baseConfig({
    auth: { tokens: [{ label: 'one', sha256: hashToken('tok-one') }, { label: 'two', sha256: hashToken('tok-two') }] },
    limits: { dayMinutes: 1, monthMinutes: 0, perMinute: 0 },
  })
  const g = await startGateway(cfg, { adapters: { fake } })
  try {
    const u = `${g.url}/v1/recognize?lang=zh`
    const clip = toneWav(35)
    assert.equal((await post(u, clip, { Authorization: 'Bearer tok-one' })).status, 200)
    assert.equal((await post(u, clip, { Authorization: 'Bearer tok-one' })).status, 200)
    const r = await post(u, clip, { Authorization: 'Bearer tok-one' })
    assert.equal(r.status, 429)
    assert.equal(r.json.quota.month.cap, 0, 'no monthly cap configured')
    assert.equal((await post(u, clip, { Authorization: 'Bearer tok-two' })).status, 200)
  } finally { await g.close() }
})

test('every recognition that reaches the engine counts, failed or cut off; requests refused before it do not', async () => {
  const fake = fakeAdapter()
  const g = await startGateway(baseConfig({ limits: { dayMinutes: 2, perMinute: 0 } }), { adapters: { fake }, deadlineMs: 300 })
  try {
    const u = `${g.url}/v1/recognize?lang=zh`
    const auth = { Authorization: `Bearer ${TOKEN}` }
    const used = () => g.gw.speech.usage({ kind: 'token', caller: 'token:my phone' }).day.used
    // refused before an engine: silence, too long, not audio
    assert.equal((await post(u, silentWav(20), auth)).json.code, 'empty')
    assert.equal((await post(u, toneWav(241), auth)).json.code, 'too-long')
    assert.equal((await post(u, Buffer.from('not audio, but long enough to be looked at by the parser....'), auth)).json.code, 'bad-audio')
    assert.equal(used(), 0)
    // the engine fails: counted
    fake.next = async () => { throw new AsrError('engine-error', 'provider:500') }
    assert.equal((await post(u, toneWav(30), auth)).status, 502)
    assert.equal(used(), 30)
    // the engine hears nothing: counted
    fake.next = async () => ({ text: '' })
    assert.equal((await post(u, toneWav(10), auth)).json.code, 'empty')
    assert.equal(used(), 40)
    // the client goes away while the engine works: counted
    let aborted
    const sawAbort = new Promise((r) => { aborted = r })
    fake.next = ({ signal }) => new Promise((resolve, reject) => { signal.addEventListener('abort', () => { aborted(); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) }) })
    const wav = toneWav(20)
    const req = http.request(u, { method: 'POST', headers: { ...auth, 'Content-Length': wav.length } })
    req.on('error', () => {})
    req.end(wav)
    for (let i = 0; i < 100 && fake.calls.length < 3; i++) await new Promise((r) => setTimeout(r, 20))
    req.destroy()
    await sawAbort
    assert.equal(used(), 60)
    // one that works: counted, and the next is refused
    fake.next = async () => ({ text: '好' })
    assert.equal((await post(u, toneWav(60), auth)).status, 200)
    assert.equal(used(), 120)
    assert.equal((await post(u, toneWav(1), auth)).json.code, 'quota')
  } finally { await g.close() }
})

test('speech time survives a restart (usage.json in the data directory, callers only as hashes) and a new day starts again', async () => {
  const dataDir = tmpDir()
  try {
    let gw = await ticketGateway({}, { dataDir })
    const dev = newDevice({ acct: 'u_quota20' })
    const quota = { asrQuota: { dayMin: 1 } }
    assert.equal((await gw.send(dev, toneWav(40), quota)).status, 200)
    assert.equal((await post(`${gw.g.url}/v1/recognize?lang=zh`, toneWav(20), { Authorization: `Bearer ${TOKEN}` })).status, 200)
    assert.equal((await gw.send(dev, toneWav(30), quota)).status, 200)
    await gw.g.close()
    const file = path.join(dataDir, 'usage.json')
    const text = fs.readFileSync(file, 'utf8')
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    for (const s of ['u_quota20', 'my phone', TOKEN]) assert.ok(!text.includes(s), `usage.json holds ${s}`)
    assert.equal(JSON.parse(text).day, '2026-10-09')
    // restarted: still used up today, also for a device that shows an older ticket without asrQuota
    gw = await ticketGateway({}, { dataDir })
    assert.equal((await gw.send(dev, toneWav(5), quota)).status, 429)
    assert.equal((await gw.send(dev, toneWav(5), { iat: T0 - 3 * HOUR })).status, 429, 'the newest ticket\'s caps were kept too')
    gw.clock.t = T0 + DAY
    assert.equal((await gw.send(dev, toneWav(5), quota)).status, 200, 'a new day')
    await gw.g.close()
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }) }
})

test('SpeechTime: asrQuota parsing, caps in seconds, the file is written atomically and read back, a broken file is ignored', () => {
  assert.deepEqual(asrQuotaOf({ dayMin: 10, monthMin: 0, extra: 1 }), { dayMin: 10, monthMin: 0 })
  assert.deepEqual(asrQuotaOf({ dayMin: -1, monthMin: '5' }), {})
  assert.equal(asrQuotaOf(null), null)
  assert.equal(asrQuotaOf([1]), null)
  const dir = tmpDir()
  const open = []
  const mk = (o) => { const s = new SpeechTime({ dataDir: dir, dayMinutes: 2, monthMinutes: 10, ...o }); open.push(s); return s }
  try {
    let t = T0
    const who = { kind: 'token', caller: 'token:x' }
    // an instance that never served (`node src/cli.mjs check`, …) writes nothing
    const idle = mk({ now: () => t })
    idle.charge(who, 5)
    idle.close()
    assert.equal(fs.existsSync(path.join(dir, 'usage.json')), false)
    const s = mk({ now: () => t })
    s.start()
    assert.deepEqual(s.caps(who), { day: 120, month: 600 })
    s.charge(who, 100)
    s.close()
    assert.deepEqual(mk({ now: () => t }).usage(who).day, { used: 100, cap: 120 })
    t = T0 + DAY
    assert.deepEqual(mk({ now: () => t }).usage(who), { day: { used: 0, cap: 120 }, month: { used: 100, cap: 600 } })
    fs.writeFileSync(path.join(dir, 'usage.json'), '{ broken')
    assert.equal(mk({ now: () => t }).usage(who).day.used, 0)
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'no temporary files left')
  } finally {
    for (const s of open) clearTimeout(s.timer)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('configuration: dayMinutes / monthMinutes default to 120 / 1500, the time zone to Beijing; both checked; ASR_DAY_MINUTES', () => {
  const c = loadConfig(baseConfig())
  assert.equal(c.limits.dayMinutes, 120)
  assert.equal(c.limits.monthMinutes, 1500)
  assert.equal(c.timezone, 'Asia/Shanghai')
  assert.throws(() => loadConfig(baseConfig({ limits: { dayMinutes: -1 } })), /limits\.dayMinutes/)
  assert.throws(() => loadConfig(baseConfig({ timezone: 'Mars/Olympus' })), /timezone/)
  assert.equal(loadConfig(baseConfig({ timezone: 'Europe/Berlin' })).timezone, 'Europe/Berlin')
  const raw = rawConfig(null, { ASR_DAY_MINUTES: '0', ASR_MONTH_MINUTES: '600' })
  assert.deepEqual(raw.limits, { dayMinutes: 0, monthMinutes: 600 })
  assert.throws(() => rawConfig(null, { ASR_DAY_MINUTES: 'lots' }), /ASR_DAY_MINUTES/)
})

test('another time zone: midnight there, and the sentence names it', async () => {
  const fake = fakeAdapter()
  const g = await startGateway(baseConfig({ timezone: 'Europe/Berlin', limits: { dayMinutes: 1 } }), { adapters: { fake }, now: () => Date.UTC(2026, 9, 9, 20, 0, 0) })
  try {
    const u = `${g.url}/v1/recognize?lang=zh`
    const auth = { Authorization: `Bearer ${TOKEN}` }
    assert.equal((await post(u, toneWav(60), auth)).status, 200)
    const r = await post(u, toneWav(1), auth)
    assert.equal(r.status, 429)
    assert.equal(Number(r.headers.get('retry-after')), 2 * 3600, '22:00 in Berlin (summer time): two hours to midnight')
    assert.match(r.json.zh, /Europe\/Berlin 时间 0 点恢复/)
    assert.match(r.json.en, /midnight Europe\/Berlin time/)
  } finally { await g.close() }
})

test('/v1/info gives the version without its patch level', async () => {
  const g = await startGateway(baseConfig(), { adapters: { fake: fakeAdapter() } })
  try {
    const j = await (await fetch(`${g.url}/v1/info`)).json()
    assert.equal(j.version, VERSION.split('.').slice(0, 2).join('.'))
    assert.match(j.version, /^\d+\.\d+$/)
  } finally { await g.close() }
})
