import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { pushRoutes, createRouteAutomation, automationView } from './route-automation.js'
import { accountConnection } from './route-bindings.js'

function fixture() {
  let clock = Date.parse('2026-09-20T00:00:00Z'), sequence = 100, uncertain = false, releaseFailure = false, enableRecoveryHook
  const source = { id: 'source', provider: 'newapi', name: '国模测试', endpoint: 'https://upstream.example.test', rechargeRate: 2,
    balance: { status: 'ok', amount: 10 }, userGroups: { status: 'ok', groups: [{ id: 'cn', rate: 0.3 }] },
    probeTokens: [{ id: 'token', key: 'test-private-key', groupId: 'cn', groupName: '国模', status: 'active', probeEnabled: true,
      probeModels: ['deepseek-v4-pro', 'deepseek-v4-flash', 'glm-5.3', 'kimi-k3', 'MiniMax-M3', 'hy4-preview', 'mimo-v2.5', 'qwen3.8-27b'].map(id => ({ id, protocol: 'chat', status: 'ok', lastProbeAt: new Date(clock).toISOString(), successStreak: 2 })) }] }
  const token = source.probeTokens[0], channels = new Map([[source.id, source]])
  const site = { id: 'site', groups: ['DeepSeek', 'GLM', 'Kimi'].map((name, i) => ({ id: i + 1, name, platform: i === 2 ? 'composite' : 'openai', status: 'active', rate: 0.3 })),
    accounts: [], syncedAt: new Date(clock).toISOString(), accountsSyncedAt: new Date(clock).toISOString(),
    automation: { direction: 'push', enabled: true, routes: {}, accounts: {}, events: [] } }
  const sites = new Map([[site.id, site]]), remote = new Map(), writes = []
  const summary = raw => ({ id: raw.id, name: raw.name, platform: raw.platform, type: raw.type, groupIds: raw.group_ids,
    status: raw.status, schedulable: raw.schedulable, connection: accountConnection(raw) })
  const request = async (_site, path, body, method = body ? 'POST' : 'GET') => {
    let raw
    if (method !== 'GET') writes.push({ path, method, body: structuredClone(body) })
    if (path === '/api/v1/admin/accounts' && method === 'POST') {
      raw = { ...structuredClone(body), id: ++sequence, status: 'active', schedulable: true }
      remote.set(raw.id, raw)
      if (uncertain) { uncertain = false; throw Error('timeout after commit') }
      return { id: raw.id }
    }
    if (path.includes('/data?')) return { accounts: [structuredClone(remote.get(Number(new URL(path, 'https://test').searchParams.get('ids'))))] }
    const match = path.match(/\/accounts\/(\d+)(?:\/(.*))?$/)
    assert.ok(match, path)
    raw = remote.get(Number(match[1])); assert.ok(raw, path)
    if (releaseFailure && method === 'POST' && match[2] === 'schedulable' && body.schedulable === false) throw Error('release unavailable')
    if (method === 'PUT') { if (body.name) raw.name = body.name; if (body.status) raw.status = body.status; if (body.credentials) raw.credentials = { ...body.credentials, api_key: raw.credentials.api_key } }
    if (method === 'POST' && match[2] === 'schedulable') raw.schedulable = body.schedulable
    const safe = structuredClone(raw); delete safe.credentials.api_key; return safe
  }
  const synchronize = async current => ({ ...current, accounts: [...remote.values()].map(summary), syncedAt: new Date(clock).toISOString(), accountsSyncedAt: new Date(clock).toISOString() })
  const create = () => createRouteAutomation({ sites, channels, busy: new Set(), auth: { exclusive: async (_id, fn) => { const result = fn(); await enableRecoveryHook?.(); return result } }, channelStore: { saveChannels() {} },
    save: value => sites.set(value.id, value), request, synchronize, now: () => clock })
  let api = create()
  return { source, token, channels, remote, writes, summary, current: () => sites.get('site'), now: () => clock,
    routes: () => pushRoutes(sites.get('site'), channels, clock),
    step: async (ms = 5000) => { clock += ms; await api.runDue() },
    refresh: (updates = {}) => { for (const model of token.probeModels) Object.assign(model, { status: 'ok', reason: null, lastProbeAt: new Date(clock).toISOString(), successStreak: 2 }, updates[model.id]) },
    configure: input => api.configure(sites.get('site'), input),
    restart: () => { sites.set('site', structuredClone(sites.get('site'))); api = create() },
    uncertain: () => { uncertain = true },
    failRelease: value => { releaseFailure = value },
    onRecoveryEnabled: fn => { enableRecoveryHook = fn },
  }
}
const creates = f => f.writes.filter(write => write.path === '/api/v1/admin/accounts')

