import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { monitorAPI } from './monitor-api.js'
import { createUserAPIKey, deleteUserAPIKey } from './user-api-keys.js'

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

test('creating and deleting API keys uses the user token routes', async t => {
  const seen = []
  const upstream = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const body = req.method === 'GET' || req.method === 'DELETE' ? '' : await readBody(req)
    seen.push({ method: req.method, path: url.pathname, body, authorization: req.headers.authorization })
    const sub = url.pathname.startsWith('/api/v1/keys')
    res.setHeader('Content-Type', 'application/json')
    if (req.method === 'DELETE' && url.pathname === '/api/token/9') {
      res.end(JSON.stringify({ success: true, message: '' }))
      return
    }
    if (req.method === 'DELETE') {
      res.end(JSON.stringify({ code: 0, data: { message: 'API key deleted successfully' } }))
      return
    }
    res.end(JSON.stringify(sub ? { code: 0, data: { id: 2, key: 'must-not-leak', name: 'New' } } : { success: true, message: '' }))
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening'); t.after(() => upstream.close())
  const endpoint = `http://127.0.0.1:${upstream.address().port}/v1`
  await createUserAPIKey({ provider: 'sub2api', endpoint, token: 'session' }, { name: 'New', groupId: '7' })
  await createUserAPIKey({ provider: 'newapi', endpoint, token: 'session' }, { name: 'Plain', groupId: '' })
  await deleteUserAPIKey({ provider: 'sub2api', endpoint, token: 'session' }, '4')
  await deleteUserAPIKey({ provider: 'newapi', endpoint, token: 'session' }, '9')
  assert.deepEqual(seen.map(item => [item.method, item.path, item.body]), [
    ['POST', '/api/v1/keys', '{"name":"New","group_id":7}'],
    ['POST', '/api/token/', '{"name":"Plain","expired_time":-1,"remain_quota":0,"unlimited_quota":true,"group":""}'],
    ['DELETE', '/api/v1/keys/4', ''],
    ['DELETE', '/api/token/9', ''],
  ])
  assert.ok(seen.every(item => item.authorization === 'Bearer session'))
})

test('probe token management creates and deletes upstream tokens without exposing secrets', async t => {
  const keys = new Map([['1', { id: 1, name: 'Old', key: 'secret-old', group_id: 1, status: 'active' }]])
  const upstream = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
    if (url.pathname.endsWith('/api/v1/auth/me')) return send(200, { code: 0, data: { id: 1, balance: 10 } })
    if (url.pathname.endsWith('/api/v1/groups/available')) return send(200, { code: 0, data: [{ id: 1, name: 'Route', rate_multiplier: 1 }] })
    if (url.pathname.endsWith('/api/v1/groups/rates')) return send(200, { code: 0, data: {} })
    if (url.pathname.endsWith('/api/v1/keys') && req.method === 'POST') {
      const body = JSON.parse(await readBody(req))
      keys.set('2', { id: 2, name: body.name, key: 'secret-new', group_id: body.group_id, status: 'active' })
      return send(200, { code: 0, data: { id: 2, name: body.name, key: 'secret-new', group_id: body.group_id, status: 'active' } })
    }
    const deleted = url.pathname.match(/\/api\/v1\/keys\/(\d+)$/)
    if (deleted && req.method === 'DELETE') {
      keys.delete(deleted[1])
      return send(200, { code: 0, data: { message: 'deleted' } })
    }
    if (url.pathname.endsWith('/api/v1/keys')) {
      return send(200, { code: 0, data: { page: 1, page_size: 100, total: keys.size, items: [...keys.values()] } })
    }
    return send(404, { code: 404, message: 'missing' })
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening'); t.after(() => upstream.close())
  const sites = [{ id: 'site', name: '调度A', accountBindings: [{ upstreamId: 'ch', tokenId: '1' }] }]
  let saved = [{ id: 'ch', name: '上游', provider: 'sub2api', endpoint: `http://127.0.0.1:${upstream.address().port}/v1`,
    token: 'session', authStatus: 'authorized', balance: { status: 'ok', amount: 10 },
    userGroups: { status: 'ok', groups: [{ id: '1', name: 'Route', rate: 1 }] },
    probeTokens: [{ id: '1', name: 'Old', key: 'secret-old', groupId: '1', status: 'active', probeEnabled: false }] }]
  const middleware = monitorAPI({
    channelStore: { load: () => structuredClone(saved), save: channels => { saved = structuredClone(channels) } },
    secondaryStore: { load: () => sites },
  })
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end() }))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { await middleware.auth.stop(); await middleware.probes.stop(); server.close() })
  const base = `http://127.0.0.1:${server.address().port}`
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const blocked = await post('/api/probe-tokens/ch/1/delete', {})
  assert.equal(blocked.status, 409)
  assert.match((await blocked.json()).error, /调度A/)
  assert.equal(keys.has('1'), true)
  sites[0].accountBindings = []
  const removed = await post('/api/probe-tokens/ch/1/delete', {})
  const removedBody = await removed.json()
  assert.equal(removed.status, 200)
  assert.equal(removedBody.probeTokens.length, 0)
  assert.equal(JSON.stringify(removedBody).includes('secret'), false)
  const created = await post('/api/probe-tokens/create', { channelId: 'ch', name: '新建令牌', groupId: '1' })
  const createdBody = await created.json()
  assert.equal(created.status, 200, createdBody.error)
  assert.equal(createdBody.probeTokens.length, 1)
  assert.equal(createdBody.probeTokens[0].id, '2')
  assert.equal(createdBody.probeTokens[0].upstreamTokenName, '新建令牌')
  assert.equal(createdBody.probeTokens[0].groupId, '1')
  assert.equal(JSON.stringify(createdBody).includes('secret'), false)
})
