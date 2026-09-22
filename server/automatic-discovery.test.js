import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { createChannelAuth } from './sub2api-auth.js'
import { createRouteDiscovery } from './route-discovery.js'

async function setup(t) {
  let now = Date.now(), created = 0, keys = [], balance = 5, reject = false
  const groups = [
    { id: 1, name: 'Codex Pro', rate_multiplier: 0.1 },
    { id: 2, name: 'Codex Pro expensive', rate_multiplier: 2 },
    { id: 3, name: 'Claude Kiro', rate_multiplier: 0.1 },
  ].map(group => ({ ...group, platform: 'openai', status: 'active', subscription_type: 'standard' }))
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    const send = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ code: 0, data })) }
    if (req.url === '/api/v1/auth/me') return send({ id: 1, balance })
    if (req.url === '/api/v1/groups/available') return send(groups)
    if (req.url === '/api/v1/groups/rates') return send({})
    if (req.url.startsWith('/api/v1/keys?')) return send({ page: 1, page_size: 100, total: keys.length, items: keys })
    if (req.url === '/api/v1/keys' && req.method === 'POST') {
      created++
      if (reject) { res.statusCode = 502; res.end('lost response'); return }
      const input = JSON.parse(body)
      const key = { id: created, name: input.name, group_id: input.group_id, key: `private-${created}`, status: 'active' }
      keys.push(key); return send(key)
    }
    res.statusCode = 404; res.end('{}')
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const channel = { id: 'source', name: 'test', provider: 'sub2api', endpoint: `http://127.0.0.1:${server.address().port}`, token: 'session', autoProbeNewTokens: true }
  const channels = new Map([[channel.id, channel]])
  const store = { save: () => {} }, auth = createChannelAuth({ channels, store, now: () => now })
  const discovery = createRouteDiscovery({ channels, auth, channelStore: store, now: () => now })
  const site = { id: 'scheduler', name: 'test', automation: { enabled: true }, syncedAt: new Date(now).toISOString(), groups: [{ id: 9, name: 'Codex Pro', platform: 'openai', rate: 0.1, status: 'active' }] }
  const sites = new Map([[site.id, site]])
  t.after(async () => { await discovery.stop(); await auth.stop(); server.close() })
  const sync = () => auth.check(channel.id, { groups: true })
  await sync()
  return { channel, auth, discovery, sites, site, sync, get created() { return created },
    keys: value => { keys = value }, balance: value => { balance = value }, reject: () => { reject = true },
    advance: () => { now += 300001; site.syncedAt = new Date(now).toISOString() } }
}

test('onboarding only reads existing keys, including legacy pending creation records', async t => {
  const f = await setup(t)
  f.channel.tokenProvisioning = [{ identity: 'legacy', groupId: '1', name: 'legacy-key', state: 'unknown' }]
  await f.auth.runDue(); f.advance(); await f.sync()
  assert.equal(f.created, 0)
  assert.equal(f.channel.probeTokens.length, 0)
  f.keys([{ id: 42, name: 'created on upstream', group_id: 1, status: 'active', key: 'existing-private-key' }])
  f.advance(); await f.sync()
  assert.equal(f.created, 0)
  assert.equal(f.channel.probeTokens.length, 1)
  assert.equal(f.channel.probeTokens[0].probeEnabled, true)
  f.channel.probeTokens[0].probeEnabled = false
  f.advance(); await f.sync()
  assert.equal(f.channel.probeTokens[0].probeEnabled, false)
})

test('100 independent channels continue syncing while one upstream hangs, including the next tick', async t => {
  const held = Promise.withResolvers(), fast = Promise.withResolvers(); let checked = 0
  const server = createServer(async (req, res) => {
    if (req.headers.authorization === 'Bearer slow' && req.url === '/api/v1/auth/me') await held.promise
    res.setHeader('Content-Type', 'application/json')
    const data = req.url === '/api/v1/auth/me' ? { id: 1, balance: 5 } : req.url.includes('/keys?') ? { page: 1, page_size: 100, total: 0, items: [] } : req.url.endsWith('/rates') ? {} : []
    res.end(JSON.stringify({ code: 0, data }))
    if (req.url.includes('/keys?') && req.headers.authorization !== 'Bearer slow' && ++checked === 100) fast.resolve()
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const make = id => ({ id, provider: 'sub2api', endpoint: `http://127.0.0.1:${server.address().port}`, token: id })
  const channels = new Map([['slow', make('slow')], ...Array.from({ length: 99 }, (_, i) => [`fast-${i}`, make(`fast-${i}`)])])
  const auth = createChannelAuth({ channels, store: { save: () => {} } })
  t.after(async () => { held.resolve(); await auth.stop(); server.close() })
  const first = auth.runDue()
  channels.set('new', make('new')); const second = auth.runDue()
  let timeout
  try { await Promise.race([fast.promise, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Fast channels waited for the slow channel')), 5000) })]) }
  finally { clearTimeout(timeout); held.resolve() }
  await Promise.all([first, second])
  assert.equal(checked, 100)
  assert.ok([...channels.values()].every(channel => channel.apiKeys.status === 'ok'))
})
