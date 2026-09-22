import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { normalizeNewAPIUserGroups, normalizeSub2APIGroups, probeTokenPricing } from './user-groups.js'
import { monitorAPI } from './monitor-api.js'
import { createChannelStore } from './site-store.js'

test('new channels automatically discover tokens and models, isolate failures and preserve activation on restart', async t => {
  let now = Date.now(), failing = true, keyReads = 0, modelReads = 0, paidProbes = 0, groupRate = 1
  const upstream = createServer(async (req, res) => {
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
    if (req.url.endsWith('/api/v1/auth/login')) return send(200, { code: 0, data: { access_token: 'private-session-secret', expires_in: 3600 } })
    if (req.url.endsWith('/api/v1/auth/me')) return send(200, { code: 0, data: { id: 1, balance: 10 } })
    if (req.url.endsWith('/api/v1/groups/available')) return send(200, { code: 0, data: [{ id: 1, name: 'Route', rate_multiplier: groupRate }] })
    if (req.url.endsWith('/api/v1/groups/rates')) return send(200, { code: 0, data: {} })
    if (req.url.includes('/api/v1/keys?')) {
      keyReads++
      if (req.url.startsWith('/bad/') && failing) return send(503, { code: 503 })
      return send(200, { code: 0, data: { page: 1, page_size: 100, total: 1,
        items: [{ id: 1, name: 'Automatic key', key: 'private-api-secret', group_id: 1, status: 'active' }] } })
    }
    if (req.url.endsWith('/v1/models')) {
      modelReads++
      return send(200, { data: [{ id: 'cheap-model' }] })
    }
    assert.equal(req.url, '/good/v1/chat/completions')
    for await (const chunk of req) { void chunk }
    paidProbes++
    return send(200, { choices: [{ message: { content: 'OK' } }] })
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening'); t.after(() => upstream.close())
  let saved = ['bad'].map(id => ({ id, name: id, provider: 'sub2api', endpoint: `http://127.0.0.1:${upstream.address().port}/${id}`,
    token: 'private-session-secret', authStatus: 'authorized' }))
  const store = { load: () => structuredClone(saved), save: channels => { saved = structuredClone(channels) } }
  let middleware = monitorAPI({ channelStore: store, now: () => now })
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end() }))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { await middleware.auth.stop(); await middleware.probes.stop(); server.close() })
  const base = `http://127.0.0.1:${server.address().port}`
  const read = () => fetch(`${base}/api/probe-tokens`).then(res => res.json())
  const added = await fetch(`${base}/api/upstream-channels`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'good', provider: 'sub2api', autoProbeNewTokens: false, endpoint: `http://127.0.0.1:${upstream.address().port}/good`, email: 'ordinary@example.test', password: 'private-password' }) })
  assert.equal(added.status, 200)
  const goodId = (await added.json()).channels.find(channel => channel.name === 'good').id
  assert.ok((await read()).channelSetup.every(item => item.status === 'syncing'))
  // A balance lookup can happen immediately after adding a channel. It must not
  // defer first key discovery until the five-minute balance refresh deadline.
  assert.equal((await fetch(`${base}/api/upstream-channels/${goodId}/balance/check`, {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{}',
  })).status, 200)
  // Funding options also verify the account before key discovery is complete.
  await middleware.auth.withAccount(goodId, async () => {})
  assert.equal(keyReads, 0)
  // No drawer, token tab or manual synchronization request is involved.
  await middleware.auth.runDue()
  assert.equal(keyReads, 2)
  const discovered = await read()
  assert.equal(discovered.probeTokens.length, 1)
  assert.equal(discovered.probeTokens[0].channelId, goodId)
  assert.equal(discovered.probeTokens[0].probeEnabled, false)
  assert.equal(discovered.channelSetup.find(item => item.channelId === 'bad').status, 'error')
  assert.equal(discovered.channelSetup.find(item => item.channelId === goodId).status, 'models')
  await middleware.probes.runDue()
  assert.equal(modelReads, 1)
  assert.equal(paidProbes, 0, 'Automatic discovery must not turn on paid model probing')
  assert.equal((await read()).channelSetup.length, 1)
  const enabled = await fetch(`${base}/api/probe-tokens/${goodId}/1`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{"enabled":true}' })
  assert.equal(enabled.status, 200)
  await middleware.probes.runDue()
  assert.equal(paidProbes, 1)
  assert.equal((await read()).probeTokens[0].probeModels[0].status, 'ok')
  await middleware.auth.runDue()
  assert.equal(keyReads, 2, 'Failed key discovery honors its own retry deadline')
  const restarted = monitorAPI({ channelStore: store, now: () => now })
  await restarted.auth.runDue()
  assert.equal(keyReads, 2, 'Restart preserves the key-discovery retry deadline')
  await restarted.auth.stop(); await restarted.probes.stop()
  now += 59999
  await middleware.auth.runDue()
  assert.equal(keyReads, 2)
  now++; failing = false
  await middleware.auth.runDue()
  assert.equal(keyReads, 3, 'Completed key snapshots are not re-fetched on each balance check')
  await middleware.probes.runDue()
  assert.equal((await read()).channelSetup.length, 0)
  await middleware.auth.stop(); await middleware.probes.stop()
  middleware = monitorAPI({ channelStore: store, now: () => now })
  const restored = await read()
  assert.equal(restored.probeTokens.find(token => token.channelId === goodId).probeEnabled, true)
  assert.equal(restored.probeTokens.find(token => token.channelId === 'bad').probeEnabled, false)
  assert.ok(!JSON.stringify(restored).includes('private-'))
  const beforeRestart = paidProbes
  await middleware.auth.runDue(); await middleware.probes.runDue()
  assert.equal(keyReads, 3)
  assert.equal(paidProbes, beforeRestart)
  const beforeRefresh = (await read()).probeTokens.find(token => token.channelId === goodId)
  groupRate = 0.05; now += 240000
  await middleware.auth.runDue()
  assert.equal(keyReads, 4, 'Successful groups and keys refresh automatically after five minutes')
  const updated = (await read()).probeTokens.find(token => token.channelId === goodId)
  assert.equal(updated.groupPricing.rate, 0.05)
  assert.equal(updated.probeEnabled, true)
  assert.deepEqual(updated.probeModels, beforeRefresh.probeModels, 'Pricing refresh keeps probe histories and reservations')
  await middleware.auth.runDue()
  assert.equal(keyReads, 4, 'Successful sync is not repeated every scheduler tick')
})

