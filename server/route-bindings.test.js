import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { accountConnection, connectionEndpoint, createRouteBindings, routingSignature } from './route-bindings.js'
import { monitorAPI } from './monitor-api.js'
import { createChannelStore, createSecondarySiteStore } from './site-store.js'

function fixture() {
  const now = Date.parse('2026-09-18T06:00:00Z'), at = offset => new Date(now + offset).toISOString()
  const model = { id: 'gpt-5', protocol: 'responses', status: 'ok', lastProbeAt: at(-30000),
    probeHistory: [{ at: at(-7200000), status: 'ok' }, { at: at(-60000), status: 'error' }, { at: at(-30000), status: 'ok' }] }
  const upstream = { id: 'upstream', name: 'Upstream', endpoint: 'https://upstream.test', provider: 'sub2api',
    balance: { status: 'ok', amount: 5 }, probeTokens: [
      { id: '1', name: 'Passing token', key: 'sk-token-one-secret', groupId: 1, status: 'active', probeEnabled: true, probeModels: [model] },
      { id: '2', name: 'Failing token', key: 'sk-token-two-secret', groupId: 2, status: 'active', probeEnabled: true,
        probeModels: [{ ...model, status: 'error', error: '请求超时', lastProbeAt: at(-10000), probeHistory: [{ at: at(-10000), status: 'error' }] }] },
    ] }
  const site = { id: 'secondary', name: 'Secondary', endpoint: 'https://secondary.test', provider: 'sub2api',
    token: 'admin-secondary-secret', groups: [{ id: 10, name: 'Shared group', platform: 'openai', status: 'active' }],
    accounts: [1, 2, 3].map(id => ({ id, name: `Account ${id}`, platform: 'openai', type: 'apikey', status: 'active',
      schedulable: true, groupIds: [10], routingSignature: routingSignature({ credentials: { api_key: 'redacted', base_url: upstream.endpoint } }) })),
    syncedAt: at(0), accountsSyncedAt: at(0) }
  const sites = new Map([[site.id, site]]), channels = new Map([[upstream.id, upstream]])
  const bindings = createRouteBindings({ channels, now: () => now })
  const save = input => {
    const current = sites.get(site.id), options = bindings.options(current)
    const updated = bindings.update(current, { version: options.version, context: options.context, ...input })
    sites.set(site.id, updated); return updated
  }
  const accountInput = (accountId, tokenId = '1') => ({ kind: 'account', accountId, upstreamId: upstream.id, tokenId,
    models: [{ model: 'codex-public', upstreamModel: 'gpt-5' }] })
  return { now, at, site, upstream, model, sites, channels, bindings, save, accountInput }
}

test('route bindings preserve exact tokens, aliases, independent evidence and eligibility', () => {
  const f = fixture(), { save, accountInput, bindings, sites, upstream, model } = f
  save(accountInput(1)); save(accountInput(2, '2')); save(accountInput(3))
  const view = () => bindings.view(sites.get('secondary'))
  let group = view().groups[0].models[0]
  assert.equal(group.model, 'codex-public')
  assert.equal(group.passed, 2); assert.equal(group.failed, 1); assert.equal(group.independentTokens, 1)
  assert.equal(view().accounts[0].models[0].successRate, 50)
  assert.equal(view().accounts[1].models[0].status, 'error')
  assert.ok(!JSON.stringify(view()).includes('secret'))
  assert.ok(!JSON.stringify(bindings.options(sites.get('secondary'))).includes('secret'))
  assert.ok(!JSON.stringify(view()).includes('routingSignature'))
  sites.get('secondary').accounts[2].schedulable = false
  group = view().groups[0].models[0]
  assert.equal(group.passed, 1); assert.equal(group.unavailable, 1)
  upstream.probeTokens[0].probeEnabled = false
  assert.equal(view().accounts[0].models[0].status, 'disabled'); assert.equal(view().groups[0].models[0].passed, 0)
  upstream.probeTokens[0].probeEnabled = true
  model.lastProbeAt = f.at(-121000)
  assert.equal(view().accounts[0].models[0].status, 'stale')
  model.lastProbeAt = f.at(-10000)
  model.autoPaused = true
  assert.equal(view().accounts[0].models[0].status, 'excluded')
  model.autoPaused = false
  upstream.balance.amount = 0
  assert.equal(view().accounts[0].models[0].status, 'paused')
  upstream.balance.amount = 5
  upstream.probeTokens[0].expiresAt = f.at(-1)
  assert.equal(view().accounts[0].models[0].status, 'paused')
  delete upstream.probeTokens[0].expiresAt
  model.status = 'error'; model.probeHistory = [{ at: f.at(-7200000), status: 'ok' }]
  assert.equal(view().accounts[0].models[0].lastSuccessAt, f.at(-7200000))
  assert.equal(view().accounts[0].models[0].successRate, null)
  upstream.probeTokens[0].key = 'rotated-secret'
  assert.equal(view().accounts[0].binding.status, 'changed')
  assert.equal(view().groups[0].models[0].routes[0].bindingStatus, 'changed')
  save(accountInput(1))
  sites.get('secondary').accounts[0].name = 'Renamed'
  assert.equal(view().accounts[0].binding.status, 'confirmed')
  sites.get('secondary').accounts[0].groupIds = []
  assert.equal(view().accounts[0].binding.status, 'changed')
  sites.get('secondary').accounts = []
  assert.equal(view().orphanBindings.length, 3)
  save({ kind: 'account', accountId: 1, remove: true })
  assert.equal(view().orphanBindings.length, 2)
})

