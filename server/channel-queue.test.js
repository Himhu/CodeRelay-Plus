import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { monitorAPI } from './monitor-api.js'
import { createChannelAuth } from './sub2api-auth.js'

test('channel operations queue in order, release after failure and do not block other channels', async () => {
  const auth = createChannelAuth({ channels: new Map(), store: { save() {} } })
  const held = Promise.withResolvers(), order = []
  const first = auth.exclusive('a', async () => { order.push('first'); await held.promise; throw Error('expected failure') })
  const rejected = assert.rejects(first, /expected failure/)
  const second = auth.exclusive('a', () => order.push('second'))
  const third = auth.exclusive('a', () => order.push('third'))
  await auth.exclusive('b', () => order.push('other'))
  assert.deepEqual(order, ['first', 'other'])
  assert.equal(auth.busy.has('a'), true)
  held.resolve()
  await Promise.all([rejected, second, third])
  assert.deepEqual(order, ['first', 'other', 'second', 'third'])
  assert.equal(auth.busy.size, 0)
  await auth.stop()
})

test('group synchronization and funding reads wait for an active probe without losing its result', async t => {
  const started = Promise.withResolvers(), release = Promise.withResolvers()
  let probeCalls = 0, groupCalls = 0
  const upstream = createServer(async (req, res) => {
    const send = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)) }
    if (req.url === '/v1/models') return send({ data: [{ id: 'cheap-model' }] })
    if (req.url === '/v1/chat/completions') {
      for await (const chunk of req) { void chunk }
      probeCalls++; started.resolve(); await release.promise
      return send({ choices: [{ message: { content: 'OK' } }] })
    }
    if (req.url === '/api/v1/auth/me') return send({ code: 0, data: { id: 1, balance: 5 } })
    if (req.url === '/api/v1/groups/available') { groupCalls++; return send({ code: 0, data: [{ id: 1, name: 'route', rate_multiplier: 1 }] }) }
    if (req.url === '/api/v1/groups/rates') return send({ code: 0, data: {} })
    if (req.url.startsWith('/api/v1/keys?')) return send({ code: 0, data: { page: 1, page_size: 100, total: 1,
      items: [{ id: 1, name: 'key', group_id: 1, key: 'test-key', status: 'active' }] } })
    if (req.url === '/api/v1/payment/config') return send({ code: 0, data: { enabled: false } })
    if (req.url === '/api/v1/settings/public') return send({ code: 0, data: {} })
    assert.fail(`Unexpected endpoint ${req.url}`)
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const channel = { id: 'channel', name: 'test', provider: 'sub2api', endpoint: `http://127.0.0.1:${upstream.address().port}`,
    token: 'session', authStatus: 'authorized', balance: { status: 'ok', amount: 5 },
    probeTokens: [{ id: '1', name: 'key', key: 'test-key', status: 'active', probeEnabled: true }] }
  const middleware = monitorAPI({ channelStore: { load: () => [channel], save() {} } })
  const api = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end() }))
  api.listen(0, '127.0.0.1'); await once(api, 'listening')
  t.after(async () => { release.resolve(); await middleware.probes.stop(); await middleware.auth.stop(); api.close(); upstream.close() })
  const probing = middleware.probes.runDue()
  await started.promise
  const syncing = middleware.auth.check(channel.id, { groups: true })
  assert.equal(groupCalls, 0)
  const reading = fetch(`http://127.0.0.1:${api.address().port}/api/upstream-channels/channel/funding/options`)
  release.resolve()
  await Promise.all([probing, syncing])
  assert.equal((await reading).status, 200)
  assert.equal(groupCalls, 1)
  assert.equal(channel.probeTokens[0].probeEnabled, true)
  assert.equal(channel.probeTokens[0].probeModels[0].probeHistory.length, 1)
  assert.equal(channel.probeTokens[0].probeModels[0].status, 'ok')
  await middleware.probes.runDue()
  assert.equal(probeCalls, 1, 'Synchronization cannot bypass the existing probe reservation')
})

