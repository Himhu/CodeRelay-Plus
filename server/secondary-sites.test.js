import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { monitorAPI } from './monitor-api.js'
import { createChannelStore, createSecondarySiteStore } from './site-store.js'

test('secondary sites use admin APIs, paginate, isolate encrypted data and retain complete snapshots', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-secondary-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const channelStore = createChannelStore(directory), disk = createSecondarySiteStore(directory)
  channelStore.save([{ id: 'existing-upstream', name: 'Existing', endpoint: 'https://example.test', provider: 'sub2api' }])
  const channelBefore = JSON.stringify(channelStore.load())
  let failSave = false, failGroups = '', failAccounts = false, requiredKey = 'admin-test-secret', reads = 0
  let holdGroups, started
  const groups = Array.from({ length: 101 }, (_, i) => ({ id: i + 1, name: `Group ${i + 1}`, platform: 'openai',
    rate_multiplier: i === 0 ? 0 : 0.2, status: i === 100 ? 'inactive' : 'active', subscription_type: 'standard',
    peak_rate_enabled: i === 1, peak_start: '12:00', peak_end: '18:00', peak_rate_multiplier: 1.5,
    secret: 'group-internal-secret' }))
  const accounts = [{ id: 12, name: 'Shared account', platform: 'openai', type: 'apikey', status: 'active', schedulable: false,
    group_ids: [1, 101], credentials: { key: 'upstream-account-secret' }, extra: { private: 'extra-secret' }, error_message: 'raw-error-secret' }]
  const remote = createServer(async (req, res) => {
    reads++
    assert.equal(req.method, 'GET', 'Connection sync never writes to the Sub2API server or runs model probes')
    assert.equal(req.headers.authorization, undefined)
    assert.equal(req.headers['user-agent'], 'Signal-Monitor/0.1')
    const url = new URL(req.url, 'http://localhost')
    const send = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)) }
    if (req.headers['x-api-key'] !== requiredKey) return send(401, { code: 'INVALID_ADMIN_KEY', message: 'credential-error-secret' })
    assert.ok(['/api/v1/admin/groups', '/api/v1/admin/accounts'].includes(url.pathname))
    const isGroups = url.pathname.endsWith('/groups')
    if (isGroups && holdGroups) { started(); await holdGroups }
    if (isGroups && failGroups === 'permission') return send(403, { code: 'FORBIDDEN', message: 'credential-error-secret' })
    if (!isGroups && failAccounts) return send(503, { code: 503 })
    if (!isGroups) assert.equal(url.searchParams.get('lite'), 'true')
    const page = Number(url.searchParams.get('page')), pageSize = Number(url.searchParams.get('page_size'))
    const all = isGroups ? groups : accounts
    let items = all.slice((page - 1) * pageSize, page * pageSize)
    if (isGroups && page === 2 && failGroups === 'partial') items = []
    if (isGroups && page === 2 && failGroups === 'duplicate') items = [groups[0]]
    send(200, { code: 0, data: { items, page, page_size: pageSize, total: all.length } })
  })
  remote.listen(0, '127.0.0.1'); await once(remote, 'listening')
  t.after(() => remote.close())
  const store = { load: disk.load, save: values => { if (failSave) throw new Error('storage-secret'); disk.save(values) } }
  let api = monitorAPI({ channelStore, secondaryStore: store })
  const server = createServer((req, res) => api(req, res, () => { res.writeHead(404); res.end() }))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  const post = async (body, path = '/api/secondary-sites', origin = base) => {
    const res = await fetch(base + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return { status: res.status, ...await res.json() }
  }
  const list = async () => (await (await fetch(base + '/api/secondary-sites')).json()).sites
  const input = { name: 'Secondary Sub2API', provider: 'sub2api', endpoint: `http://127.0.0.1:${remote.address().port}/api/v1`, token: requiredKey }
  assert.deepEqual(await list(), [])
  assert.equal((await post(input, '/api/secondary-sites', 'https://foreign.test')).status, 403)
  for (const invalid of [{ ...input, token: '' }, { ...input, provider: 'newapi' }, { ...input, endpoint: 'http://external.test' },
    { ...input, endpoint: 'https://user:pass@example.test' }, { ...input, endpoint: 'https://example.test/?key=secret' }]) {
    assert.equal((await post(invalid)).status, 400)
  }
  assert.equal(reads, 0)
  const denied = await post({ ...input, token: 'sk-user-key' })
  assert.equal(denied.status, 401)
  assert.match(denied.error, /Admin API Key/)
  assert.deepEqual(await list(), [])
  failSave = true
  assert.equal((await post(input)).status, 500)
  assert.deepEqual(await list(), [])
  failSave = false
  const added = await post(input)
  assert.equal(added.status, 200)
  assert.equal(added.site.groups.length, 101)
  assert.equal(added.site.groups[0].rate, 0)
  assert.equal(added.site.groups[100].status, 'inactive')
  assert.deepEqual(added.site.groups[1].peak, { start: '12:00', end: '18:00', factor: 1.5 })
  assert.deepEqual(added.site.accounts[0].groupIds, [1, 101])
  assert.equal(added.site.accounts[0].schedulable, false)
  const id = added.site.id, syncPath = `/api/secondary-sites/${id}/sync`
  const snapshot = disk.load()[0]
  assert.equal(snapshot.token, requiredKey)
  assert.equal(snapshot.authMode, 'admin-api-key')
  for (const secret of ['upstream-account-secret', 'extra-secret', 'raw-error-secret', 'group-internal-secret']) assert.ok(!JSON.stringify(snapshot).includes(secret))
  assert.ok(!JSON.stringify(added).includes(requiredKey))
  assert.ok(!readFileSync(join(directory, 'monitor.sqlite'), 'utf8').includes(requiredKey))

  for (failGroups of ['partial', 'duplicate', 'permission']) {
    const failed = await post({}, syncPath)
    assert.ok(failed.site.error)
    assert.deepEqual(failed.site.groups, added.site.groups)
    assert.equal(failed.site.syncedAt, added.site.syncedAt)
  }
  assert.equal((await post({ ...input, id })).status, 403)
  failGroups = ''
  failAccounts = true
  const partial = await post({}, syncPath)
  assert.equal(partial.site.error, null)
  assert.ok(partial.site.accountsError)
  assert.deepEqual(partial.site.accounts, added.site.accounts)
  failAccounts = false
  const edited = await post({ ...input, id, token: '', name: 'Renamed secondary' })
  assert.equal(edited.site.name, 'Renamed secondary')
  assert.equal((await post({ ...input, id, endpoint: 'https://different.test', token: '' })).status, 400)
  requiredKey = 'admin-rotated-secret'
  assert.equal((await post({ ...input, id, token: requiredKey })).status, 200)
  assert.equal(disk.load()[0].token, requiredKey)
  let release
  holdGroups = new Promise(resolve => { release = resolve })
  const waiting = new Promise(resolve => { started = resolve })
  const running = post({}, syncPath)
  await waiting
  assert.equal((await post({}, syncPath)).status, 409)
  release(); holdGroups = null
  assert.equal((await running).status, 200)
  const beforeRestart = await list()
  api = monitorAPI({ channelStore, secondaryStore: createSecondarySiteStore(directory) })
  assert.deepEqual(await list(), beforeRestart)
  assert.equal(JSON.stringify(channelStore.load()), channelBefore)
})