test('user route rates include zero overrides and automatic groups without inventing prices', () => {
  const group = { id: 1, name: 'Route', platform: 'openai', rate_multiplier: 2, description: 'Description',
    subscription_type: 'subscription', peak_rate_enabled: true, peak_start: '18:00', peak_end: '22:00', peak_rate_multiplier: 1.5,
    credentials: 'private-secret' }
  const result = normalizeSub2APIGroups([group], { 1: 0, 99: 0.1 })[0]
  assert.equal(result.rate, 0)
  assert.equal(result.defaultRate, 2)
  assert.equal(result.userRate, 0)
  assert.equal(result.peak.factor, 1.5)
  assert.equal(result.source, 'custom')
  assert.ok(!JSON.stringify(result).includes('private-secret'))
  assert.equal(normalizeSub2APIGroups([group], null)[0].rate, 2)
  assert.throws(() => normalizeSub2APIGroups([group, group], {}))
  assert.throws(() => normalizeSub2APIGroups([group], { 1: -1 }))
  const groups = normalizeNewAPIUserGroups({ vip: { ratio: 0.5, desc: 'VIP', secret: 'private-secret' }, free: { ratio: 0 }, auto: { ratio: '自动' } })
  assert.deepEqual(groups.map(g => g.rate), [0.5, 0, null])
  assert.equal(groups[2].source, 'automatic')
  assert.ok(!JSON.stringify(groups).includes('private-secret'))
  assert.throws(() => normalizeNewAPIUserGroups({ vip: { ratio: '0.5' } }))
  assert.throws(() => normalizeNewAPIUserGroups({ vip: { ratio: -1 } }))
})

test('probe pricing matches exact token group IDs and exposes only applicable group metadata', () => {
  const channel = { userGroups: { status: 'ok', updatedAt: '2026-09-17T00:00:00Z', groups: [
    ...normalizeSub2APIGroups([{ id: 1, name: 'same', rate_multiplier: 10 }, { id: 2, name: 'same', rate_multiplier: 3.5 }], { 1: 0 }),
    ...normalizeNewAPIUserGroups({ vip: { ratio: 0.3 }, auto: { ratio: '自动' } }),
  ] } }
  channel.userGroups.groups[0].credentials = 'private-secret'
  assert.equal(probeTokenPricing(channel, { groupId: 1 }).rate, 0)
  assert.equal(probeTokenPricing(channel, { groupId: '1' }).source, 'custom')
  assert.equal(probeTokenPricing(channel, { groupId: '2' }).rate, 3.5)
  assert.equal(probeTokenPricing(channel, { groupId: 'vip' }).rate, 0.3)
  assert.equal(probeTokenPricing(channel, { groupId: 'auto' }).source, 'automatic')
  assert.equal(probeTokenPricing(channel, { groupId: 'missing', groupName: 'same' }).rate, null)
  assert.equal(probeTokenPricing(channel, {}).rate, null)
  assert.equal(probeTokenPricing({}, { groupId: '1' }).rate, null)
  assert.equal(probeTokenPricing({}, { groupId: 'auto' }).source, 'automatic')
  assert.ok(!JSON.stringify(probeTokenPricing(channel, { groupId: '1' })).includes('secret'))
  channel.userGroups.status = 'error'
  assert.equal(probeTokenPricing(channel, { groupId: '1' }).status, 'error')
})

