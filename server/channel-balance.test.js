import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { channelBalanceView, newAPIBalance, saveBalance, sub2APIBalance } from './channel-balance.js'
import { monitorAPI } from './monitor-api.js'
import { createChannelStore } from './site-store.js'
import { createChannelAuth } from './sub2api-auth.js'

test('account balances preserve zero, debt and precision, and never guess quota conversion', () => {
  const user = { quota: 1250000, used_quota: 9000000 }
  const settings = { quota_per_unit: 500000, quota_display_type: 'USD' }
  assert.equal(newAPIBalance(user, settings).amount, 2.5)
  assert.equal(newAPIBalance(user, { ...settings, quota_display_type: 'CNY', usd_exchange_rate: 7.2 }).amount, 18)
  const custom = newAPIBalance(user, { ...settings, quota_display_type: 'CUSTOM', custom_currency_symbol: '积分', custom_currency_exchange_rate: '10' })
  assert.equal(custom.amount, 25)
  assert.equal(custom.symbol, '积分')
  assert.equal(newAPIBalance({ quota: 0 }, settings).amount, 0)
  assert.equal(newAPIBalance({ quota: -5 }, settings).amount, -0.00001)
  assert.equal(newAPIBalance(user, { quota_per_unit: '500000', display_in_currency: true }).currency, 'USD')
  for (const config of [null, {}, { quota_per_unit: 0 }, { ...settings, quota_display_type: 'CNY' },
    { ...settings, quota_display_type: 'TOKENS' }, { ...settings, quota_display_type: 'CUSTOM', custom_currency_exchange_rate: 2 }]) {
    const result = newAPIBalance(user, config)
    assert.equal(result.currency, 'QUOTA')
    assert.equal(result.amount, user.quota)
    assert.ok(result.notice)
  }
  for (const balance of [0, -3.25, 0.000001, 17.234567]) assert.equal(sub2APIBalance({ balance }).amount, balance)
  for (const invalid of [undefined, null, '', '12', NaN, Infinity]) {
    assert.throws(() => sub2APIBalance({ balance: invalid }))
    assert.throws(() => newAPIBalance({ quota: invalid }, settings))
  }
  assert.throws(() => newAPIBalance({ quota: Number.MAX_SAFE_INTEGER + 1 }, settings))
})

test('recharge rates convert upstream wallet balance to actual balance and retain the raw value', () => {
  const channel = { rechargeRate: 1.2 }
  saveBalance(channel, { amount: 120, currency: 'USD', symbol: '$' }, Date.parse('2026-01-01T00:00:00Z'))
  assert.equal(channel.balance.amount, 100)
  assert.equal(channel.balance.rawAmount, 120)
  assert.equal(channel.balance.rawCurrency, 'USD')
  assert.equal(channelBalanceView(channel).amount, 100)
  channel.rechargeRate = 2
  assert.equal(channelBalanceView(channel).amount, 60)
  const unchanged = { rechargeRate: 1 }
  saveBalance(unchanged, { amount: 0, currency: 'USD', symbol: '$' }, Date.now())
  assert.equal(unchanged.balance.amount, 0)
})

test('a manual balance check does not defer a short-lived session renewal', async t => {
  let now = Date.now(), refreshes = 0
  const upstream = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url.startsWith('/api/v1/keys?')) return res.end(JSON.stringify({ code: 0, data: { items: [], total: 0, page: 1, page_size: 100 } }))
    if (req.url === '/api/v1/groups/available') return res.end(JSON.stringify({ code: 0, data: [] }))
    if (req.url === '/api/v1/groups/rates') return res.end(JSON.stringify({ code: 0, data: {} }))
    if (req.url === '/api/v1/auth/refresh') {
      refreshes++
      return res.end(JSON.stringify({ code: 0, data: { access_token: 'new-secret', refresh_token: 'new-refresh-secret', expires_in: 20 } }))
    }
    if (req.url === '/api/v1/announcements' || req.url === '/api/v1/subscriptions/progress') return res.end(JSON.stringify({ code: 0, data: [] }))
    assert.equal(req.url, '/api/v1/auth/me')
    res.end(JSON.stringify({ code: 0, data: { id: 1, balance: 2 } }))
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const channel = { id: 'short', provider: 'sub2api', endpoint: `http://127.0.0.1:${upstream.address().port}`,
    token: 'access-secret', refreshToken: 'refresh-secret', expiresAt: now + 20000, refreshAt: now + 10000 }
  const auth = createChannelAuth({ channels: new Map([[channel.id, channel]]), store: { save() {} }, now: () => now })
  t.after(async () => { await auth.stop(); upstream.close() })
  now += 2000
  await auth.check(channel.id)
  assert.equal(refreshes, 0)
  assert.equal(auth.nextCheckAt(channel.id), new Date(channel.refreshAt).toISOString())
  now += 13000
  await auth.runDue()
  assert.equal(refreshes, 1)
  assert.equal(channel.balance.amount, 2)
})