test('a changed rate before creating the remote account cancels the obsolete plan without a pending creation', async () => {
  const f = fixture()
  f.onRecoveryEnabled(() => { f.source.userGroups.groups[0].rate = 100 })
  await f.step()
  assert.equal(creates(f).length, 0)
  assert.ok(Object.values(f.current().automation.routes).every(route => !route.pendingCreate && !route.error))
  await f.step(1)
  assert.equal(creates(f).length, 0)
  assert.ok(f.routes().filter(route => route.groupId).every(route => route.costBlocked))
})

function parallelRoutesFixture() {
  const f = fixture()
  f.current().groups = [f.current().groups[0]]
  f.token.probeModels = f.token.probeModels.slice(0, 2)
  const spare = structuredClone(f.source)
  spare.id = 'spare'; spare.name = '便宜备选'; spare.probeTokens[0].key = 'spare-private-key'; spare.userGroups.groups[0].rate = 0.02
  f.channels.set(spare.id, spare)
  const history = (model, failures = 0) => {
    model.probeHistory = Array.from({ length: 60 }, (_, i) => ({ at: new Date(f.now() - (59 - i) * 60000).toISOString(), status: i < failures ? 'error' : 'ok' }))
    Object.assign(model, { status: 'ok', successStreak: 60 - failures, lastProbeAt: new Date(f.now()).toISOString() })
  }
  f.token.probeModels.forEach(model => history(model))
  spare.probeTokens[0].probeModels.forEach(model => history(model, 15))
  const active = model => [...f.remote.values()].filter(account => account.schedulable && Object.keys(account.credentials.model_mapping).includes(model))
  return { ...f, spare, history, active }
}

test('all healthy routes share a group/model, including equal cost, weaker history and newly verified sources', async () => {
  const f = parallelRoutesFixture()
  f.source.userGroups.groups[0].rate = 0.6 // Folded 0.3 equals the target.
  f.token.probeModels.forEach(model => { model.latencyMs = 9000 })
  f.spare.probeTokens[0].probeModels.forEach(model => { model.latencyMs = 10 })
  await f.step()
  assert.equal(creates(f).length, 2)
  for (const model of f.token.probeModels) assert.deepEqual(f.active(model.id).map(account => account.credentials.api_key).sort(), ['spare-private-key', 'test-private-key'])
  assert.ok(f.routes().every(route => route.state === 'healthy'))
  const newRoute = structuredClone(f.source); newRoute.id = 'new'; newRoute.probeTokens[0].key = 'new-private-key'
  newRoute.probeTokens[0].probeModels.forEach(model => { model.probeHistory = []; model.successStreak = 1 })
  f.channels.set('new', newRoute)
  await f.step(); assert.equal(creates(f).length, 3, 'A newly verified source also participates')
  f.restart(); await f.step(); assert.equal(creates(f).length, 3, 'Restart does not duplicate accounts')
  for (const model of f.token.probeModels) assert.equal(f.active(model.id).length, 3)
})

test('a failure removes only that source model while every other healthy model and source remains active', async () => {
  const f = parallelRoutesFixture(), [first, second] = f.token.probeModels
  await f.step()
  const primary = [...f.remote.values()].find(account => account.credentials.api_key === f.token.key)
  Object.assign(first, { status: 'error', reason: 'authentication', lastProbeAt: new Date(f.now()).toISOString(), successStreak: 0 })
  await f.step()
  assert.equal(primary.schedulable, true)
  assert.equal(f.active(first.id).length, 1); assert.equal(f.active(first.id)[0].credentials.api_key, 'spare-private-key')
  assert.equal(f.active(second.id).length, 2)
  Object.assign(first, { status: 'ok', lastProbeAt: new Date(f.now()).toISOString(), successStreak: 1 })
  await f.step()
  assert.equal(f.active(first.id).length, 2, 'The recovered model rejoins without displacing its peer')
  assert.equal(creates(f).length, 2)
})