test('sync auto-matches full keys and authorized single-account exports without storing or exposing credentials', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-auto-bindings-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const disk = createSecondarySiteStore(directory), channels = createChannelStore(directory)
  const endpoint = 'https://upstream.example.test'
  channels.save([{ id: 'upstream', name: '匹配上游', endpoint, provider: 'sub2api', probeTokens: [1, 2].map(id => ({
    id: String(id), name: `令牌 ${id}`, key: `sk-matching-secret-${id}`, probeEnabled: false, status: 'active',
    probeModels: [{ id: 'gpt-5', protocol: 'responses' }],
  })) }])
  let denied = false, malformed = false, rotated = false
  const exported = []
  const remote = createServer((req, res) => {
    assert.equal(req.method, 'GET')
    assert.equal(req.headers['x-api-key'], 'admin-read-only-secret')
    const url = new URL(req.url, 'http://localhost')
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: status === 200 ? 0 : status, data })) }
    if (url.pathname.endsWith('/data')) {
      assert.equal(url.searchParams.get('ids'), '2')
      assert.equal(url.searchParams.get('include_proxies'), 'false')
      exported.push(2)
      if (denied) return send(403, {})
      return send(200, { accounts: malformed ? [] : [{ name: ' 账号 2 ', type: 'apikey', platform: 'openai',
        credentials: { base_url: endpoint + '/v1', api_key: rotated ? 'sk-rotated-secret' : 'sk-matching-secret-2', model_mapping: { 'public-codex': 'gpt-5' } },
        extra: { ignored: 'extra-secret' } }], proxies: [] })
    }
    const items = url.pathname.endsWith('/groups') ? [{ id: 1, name: 'Codex', platform: 'openai', status: 'active' }]
      : [1, 2].map(id => ({ id, name: ` 账号 ${id} `, type: 'apikey', platform: 'openai', status: 'active', schedulable: true, group_ids: [1],
        credentials: { base_url: endpoint + '/v1/', ...(id === 1 ? { api_key: 'sk-matching-secret-1' } : {}) }, credentials_status: { has_api_key: true } }))
    send(200, { items, page: 1, page_size: 100, total: items.length })
  })
  remote.listen(0, '127.0.0.1'); await once(remote, 'listening')
  t.after(() => remote.close())
  let api = monitorAPI({ channelStore: channels, secondaryStore: disk })
  const server = createServer((req, res) => api(req, res, () => { res.writeHead(404); res.end() }))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  const post = async (path, body) => {
    const response = await fetch(base + path, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    assert.equal(response.status, 200)
    return (await response.json()).site
  }
  let site = await post('/api/secondary-sites', { name: '调度站点', endpoint: `http://127.0.0.1:${remote.address().port}`, token: 'admin-read-only-secret' })
  assert.deepEqual(site.routes.accounts.map(account => account.binding.tokenId), ['1', '2'])
  assert.equal(site.routes.accounts[1].models[0].model, 'public-codex')
  assert.equal(site.routes.accounts[1].models[0].status, 'disabled')
  assert.deepEqual(exported, [2])
  assert.ok(!JSON.stringify(site).includes('secret'))
  assert.ok(!JSON.stringify(site).includes('keyHash'))
  assert.ok(!JSON.stringify(disk.load()[0].accounts).includes('secret'))
  assert.ok(!readFileSync(join(directory, 'monitor.sqlite'), 'utf8').includes(endpoint))
  const sync = () => post(`/api/secondary-sites/${site.id}/sync`, {})
  denied = true
  site = await sync()
  assert.equal(site.accountsError, null, 'credential permission failures must not discard the account catalog')
  assert.equal(site.routes.accounts[0].binding.tokenId, '1')
  assert.equal(site.routes.accounts[1].binding, null)
  assert.match(site.routes.accounts[1].autoMatchReason, /导出权限/)
  denied = false; malformed = true
  site = await sync()
  assert.equal(site.routes.accounts[1].binding, null)
  malformed = false; rotated = true
  site = await sync()
  assert.equal(site.routes.accounts[1].binding, null, 'an old fingerprint must never survive a key rotation')
  rotated = false
  site = await sync()
  api = monitorAPI({ channelStore: channels, secondaryStore: disk })
  const reloaded = (await (await fetch(base + '/api/secondary-sites')).json()).sites[0]
  assert.equal(reloaded.routes.accounts[1].binding.source, 'auto')
  assert.deepEqual(channels.load()[0].probeTokens.map(token => token.probeEnabled), [false, false])
})