test('route synchronization uses user access, keeps complete snapshots and shares account locks', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-user-groups-'))
  const disk = createChannelStore(directory)
  let failSave = false, failure = '', keyFailure = '', override = 0, refreshes = 0, modelReads = 0, holdGroups, started
  const upstream = createServer(async (req, res) => {
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
    if (req.url === '/sub/v1/models') {
      assert.equal(req.method, 'GET')
      assert.equal(req.headers.authorization, 'Bearer private-key-secret')
      modelReads++
      return send(200, { data: [{ id: 'cheap-model' }] })
    }
    if (req.url === '/sub/api/v1/auth/refresh') {
      refreshes++
      return send(200, { code: 0, data: { access_token: 'fresh-secret', refresh_token: 'refresh-secret', expires_in: 3600 } })
    }
    if (req.url.startsWith('/sub/')) {
      assert.equal(req.headers.authorization, 'Bearer fresh-secret')
      assert.equal(disk.load().find(c => c.id === 'sub').token, 'fresh-secret')
      if (req.url.startsWith('/sub/api/v1/keys?')) {
        if (keyFailure) return send(keyFailure === 'denied' ? 403 : 503, { code: keyFailure, message: 'private-key-secret' })
        return send(200, { code: 0, data: { page: 1, page_size: 100, total: 1,
          items: [{ id: 10, name: 'Created token', group_id: 1, status: 'active', key: 'private-key-secret' }] } })
      }
      if (req.url === '/sub/api/v1/auth/me') return send(200, { code: 0, data: { id: 1, balance: 5 } })
      if (req.url === '/sub/api/v1/groups/available') {
        if (holdGroups) { started(); await holdGroups }
        return send(200, { code: 0, data: [{ id: 1, name: 'User route', rate_multiplier: 2, platform: 'openai', secret: 'private-secret' }] })
      }
      assert.equal(req.url, '/sub/api/v1/groups/rates')
      if (failure) return send(failure === 'denied' ? 403 : 503, { code: failure, message: 'private-secret' })
      return send(200, { code: 0, data: { 1: override } })
    }
    if (req.url === '/new/api/status') return send(200, { success: true, data: { quota_display_type: 'USD', quota_per_unit: 500000 } })
    assert.equal(req.headers.authorization, 'Bearer new-secret')
    assert.equal(req.headers['new-api-user'], '9')
    if (req.url.startsWith('/new/api/token/?')) return send(200, { success: true, data: { p: 1, page_size: 100, total: 0, items: [] } })
    if (req.url === '/new/api/user/self') return send(200, { success: true, data: { id: 9, quota: 500000 } })
    // Never query public groups, system settings or administrator channels.
    assert.equal(req.url, '/new/api/user/self/groups')
    return send(200, { success: true, data: { vip: { ratio: 0.3, desc: 'Account price' }, auto: { ratio: '自动' } } })
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const endpoint = `http://127.0.0.1:${upstream.address().port}`
  disk.save([
    { id: 'sub', name: 'Sub', provider: 'sub2api', endpoint: endpoint + '/sub/v1', token: 'expired-secret', refreshToken: 'refresh-secret', expiresAt: Date.now() - 1 },
    { id: 'new', name: 'New', provider: 'newapi', endpoint: endpoint + '/new/api', token: 'new-secret', userId: '9' },
    { id: 'empty', name: 'Empty', provider: 'sub2api', endpoint },
  ])
  const store = { load: () => disk.load(), save: records => { if (failSave) throw new Error('private-disk-secret'); disk.save(records) } }
  let middleware = monitorAPI({ channelStore: store })
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end() }))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { await middleware.probes.stop(); await middleware.auth.stop(); server.close(); upstream.close(); rmSync(directory, { recursive: true, force: true }) })
  const base = `http://127.0.0.1:${server.address().port}`
  const sync = async (id, origin = base) => {
    const response = await fetch(`${base}/api/upstream-channels/${id}/groups/sync`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' })
    return { status: response.status, ...await response.json() }
  }
  const channel = result => result.channels.find(c => c.id === 'sub')
  assert.equal((await sync('sub', 'https://foreign.example')).status, 403)
  assert.equal((await sync('missing')).status, 404)
  const initial = channel(await sync('sub'))
  assert.equal(refreshes, 1)
  assert.equal(initial.userGroups.groups[0].rate, 0)
  assert.equal(initial.auth.status, 'authorized')
  assert.equal(initial.balance.amount, 5)
  assert.equal(initial.apiKeys.items[0].groupId, '1')
  assert.equal(initial.apiKeys.items[0].name, 'Created token')
  assert.ok(!JSON.stringify(initial.apiKeys).includes('private-key-secret'))
  await middleware.probes.runDue()
  assert.equal(modelReads, 1)
  const probeResponse = await fetch(`${base}/api/probe-tokens`)
  assert.equal(probeResponse.status, 200)
  const probeTokens = await probeResponse.json()
  assert.equal(probeTokens.probeTokens[0].name, 'Sub · 0×')
  assert.equal(probeTokens.probeTokens[0].upstreamTokenName, 'Created token')
  assert.equal(probeTokens.probeTokens[0].endpoint, endpoint + '/sub/v1')
  assert.equal(probeTokens.probeTokens[0].probeEnabled, false)
  assert.equal(probeTokens.probeTokens[0].groupPricing.rate, 0)
  assert.equal(probeTokens.probeTokens[0].groupPricing.source, 'custom')
  assert.equal(probeTokens.probeTokens[0].groupPricing.status, 'ok')
  assert.equal(probeTokens.probeTokens[0].probeModels[0].id, 'cheap-model')
  assert.equal(probeTokens.probeTokens[0].probeModels[0].status, 'unknown')
  const nextModelsAt = probeTokens.probeTokens[0].modelsNextRefreshAt
  assert.ok(Date.parse(nextModelsAt) > Date.now())
  assert.ok(!JSON.stringify(probeTokens).includes('private-key-secret'))
  const pricing = initial.userGroups.groups
  override = 0.75
  assert.equal(channel(await sync('sub')).userGroups.groups[0].rate, 0.75)
  const updatedPricing = await fetch(`${base}/api/probe-tokens`).then(r => r.json())
  assert.equal(updatedPricing.probeTokens[0].groupPricing.rate, 0.75)
  assert.equal(disk.load().find(c => c.id === 'sub').probeTokens[0].modelsNextRefreshAt, nextModelsAt)
  await middleware.probes.runDue()
  assert.equal(modelReads, 1, 'Token synchronization preserves the model refresh schedule')
  for (keyFailure of ['temporary', 'denied']) {
    const failed = channel(await sync('sub'))
    assert.equal(failed.userGroups.status, 'ok')
    assert.equal(failed.userGroups.groups[0].rate, 0.75)
    assert.equal(failed.apiKeys.status, 'error')
    assert.deepEqual(failed.apiKeys.items, initial.apiKeys.items)
    assert.equal(failed.auth.status, 'authorized', 'Key permission failure does not revoke a valid login')
    assert.ok(!JSON.stringify(failed).includes('secret'))
  }
  keyFailure = ''
  for (failure of ['temporary', 'denied']) {
    const failed = channel(await sync('sub'))
    assert.equal(failed.userGroups.status, 'error')
    assert.equal(failed.userGroups.groups[0].rate, 0.75)
    assert.equal(failed.apiKeys.status, 'ok', 'Group failures do not discard successful key queries')
    assert.equal(failed.auth.status, 'authorized', 'Group permission failure does not revoke a valid login')
    assert.ok(!JSON.stringify(failed).includes('secret'))
  }
  failure = ''
  let release
  holdGroups = new Promise(resolve => { release = resolve })
  const reading = new Promise(resolve => { started = resolve })
  const pending = sync('sub')
  await reading
  const queued = sync('sub')
  release(); holdGroups = null
  await pending
  assert.equal((await queued).status, 200)
  failSave = true
  const failedSave = channel(await sync('sub'))
  assert.equal(failedSave.userGroups.status, 'error')
  assert.equal(failedSave.userGroups.groups[0].rate, 0.75)
  failSave = false
  assert.equal(channel(await sync('sub')).userGroups.status, 'ok')
  const newChannel = (await sync('new')).channels.find(c => c.id === 'new')
  assert.deepEqual(newChannel.userGroups.groups.map(g => g.rate), [0.3, null])
  const empty = (await sync('empty')).channels.find(c => c.id === 'empty')
  assert.equal(empty.userGroups.status, 'error')
  assert.equal(empty.userGroups.groups, null)
  await middleware.auth.stop()
  middleware = monitorAPI({ channelStore: store })
  const loaded = await fetch(base + '/api/upstream-channels').then(r => r.json())
  assert.equal(channel(loaded).userGroups.groups[0].rate, 0.75)
  assert.equal(channel(loaded).apiKeys.items[0].name, 'Created token')
  assert.equal(pricing[0].rate, 0)
  assert.ok(!JSON.stringify(loaded).includes('secret'))
  assert.ok(!JSON.stringify(disk.load().map(c => c.userGroups)).includes('private-secret'))
  assert.ok(!JSON.stringify(disk.load().map(c => c.apiKeys)).includes('private-key-secret'))
})
