import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { probeCostBlocks, pushRoutes } from './route-automation.js'
import { monitorAPI } from './monitor-api.js'
import { normalizeSub2APIGroups } from './user-groups.js'

function fixture() {
  const channel = { id: 'source', name: '上游', provider: 'sub2api', rechargeRate: 2,
    userGroups: { status: 'ok', groups: [{ id: '1', rate: 0.4, source: 'custom' }] },
    probeTokens: [{ id: 'key', key: 'private-test-key', status: 'active', groupId: '1', probeEnabled: true,
      probeModels: [{ id: 'claude-sonnet-4', protocol: 'messages' }, { id: 'gpt-5', protocol: 'responses' }] }] }
  const site = { id: 'site', name: '调度站', groups: [
    { id: 1, name: 'Claude', platform: 'anthropic', status: 'active', rate: 0.1 },
    { id: 2, name: 'Codex', platform: 'openai', status: 'active', rate: 0.3 },
  ], accounts: [], automation: { direction: 'push', enabled: true, routes: {}, accounts: {}, events: [] } }
  const sites = new Map([[site.id, site]]), token = channel.probeTokens[0]
  return { channel, token, site, sites, blocks: () => probeCostBlocks(sites, channel, token) }
}

test('probe costs use exact applicable group, recharge and peak; equality, free and unknown prices are not blocked', () => {
  const f = fixture(), price = f.channel.userGroups.groups[0]
  assert.deepEqual([...f.blocks().keys()], ['claude-sonnet-4'])
  assert.match(f.blocks().get('claude-sonnet-4').reason, /实际成本 0.2× 高于调度分组 0.1×/)
  f.channel.rechargeRate = 4
  assert.equal(f.blocks().size, 0, 'Equal rates still probe')
  price.rate = 0.1 + 0.2; f.channel.rechargeRate = 3
  assert.equal(f.blocks().size, 0, 'Floating-point equality is not a loss')
  price.peak = { factor: 4 }
  assert.equal(f.blocks().size, 2, 'Use conservative peak cost for both families')
  price.peak = null
  f.channel.userGroups.groups = normalizeSub2APIGroups([{ id: 1, name: 'all', rate_multiplier: 10 }], { 1: 0 })
  assert.equal(f.blocks().size, 0, 'Zero user override replaces the default')
  f.channel.userGroups.groups[0].rate = 10
  f.channel.userGroups.groups[0].source = 'automatic'
  assert.equal(f.blocks().size, 0)
  f.channel.userGroups.groups[0].source = 'default'; f.channel.userGroups.status = 'error'
  assert.equal(f.blocks().size, 0, 'Failed pricing is not proof of expensive cost')
  f.channel.userGroups.status = 'ok'; f.token.groupId = 'missing'
  assert.equal(f.blocks().size, 0, 'Never substitute a similarly named group')
})

test('cost gates respect enabled destinations, explicit choices, tiers and alternative affordable targets', () => {
  const f = fixture()
  f.site.automation.enabled = false; assert.equal(f.blocks().size, 0)
  f.site.automation.enabled = true; f.site.error = 'sync failed'; assert.equal(f.blocks().size, 0)
  f.site.error = null
  f.site.groups.push({ ...f.site.groups[0], id: 3, rate: 0.25 })
  assert.equal(f.blocks().size, 0, 'One affordable candidate keeps probes useful')
  const route = pushRoutes(f.site, new Map([[f.channel.id, f.channel]])).find(route => route.family === 'Claude Code')
  assert.ok(route)
  f.site.automation.routes[route.id] = { channelId: f.channel.id, tokenId: f.token.id, platform: route.platform, family: route.family, groupId: 1, enabled: true }
  assert.equal(f.blocks().size, 1, 'Explicit selection takes precedence over alternatives')
  f.site.automation.routes[route.id].enabled = false; assert.equal(f.blocks().size, 1, 'Obsolete route stops cannot bypass the automatic cost gate')
  f.site.automation.routes = {}
  f.site.groups.pop()
  const second = structuredClone(f.site); second.id = 'second'; second.groups[0].rate = 0.25
  f.sites.set(second.id, second); assert.equal(f.blocks().size, 0)
  second.groups[0].rate = null; assert.equal(f.blocks().size, 0, 'Unknown eligible target is not presumed too cheap')
  second.automation.enabled = false; assert.equal(f.blocks().size, 1)
  f.token.groupName = 'Claude Kiro'
  f.site.groups[0].name = 'Claude Max'
  assert.equal(f.blocks().size, 0, 'A different tier is not an eligible price comparator')
})

