import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createUserGatewayStore } from './site-store.js'
import { createUserGateways, maskKey, validGatewayEndpoint } from './user-gateway.js'
import { SyncError } from './upstream-client.js'

const days = (at = Date.now()) => new Date(at).toISOString()

// A stand-in for the shared site client: records every call so tests can prove
// which credentials were sent and that no write ever reaches the main site.
function recorder(routes) {
  const calls = []
  const request = async (site, path, body, method = body ? 'POST' : 'GET') => {
    calls.push({ path, method, token: site.token, userId: site.userId, body })
    const handler = routes[path.split('?')[0]]
    if (!handler) throw new SyncError(`未预期的请求 ${path}`, 500)
    return handler({ site, path, body, method })
  }
  return { calls, request }
}

const adminRoutes = extra => ({
  '/api/user/self': () => ({ id: 1, username: 'root', role: 100 }),
  '/api/status': () => ({ version: 'v1.2.3' }),
  ...extra,
})

test('gateway connections require an administrator token and never send write requests', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-gateway-'))
  const store = createUserGatewayStore(directory)
  try {
    // A non-admin token must be rejected: attribution needs admin log visibility.
    const member = recorder({ '/api/user/self': () => ({ id: 2, username: 'member', role: 1 }) })
    const memberAPI = createUserGateways({ store, request: member.request })
    await assert.rejects(() => memberAPI.save({ name: '主站', endpoint: 'https://main.example.test', token: 'pat-member' }),
      error => error.status === 403 && /管理员/.test(error.message))
    assert.equal(store.load().length, 0, 'a rejected connection must not be persisted')

    const { calls, request } = recorder(adminRoutes({}))
    const api = createUserGateways({ store, request })
    const saved = await api.save({ name: '主站', endpoint: 'https://main.example.test/', token: 'Bearer pat-root' })
    assert.equal(saved.name, '主站')
    assert.equal(saved.endpoint, 'https://main.example.test', 'trailing slash is normalized away')
    assert.equal(saved.role, 100)
    assert.equal(saved.version, 'v1.2.3')
    assert.equal(saved.status, 'authorized')
    // The Bearer prefix is stripped before storage; only GETs are issued.
    assert.equal(calls.every(call => call.method === 'GET'), true, JSON.stringify(calls.map(c => [c.method, c.path])))
    assert.equal(calls[0].token, 'pat-root')
    assert.equal(store.load()[0].token, 'pat-root')

    // Reload proves the connection survives a restart with its token intact.
    const reloaded = createUserGateways({ store, request }).gateways.get(saved.id)
    assert.equal(reloaded.token, 'pat-root')
    assert.equal(reloaded.keys.length, 0)
  } finally { store.close?.(); rmSync(directory, { recursive: true, force: true }) }
})

test('downstream keys are validated against the real model catalog and stay masked', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-gateway-keys-'))
  const store = createUserGatewayStore(directory)
  const models = ['gpt-5.6-sol', 'gpt-5.6-terra', 'claude-sonnet-5']
  const routes = adminRoutes({
    '/v1/models': ({ site }) => {
      // The probe credential is the downstream key, never the administrator token.
      if (site.token !== 'sk-downstream-secret-value') throw new SyncError('上游站点登录或令牌已失效，请重新授权。', 401)
      return { data: models.map(id => ({ id })) }
    },
  })
  const calls = []
  const request = async (site, path, body, method = 'GET') => {
    calls.push({ site, path })
    return routes[path]({ site, path, body, method })
  }
  try {
    const api = createUserGateways({ store, request })
    const saved = await api.save({ name: '主站', endpoint: 'https://main.example.test', token: 'pat-root' })
    const gateway = await api.addKey(saved.id, { key: 'sk-downstream-secret-value', groupId: 7, name: 'Plus', groupName: 'Plus' })
    const key = gateway.keys[0]
    assert.equal(key.modelsCount, 3)
    assert.equal(key.masked, maskKey('sk-downstream-secret-value'))
    assert.equal(key.masked.includes('secret'), false, 'masked value must not leak the middle of the key')
    assert.deepEqual(key.models.map(m => m.id), models)

    // The raw key is reachable only through the encrypted store, never the public view.
    assert.equal(JSON.stringify(gateway).includes('sk-downstream-secret-value'), false)
    assert.equal(store.load()[0].keys[0].key, 'sk-downstream-secret-value')

    // A duplicate key is refused instead of silently stored twice.
    await assert.rejects(() => api.addKey(saved.id, { key: 'sk-downstream-secret-value' }), error => error.status === 409)

    // A broken key must not be persisted, and a whitespace key is invalid input.
    await assert.rejects(() => api.addKey(saved.id, { key: 'sk-broken-value' }), error => error.status === 401 || error.status === 502)
    await assert.rejects(() => api.addKey(saved.id, { key: 'sk-has space' }), error => /有效的下游 API 密钥/.test(error.message))
    assert.equal(store.load()[0].keys.length, 1)

    // Model refresh preserves prior probe results for models that still exist.
    // Mutate the live gateway, because store.load() decodes a fresh copy.
    api.gateways.get(saved.id).keys[0].models[0].status = 'ok'
    api.gateways.get(saved.id).keys[0].models[0].latencyMs = 123
    const synced = await api.syncModels(saved.id, key.id)
    const sol = synced.keys[0].models.find(m => m.id === 'gpt-5.6-sol')
    assert.equal(sol.status, 'ok', 'a previous probe result survives a catalog refresh')
    assert.equal(sol.latencyMs, 123)
    assert.equal(synced.keys[0].models.length, 3)
  } finally { store.close?.(); rmSync(directory, { recursive: true, force: true }) }
})

