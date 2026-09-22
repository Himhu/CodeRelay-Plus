import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, request } from 'node:http'
import { once } from 'node:events'
import { createChannelStore, createConsoleSettingsStore } from './site-store.js'
import { createOperationLogs } from './operation-logs.js'
import { monitorAPI } from './monitor-api.js'

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'signal-logs-'))
  const store = createChannelStore(directory)
  const clock = Date.parse('2026-09-20T00:00:00Z')
  const channel = { id: 'channel', name: '测试上游', provider: 'newapi', endpoint: 'https://example.test', token: 'private-access-secret', probeTokens: [
    { id: '7', status: 'active', key: 'private-model-secret', probeModels: [{ id: 'gpt-5', probeHistory: [{ at: new Date(clock - 60000).toISOString(), status: 'ok', latencyMs: 432 },
      { at: new Date(clock).toISOString(), status: 'error', reason: 'timeout', error: 'safe timeout' }] }] }] }
  store.save([channel])
  const channels = new Map([[channel.id, channel]])
  const logger = createOperationLogs({ store, channels, now: () => clock })
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  return { directory, store, channel, logger, channels, clock }
}

test('operation history survives restart, paginates beyond 100 and imports old events once without exposing credentials', t => {
  const { directory, store, logger, channels, clock } = fixture(t)
  const site = { id: 's', name: '调度站', token: 'private-admin-secret', automation: { accounts: { 1: { channelId: 'channel', tokenId: '7' } },
    events: [{ at: new Date(clock - 60000).toISOString(), accountId: 1, action: '暂停调度', reason: '余额不足' }] } }
  logger.setSites(new Map([[site.id, site]]))
  logger.importEvents(site); logger.importEvents(site)
  for (let i = 0; i < 125; i++) logger.record({ category: 'routing', level: i % 2 ? 'success' : 'error', siteId: 's', channelId: 'channel', action: `更新模型 ${i}`,
    message: 'private-access-secret private-model-secret private-admin-secret password=hidden-password sk-123secret',
    details: { modelsBefore: ['gpt-5'], modelsAfter: ['gpt-5.2'], password: 'never-log', credentials: { api_key: 'never-log' }, before: 'Bearer private-test' } })
  const first = logger.query(new URLSearchParams('hours=0'))
  assert.equal(first.total, 126); assert.equal(first.items.length, 5)
  const second = logger.query(new URLSearchParams('hours=0&page=2'))
  assert.equal(second.items.length, 5)
  assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 10)
  assert.equal(logger.query(new URLSearchParams('page=26')).items.length, 1)
  const filtered = logger.query(new URLSearchParams('category=routing&level=success&channel=channel&q=gpt-5.2'))
  assert.equal(filtered.total, 62)
  assert.deepEqual(logger.query(new URLSearchParams('page=100001')).items, [], 'A small page size must not reduce the accessible history range')
  assert.equal(logger.query(new URLSearchParams("site=s%27%20OR%201%3D1")).total, 0)
  assert.ok(!JSON.stringify(first).includes('private-')); assert.ok(!JSON.stringify(first).includes('hidden-password'))
  assert.ok(!JSON.stringify(first).includes('never-log'))
  store.close()
  const reloaded = createOperationLogs({ store, channels, now: () => clock })
  reloaded.importEvents(site)
  assert.equal(reloaded.query(new URLSearchParams()).total, 126)
  for (const file of readdirSync(directory).filter(name => name.startsWith('monitor.sqlite'))) {
    const bytes = readFileSync(join(directory, file))
    for (const secret of ['private-access-secret', 'private-model-secret', 'private-admin-secret', 'hidden-password', 'never-log']) assert.ok(!bytes.includes(Buffer.from(secret)))
  }
})

test('probe log view uses durable history, filters without running probes and preserves business records', t => {
  const { store, logger } = fixture(t)
  const before = store.load()
  logger.setSites(new Map([['s', { id: 's', name: '调度', automation: { routes: { r: { channelId: 'channel' } } } }]]))
  const result = logger.query(new URLSearchParams('kind=probes&site=s&channel=channel&q=gpt-5&level=error'))
  assert.equal(result.total, 1)
  assert.equal(result.items[0].tokenId, '7'); assert.equal(result.items[0].details.reason, 'timeout')
  assert.equal(logger.query(new URLSearchParams('kind=probes&level=success')).items[0].details.latencyMs, 432)
  assert.equal(logger.query(new URLSearchParams('kind=probes&site=missing')).total, 0)
  assert.deepEqual(store.load(), before)
  for (const query of ['page=-1', 'page=1.5', 'page=9007199254740991', 'hours=9999', 'kind=raw', 'level=invalid', 'until=invalid', 'category=sql', 'kind=probes&level=info']) {
    assert.throws(() => logger.query(new URLSearchParams(query)), /筛选参数无效/)
  }
})

test('log storage failures do not turn upstream writes into failures and queued records are retried visibly', () => {
  let failed = true
  const saved = []
  const logger = createOperationLogs({ store: {
    appendLog(entry) { if (failed) throw new Error('disk full'); saved.push(entry) },
    queryLogs() { return { items: saved, total: saved.length } },
  } })
  assert.doesNotThrow(() => logger.record({ action: '已确认的上游修改', level: 'success' }))
  assert.match(logger.query(new URLSearchParams()).warning, /日志写入失败/)
  failed = false
  assert.equal(logger.query(new URLSearchParams()).total, 1)
  assert.equal(logger.query(new URLSearchParams()).warning, null)
})

test('logs API shares access guards and records actual manual operations with safe request fields', async t => {
  const { directory, store } = fixture(t)
  const settings = createConsoleSettingsStore(directory)
  const api = monitorAPI({ channelStore: store, settingsStore: settings })
  const server = createServer((req, res) => api(req, res, () => { res.writeHead(404); res.end() }))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { await new Promise(resolve => server.close(resolve)); api.closeStores() })
  const base = `http://127.0.0.1:${server.address().port}`
  const write = (path, body) => fetch(base + path, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  assert.equal((await write('/api/settings', { lowBalanceThreshold: 8.5 })).status, 200)
  assert.equal((await write('/api/probe-tokens/channel/7', { enabled: true })).status, 200)
  assert.equal((await write('/api/probe-tokens/channel/7', { enabled: 'invalid', password: 'not-logged-password' })).status, 400)
  const response = await fetch(base + '/api/logs?hours=0')
  const payload = await response.json()
  assert.equal(response.status, 200); assert.equal(payload.total, 3)
  assert.equal(payload.items.filter(item => item.level === 'error').length, 1)
  assert.ok(payload.items.some(item => item.action === '启用令牌探测' && item.tokenId === '7' && item.actor === 'user'))
  assert.ok(!JSON.stringify(payload).includes('not-logged-password'))
  assert.equal((await fetch(base + '/api/logs?page=0')).status, 400)
  assert.equal((await write('/api/logs', {})).status, 405)
  const denied = await new Promise((resolve, reject) => {
    const req = request(base + '/api/logs', { headers: { Host: 'foreign.test' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
    req.on('error', reject); req.end()
  })
  assert.equal(denied, 403)
  assert.equal((await fetch(base + '/api/logs?kind=probes')).status, 200)
})