test('paid runner skips expensive models, guards manual retries and in-flight price edits, resumes after repricing and restart', async t => {
  const f = fixture(), calls = [], entries = []
  let now = 60000, beforeSave = () => {}, saved
  const upstream = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: f.token.probeModels.map(model => ({ id: model.id })) }))
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks)); calls.push(body.model)
    res.end(JSON.stringify(req.url === '/v1/messages' ? { content: [{ type: 'text', text: 'OK' }] }
      : { output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] }))
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening'); t.after(() => upstream.close())
  f.channel.endpoint = `http://127.0.0.1:${upstream.address().port}`
  f.token.modelsNextRefreshAt = new Date(now + 600000).toISOString()
  const store = { load: () => [f.channel], save: records => { beforeSave(); saved = structuredClone(records) }, appendLog: entry => entries.push(entry) }
  const secondaryStore = { load: () => [f.site], save() {} }
  let api = monitorAPI({ channelStore: store, secondaryStore, now: () => now })
  t.after(() => api.probes.stop())
  const server = createServer((req, res) => api(req, res, () => { res.writeHead(404); res.end() }))
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  const read = path => fetch(base + path).then(res => res.json())
  await api.probes.runDue()
  assert.deepEqual(calls, ['gpt-5'])
  assert.equal(f.token.probeModels[0].probeHistory, undefined, 'Do not invent failed samples')
  const first = (await read('/api/probe-tokens')).probeTokens[0]
  assert.equal(first.costBlockedModels, 1); assert.equal(first.probeEnabled, true)
  assert.equal(first.probeModels[0].nextProbeAt, null)
  assert.ok(first.probeModels[1].nextProbeAt)
  assert.ok(!JSON.stringify(first).includes(f.token.key))
  const retry = await fetch(`${base}/api/probe-tokens/source/key/models/revalidate`, { method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'claude-sonnet-4' }) })
  assert.equal(retry.status, 409); assert.match((await retry.json()).error, /实际成本/)
  assert.equal(f.token.probeModels[0].revalidatePending, undefined)
  await api.probes.runDue()
  assert.equal(entries.filter(entry => entry.action === '成本过高，暂停模型探测').length, 1, 'No per-tick log spam')
  // Re-evaluate the group after the asynchronous durable reservation, before I/O.
  now += 60000
  beforeSave = () => { f.site.groups[1].rate = 0.1 }
  await api.probes.runDue(); beforeSave = () => {}
  assert.deepEqual(calls, ['gpt-5'])
  assert.equal((await read('/api/upstream-channels')).channels[0].probeSummary.status, 'paused')
  assert.equal((await read('/api/probe-tokens')).probeTokens[0].nextProbeAt, null)
  await api.probes.stop()
  store.load = () => saved
  api = monitorAPI({ channelStore: store, secondaryStore, now: () => now })
  await api.probes.runDue(); assert.equal(calls.length, 1, 'Restart keeps cost protection and enabled setting')
  now += 60000; f.site.groups.forEach(group => { group.rate = 0.2 })
  await api.probes.runDue()
  assert.deepEqual(calls.slice(1).sort(), ['claude-sonnet-4', 'gpt-5'])
  const recovered = (await read('/api/probe-tokens')).probeTokens[0]
  assert.equal(recovered.costBlockedModels, 0); assert.equal(recovered.probeEnabled, true)
  assert.ok(recovered.probeModels.every(model => model.status === 'ok'))
  assert.equal(recovered.probeModels[1].history.length, 2, 'Old history is preserved')
})
