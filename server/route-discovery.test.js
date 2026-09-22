import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { analyzeUpstreamRoutes, isLowerRouteCost, isWithinRouteRate } from './route-discovery.js'
import { monitorAPI } from './monitor-api.js'
import { createChannelStore, createSecondarySiteStore } from './site-store.js'

test('discovery examines unkeyed routes, uses scheduler group pricing, recharge and peak, and separates route tiers and unknown costs', () => {
  const now = Date.now(), at = new Date(now).toISOString()
  const site = { groups: [{ id: 1, name: 'Codex Pro', platform: 'openai', status: 'active', rate: 0.5 }], accounts: [{ id: 1, name: 'api.example.test / Pro', groupIds: [1] }] }
  const group = (id, name, rate, extra = {}) => ({ id: String(id), name, rate, status: 'active', platform: 'openai', subscriptionType: 'standard', source: 'account', ...extra })
  const channel = { id: 'upstream', name: 'Test upstream', endpoint: 'https://api.example.test', provider: 'sub2api', token: 'secret', rechargeRate: 2,
    balance: { status: 'ok', amount: 10 }, apiKeys: { status: 'ok', updatedAt: at, items: [] },
    userGroups: { status: 'ok', updatedAt: at, groups: [group(1, 'GPT Pro', 0.99, { longContextPricing: true }), group(2, 'GPT Pro cost', 1), group(3, 'GPT Plus', 0.01),
      group(4, 'Claude Kiro', 0.01), group(5, 'GPT Pro subscription', 0.01, { subscriptionType: 'subscription' }),
      group(6, 'GPT Pro peak', 0.5, { peak: { factor: 2 } }), group(7, 'GPT Pro image', 0.01),
      group(8, 'GPT Pro free', 0, { source: 'custom' }), group(9, 'GPT Pro unknown', null), group(10, 'GPT Pro 拉闸', 0.01)] } }
  const channels = new Map([['upstream', channel]])
  const analyze = () => analyzeUpstreamRoutes({ site, groupId: 1, channels, now })
  let rows = analyze()
  assert.equal(rows.length, 10)
  assert.equal(rows[0].status, 'eligible', 'Even a cost less than 1% below the group rate qualifies')
  assert.equal(rows[0].targetRate, 0.5); assert.equal(rows[0].costRate, 0.495); assert.equal(rows[0].tokenState, 'missing')
  assert.equal(rows[0].accountSuggestions[0].id, 1)
  assert.match(rows[0].pricingNote, /普通上下文/)
  assert.deepEqual(rows.map(row => row.status), ['eligible', 'eligible', 'unmatched', 'unmatched', 'unknown-price', 'eligible', 'unknown-price', 'eligible', 'unknown-price', 'unavailable'])
  site.groups[0].name = 'Codex'
  const mixed = analyzeUpstreamRoutes({ site, groupId: 1, channels, now })
  assert.equal(mixed[0].status, 'eligible'); assert.equal(mixed[2].status, 'eligible')
  site.groups[0].name = 'Codex Pro'
  site.groups[0].rate = 0
  assert.deepEqual(analyze().filter(row => row.status === 'eligible').map(row => row.groupId), ['8'])
  site.groups[0].rate = 0.5
  channel.userGroups.status = 'error'
  assert.ok(analyze().every(row => row.status === 'unavailable'))
  channel.userGroups.status = 'ok'; site.groups[0].rate = null
  assert.ok(analyze().every(row => row.status !== 'eligible'))
  site.groups[0].rate = 0.5; site.groups[0].name = 'Max'; site.groups[0].platform = 'anthropic'
  channel.userGroups.groups = [group(1, 'Claude Kiro', 0.01, { platform: 'anthropic' }), group(2, 'CCMAX', 0.01, { platform: 'anthropic' })]
  assert.deepEqual(analyze().map(row => row.status), ['unmatched', 'eligible'])
  channel.userGroups.groups[1].rate = Number.MAX_VALUE; channel.rechargeRate = 0.1
  assert.equal(analyze()[1].costRate, null)
  assert.equal(analyze()[1].status, 'unknown-price')
})