test('subsidiary account associations reject stale configurations and ignore obsolete main links', () => {
  const f = fixture(), { save, accountInput, bindings, sites, site } = f
  site.mainBindings = [{ groupId: 10, mainSiteId: 'obsolete' }]
  site.mainGroupBindings = [{ groupId: 10, mainSiteId: 'obsolete', mainGroupId: 'gone' }]
  const first = bindings.options(site)
  save(accountInput(1))
  assert.throws(() => bindings.update(sites.get(site.id), { ...accountInput(2), version: first.version, context: first.context }), /配置已变化/)
  for (const models of [[], [{ model: 'bad', upstreamModel: 'missing' }], [accountInput(1).models[0], accountInput(1).models[0]]]) {
    assert.throws(() => save({ ...accountInput(2), models }))
  }
  assert.throws(() => save({ ...accountInput(2), context: 'old' }), /过期/)
  assert.throws(() => save({ kind: 'group', groupId: 10, mainGroups: [] }))
  assert.equal(bindings.options(site).mainGroups, undefined)
  assert.equal(bindings.view(sites.get(site.id)).mainLinks, undefined)
  assert.equal(bindings.view(sites.get(site.id)).groups[0].models[0].passed, 1)
  sites.get(site.id).accountsSyncedAt = f.at(-86400001)
  assert.throws(() => save(accountInput(2)), /过期/)
  assert.equal(bindings.view(sites.get(site.id)).accounts[0].binding.status, 'stale')
  assert.equal(routingSignature({ credentials: { model_mapping: { a: 'b', c: 'd' } } }),
    routingSignature({ credentials: { model_mapping: { c: 'd', a: 'b' } } }))
})

test('URL and full-key matching is exact, unique, private and follows the current token catalog', () => {
  const f = fixture(), account = f.site.accounts[0]
  const config = { platform: 'openai', credentials: { base_url: 'https://UPSTREAM.test:443/v1/', api_key: 'sk-token-one-secret', model_mapping: { 'codex-public': 'gpt-5' } } }
  account.connection = accountConnection(config)
  const view = () => f.bindings.view(f.site)
  let result = view()
  assert.equal(result.accounts[0].binding.source, 'auto')
  assert.equal(result.accounts[0].binding.tokenId, '1')
  assert.equal(result.accounts[0].models[0].model, 'codex-public')
  assert.equal(result.groups[0].models[0].passed, 1)
  assert.equal(f.site.accountBindings, undefined, 'automatic associations are derived from encrypted configuration fingerprints')
  for (const secret of ['sk-token-one-secret', account.connection.keyHash, 'connection']) {
    assert.ok(!JSON.stringify(result).includes(secret)); assert.ok(!JSON.stringify(f.bindings.options(f.site)).includes(secret))
  }
  assert.ok(!JSON.stringify(account.connection).includes('sk-token-one-secret'))
  assert.notEqual(connectionEndpoint('https://upstream.test/tenant-a/v1'), connectionEndpoint('https://upstream.test/tenant-b/v1'))
  assert.notEqual(connectionEndpoint('http://upstream.test'), connectionEndpoint('https://upstream.test'))
  assert.equal(connectionEndpoint('https://upstream.test/?key=secret'), null)
  const duplicate = structuredClone(f.upstream)
  duplicate.id = 'duplicate'; f.channels.set(duplicate.id, duplicate)
  assert.equal(view().accounts[0].binding, null)
  assert.match(view().accounts[0].autoMatchReason, /多个令牌/)
  f.channels.delete(duplicate.id)
  f.upstream.probeTokens[0].key = 'rotated-key'
  assert.equal(view().accounts[0].binding, null)
  f.upstream.probeTokens[0].key = 'sk-token-one-secret'
  config.credentials.api_key = 'sk-***secret'
  account.connection = accountConnection(config)
  assert.equal(view().accounts[0].binding, null)
  config.credentials.api_key = 'sk-token-one-secret'
  config.credentials.model_mapping = {}
  account.connection = accountConnection(config)
  f.upstream.probeTokens[0].probeModels.push({ id: 'gpt-5-mini', protocol: 'responses' })
  assert.deepEqual(view().accounts[0].models.map(model => model.model), ['gpt-5', 'gpt-5-mini'])
  config.credentials.model_mapping = { 'gpt-*': 'gpt-5', 'gpt-5-mini': 'gpt-5-mini', unknown: 'missing-model' }
  account.connection = accountConnection(config)
  assert.deepEqual(view().accounts[0].models.map(({ model, upstreamModel }) => [model, upstreamModel]), [['gpt-5-mini', 'gpt-5-mini'], ['gpt-5', 'gpt-5']])
  config.credentials.model_mapping = { unsupported: 'missing-model' }
  account.connection = accountConnection(config)
  assert.equal(view().accounts[0].models.length, 0)
  config.extra = { openai_passthrough: true }
  account.connection = accountConnection(config)
  assert.equal(view().accounts[0].models.length, 2)
  f.site.accountsError = '账号同步失败'
  assert.equal(view().accounts[0].binding.status, 'stale')
  assert.equal(view().groups[0].models[0].passed, 0)
  f.site.accountsError = null
  account.type = 'oauth'
  assert.equal(view().accounts[0].binding, null)
})

