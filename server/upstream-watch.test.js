import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { normalizeSettings } from './console-settings.js'
import { qqIncidents } from './qq-bot.js'
import { applyRateSnapshot, normalizeSubscriptionProgress, syncUpstreamWatch, watchIncidents } from './upstream-watch.js'

const settings = normalizeSettings()
const at = 1_700_000_000_000
const group = (id, name, rate) => ({ id, name, rate })

test('rate changes baseline once, ignore small moves, and merge adds, removals and real changes', () => {
  const channel = { id: 'up', name: '上游 A', provider: 'sub2api' }
  assert.equal(applyRateSnapshot(channel, [group('1', 'Pro', 1), group('2', 'Auto', null)], settings.rateChangeMinPercent, at), null)
  assert.equal(channel.upstreamWatch.rateBaselined, true)
  assert.equal(applyRateSnapshot(channel, [group('1', 'Pro', 1.005), group('2', 'Auto', null)], 1, at + 1000), null)
  assert.equal(channel.upstreamWatch.rateChanges, undefined)
  const alert = applyRateSnapshot(channel, [group('1', 'Pro', 1.2), group('3', 'New', 0.4)], 1, at + 2000)
  assert.match(alert.text, /倍率变动：上游 A/)
  assert.match(alert.text, /新增 1：New 0\.4×/)
  assert.match(alert.text, /删除 1：Auto 自动/)
  assert.match(alert.text, /Pro 1\.005×→1\.2×（19%）/)
  assert.equal(channel.upstreamWatch.rateChanges.length, 1)
  assert.equal(applyRateSnapshot(channel, [group('1', 'Pro', 1.2), group('3', 'New', 0.4)], 1, at + 3000), null)
  assert.equal(channel.upstreamWatch.rateAlert.key, alert.key)
})

test('announcements alert only after the baseline, and subscriptions stay separate from wallet balance', async t => {
  let announcements = [], progress = []
  const upstream = createServer((req, res) => {
    const data = req.url.endsWith('/announcements') ? announcements : progress
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ code: 0, data }))
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening'); t.after(() => upstream.close())
  const channel = { id: 'sub', name: '订阅站', provider: 'sub2api', endpoint: `http://127.0.0.1:${upstream.address().port}`, token: 'session' }
  const first = await syncUpstreamWatch(channel, [group('1', 'Pro', 1)], at, settings)
  assert.equal(first.rateAlert, null)
  assert.deepEqual(first.newAnnouncements, [])
  announcements = [{ id: 7, title: '维护', content: '今晚维护', created_at: '2026-09-23T00:00:00Z' }]
  progress = [{ subscription: { id: 4, status: 'active', group: { name: 'Codex' } }, progress: { id: 4, group_name: 'Codex', expires_in_days: 2, expires_at: '2026-09-25T00:00:00Z',
    daily: { limit_usd: 10, used_usd: 9, remaining_usd: 1 }, weekly: { limit_usd: 20, used_usd: 1, remaining_usd: 19 } } }]
  const second = await syncUpstreamWatch(channel, [group('1', 'Pro', 1)], at + 1000, settings)
  assert.equal(second.newAnnouncements.length, 1)
  assert.match(second.newAnnouncements[0].text, /上游公告：订阅站。维护/)
  const incidents = watchIncidents(channel, settings).map(item => item.key)
  assert.ok(incidents.includes('announce:sub:7'))
  assert.ok(incidents.includes('sub:daily:sub:4'))
  assert.ok(incidents.includes('sub:exp:sub:4'))
  assert.equal(incidents.some(key => key.includes('weekly')), false)
  channel.ignoreAnnouncements = true
  await syncUpstreamWatch(channel, [group('1', 'Pro', 1)], at + 2000, settings)
  assert.equal(watchIncidents(channel, settings).some(item => item.key.startsWith('announce:')), false)
  assert.equal(channel.upstreamWatch.announcements[0].title, '维护')
  assert.equal(channel.balance, undefined)
})

test('missing subscription and announcement routes do not fail the rate baseline', async t => {
  const upstream = createServer((req, res) => { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: 404, message: 'missing' })) })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening'); t.after(() => upstream.close())
  const channel = { id: 'old', name: '旧站', provider: 'sub2api', endpoint: `http://127.0.0.1:${upstream.address().port}` }
  const result = await syncUpstreamWatch(channel, [group('1', 'Pro', 1)], at, settings)
  assert.equal(result.rateAlert, null)
  assert.equal(channel.upstreamWatch.rateBaselined, true)
  assert.equal(channel.upstreamWatch.announcementsError, null)
  assert.deepEqual(channel.upstreamWatch.subscriptions, [])
})

test('newapi notices come from the public status and notice endpoints', async t => {
  const upstream = createServer((req, res) => {
    assert.equal(req.headers.authorization, undefined)
    const data = req.url.endsWith('/api/status') ? { announcements: [{ content: '价格调整', publishDate: '2026-09-23T00:00:00Z', extra: '价格' }] } : '文本通知'
    res.end(JSON.stringify({ success: true, data }))
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening'); t.after(() => upstream.close())
  const channel = { id: 'new', name: 'New', provider: 'newapi', endpoint: `http://127.0.0.1:${upstream.address().port}/v1`, token: 'secret', userId: '9' }
  const first = await syncUpstreamWatch(channel, [group('vip', 'VIP', 0.3)], at, settings)
  assert.deepEqual(first.newAnnouncements, [])
  assert.deepEqual(channel.upstreamWatch.announcements.map(item => item.title), ['价格', '站点通知'])
  const second = await syncUpstreamWatch(channel, [group('vip', 'VIP', 0.3)], at + 1, settings)
  assert.deepEqual(second.newAnnouncements, [])
  assert.equal(JSON.stringify(channel.upstreamWatch).includes('secret'), false)
})

test('subscription progress keeps remaining amounts and rejects a bad payload', () => {
  const [item] = normalizeSubscriptionProgress([{ subscription: { id: 3, status: 'expired' }, progress: { id: 3, group_name: 'Max', expires_in_days: -1, monthly: { limit_usd: 5, remaining_usd: 0, used_usd: 5 } } }])
  assert.equal(item.monthly.remainingPercent, 0)
  assert.equal(item.status, 'expired')
  assert.throws(() => normalizeSubscriptionProgress({}), /订阅用量格式无效/)
  const found = qqIncidents({ channels: [{ id: 'up', name: '上游', upstreamWatch: { subscriptions: [item] } }], sites: [], settings, now: at })
  assert.deepEqual(found.map(entry => entry.key), ['sub:exp:up:3'])
})