test('API discovery scans every upstream route, never creates user tokens and only reads existing model catalogs', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-discovery-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const channelStore = createChannelStore(directory), secondaryStore = createSecondarySiteStore(directory)
  let creates = 0, modelReads = 0, paidRequests = 0, releaseSync, syncStarted
  const syncGate = new Promise(resolve => { releaseSync = resolve })
  const syncWait = new Promise(resolve => { syncStarted = resolve })
  const subKeys = [{ id: 41, name: 'Existing', group_id: 4, status: 'active', key: 'sk-sub-existing-secret' },
    { id: 43, name: 'Unrelated', group_id: 3, status: 'active', key: 'sk-sub-unrelated-secret' }], newKeys = []
  const upstream = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'), path = url.pathname
    const sub = path.startsWith('/sub/'), newapi = path.startsWith('/new/')
    const send = data => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
    const wrap = data => send(sub || path.startsWith('/side/') ? { code: 0, data } : { success: true, data })
    if (path.startsWith('/side/api/v1/admin/')) {
      syncStarted(); await syncGate
      assert.equal(req.headers['x-api-key'], 'admin-side-secret'); assert.equal(req.method, 'GET')
      const items = path.endsWith('/groups') ? [{ id: 1, name: 'Codex', platform: 'openai', status: 'active', rate_multiplier: 0.5 }]
        : [{ id: 1, name: 'Test account', platform: 'openai', type: 'apikey', group_ids: [1], status: 'active', schedulable: true }]
      return wrap({ items, page: 1, page_size: 100, total: items.length })
    }
    if (path.endsWith('/api/v1/auth/me')) return wrap({ id: 1, balance: 10 })
    if (path.endsWith('/api/user/self')) return wrap({ id: 2, quota: 5000000 })
    if (path.endsWith('/api/status')) return wrap({ quota_per_unit: 500000, quota_display_type: 'USD' })
    if (path.endsWith('/api/v1/groups/available')) return wrap([
      { id: 1, name: 'Codex good', platform: 'openai', status: 'active', rate_multiplier: 0.4, subscription_type: 'standard' },
      { id: 2, name: 'Codex costly', platform: 'openai', status: 'active', rate_multiplier: 0.8, subscription_type: 'standard' },
      { id: 3, name: 'Claude Kiro', platform: 'anthropic', status: 'active', rate_multiplier: 0.1, subscription_type: 'standard' },
      { id: 4, name: 'Codex existing', platform: 'openai', status: 'active', rate_multiplier: 0.45, subscription_type: 'standard' },
    ])
    if (path.endsWith('/api/v1/groups/rates')) return wrap({})
    if (path.endsWith('/api/user/self/groups')) return wrap({ 'Codex cheap': { ratio: 0.2 }, 'Codex costly': { ratio: 0.9 } })
    if ((path.endsWith('/api/v1/keys') || path.endsWith('/api/token/')) && req.method === 'GET') {
      const items = sub ? subKeys : newKeys
      return wrap({ items, total: items.length, page_size: 100, ...(sub ? { page: 1 } : { p: 1 }) })
    }
    if ((path.endsWith('/api/v1/keys') || path.endsWith('/api/token/')) && req.method === 'POST') {
      let raw = ''; for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw); creates++
      assert.ok(body.name.startsWith('signal-route-')); assert.equal(req.headers['x-api-key'], undefined)
      assert.ok(req.headers.authorization.startsWith('Bearer '))
      if (sub) {
        assert.equal(body.group_id, 1); assert.equal(body.quota, undefined); assert.equal(body.rate_limit_1d, undefined)
        const key = { id: 42, name: body.name, group_id: body.group_id, status: 'active', key: 'sk-sub-created-secret' }
        subKeys.push(key); return wrap(key)
      }
      assert.equal(newapi, true); assert.equal(body.group, 'Codex cheap'); assert.equal(body.unlimited_quota, true); assert.equal(body.expired_time, -1)
      newKeys.push({ id: 51, name: body.name, group: body.group, status: 1, key: 'sk-new-created-secret', expired_time: -1 })
      return send({ success: true, message: '' })
    }
    if (path.endsWith('/api/token/51/key')) return wrap({ key: 'sk-new-created-secret' })
    if (path.endsWith('/v1/models')) { assert.equal(req.method, 'GET'); modelReads++; return send({ data: [{ id: 'gpt-5', owned_by: 'openai' }] }) }
    paidRequests++; res.writeHead(500); res.end('{}')
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening'); t.after(() => upstream.close())
  const remote = `http://127.0.0.1:${upstream.address().port}`, at = new Date().toISOString()
  secondaryStore.save([{ id: 'side', name: 'Side', provider: 'sub2api', endpoint: remote + '/side', token: 'admin-side-secret', authMode: 'admin-api-key',
    groups: [{ id: 1, name: 'Codex', platform: 'openai', status: 'active' }], accounts: [], syncedAt: at, accountsSyncedAt: at }])
  channelStore.save(['sub', 'new'].map(id => ({ id, name: id, provider: id === 'sub' ? 'sub2api' : 'newapi', endpoint: remote + '/' + id, token: id + '-session-secret',
    probeTokens: id === 'sub' ? [{ id: '43', groupId: '3', status: 'active', key: 'sk-sub-unrelated-secret', modelsError: 'Old unrelated model error' }] : [] })))
  let api = monitorAPI({ channelStore, secondaryStore })
  const server = createServer((req, res) => api(req, res, () => { res.writeHead(404); res.end() }))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { await api.discovery.stop(); await api.probes.stop(); await api.auth.stop(); server.close() })
  const base = `http://127.0.0.1:${server.address().port}`, path = '/api/secondary-sites/side/discovery'
  const post = async (input, origin = base) => {
    const response = await fetch(base + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
    return { status: response.status, ...await response.json() }
  }
  const read = async () => (await fetch(base + path)).json()
  const waitJob = async () => {
    for (let attempt = 0; attempt < 300; attempt++) { const result = await read(); if (result.job.status !== 'running') return result.job; await new Promise(resolve => setTimeout(resolve, 10)) }
    assert.fail('Discovery did not finish')
  }
  const config = { groupId: 1, createMissing: false, saleRate: 1000, minMargin: 99 } // Old clients cannot override the scheduler's multiplier.
  assert.equal((await post(config, 'https://foreign.test')).status, 403)
  assert.equal((await post({ ...config, groupId: 999 })).status, 400)
  assert.equal((await post({ ...config, createMissing: 'true' })).status, 400)
  assert.equal((await post({ ...config, createMissing: true })).status, 400)
  assert.equal(creates, 0, 'Legacy clients cannot create upstream keys')
  assert.equal((await post(config)).status, 202)
  await syncWait
  assert.equal((await post(config)).status, 409)
  releaseSync()
  let job = await waitJob()
  assert.equal(job.status, 'complete', JSON.stringify(job))
  assert.equal(job.config.targetRate, 0.5)
  assert.equal(job.config.minMargin, undefined); assert.equal(job.config.saleRate, undefined)
  assert.equal(job.rows.length, 6); assert.equal(job.created, undefined); assert.equal(creates, 0); assert.equal(paidRequests, 0)
  assert.equal(job.rows.filter(row => row.status === 'eligible').length, 3)
  assert.equal(job.rows.filter(row => row.tokenState === 'created').length, 0)
  assert.equal(job.rows.filter(row => row.status === 'eligible' && row.tokenState === 'missing').length, 2)
  assert.ok(job.rows.filter(row => row.status === 'eligible' && row.tokenId).every(row => row.models.length === 1))
  assert.ok(modelReads >= 1)
  assert.ok(!JSON.stringify(job).includes('secret'))
  assert.ok(channelStore.load().flatMap(channel => channel.probeTokens).every(token => !token.probeEnabled))
  await api.discovery.stop(); await api.auth.stop(); await api.probes.stop()
  api = monitorAPI({ channelStore, secondaryStore })
  assert.equal((await post(config)).status, 202)
  job = await waitJob()
  assert.equal(job.status, 'complete'); assert.equal(job.created, undefined); assert.equal(creates, 0)
  assert.equal(paidRequests, 0)
})

test('multiplier comparison accepts any real discount and excludes equal, higher and unknown costs', () => {
  assert.equal(isLowerRouteCost(0.49999999, 0.5), true)
  assert.equal(isLowerRouteCost(0, 0.5), true)
  for (const [cost, target] of [[0.5, 0.5], [0.51, 0.5], [null, 0.5], [0.1, null], [Infinity, 1], [0.1, 0], [-1, 1]]) assert.equal(isLowerRouteCost(cost, target), false)
  assert.equal(isLowerRouteCost(0.3 / 3, 0.1), false, 'Floating point division cannot make equal multipliers qualify')
  for (const [cost, target] of [[0, 0], [0.5, 0.5], [0.1, 0.5], [0.1, 0.3 / 3]]) assert.equal(isWithinRouteRate(cost, target), true)
  for (const [cost, target] of [[0.51, 0.5], [null, 0.5], [0.1, null], [Infinity, 1], [0.1, 0], [-1, 1]]) assert.equal(isWithinRouteRate(cost, target), false)
})