test('model read failures keep the previous catalog instead of reporting it empty', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-gateway-stale-'))
  const store = createUserGatewayStore(directory)
  let fail = false
  const request = async (site, path) => {
    if (path.startsWith('/api/user/self')) return { id: 1, username: 'root', role: 100 }
    if (path === '/api/status') return { version: 'v1.2.3' }
    if (path.startsWith('/v1/models')) {
      if (fail) throw new SyncError('上游站点登录或令牌已失效，请重新授权。', 401)
      return { data: [{ id: 'gpt-5.6-sol' }] }
    }
    throw new SyncError('未预期', 500)
  }
  try {
    const api = createUserGateways({ store, request })
    const saved = await api.save({ name: '主站', endpoint: 'https://main.example.test', token: 'pat-root' })
    const gateway = await api.addKey(saved.id, { key: 'sk-value-123456' })
    const keyId = gateway.keys[0].id
    fail = true
    await assert.rejects(() => api.syncModels(saved.id, keyId), error => error.status === 401)
    const after = createUserGateways({ store, request }).gateways.get(saved.id).keys[0]
    assert.equal(after.models.length, 1, 'a failed read must not wipe the known catalog')
    assert.match(after.modelsError, /失效/)
    assert.equal(after.status, 'invalid')
  } finally { store.close?.(); rmSync(directory, { recursive: true, force: true }) }
})