for (const scenario of ['single', 'batch', 'balance', 'removed', 'stale', 'stop', 'revalidate', 'storage']) test(`queued probe actions recheck live state: ${scenario}`, { timeout: 5000 }, async t => {
  const started = Promise.withResolvers(), release = Promise.withResolvers(), queued = Promise.withResolvers(), otherSaved = Promise.withResolvers()
  let probeCalls = 0, failSave = false
  const upstream = createServer(async (req, res) => {
    for await (const chunk of req) { void chunk }
    probeCalls++; started.resolve(); await release.promise
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }))
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const now = 60000, future = new Date(now + 60000).toISOString()
  const target = { id: 'new', key: 'secret', status: 'active', probeEnabled: scenario === 'revalidate', modelsNextRefreshAt: future,
    probeModels: [{ id: 'target', protocol: 'chat', status: 'error', reason: 'model_unsupported', autoPaused: true, nextProbeAt: future,
      probeHistory: [{ at: new Date(0).toISOString(), status: 'error' }] }] }
  const channel = { id: 'channel', balance: { status: 'ok', amount: 5 }, endpoint: `http://127.0.0.1:${upstream.address().port}`, probeTokens: [
    { id: 'slow', key: 'secret', status: 'active', probeEnabled: true, modelsNextRefreshAt: future, probeModels: [{ id: 'slow', protocol: 'chat' }] }, target] }
  const other = { id: 'other', probeTokens: [{ ...target, probeEnabled: false }] }
  const middleware = monitorAPI({ channelStore: { load: () => [channel, other], save() {
    if (failSave && channel.probeTokens.find(t => t.id === 'new')?.probeEnabled) throw Error('disk')
    if (other.probeTokens[0].probeEnabled) otherSaved.resolve()
  } }, now: () => now })
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end() }))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { release.resolve(); await middleware.probes.stop(); await middleware.auth.stop(); server.close(); upstream.close() })
  const base = `http://127.0.0.1:${server.address().port}`
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const probing = middleware.probes.runDue(); await started.promise
  const exclusive = middleware.auth.exclusive
  middleware.auth.exclusive = (...args) => { const result = exclusive(...args); if (args[0] === 'channel') queued.resolve(); return result }
  const changing = scenario === 'batch'
    ? post('/api/probe-tokens/batch-enable', { tokens: [{ channelId: 'channel', id: 'new' }, { channelId: 'other', id: 'new' }] })
    : scenario === 'revalidate' ? post('/api/probe-tokens/channel/new/models/revalidate', { model: 'target' })
      : post('/api/probe-tokens/channel/new', { enabled: true })
  await queued.promise
  assert.equal(channel.probeTokens[1].probeEnabled, scenario === 'revalidate', 'Queued enable cannot run ahead of a probe')
  if (scenario === 'batch') { await otherSaved.promise; assert.equal(other.probeTokens[0].probeEnabled, true, 'An independent channel proceeds immediately') }
  channel.probeTokens[1] = structuredClone(target) // Group synchronization replaces token objects.
  if (scenario === 'balance') channel.balance.amount = 0
  if (scenario === 'removed') channel.probeTokens.pop()
  if (scenario === 'stale') channel.probeTokens[1].stale = true
  if (scenario === 'storage') failSave = true
  if (scenario === 'stop') {
    const response = await post('/api/probe-tokens/channel/new', { enabled: false })
    assert.equal(response.status, 200, 'A stop need not wait for another token')
  }
  release.resolve(); await probing
  const response = await changing, payload = await response.json()
  assert.equal(response.status, ({ balance: 402, removed: 404, stale: 409, stop: 409, storage: 500 })[scenario] ?? 200)
  if (['single', 'batch'].includes(scenario)) {
    assert.equal(channel.probeTokens[1].probeEnabled, true)
    assert.equal(target.probeEnabled, false, 'The obsolete token object is never modified')
  } else if (scenario === 'revalidate') {
    assert.equal(channel.probeTokens[1].probeModels[0].revalidatePending, true)
    assert.equal(channel.probeTokens[1].probeModels[0].nextProbeAt, future)
  } else if (scenario !== 'removed') assert.equal(channel.probeTokens[1].probeEnabled, false)
  if (scenario === 'batch') assert.equal(payload.batch.enabled, 2)
  assert.equal(channel.probeTokens[0].probeModels[0].status, 'ok')
  assert.equal(channel.probeTokens[0].probeModels[0].probeHistory.length, 1)
  assert.equal(probeCalls, 1, 'Changing eligibility never runs an extra paid request')
})
