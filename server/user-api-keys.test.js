import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { normalizeAPIKey, readUserAPIKeys } from './user-api-keys.js'

test('API key metadata uses exact group IDs and omits secret key contents', () => {
  const sub = normalizeAPIKey('sub2api', { id: 1, name: 'Created key', group_id: 7, status: 'inactive',
    key: 'full-secret-key', user: { email: 'private-email' }, group: { name: 'Route', credentials: 'secret' },
    created_at: '2026-01-02T03:04:05Z', last_used_at: null, expires_at: '2027-01-02T03:04:05Z' })
  assert.equal(sub.groupId, '7')
  assert.equal(sub.groupName, 'Route')
  assert.equal(sub.status, 'inactive')
  assert.equal(sub.createdAt, '2026-01-02T03:04:05.000Z')
  assert.ok(!JSON.stringify(sub).includes('secret'))
  assert.ok(!JSON.stringify(sub).includes('private-email'))
  assert.equal(normalizeAPIKey('sub2api', { id: 2, name: 'Unbound', group_id: null, status: 'active' }).groupId, null)
  assert.throws(() => normalizeAPIKey('sub2api', { id: 2, name: 'Missing group', status: 'active' }))
  assert.throws(() => normalizeAPIKey('sub2api', { id: 2, name: 'Bad group', group_id: '7', status: 'active' }))
  const token = normalizeAPIKey('newapi', { id: 3, name: 'Auto', group: 'auto', status: 4, key: 'full-secret', expired_time: -1, created_time: 1 })
  assert.equal(token.groupId, 'auto')
  assert.equal(token.status, 'quota_exhausted')
  assert.equal(token.expiresAt, null)
  assert.equal(token.createdAt, '1970-01-01T00:00:01.000Z')
  assert.equal(normalizeAPIKey('newapi', { id: 4, name: 'Default', group: '', status: 99 }).groupId, null)
})

test('API key lists read every page and reject partial or changing results', async t => {
  let mode = '', requests = 0
  const server = createServer((req, res) => {
    assert.equal(req.method, 'GET')
    assert.equal(req.headers.authorization, 'Bearer user-session-secret')
    const url = new URL(req.url, 'http://localhost')
    const sub = url.pathname === '/api/v1/keys'
    assert.ok(sub || url.pathname === '/api/token/')
    const page = Number(url.searchParams.get(sub ? 'page' : 'p'))
    requests++
    const all = [1, 2, 3].map(id => ({ id, name: `Key ${id}`, key: 'full-api-key-secret',
      ...(sub ? { group_id: id === 3 ? null : 7, status: id === 2 ? 'inactive' : 'active' } : { group: id === 3 ? 'auto' : 'vip', status: 1 }) }))
    let total = mode === 'empty' ? 0 : mode === 'too-many' ? 10001 : 3
    let items = total === 0 ? [] : all.slice((page - 1) * 2, page * 2)
    if (page === 2 && mode === 'duplicate') items = [all[0]]
    if (page === 2 && mode === 'changed') total = 4
    if (page === 2 && mode === 'short') items = []
    res.setHeader('Content-Type', 'application/json')
    const data = { items, total, page_size: 2, [sub || mode === 'new-page' ? 'page' : 'p']: mode === 'wrong-page' ? 10 : page }
    if (!sub && mode === 'conflicting-pages') data.page = page + 1
    res.end(JSON.stringify(sub ? { code: 0, data } : { success: true, data }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => server.close())
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`
  for (const provider of ['sub2api', 'newapi']) {
    const channel = { provider, endpoint, token: 'user-session-secret' }
    mode = ''; requests = 0
    const keys = await readUserAPIKeys(channel)
    assert.equal(keys.length, 3)
    assert.equal(requests, 2)
    assert.equal(keys[0].groupId, provider === 'sub2api' ? '7' : 'vip')
    assert.ok(!JSON.stringify(keys).includes('secret'))
    if (provider === 'newapi') {
      mode = 'new-page'; requests = 0
      assert.deepEqual(await readUserAPIKeys(channel), keys)
      assert.equal(requests, 2)
      mode = 'conflicting-pages'
      await assert.rejects(() => readUserAPIKeys(channel))
    }
    for (mode of ['duplicate', 'changed', 'short', 'wrong-page', 'too-many']) await assert.rejects(() => readUserAPIKeys(channel))
    mode = 'empty'
    assert.deepEqual(await readUserAPIKeys(channel), [])
  }
})