test('legacy standby resumes and a stopped peer automatically rejoins after new verification', async () => {
  const f = parallelRoutesFixture(); await f.step()
  const [primary, spare] = [...f.remote.values()]
  const standby = f.current().automation.accounts[spare.id]
  spare.schedulable = false; f.current().accounts.find(account => account.id === spare.id).schedulable = false
  Object.assign(standby, { pausedBySystem: true, pauseReason: 'standby', state: 'standby', expectedSchedulable: false,
    pausedAt: new Date(f.now()).toISOString(), recovery: {}, lastEvidence: 'previous-recommendation-policy' })
  primary.schedulable = false // A remote stop now triggers automatic recovery.
  f.restart(); await f.step()
  assert.equal(spare.schedulable, true)
  assert.equal(primary.schedulable, false)
  assert.equal(f.current().automation.accounts[primary.id].managed, true)
  assert.equal(f.current().automation.accounts[spare.id].state, 'healthy')
  assert.ok(f.current().automation.events.some(event => event.action === '恢复全部线路调度'))
  f.restart(); await f.step(); f.refresh(); await f.step(); f.refresh(); await f.step()
  assert.equal(creates(f).length, 2)
  assert.equal(primary.schedulable, true)
})

test('an unhealthy legacy standby still needs recovery checks, and unknown pricing never permits dispatch', async () => {
  const f = parallelRoutesFixture(); await f.step()
  const sourceAccount = [...f.remote.values()].find(account => account.credentials.api_key === f.token.key)
  sourceAccount.schedulable = false
  f.current().accounts.find(account => account.id === sourceAccount.id).schedulable = false
  Object.assign(f.current().automation.accounts[sourceAccount.id], { pausedBySystem: true, pauseReason: 'standby', expectedSchedulable: false,
    pausedAt: new Date(f.now()).toISOString(), recovery: {}, lastEvidence: 'previous-recommendation-policy' })
  f.refresh(Object.fromEntries(f.token.probeModels.map(model => [model.id, { status: 'error', reason: 'authentication', successStreak: 0 }])))
  await f.step()
  assert.equal(sourceAccount.schedulable, false)
  assert.equal(f.current().automation.accounts[sourceAccount.id].pauseReason, 'error')
  await f.step()
  f.refresh(); await f.step(); assert.equal(sourceAccount.schedulable, false)
  f.refresh(); await f.step(); assert.equal(sourceAccount.schedulable, true)
  f.source.userGroups.groups = []
  await f.step(); assert.equal(sourceAccount.schedulable, false)
  assert.match(f.current().automation.accounts[sourceAccount.id].reason, /倍率成本未确认/)
  assert.equal([...f.remote.values()].filter(account => account.schedulable).length, 1)
})

test('an uncertain stop on a failed source does not block a different healthy source from joining', async () => {
  const f = parallelRoutesFixture()
  f.channels.delete('spare'); await f.step()
  f.refresh(Object.fromEntries(f.token.probeModels.map(model => [model.id, { status: 'error', reason: 'authentication', successStreak: 0 }])))
  f.failRelease(true); f.channels.set('spare', f.spare)
  await f.step()
  assert.equal(creates(f).length, 2)
  assert.ok([...f.remote.values()].some(account => account.credentials.api_key === 'spare-private-key' && account.schedulable))
  assert.ok(Object.values(f.current().automation.accounts).some(state => state.pending?.action === 'schedulable'))
  f.restart(); await f.step(); assert.equal(creates(f).length, 2)
})

test('repricing pauses only expensive managed families and resumes after two new successful rounds', async () => {
  const f = fixture(); await f.step()
  const deep = [...f.remote.values()].find(account => account.group_ids[0] === 1)
  const kimi = [...f.remote.values()].find(account => account.group_ids[0] === 3)
  f.current().groups[0].rate = 0.1
  await f.step()
  assert.equal(deep.schedulable, false); assert.equal(kimi.schedulable, true)
  assert.equal(f.current().automation.accounts[deep.id].pauseReason, 'cost')
  assert.match(f.current().automation.accounts[deep.id].reason, /实际成本.*高于/)
  f.restart(); await f.step()
  assert.equal(deep.schedulable, false)
  f.current().groups[0].rate = 0.15
  f.refresh(); await f.step(); assert.equal(deep.schedulable, false)
  f.refresh(); await f.step(); assert.equal(deep.schedulable, true)
  assert.equal(creates(f).length, 3, 'Recover existing accounts without duplicates')
})