test('manual choices override automatic matches; unlink disables matching until explicitly restored', () => {
  const f = fixture()
  f.site.accounts[0].connection = accountConnection({ credentials: { base_url: f.upstream.endpoint, api_key: 'sk-token-one-secret' } })
  f.save(f.accountInput(1, '2'))
  let site = f.sites.get(f.site.id)
  assert.equal(f.bindings.view(site).accounts[0].binding.source, 'manual')
  assert.equal(f.bindings.view(site).accounts[0].binding.tokenId, '2')
  f.save({ kind: 'account', accountId: 1, remove: true })
  site = f.sites.get(f.site.id)
  assert.equal(f.bindings.view(site).accounts[0].binding, null)
  assert.equal(f.bindings.view(site).accounts[0].autoBindingDisabled, true)
  f.save({ kind: 'account', accountId: 1, automatic: true })
  site = f.sites.get(f.site.id)
  assert.equal(f.bindings.view(site).accounts[0].binding.tokenId, '1')
  assert.equal(f.bindings.view(site).accounts[0].autoBindingDisabled, false)
})

test('NewAPI matching accepts its optional sk- prefix and uses the same base URL as model probes', () => {
  const f = fixture(), account = f.site.accounts[0], token = f.upstream.probeTokens[0]
  f.upstream.provider = 'newapi'
  f.upstream.endpoint = 'https://upstream.test/api/v1'
  token.key = 'newapi-private-token'
  const match = key => {
    account.connection = accountConnection({ credentials: { base_url: 'https://upstream.test/v1/', api_key: key } })
    return f.bindings.view(f.site).accounts[0]
  }
  assert.equal(match('sk-newapi-private-token').binding.tokenId, '1')
  assert.equal(match('newapi-private-token').binding.tokenId, '1')
  assert.equal(match('SK-newapi-private-token').binding, null)
  assert.equal(match('sk-sk-newapi-private-token').binding, null)
  assert.equal(match('sk-newapi-private-token-different').binding, null)
  f.upstream.endpoint = 'https://upstream.test/api'
  assert.equal(match('sk-newapi-private-token').binding.tokenId, '1')
  f.upstream.provider = 'sub2api'
  assert.equal(match('sk-newapi-private-token').binding, null, 'Sub2API prefixes must not be rewritten')
  assert.equal(match('newapi-private-token').binding.tokenId, '1')
})

test('binding API persists encrypted associations, rejects foreign writes and rolls back failed storage without upstream requests', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-bindings-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const f = fixture(), channelStore = createChannelStore(directory), disk = createSecondarySiteStore(directory)
  channelStore.save([f.upstream]); disk.save([f.site])
  const upstreamBefore = JSON.stringify(channelStore.load())
  let failSave = false
  const store = { load: disk.load, save: records => { if (failSave) throw new Error('storage secret'); disk.save(records) } }
  let api = monitorAPI({ channelStore, secondaryStore: store, now: () => f.now })
  const server = createServer((req, res) => api(req, res, () => { res.writeHead(404); res.end() }))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`, path = '/api/secondary-sites/secondary/bindings'
  const get = async () => (await fetch(base + path)).json()
  const post = async (input, origin = base) => {
    const result = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(input) })
    return { status: result.status, ...await result.json() }
  }
  const options = await get(), input = { ...f.accountInput(1), version: options.version, context: options.context }
  assert.equal((await post(input, 'https://foreign.test')).status, 403)
  failSave = true
  assert.equal((await post(input)).status, 500)
  assert.equal((await get()).routes.accounts[0].binding, null)
  failSave = false
  const result = await post(input)
  assert.equal(result.status, 200)
  assert.equal(result.site.routes.accounts[0].binding.tokenId, '1')
  assert.equal((await post(input)).status, 409)
  assert.ok(!JSON.stringify(result).includes('secret'))
  assert.ok(!readFileSync(join(directory, 'monitor.sqlite'), 'utf8').includes('codex-public'))
  api = monitorAPI({ channelStore, secondaryStore: disk, now: () => f.now })
  assert.equal((await get()).routes.accounts[0].models[0].model, 'codex-public')
  assert.deepEqual(JSON.stringify(channelStore.load()), upstreamBefore)
})