test('balance checks persist, renew Sub2API sessions and preserve snapshots through failures', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-balance-'))
  const disk = createChannelStore(directory)
  let failSave = false, now = Date.now(), balance = 12.3456, quota = 1500000
  let newFailure = '', subFailure = '', statusFailure = false, refreshes = 0, lookups = 0
  const store = { load: () => disk.load(), save: records => {
    if (failSave) throw new Error('private-disk-secret')
    disk.save(records)
  } }
  const upstream = createServer(async (req, res) => {
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
    if (req.url.startsWith('/sub/api/v1/keys?')) return send(200, { code: 0, data: { items: [], total: 0, page: 1, page_size: 100 } })
    if (req.url === '/sub/api/v1/groups/available') return send(200, { code: 0, data: [] })
    if (req.url === '/sub/api/v1/groups/rates') return send(200, { code: 0, data: {} })
    if (req.url.startsWith('/new/api/token/?')) return send(200, { success: true, data: { items: [], total: 0, page: 1, page_size: 100 } })
    if (req.url === '/new/api/user/self/groups') return send(200, { success: true, data: {} })
    if (req.url === '/new/api/user/self') {
      lookups++
      assert.equal(req.headers.authorization, 'Bearer new-token-secret')
      if (req.headers['new-api-user'] !== '7') return send(401, { success: false, message: 'Invalid New-Api-User' })
      if (newFailure) return send(newFailure === 'denied' ? 401 : 503, { success: false, message: 'private-upstream-secret' })
      return send(200, { success: true, data: { id: 7, quota, used_quota: 90000000, access_token: 'private-profile-secret' } })
    }
    if (req.url === '/new/api/status') {
      assert.equal(req.headers.authorization, undefined)
      assert.equal(req.headers['new-api-user'], undefined)
      if (statusFailure) return send(503, { success: false })
      return send(200, { success: true, data: { quota_per_unit: 500000, quota_display_type: 'USD' } })
    }
    if (req.url === '/sub/api/v1/auth/refresh') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      assert.deepEqual(JSON.parse(Buffer.concat(chunks)), { refresh_token: 'refresh-secret' })
      refreshes++
      return send(200, { code: 0, data: { access_token: 'rotated-secret', refresh_token: 'next-refresh-secret', expires_in: 3600 } })
    }
    if (req.url === '/sub/api/v1/announcements' || req.url === '/sub/api/v1/subscriptions/progress') return send(200, { code: 0, data: [] })
    if (req.url === '/new/api/notice') return send(200, { success: true, data: '' })
    assert.equal(req.url, '/sub/api/v1/auth/me')
    assert.equal(req.headers.authorization, 'Bearer rotated-secret')
    assert.equal(disk.load().find(c => c.id === 'sub').token, 'rotated-secret')
    if (subFailure === 'denied') return send(401, { code: 'TOKEN_REVOKED' })
    return send(200, { code: 0, data: { id: 8, ...(subFailure === 'missing' ? {} : { balance }), private: 'private-profile-secret' } })
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const endpoint = `http://127.0.0.1:${upstream.address().port}`
  disk.save([
    { id: 'new', name: 'NewAPI', provider: 'newapi', endpoint: endpoint + '/new/v1', token: 'new-token-secret', userId: '7' },
    { id: 'sub', name: 'Sub2API', provider: 'sub2api', endpoint: endpoint + '/sub/api/v1', token: 'expired-secret', refreshToken: 'refresh-secret', expiresAt: now - 1 },
    { id: 'empty', name: 'No credentials', provider: 'newapi', endpoint },
  ])
  let middleware = monitorAPI({ channelStore: store, now: () => now })
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end() }))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { await middleware.auth.stop(); server.close(); upstream.close(); rmSync(directory, { recursive: true, force: true }) })
  const base = `http://127.0.0.1:${server.address().port}`
  const post = async (path, body, origin = base) => {
    const response = await fetch(base + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, ...await response.json() }
  }
  const list = async () => (await (await fetch(base + '/api/upstream-channels')).json()).channels
  const check = async id => (await post(`/api/upstream-channels/${id}/balance/check`, {})).channels.find(c => c.id === id)
  await middleware.auth.runDue()
  let channels = await list()
  assert.equal(channels[0].balance.amount, 3)
  assert.equal(channels[1].balance.amount, 12.3456)
  assert.equal(channels[2].balance.status, 'missing')
  assert.equal(channels[2].balance.amount, null)
  assert.equal(channels[0].balance.nextCheckAt, new Date(now + 300000).toISOString())
  assert.equal(channels[1].balance.nextCheckAt, new Date(now + 300000).toISOString())
  assert.equal(channels[2].balance.nextCheckAt, null)
  assert.equal(refreshes, 1)
  assert.equal((await post('/api/upstream-channels/new/balance/check', {}, 'https://foreign.example')).status, 403)
  assert.equal((await post('/api/upstream-channels/unknown/balance/check', {})).status, 404)
  now += 300000
  quota = 0; balance = 0
  await middleware.auth.runDue()
  channels = await list()
  assert.equal(channels[0].balance.amount, 0)
  assert.equal(channels[1].balance.amount, 0)
  const updatedAt = channels[0].balance.updatedAt
  newFailure = 'temporary'; now += 1000
  let channel = await check('new')
  assert.equal(channel.balance.status, 'error')
  assert.equal(channel.balance.amount, 0)
  assert.equal(channel.balance.updatedAt, updatedAt)
  assert.equal(channel.balance.nextCheckAt, new Date(now + 30000).toISOString())
  const previousLookups = lookups
  now += 29000; await middleware.auth.runDue()
  assert.equal(lookups, previousLookups)
  newFailure = ''; now += 1000; quota = 5
  await middleware.auth.runDue()
  assert.equal((await list())[0].balance.amount, 0.00001)
  statusFailure = true
  channel = await check('new')
  assert.equal(channel.balance.amount, 5)
  assert.equal(channel.balance.currency, 'QUOTA')
  statusFailure = false
  subFailure = 'missing'
  channel = await check('sub')
  assert.equal(channel.auth.status, 'authorized')
  assert.equal(channel.balance.status, 'error')
  assert.equal(channel.balance.amount, 0)
  subFailure = 'denied'
  channel = await check('sub')
  assert.equal(channel.auth.status, 'expired')
  assert.equal(channel.balance.status, 'unauthorized')
  assert.equal(channel.balance.nextCheckAt, null)
  assert.equal(channel.balance.amount, 0)
  newFailure = 'denied'
  channel = await check('new')
  assert.equal(channel.balance.status, 'unauthorized')
  assert.equal(channel.balance.nextCheckAt, null)
  const beforeDenied = lookups
  now += 300000; await middleware.auth.runDue()
  assert.equal(lookups, beforeDenied, 'Terminal NewAPI authorization failures stop automatic queries')
  newFailure = ''
  failSave = true
  channel = await check('new')
  assert.equal(channel.balance.status, 'storage-error')
  assert.equal(channel.balance.nextCheckAt, null)
  const beforeBlocked = lookups
  await check('new')
  assert.equal(lookups, beforeBlocked, 'A failed disk write pauses more network work')
  failSave = false
  channel = await check('new')
  assert.equal(channel.balance.status, 'ok')
  assert.equal(channel.balance.nextCheckAt, new Date(now + 300000).toISOString())
  const input = { id: 'new', name: 'NewAPI', provider: 'newapi', endpoint: endpoint + '/new/v1', token: 'new-token-secret', userId: '7' }
  for (const userId of ['-1', '1\n2', {}, 7]) assert.equal((await post('/api/upstream-channels', { ...input, userId })).status, 400)
  assert.equal((await post('/api/upstream-channels', { ...input, token: '' })).status, 400)
  assert.equal((await post('/api/upstream-channels', input)).status, 200)
  assert.equal((await check('new')).balance.amount, 0.00001)
  const beforeRestart = await list()
  await middleware.auth.stop()
  middleware = monitorAPI({ channelStore: store, now: () => now })
  // The next query comes from the running scheduler; restart queues a fresh
  // check rather than advertising the previous process's schedule.
  assert.deepEqual(await list(), beforeRestart.map(c => ({ ...c, balance: { ...c.balance, nextCheckAt: null } })))
  assert.ok(!JSON.stringify(await list()).includes('secret'))
  assert.ok(!readFileSync(join(directory, 'monitor.sqlite'), 'utf8').includes('secret'))
  assert.equal(disk.load()[0].userId, '7')
})