test('one key fans out into existing compatible family groups, with scoped whitelists and no extra probes', async () => {
  const f = fixture()
  const routes = f.routes()
  assert.equal(routes.length, 7)
  assert.deepEqual(routes.filter(route => route.groupId).map(route => route.family), ['DeepSeek', 'GLM', 'Kimi'])
  for (const route of routes.filter(route => !route.groupId)) assert.match(route.blockReason, /未匹配调度分组/)
  await f.step()
  assert.equal(creates(f).length, 3)
  const expected = [['deepseek-v4-pro', 'deepseek-v4-flash'], ['glm-5.3'], ['kimi-k3']]
  for (const { body } of creates(f)) {
    assert.equal(body.credentials.api_key, f.token.key)
    assert.equal(body.credentials.base_url, f.source.endpoint)
    assert.deepEqual(Object.keys(body.credentials.model_mapping), expected[body.group_ids[0] - 1])
    assert.equal(body.extra.openai_responses_mode, 'force_chat_completions')
    assert.equal(body.extra.openai_passthrough, false)
    assert.equal(body.concurrency, 1000); assert.equal(body.priority, 1)
  }
  assert.equal(f.source.probeTokens.length, 1)
  f.restart(); await f.step()
  assert.equal(creates(f).length, 3)
  const view = automationView(f.current(), f.channels, f.now())
  assert.equal(view.routes.find(route => route.family === 'Kimi').targetGroupName, 'Kimi')
  assert.ok(!JSON.stringify(view).includes(f.token.key))
})

test('failure, recovery, model removal and a deleted target group are isolated to their family', async () => {
  const f = fixture(); await f.step()
  const deep = [...f.remote.values()].find(account => account.group_ids[0] === 1)
  const kimi = [...f.remote.values()].find(account => account.group_ids[0] === 3)
  f.refresh({ 'deepseek-v4-pro': { status: 'error', reason: 'authentication' } }); await f.step()
  assert.deepEqual(deep.credentials.model_mapping, { 'deepseek-v4-flash': 'deepseek-v4-flash' })
  f.refresh({ 'deepseek-v4-pro': { status: 'error', reason: 'authentication' }, 'deepseek-v4-flash': { status: 'error', reason: 'authentication' } }); await f.step()
  assert.equal(deep.schedulable, false); assert.equal(kimi.schedulable, true)
  await f.step()
  f.refresh(); await f.step(); assert.equal(deep.schedulable, false)
  f.refresh(); await f.step(); assert.equal(deep.schedulable, true)
  f.token.probeModels = f.token.probeModels.filter(model => !model.id.startsWith('deepseek'))
  await f.step(); assert.equal(deep.schedulable, false); assert.equal(kimi.schedulable, true)
  assert.notDeepEqual(deep.credentials.model_mapping, {}, 'An empty map would allow every model')
  f.current().groups = f.current().groups.filter(group => group.id !== 3)
  await f.step(); assert.equal(kimi.schedulable, false)
  assert.equal(creates(f).length, 3)
})

test('ambiguous destinations, unknown costs and misleading source names do not bypass matching', async () => {
  const f = fixture()
  f.token.groupName = 'Codex Plus'
  f.current().groups.push({ id: 4, name: 'Kimi 特惠', platform: 'openai', status: 'active', rate: 0.3 }, { id: 5, name: 'Codex Plus', platform: 'openai', status: 'active', rate: 1 })
  let kimi = f.routes().find(route => route.family === 'Kimi')
  assert.equal(kimi.groupId, null); assert.match(kimi.blockReason, /请选择/)
  assert.throws(() => f.configure({ routeId: kimi.id, groupId: 5, enabled: true }), /系列和协议兼容/)
  f.configure({ routeId: kimi.id, groupId: 3, enabled: true })
  assert.equal(f.routes().find(route => route.family === 'Kimi').groupId, 3)
  assert.equal(f.routes().find(route => route.family === 'DeepSeek').groupId, 1)
  f.current().groups.find(group => group.id === 1).rate = 0.15
  f.source.userGroups.groups = []
  await f.step(); assert.equal(creates(f).length, 0)
})

test('duplicate local sources do not create duplicate destination accounts', async () => {
  const f = fixture()
  f.channels.set('duplicate', { ...structuredClone(f.source), id: 'duplicate' })
  await f.step(); await f.step()
  assert.equal(creates(f).length, 3)
  assert.equal(f.remote.size, 3)
})

