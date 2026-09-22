import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { monitorAPI } from './monitor-api.js'

test('new-channel automation discovers and probes new tokens while preserving manual stops, restart and reauthorization', async t => {
  let saved = [], now = Date.now(), keyIds = [1, 2], balance = 5, paid = 0, loginWait, loginStarted
  const upstream = createServer(async (req, res) => {
    for await (const chunk of req) { void chunk }
    const send = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)) }
    if (req.url === '/api/v1/auth/login') {
      if (loginWait) { loginStarted.resolve(); await loginWait.promise }
      return send({ code: 0, data: { access_token: 'private-session', refresh_token: 'private-refresh', expires_in: 3600 } })
    }
    if (req.url === '/api/v1/auth/me') return send({ code: 0, data: { id: 1, balance } })
    if (req.url === '/api/v1/groups/available') return send({ code: 0, data: [{ id: 1, name: 'Codex Pro', platform: 'openai', rate_multiplier: 0.1 }] })
    if (req.url === '/api/v1/groups/rates') return send({ code: 0, data: {} })
    if (req.url.startsWith('/api/v1/keys?')) return send({ code: 0, data: { page: 1, page_size: 100, total: keyIds.length,
      items: keyIds.map(id => ({ id, name: `key ${id}`, group_id: 1, key: `private-key-${id}`, status: 'active' })) } })
    if (req.url === '/v1/models') return send({ data: [{ id: 'gpt-test' }] })
    assert.equal(req.url, '/v1/chat/completions')
    paid++
    send({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] })
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const store = { load: () => saved, save: records => { saved = structuredClone(records) } }
  let api = monitorAPI({ channelStore: store, now: () => now })
  const server = createServer((req, res) => api(req, res, () => { res.writeHead(404); res.end() }))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { await api.probes.stop(); await api.auth.stop(); server.close(); upstream.close() })
  const base = `http://127.0.0.1:${server.address().port}`
  const post = async (path, body) => {
    const response = await fetch(base + path, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    assert.equal(response.status, 200)
    return response.json()
  }
  const input = { name: 'auto', provider: 'sub2api', endpoint: `http://127.0.0.1:${upstream.address().port}`, email: 'user@example.test', password: 'private-password' }
  const added = await post('/api/upstream-channels', input), id = added.channels[0].id
  assert.equal(added.channels[0].autoProbeNewTokens, true)
  assert.equal(saved[0].autoProbeNewTokens, true)
  await api.auth.check(id, { groups: true })
  assert.ok(saved[0].probeTokens.every(t => t.probeEnabled))
  await api.probes.runDue()
  assert.equal(paid, 2)
  loginWait = Promise.withResolvers(); loginStarted = Promise.withResolvers()
  const reauthorizing = post('/api/upstream-channels', { ...input, id })
  await loginStarted.promise
  await post(`/api/probe-tokens/${id}/1`, { enabled: false })
  loginWait.resolve(); await reauthorizing; loginWait = null
  assert.deepEqual(saved[0].probeDisabledTokenIds, ['1'], 'A stop during login must survive the later authorization commit')
  keyIds = [2]; await api.auth.check(id, { groups: true })
  keyIds = [1, 2]; await api.auth.check(id, { groups: true })
  assert.equal(saved[0].probeTokens.find(t => t.id === '1').probeEnabled, false, 'A disappeared manual stop must not become a new auto-enabled token')
  const history = structuredClone(saved[0].probeTokens.find(t => t.id === '2').probeModels)
  await post('/api/upstream-channels', { ...input, id })
  assert.deepEqual(saved[0].probeTokens.find(t => t.id === '2').probeModels, history, 'Reauthorization preserves probe history and reservations')
  assert.equal(saved[0].probeTokens.find(t => t.id === '1').probeEnabled, false)
  await api.probes.stop(); await api.auth.stop()
  api = monitorAPI({ channelStore: store, now: () => now })
  balance = 0; keyIds.push(3)
  await api.auth.check(id, { groups: true })
  assert.equal(saved[0].probeTokens.find(t => t.id === '3').probeEnabled, true, 'Automatic intent can wait for a recharge')
  await api.probes.runDue()
  assert.equal(paid, 2, 'A confirmed zero balance blocks all paid probes')
  balance = 5; now += 60000
  await api.auth.check(id, { groups: true }); await api.probes.runDue()
  assert.equal(paid, 4, 'Recharge automatically resumes eligible tokens, excluding the manual stop')
  await post('/api/upstream-channels', { ...input, id, edit: true, password: '', autoProbeNewTokens: false })
  keyIds.push(4); await api.auth.check(id, { groups: true })
  assert.equal(saved[0].probeTokens.find(t => t.id === '4').probeEnabled, false)
  assert.equal(saved[0].probeTokens.find(t => t.id === '3').probeEnabled, true, 'Changing the default does not stop an already-enabled token')
  assert.equal(saved[0].probeTokens.find(t => t.id === '1').probeEnabled, false)
  await api.probes.stop(); await api.auth.stop()
  delete saved[0].autoProbeNewTokens
  api = monitorAPI({ channelStore: store, now: () => now })
  keyIds.push(5); await api.auth.check(id, { groups: true })
  assert.equal(saved[0].probeTokens.find(t => t.id === '5').probeEnabled, false, 'Legacy channels without this policy stay manual')
})