test('attribution merges consume and error logs and surfaces the attempted channel chain', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-gateway-attr-'))
  const store = createUserGatewayStore(directory)
  const at = Math.floor(Date.now() / 1000)
  const seen = []
  const request = async (site, path) => {
    seen.push(path)
    if (path.startsWith('/api/user/self')) return { id: 1, username: 'root', role: 100 }
    if (path === '/api/status') return { version: 'v1.2.3' }
    const type = new URL(`https://x.test${path}`).searchParams.get('type')
    if (type === '2') {
      return { total: 1, items: [{ created_at: at, model_name: 'gpt-5.6-sol', channel: 41, channel_name: '主站-Plus-A',
        use_time: 3, is_stream: true, token_name: 'probe', request_id: 'req-1',
        // Admin visibility keeps admin_info; a user token would have this stripped.
        other: JSON.stringify({ admin_info: { use_channel: [41] }, frt: 900 }) }] }
    }
    return { total: 2, items: [
      { created_at: at - 1, model_name: 'gpt-5.6-sol', channel: 42, channel_name: '主站-Plus-B', use_time: 45,
        other: JSON.stringify({ error_type: 'upstream_error', error_code: 'channel_failed', status_code: 502,
          admin_info: { use_channel: [42, 41] } }) },
      { created_at: at - 2, model_name: 'gpt-5.6-sol', channel: 43, channel_name: '主站-Kiro', use_time: 45,
        other: JSON.stringify({ admin_info: { use_channel: [43] } }) },
    ] }
  }
  try {
    const api = createUserGateways({ store, request })
    const saved = await api.save({ name: '主站', endpoint: 'https://main.example.test', token: 'pat-root' })
    const result = await api.attribute(saved.id, { model: 'gpt-5.6-sol', minutes: 30 })
    assert.equal(result.model, 'gpt-5.6-sol')
    assert.equal(result.consumeTotal, 1)
    assert.equal(result.errorTotal, 2)
    assert.equal(result.errorLogAvailable, true)
    assert.equal(result.sampleSize, 3)
    // Every attempted channel is collected, including the one that failed first.
    // Attempts are ordered chronologically, so the oldest attempt is listed first.
    assert.deepEqual(result.failedChannelIds, [43, 42])
    assert.deepEqual(result.channelIds.sort((a, b) => a - b), [41, 42, 43])
    assert.deepEqual(result.channels.find(c => c.id === 42), { id: 42, name: '主站-Plus-B' })
    const failure = result.attempts.find(a => a.kind === 'error' && a.channelId === 42)
    assert.equal(failure.statusCode, 502)
    assert.equal(failure.errorCode, 'channel_failed')
    assert.deepEqual(failure.usedChannelIds, [42, 41], 'the retry chain is preserved in order')
    // Time window is applied to the log query, and consume/error are read separately.
    assert.equal(seen.filter(p => p.includes('type=2')).length, 1)
    assert.equal(seen.filter(p => p.includes('type=5')).length, 1)
    assert.match(seen.find(p => p.includes('type=2')), /model_name=gpt-5\.6-sol/)
    assert.match(seen.find(p => p.includes('type=5')), /start_timestamp=\d+/)

    // Absent error rows must be reported as "unavailable", not as "nothing failed".
    const noErrors = createUserGateways({ store, request: async (site, path) => {
      if (path.startsWith('/api/user/self')) return { id: 1, username: 'root', role: 100 }
      if (path === '/api/status') return { version: 'v1.2.3' }
      return path.includes('type=5') ? { total: 0, items: [] } : { total: 0, items: [] }
    } })
    const quiet = await noErrors.attribute(saved.id, { model: 'gpt-5.6-sol' })
    assert.equal(quiet.errorLogAvailable, false)
    assert.match(JSON.stringify(quiet), /"errorLogAvailable":false/)

    await assert.rejects(() => api.attribute(saved.id, { model: '' }), error => /模型名称/.test(error.message))
    await assert.rejects(() => api.attribute(saved.id, { model: 'm', minutes: 0 }), error => /1 至 1,440/.test(error.message))
  } finally { store.close?.(); rmSync(directory, { recursive: true, force: true }) }
})

test('gateway endpoints and key masks reject unsafe input', () => {
  assert.equal(validGatewayEndpoint('https://main.example.test'), 'https://main.example.test')
  assert.equal(validGatewayEndpoint('https://main.example.test/'), 'https://main.example.test')
  assert.equal(validGatewayEndpoint('http://127.0.0.1:3000'), 'http://127.0.0.1:3000')
  // Credentials, query strings, fragments and plain HTTP off-loopback are refused.
  assert.equal(validGatewayEndpoint('https://user:pass@main.example.test'), null)
  assert.equal(validGatewayEndpoint('https://main.example.test?a=1'), null)
  assert.equal(validGatewayEndpoint('https://main.example.test#x'), null)
  assert.equal(validGatewayEndpoint('http://main.example.test'), null)
  assert.equal(validGatewayEndpoint('not-a-url'), null)
  assert.equal(maskKey(''), null)
  assert.equal(maskKey('short'), 'sh***')
  assert.equal(maskKey('sk-abcdefghijkl'), 'sk-a******ijkl')
})

test('removing a gateway clears its stored credentials', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-gateway-remove-'))
  const store = createUserGatewayStore(directory)
  const request = async (site, path) => {
    if (path.startsWith('/api/user/self')) return { id: 1, username: 'root', role: 100 }
    if (path === '/api/status') return { version: 'v1.2.3' }
    if (path.startsWith('/v1/models')) return { data: [{ id: 'gpt-5.6-sol' }] }
    throw new SyncError('未预期', 500)
  }
  try {
    const api = createUserGateways({ store, request })
    const saved = await api.save({ name: '主站', endpoint: 'https://main.example.test', token: 'pat-root' })
    await api.addKey(saved.id, { key: 'sk-secret-value-1' })
    assert.equal(store.load()[0].keys.length, 1)
    const afterKey = await api.removeKey(saved.id, store.load()[0].keys[0].id)
    assert.equal(afterKey.keys.length, 0)
    await api.remove(saved.id)
    assert.equal(store.load().length, 0)
    await assert.rejects(() => api.check(saved.id), error => error.status === 404)
  } finally { store.close?.(); rmSync(directory, { recursive: true, force: true }) }
})

export const __testMeta = { days }