test('legacy account identity survives while obsolete per-route stops are removed', async () => {
  for (const stopped of [false, true]) {
    const f = fixture(), id = createHash('sha256').update(JSON.stringify([f.source.id, f.token.id, 'openai'])).digest('hex').slice(0, 24)
    const raw = { id: 50, name: '国模测试 · 0.15×', platform: 'openai', type: 'apikey', status: 'active', schedulable: !stopped, group_ids: [3],
      credentials: { base_url: f.source.endpoint, api_key: f.token.key, model_mapping: Object.fromEntries(f.token.probeModels.map(model => [model.id, model.id])) }, extra: {} }
    f.remote.set(50, raw); f.current().accounts.push(f.summary(raw))
    f.current().automation.routes[id] = { channelId: f.source.id, tokenId: f.token.id, platform: 'openai', accountId: 50, groupId: 3, enabled: !stopped }
    const kimi = f.routes().find(route => route.family === 'Kimi')
    assert.equal(kimi.id, id); assert.equal(kimi.accountId, 50)
    delete f.current().automation.management
    f.restart(); await f.step(); await f.step(); f.refresh(); await f.step(); f.refresh(); await f.step()
    assert.equal(f.routes().find(route => route.family === 'Kimi').id, id)
    assert.equal(raw.schedulable, true)
    assert.equal(creates(f).length, 2)
    assert.equal(f.current().automation.routes[id].enabled, undefined)
    assert.deepEqual(raw.credentials.model_mapping, { 'kimi-k3': 'kimi-k3' })
  }
})

test('uncertain creation is reconciled by family and destination without duplicate POSTs', async () => {
  const f = fixture(); f.uncertain(); await f.step()
  assert.equal(creates(f).length, 3)
  f.restart(); f.refresh(); await f.step(60000)
  assert.equal(creates(f).length, 3)
  assert.equal(f.routes().filter(route => route.accountId).length, 3)
  assert.equal(f.routes().filter(route => route.pendingCreate).length, 0)
})

test('native Chinese-provider groups use the matching account platform and explicit protocol', async () => {
  const f = fixture()
  const platforms = ['deepseek', 'zhipu', 'kimi']
  for (const [i, group] of f.current().groups.entries()) group.platform = platforms[i]
  await f.step()
  assert.equal(creates(f).length, 3)
  for (const { body } of creates(f)) {
    assert.equal(body.platform, platforms[body.group_ids[0] - 1])
    assert.equal(body.credentials.api_protocol, 'chat_completions')
    assert.equal(body.credentials.account_mode, 'payg')
    assert.equal(body.credentials.base_url, f.source.endpoint + '/v1')
  }
  f.restart(); await f.step()
  assert.equal(creates(f).length, 3)
  assert.ok(f.routes().filter(route => route.accountId).every(route => route.state === 'healthy'))
})

test('an uncertain POST also blocks duplicate sources from creating the same destination', async () => {
  const f = fixture()
  f.channels.set('duplicate', { ...structuredClone(f.source), id: 'duplicate' })
  f.uncertain(); await f.step()
  assert.equal(creates(f).length, 3)
  f.restart(); f.refresh(); await f.step(60000)
  assert.equal(creates(f).length, 3)
})

test('a removed group keeps a stopped account paused until the group and probe evidence recover', async () => {
  const f = fixture(); await f.step()
  const account = [...f.remote.values()].find(account => account.group_ids[0] === 1)
  account.schedulable = false
  const group = f.current().groups.find(group => group.id === 1); group.status = 'inactive'
  await f.step()
  assert.equal(f.current().automation.accounts[account.id].managed, true)
  assert.equal(account.schedulable, false)
  group.status = 'active'
  await f.step(); f.refresh(); await f.step(); f.refresh(); await f.step()
  assert.equal(account.schedulable, true)
})

test('missing credentials remain a blocked route and never crash the route list', async () => {
  const f = fixture(); await f.step()
  delete f.token.key
  assert.equal(f.routes().length, 7)
  await f.step()
  assert.equal(creates(f).length, 3)
})


test('unmatched families keep automatic model recovery enabled without creating a scheduler account', async () => {
  const f = fixture(); f.current().groups = []
  await f.step()
  assert.equal(f.token.autoRecoverModels, true)
  assert.equal(creates(f).length, 0)
})
