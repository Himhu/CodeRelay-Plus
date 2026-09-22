import assert from 'node:assert/strict'
import test from 'node:test'
import { createOperationLogs } from './operation-logs.js'
import { createRouteAutomation, automationView, pushRoutes } from './route-automation.js'
import { accountConnection } from './route-bindings.js'
import { summarizeProbeHistory } from './probe-history.js'

function fixture({ schedulable = true, mapping = { good: 'good', bad: 'bad' }, passthrough = false, matching = true, history = false } = {}) {
  let clock = Date.parse('2026-09-19T00:00:00Z'), failSave = false, timeoutWrite = false, readHook
  const raw = { id: 1, name: 'upstream · 0.1×', platform: 'openai', type: 'apikey', status: 'active', schedulable, group_ids: [1],
    credentials: { base_url: 'https://probe.example.test', api_key: 'private-key', model_mapping: mapping, custom: 'retain-me' },
    extra: { openai_passthrough: passthrough } }
  const account = () => ({ id: raw.id, name: raw.name, type: raw.type, platform: raw.platform, status: raw.status,
    schedulable: raw.schedulable, groupIds: raw.group_ids, connection: accountConnection(raw) })
  const site = { id: 'site', name: '调度', endpoint: 'https://scheduler.example.test', token: 'private-admin', provider: 'sub2api',
    groups: [{ id: 1, name: 'Codex Plus', platform: 'openai', status: 'active', rate: 1 }], accounts: [account()], syncedAt: new Date(clock).toISOString(), accountsSyncedAt: new Date(clock).toISOString(),
    automation: { direction: 'push', enabled: true, routes: {}, accounts: {}, events: [] } }
  const sites = new Map([[site.id, site]]), writes = []
  const channel = { id: 'channel', provider: 'sub2api', name: 'upstream', userGroups: { status: 'ok', groups: [{ id: 'g', rate: 0.1 }] }, endpoint: raw.credentials.base_url, balance: { status: 'ok', amount: 1 },
    probeTokens: [{ id: 'token', name: 'token', groupId: 'g', groupName: 'Codex Plus', key: 'private-key', status: 'active', probeEnabled: true, probeModels: [
      { id: 'good', protocol: 'chat' }, { id: 'bad', protocol: 'chat' }] }] }
  const channels = new Map(matching ? [[channel.id, channel]] : [])
  const entries = []
  const logs = createOperationLogs({ store: { appendLog: entry => entries.push(entry) }, channels, now: () => clock })
  logs.setSites(sites)
  let durable = structuredClone(site)
  const save = value => { if (failSave) throw Object.assign(new Error('storage'), { storage: true }); durable = structuredClone(value); sites.set(value.id, value) }
  const request = async (_site, path, body, method = body ? 'POST' : 'GET') => {
    if (method === 'GET') await readHook?.(path)
    if (method !== 'GET') {
      writes.push({ path, body: structuredClone(body), method })
      if (path.endsWith('/schedulable')) raw.schedulable = body.schedulable
      else if (path.endsWith('/clear-error')) raw.status = 'active'
      else if (path.endsWith('/temp-unschedulable')) raw.temp_unschedulable_until = null
      else if (method === 'PUT' && body.name) raw.name = body.name
      else if (method === 'PUT' && body.extra) raw.extra = { ...raw.extra, ...body.extra }
      else if (method === 'PUT' && body.status) raw.status = body.status
      else if (method === 'PUT' && Object.hasOwn(body, 'priority')) raw.priority = body.priority
      else if (method === 'PUT') raw.credentials = { ...body.credentials, api_key: raw.credentials.api_key }
      else throw new Error('Unexpected write')
      if (timeoutWrite) { timeoutWrite = false; throw new Error('Request timed out after commit') }
    }
    if (path.includes('/data?')) return { accounts: [structuredClone(raw)] }
    const publicRaw = structuredClone(raw); delete publicRaw.credentials.api_key
    return publicRaw
  }
  const create = () => createRouteAutomation({ sites, busy: new Set(), save, channels, channelStore: { saveChannels() {} },
    auth: { exclusive: (_id, fn) => fn() }, logs, request, now: () => clock,
    synchronize: async current => ({ ...current, accounts: [account()], syncedAt: new Date(clock).toISOString(), accountsSyncedAt: new Date(clock).toISOString() }) })
  let automation = create()
  const step = async (ms = 60000) => { clock += ms; await automation.runDue() }
  const results = (good, bad, { streak = 2, reason = 'upstream_unavailable' } = {}) => {
    for (const [i, status] of [good, bad].entries()) {
      const model = channel.probeTokens[0].probeModels[i]
      Object.assign(model, {
      status, successStreak: status === 'ok' ? streak : 0, reason: status === 'ok' ? null : reason,
      lastProbeAt: new Date(clock).toISOString(), autoPaused: reason === 'model_unsupported' && status === 'error' })
      if (history) model.probeHistorySummary = summarizeProbeHistory([{ at: model.lastProbeAt, status, reason: model.reason }], model.probeHistorySummary)
    }
  }
  return { raw, channels, channel, sites, writes, entries, step, results, current: () => sites.get('site'),
    view: () => automationView(sites.get('site'), channels, clock), clock: () => clock,
    failSave: value => { failSave = value }, timeout: () => { timeoutWrite = true },
    restart: () => { sites.set('site', structuredClone(durable)); automation = create() },
    configure: input => automation.configure(sites.get('site'), input),
    onRead: fn => { readHook = fn }, notify: () => automation.probesUpdated(channel.id) }
}

test('a transient failed round observes an existing recent success without flapping or claiming a current pass', async () => {
  for (const reason of ['timeout', 'connection_error', 'upstream_unavailable', 'rate_limit', 'empty_response', 'request_incompatible', 'incomplete_stream', 'incomplete_response', 'output_limit']) {
    const f = fixture({ history: true })
    f.results('ok', 'ok'); await f.step(60000)
    const status = ['empty_response', 'request_incompatible', 'incomplete_stream', 'incomplete_response', 'output_limit'].includes(reason) ? 'inconclusive' : 'error'
    f.results(status, status, { reason }); await f.step(5000)
    assert.equal(f.raw.schedulable, true, reason)
    assert.deepEqual(f.raw.credentials.model_mapping, { good: 'good', bad: 'bad' })
    assert.equal(f.view().accounts[0].state, 'observing')
    assert.deepEqual(f.view().routes[0].availableModels, [])
    assert.deepEqual(f.view().routes[0].retainedModels, ['good', 'bad'])
    const observation = f.entries.find(entry => entry.action === '短暂异常观察')
    assert.deepEqual(observation.details.retainedModels, ['good', 'bad'])
    assert.ok(observation.details.modelResults[0].includes('最近成功 2026-09-19T00:00:00.000Z'))
    f.results('ok', status, { streak: 1, reason }); await f.step(5000)
    assert.equal(f.view().accounts[0].state, 'observing')
    assert.deepEqual(f.raw.credentials.model_mapping, { good: 'good', bad: 'bad' }, 'A single transient failed peer retains its own recent success')
    assert.deepEqual(f.view().routes[0].availableModels, ['good'], 'Observation is never presented as a current pass')
    assert.equal(f.writes.some(write => write.path.endsWith('/schedulable')), false)
  }
})

test('observation expires from the original success without new samples, including across restart', async () => {
  for (const restart of [false, true]) {
    const f = fixture({ history: true })
    f.results('ok', 'ok'); await f.step(5000)
    f.results('error', 'error', { reason: 'timeout' }); await f.step(5000)
    await f.step(60000)
    assert.equal(f.view().accounts[0].state, 'observing')
    const lastSync = f.current().accountsSyncedAt
    if (restart) f.restart()
    await f.step(51000)
    assert.equal(f.current().accountsSyncedAt, lastSync, 'Expiry must be checked even without a scheduler sync')
    assert.equal(f.raw.schedulable, false)
    assert.deepEqual(f.view().accounts[0].retainedModels, [])
    assert.match(f.view().accounts[0].reason, /本轮无当前通过.*探测超时 2/)
    const decision = f.entries.find(entry => entry.action === '决定暂停调度')
    assert.deepEqual(decision.details.availableModels, [])
    assert.match(decision.details.modelResults[0], /good · error · 探测超时/)
    assert.ok(f.entries.some(entry => entry.action === '关闭调度已确认'))
  }
})

test('new transient failures cannot extend the last successful probe lifetime', async () => {
  const f = fixture({ history: true })
  f.results('ok', 'ok'); await f.step(60000)
  f.results('error', 'error', { reason: 'timeout' }); await f.step(5000)
  await f.step(45000)
  f.results('error', 'error', { reason: 'timeout' }); await f.step(5000)
  assert.equal(f.raw.schedulable, true)
  await f.step(5001)
  assert.equal(f.raw.schedulable, false)
})

test('a transient model has its own grace deadline even while its sibling stays healthy', async () => {
  const f = fixture({ history: true })
  f.results('ok', 'ok'); await f.step(60000)
  f.results('ok', 'error', { reason: 'timeout' }); await f.step(5000)
  assert.equal(f.view().accounts[0].state, 'observing')
  assert.deepEqual(f.raw.credentials.model_mapping, { good: 'good', bad: 'bad' })
  await f.step(56000)
  assert.equal(f.raw.schedulable, true)
  assert.deepEqual(f.raw.credentials.model_mapping, { good: 'good' }, 'Expiry removes only the failed sibling')
  assert.equal(f.view().accounts[0].state, 'healthy')
})

test('a new probe notification bypasses the periodic wait and stale reads cannot disable a recovered route', async () => {
  for (const changeOnRead of [1, 2]) {
    const f = fixture()
    f.results('ok', 'ok'); await f.step(5000)
    f.results('error', 'error', { reason: 'authentication' })
    let reads = 0
    f.onRead(path => {
      if (path.includes('/data?') && ++reads === changeOnRead) {
        f.results('ok', 'ok'); f.notify()
      }
    })
    await f.step(1)
    assert.equal(reads, 0, 'The periodic deadline still applies before notification')
    f.notify(); await f.step(1)
    assert.ok(reads >= changeOnRead, 'Notifications process new evidence before the five-second scan')
    assert.equal(f.raw.schedulable, true)
    assert.equal(f.writes.length, 0, 'No obsolete disable reaches the scheduler')
    assert.equal(Boolean(f.current().automation.accounts[1].pausedBySystem), false, 'An unsent pause must not become system ownership')
    assert.equal(f.current().automation.accounts[1].pending, undefined)
    await f.step(1)
    assert.equal(f.view().accounts[0].state, 'healthy', 'The dirty plan is immediately recomputed')
    assert.equal(f.current().automation.error, null)
  }
})

test('probe history uses completion time for recent success and preserves old timestamp-only records', () => {
  const start = '2026-09-19T00:00:00.000Z', end = '2026-09-19T00:00:40.000Z'
  assert.equal(summarizeProbeHistory([{ at: start, completedAt: end, status: 'ok' }, { at: end, status: 'error' }]).lastSuccessAt, end)
  assert.equal(summarizeProbeHistory([{ at: start, status: 'ok' }]).lastSuccessAt, start)
})

test('observation only retains exact previously allowed models with actual successes', async () => {
  const f = fixture({ history: true })
  f.results('ok', 'ok'); await f.step(60000)
  f.results('error', 'error', { reason: 'timeout' })
  f.channel.probeTokens[0].probeModels[1].reason = 'authentication'
  f.channel.probeTokens[0].probeModels.push({ id: 'new', protocol: 'chat', status: 'error', reason: 'timeout',
    lastProbeAt: new Date(f.clock()).toISOString(), probeHistorySummary: { lastSuccessAt: new Date(f.clock()).toISOString() } })
  await f.step(5000)
  assert.equal(f.raw.schedulable, true)
  assert.deepEqual(f.raw.credentials.model_mapping, { good: 'good' }, 'No new models, failed auth peers or unverified models')
  assert.deepEqual(f.view().accounts[0].retainedModels, ['good'])
  const unverified = fixture()
  unverified.results('error', 'error', { reason: 'timeout' }); await unverified.step(5000)
  assert.equal(unverified.raw.schedulable, false)
  const wildcard = fixture({ history: true, mapping: { '*': 'good' } })
  wildcard.results('ok', 'ok')
  wildcard.results('error', 'error', { reason: 'timeout' }); await wildcard.step(5000)
  assert.equal(wildcard.raw.schedulable, false)
  assert.deepEqual(wildcard.view().accounts[0].retainedModels, [])
})

test('hard blockers and explicit model rejection override recent successes', async () => {
  const blocks = [
    f => { f.channel.balance.amount = 0 },
    f => { f.channel.probeTokens[0].probeEnabled = false },
    f => { f.channel.probeTokens[0].status = 'inactive' },
    f => { f.channel.probeTokens[0].status = 'quota_exhausted' },
    f => { f.channel.probeTokens[0].expiresAt = new Date(f.clock() - 1).toISOString() },
    f => { f.channel.probeTokens[0].probeModels.forEach(model => { model.autoPaused = true }) },
    ...['authentication', 'permission', 'quota', 'request_invalid', 'model_unsupported'].map(reason => f => f.results('error', 'error', { reason })),
  ]
  for (const block of blocks) {
    const f = fixture({ history: true })
    f.results('ok', 'ok'); await f.step(60000)
    f.results('error', 'error', { reason: 'timeout' }); block(f); await f.step(5000)
    assert.equal(f.raw.schedulable, false)
    assert.deepEqual(f.view().accounts[0].retainedModels, [])
  }
  const passthrough = fixture({ history: true, passthrough: true })
  passthrough.results('ok', 'ok'); await passthrough.step(60000)
  passthrough.results('error', 'error', { reason: 'timeout' }); await passthrough.step(5000)
  assert.equal(passthrough.raw.schedulable, false)
})

test('observation never reopens a stopped account and recovery still needs two successful rounds', async () => {
  const manual = fixture({ history: true, schedulable: false })
  manual.results('ok', 'ok'); manual.results('error', 'error', { reason: 'timeout' }); await manual.step(5000)
  assert.equal(manual.view().accounts[0].state, 'cooldown')
  assert.equal(manual.writes.length, 0)
  const f = fixture({ history: true })
  f.results('ok', 'ok'); await f.step(5000)
  f.results('error', 'error', { reason: 'authentication' }); await f.step(5000)
  assert.equal(f.raw.schedulable, false)
  f.results('error', 'error', { reason: 'timeout' }); await f.step(5000)
  assert.equal(f.raw.schedulable, false)
  assert.deepEqual(f.view().accounts[0].retainedModels, [])
  f.results('ok', 'error', { streak: 1, reason: 'timeout' }); await f.step(5000)
  assert.equal(f.raw.schedulable, false)
  f.results('ok', 'error', { reason: 'timeout' }); await f.step(60000)
  assert.equal(f.raw.schedulable, true)
  assert.deepEqual(f.raw.credentials.model_mapping, { good: 'good' })
})

test('automatic model filtering, immediate isolation and quota recovery only reopen system-owned accounts after two good rounds', async () => {
  const f = fixture()
  f.results('ok', 'ok'); await f.step()
  assert.equal(f.writes.length, 0)
  f.results('ok', 'error', { reason: 'model_unsupported' }); await f.step(5000)
  assert.deepEqual(f.raw.credentials.model_mapping, { good: 'good' })
  assert.equal(f.raw.credentials.api_key, 'private-key')
  assert.equal(f.raw.credentials.custom, 'retain-me')
  assert.equal(f.raw.schedulable, true)
  f.results('error', 'error', { reason: 'quota' }); await f.step(5000)
  assert.equal(f.raw.schedulable, false)
  assert.equal(f.view().accounts[0].pausedBySystem, true)
  assert.deepEqual(f.raw.credentials.model_mapping, { good: 'good' }, 'Never write an empty allowlist')
  f.raw.status = 'error'; f.raw.error_message = 'insufficient balance'
  f.raw.temp_unschedulable_until = new Date(f.clock() + 3600000).toISOString()
  f.channel.balance.amount = 0
  f.results('ok', 'ok'); await f.step()
  assert.equal(f.raw.schedulable, false, 'A zero balance blocks recovery even if older models passed')
  f.channel.balance.amount = 10
  f.results('ok', 'ok', { streak: 1 }); await f.step(5000)
  assert.equal(f.raw.schedulable, false)
  f.results('ok', 'ok', { streak: 2 }); await f.step(60000)
  assert.equal(f.raw.status, 'active')
  assert.equal(f.raw.schedulable, true)
  assert.equal(f.raw.temp_unschedulable_until, null)
  assert.deepEqual(f.raw.credentials.model_mapping, { good: 'good', bad: 'bad' })
  assert.equal(f.view().accounts[0].pausedBySystem, false)
  assert.ok(!JSON.stringify(f.view()).includes('private'))
})

test('stopped and inactive accounts automatically recover after two fresh successes, including across restart', async () => {
  for (const status of ['active', 'inactive', 'error']) {
    const f = fixture({ schedulable: false }); f.raw.status = status
    await f.step(); await f.step(5000); f.results('ok', 'ok'); await f.step()
    assert.equal(f.raw.schedulable, false)
    assert.equal(f.view().accounts[0].managed, true)
    f.restart(); f.results('ok', 'ok'); await f.step()
    assert.equal(f.raw.schedulable, true)
    assert.equal(f.raw.status, 'active')
    f.raw.credentials.model_mapping = { custom: 'good' }
    f.results('ok', 'error', { reason: 'model_unsupported' }); await f.step()
    assert.equal(f.view().accounts[0].managed, true)
    assert.deepEqual(f.raw.credentials.model_mapping, { good: 'good' })
  }
})

test('credential or target changes block writes and automatically resume checking when the original source returns', async () => {
  for (const change of ['key', 'group']) {
    const f = fixture(); f.results('ok', 'ok'); await f.step()
    const writes = f.writes.length
    if (change === 'key') f.raw.credentials.api_key = 'changed-key'
    else f.raw.group_ids = [99]
    f.results('ok', 'ok'); await f.step()
    assert.equal(f.writes.length, writes)
    assert.equal(f.view().routes[0].state, 'error')
    assert.equal(f.view().accounts[0].managed, true)
    f.raw.credentials.api_key = 'private-key'; f.raw.group_ids = [1]
    f.results('ok', 'ok'); await f.step()
    assert.equal(f.view().routes[0].state, 'healthy')
  }
})

test('remote re-enabling a failing account never opts it out of automatic isolation', async () => {
  const f = fixture(); f.results('ok', 'ok'); await f.step()
  f.results('error', 'error', { reason: 'authentication' }); await f.step()
  assert.equal(f.raw.schedulable, false)
  f.raw.schedulable = true
  f.results('error', 'error', { reason: 'authentication' }); await f.step()
  assert.equal(f.raw.schedulable, false)
  assert.equal(f.view().accounts[0].managed, true)
  assert.equal(f.view().accounts[0].state, 'cooldown')
})

test('managed route names follow recharge and group rates, survive uncertain writes and leave credentials intact', async () => {
  const f = fixture()
  f.results('ok', 'ok'); await f.step()
  f.channel.rechargeRate = 10
  f.timeout(); await f.step(5000)
  assert.equal(f.raw.name, 'upstream · 0.01×')
  assert.equal(f.current().automation.accounts[1].pending.action, 'name')
  f.restart(); f.results('ok', 'ok'); await f.step(60000)
  assert.equal(f.current().automation.accounts[1].pending, null)
  assert.equal(f.writes.filter(write => write.body?.name).length, 1)
  f.channel.userGroups.groups[0].rate = 0.6
  await f.step(5000)
  assert.equal(f.raw.name, 'upstream · 0.06×')
  assert.equal(f.current().accounts[0].name, f.raw.name)
  assert.equal(f.view().routes[0].tokenName, f.raw.name)
  assert.ok(f.writes.every(write => write.method === 'PUT' && Object.keys(write.body).join() === 'name'))
  assert.equal(f.raw.credentials.api_key, 'private-key')
  assert.deepEqual(f.raw.credentials.model_mapping, { good: 'good', bad: 'bad' })
  assert.equal(f.raw.schedulable, true)
})

test('one model failing auth, quota or other checks only removes that model, and successful revalidation restores it', async () => {
  for (const reason of ['authentication', 'quota', 'permission', 'rate_limit', 'timeout', 'model_unsupported']) {
    const f = fixture()
    f.results('ok', 'ok'); await f.step()
    f.results('ok', 'error', { reason }); await f.step(5000)
    assert.equal(f.raw.schedulable, true, reason)
    assert.equal(f.view().accounts[0].state, 'healthy', reason)
    assert.deepEqual(f.raw.credentials.model_mapping, { good: 'good' }, reason)
    assert.equal(f.writes.some(write => write.path.endsWith('/schedulable')), false, reason)
    assert.match(f.view().accounts[0].reason, /已隔离 1 个异常模型/)
    f.results('ok', 'ok'); await f.step(5000)
    assert.deepEqual(f.raw.credentials.model_mapping, { good: 'good', bad: 'bad' })
    assert.equal(f.raw.credentials.api_key, 'private-key')
  }
})

test('system-paused lines recover with two good rounds of one model even while another keeps failing auth or quota', async () => {
  for (const reason of ['authentication', 'quota']) {
    const f = fixture()
    f.results('ok', 'ok'); await f.step()
    f.results('error', 'error', { reason }); await f.step(5000)
    assert.equal(f.raw.schedulable, false)
    assert.deepEqual(f.raw.credentials.model_mapping, { good: 'good', bad: 'bad' }, 'Empty mapping must never allow all models')
    await f.step(5000)
    f.results('ok', 'error', { reason, streak: 1 }); await f.step(60000)
    assert.equal(f.raw.schedulable, false)
    assert.equal(f.view().accounts[0].state, 'recovering')
    f.results('ok', 'error', { reason }); await f.step(60000)
    assert.equal(f.raw.schedulable, true)
    assert.deepEqual(f.raw.credentials.model_mapping, { good: 'good' })
  }
})

test('confirmed account or token limits override healthy models; expired results cannot keep a line active', async () => {
  for (const block of [f => { f.channel.balance.amount = 0 },
    f => { f.channel.probeTokens[0].status = 'quota_exhausted' },
    f => { f.channel.probeTokens[0].status = 'inactive' },
    f => { f.channel.probeTokens[0].expiresAt = new Date(f.clock() - 1).toISOString() }]) {
    const f = fixture()
    f.results('ok', 'ok'); await f.step()
    block(f); await f.step(5000)
    assert.equal(f.raw.schedulable, false)
  }
  const stale = fixture()
  stale.results('ok', 'error', { reason: 'authentication' }); await stale.step(5000)
  assert.equal(stale.raw.schedulable, true)
  // A healthy model for a different scheduler platform cannot rescue this route.
  stale.channel.probeTokens[0].probeModels.push({ id: 'claude', protocol: 'messages', status: 'ok', lastProbeAt: new Date(stale.clock() + 120000).toISOString() })
  await stale.step(120001)
  assert.equal(stale.raw.schedulable, false)
  assert.match(stale.view().accounts[0].reason, /没有近两分钟内验证通过/)
})

test('catalog failure alone does not override fresh successful probes; missing fresh evidence stops the line', async () => {
  const f = fixture()
  f.results('ok', 'ok'); await f.step()
  f.channel.probeTokens[0].modelsError = '模型列表访问失败'
  f.channel.probeTokens[0].modelsErrorReason = 'authentication'
  f.results('ok', 'error', { reason: 'quota' }); await f.step(5000)
  assert.equal(f.raw.schedulable, true)
  assert.deepEqual(f.raw.credentials.model_mapping, { good: 'good' })
  await f.step(120001)
  assert.equal(f.raw.schedulable, false)
  assert.match(f.view().accounts[0].reason, /模型列表读取失败且已无近期验证通过/)
})

test('scheduler error is cleared after two good rounds without closing a line for one failed model', async () => {
  const f = fixture()
  f.results('ok', 'ok'); await f.step()
  f.raw.status = 'error'; f.raw.error_message = 'authentication_error from one model'
  f.results('ok', 'error', { reason: 'authentication' }); await f.step(5000)
  assert.equal(f.raw.schedulable, true)
  assert.equal(f.view().accounts[0].state, 'recovering')
  assert.deepEqual(f.raw.credentials.model_mapping, { good: 'good' })
  await f.step(5000)
  f.results('ok', 'error', { reason: 'authentication', streak: 1 }); await f.step(60000)
  assert.equal(f.raw.status, 'error')
  f.results('ok', 'error', { reason: 'authentication' }); await f.step(60000)
  assert.equal(f.raw.status, 'active')
  assert.equal(f.raw.schedulable, true)
  assert.equal(f.writes.some(write => write.path.endsWith('/schedulable')), false)
})

test('external cooldown is preserved, and an unknown balance cannot count as a successful recharge', async () => {
  const external = fixture()
  external.results('ok', 'ok'); await external.step()
  external.raw.temp_unschedulable_until = new Date(external.clock() + 3600000).toISOString()
  external.raw.temp_unschedulable_reason = 'insufficient quota'
  external.results('ok', 'error', { reason: 'quota' }); await external.step(5000)
  assert.equal(external.raw.schedulable, true)
  assert.equal(external.view().accounts[0].state, 'cooldown')
  assert.ok(!external.writes.some(write => write.path.endsWith('/temp-unschedulable') || write.path.endsWith('/schedulable')))

  const f = fixture()
  f.results('ok', 'ok'); await f.step()
  f.channel.balance.amount = 0; await f.step(5000)
  assert.equal(f.raw.schedulable, false)
  f.raw.temp_unschedulable_until = new Date(f.clock() + 3600000).toISOString()
  f.raw.temp_unschedulable_reason = 'insufficient balance'
  f.channel.balance = { status: 'error', amount: null }
  await f.step(5000)
  f.results('ok', 'error', { reason: 'quota', streak: 1 }); await f.step()
  f.results('ok', 'error', { reason: 'quota' }); await f.step()
  assert.equal(f.raw.schedulable, false)
  assert.ok(f.raw.temp_unschedulable_until)
  f.channel.balance = { status: 'ok', amount: 10 }; await f.step(5000)
  assert.equal(f.raw.schedulable, true)
  assert.equal(f.raw.temp_unschedulable_until, null)
})

test('uncertain writes survive restart and verify actual state before recovery', async () => {
  const f = fixture()
  f.results('ok', 'ok'); await f.step(); f.results('error', 'error'); f.timeout(); await f.step(5000)
  assert.equal(f.raw.schedulable, false)
  assert.ok(f.current().automation.accounts[1].pending)
  f.restart(); await f.step()
  assert.equal(f.raw.schedulable, false)
  assert.equal(f.current().automation.accounts[1].pending, null)
  f.results('ok', 'ok', { streak: 1 }); await f.step(5000)
  assert.equal(f.raw.schedulable, false)
  f.results('ok', 'ok'); await f.step()
  assert.equal(f.raw.schedulable, true)
})

test('storage reservation failure prevents remote writes; imports stay private and stop with automation', async () => {
  const f = fixture()
  f.results('ok', 'ok'); await f.step(); f.failSave(true); f.results('error', 'error'); await f.step(5000)
  assert.equal(f.writes.length, 0)
  const direct = fixture({ matching: false })
  await direct.step()
  assert.equal(direct.channels.size, 0, 'Scheduler-only accounts never become probe sources')
  assert.equal(direct.writes.length, 0)
  direct.configure({ enabled: false })
  assert.equal(direct.raw.schedulable, true)
})

test('passthrough failures pause the whole route without changing passthrough behavior, and foreign cooldowns are preserved', async () => {
  const f = fixture({ passthrough: true })
  f.results('ok', 'ok'); await f.step(); f.results('ok', 'error'); await f.step(5000)
  assert.equal(f.raw.schedulable, false)
  assert.ok(!f.writes.some(write => write.method === 'PUT'))
  f.raw.temp_unschedulable_until = new Date(f.clock() + 3600000).toISOString()
  f.raw.temp_unschedulable_reason = 'rate limit'
  f.results('ok', 'ok'); await f.step()
  assert.equal(f.raw.schedulable, false)
  assert.ok(f.raw.temp_unschedulable_until)
})

test('push creates from a healthy local token, deduplicates, and never imports scheduler-only accounts', async () => {
  const f = fixture()
  f.results('ok', 'ok')
  const site = f.current(); site.accounts = []
  f.channels.set('duplicate', { ...structuredClone(f.channel), id: 'duplicate' })
  const writes = [], remote = new Map()
  let clock = f.clock()
  const request = async (_site, path, body, method = body ? 'POST' : 'GET') => {
    if (path === '/api/v1/admin/accounts' && method === 'POST') {
      writes.push(structuredClone(body))
      assert.equal(body.credentials.api_key, 'private-key')
      assert.equal(body.concurrency, 1000)
      assert.equal(body.priority, 1)
      assert.equal(body.name, 'upstream · 0.1×')
      assert.match(body.notes, /^Signal 探测站推送 [a-f0-9]{24}$/)
      assert.deepEqual(body.credentials.model_mapping, { good: 'good', bad: 'bad' })
      const raw = { ...body, id: 2, status: 'active', schedulable: true }
      remote.set(2, raw); return { id: 2 }
    }
    const raw = remote.get(2)
    if (path.includes('/data?')) return { accounts: [structuredClone(raw)] }
    const safe = structuredClone(raw); delete safe.credentials.api_key; return safe
  }
  const api = createRouteAutomation({ sites: f.sites, busy: new Set(), channels: f.channels, channelStore: { saveChannels() {} },
    auth: { exclusive: (_id, fn) => fn() }, now: () => clock, request,
    save: value => f.sites.set(value.id, value), synchronize: async value => value })
  await api.runDue()
  assert.equal(writes.length, 1); assert.equal(f.current().accounts.length, 1)
  assert.equal(f.channels.size, 2, 'Both local source records are preserved')
  clock += 5000; await api.runDue()
  assert.equal(writes.length, 1, 'Repeated cycles do not create duplicates')
  assert.equal(f.current().automation.accounts[2].managed, true)
  assert.ok(!JSON.stringify(automationView(f.current(), f.channels, clock)).includes('private-key'))
})

test('failed, disabled, ambiguous and unprofitable local sources do not create accounts', async () => {
  const f = fixture(); f.current().accounts = []
  f.results('error', 'error'); await f.step(5000)
  assert.equal(f.writes.length, 0)
  f.results('ok', 'ok'); f.channel.probeTokens[0].probeEnabled = false; await f.step(5000)
  assert.equal(f.writes.length, 0)
  f.channel.probeTokens[0].probeEnabled = true
  f.current().groups.push({ ...f.current().groups[0], id: 2 })
  assert.match(pushRoutes(f.current(), f.channels, f.clock())[0].blockReason, /请选择/)
  f.current().groups.pop(); f.current().groups[0].rate = 0.1
  assert.equal(pushRoutes(f.current(), f.channels, f.clock())[0].blockReason, null, 'Equal multipliers qualify')
  f.current().groups[0].rate = 0.101
  assert.equal(pushRoutes(f.current(), f.channels, f.clock())[0].blockReason, null, 'No minimum percentage is required')
  f.current().groups[0].rate = 0.09
  assert.match(pushRoutes(f.current(), f.channels, f.clock())[0].blockReason, /实际成本.*高于/)
})

test('legacy reverse imports are archived on upgrade and cannot run, sources and history remain', async () => {
  const f = fixture(), imported = { id: 'legacy-import', provider: 'direct', routingSource: { siteId: 'site', accountId: 1 }, probeTokens: [{ probeEnabled: true, probeModels: [{ id: 'old', probeHistory: [{ status: 'ok' }] }] }] }
  f.channels.set(imported.id, imported)
  delete f.current().automation.direction
  f.restart = undefined
  const api = createRouteAutomation({ sites: f.sites, busy: new Set(), channels: f.channels, channelStore: { saveChannels() {} }, auth: {},
    save: value => f.sites.set(value.id, value), now: () => f.clock(), request: () => assert.fail('No reverse requests'), synchronize: () => assert.fail('Disabled after upgrade') })
  assert.equal(imported.routingArchived, true); assert.equal(imported.probeTokens[0].probeEnabled, false)
  assert.equal(imported.probeTokens[0].probeModels[0].probeHistory.length, 1)
  assert.equal(f.channel.probeTokens[0].probeEnabled, true)
  assert.equal(f.current().automation.enabled, false)
  assert.equal(api.sourceEnabled(imported.routingSource), false)
  await api.runDue()
  assert.equal(pushRoutes(f.current(), f.channels, f.clock()).length, 1)
})

test('uncertain account creation is not repeated across retries or restart', async () => {
  const f = fixture(); f.current().accounts = []; f.results('ok', 'ok')
  let calls = 0, clock = f.clock()
  const create = () => createRouteAutomation({ sites: f.sites, busy: new Set(), channels: f.channels, channelStore: { saveChannels() {} }, auth: { exclusive: (_id, fn) => fn() }, now: () => clock,
    save: value => f.sites.set(value.id, value), synchronize: async value => value,
    request: async () => { calls++; throw Error('timeout') } })
  let api = create(); await api.runDue(); assert.equal(calls, 1)
  assert.ok(Object.values(f.current().automation.routes)[0].pendingCreate)
  api = create(); clock += 60000; await api.runDue(); assert.equal(calls, 1)
})

test('removing a local source pauses only its previously managed destination', async () => {
  const f = fixture(); f.results('ok', 'ok'); await f.step()
  assert.equal(f.raw.schedulable, true)
  f.channels.clear(); await f.step(5000)
  assert.equal(f.raw.schedulable, false)
  assert.match(f.view().accounts[0].reason, /已移除/)
})

test('HTTP integration pushes local credentials and healthy models without importing unrelated scheduler accounts', async t => {
  const { once } = await import('node:events')
  const { createServer } = await import('node:http')
  const { monitorAPI } = await import('./monitor-api.js')
  let clock = 60000, created = 0, savedChannels
  const remote = [{ id: 99, name: 'scheduler-only', type: 'apikey', platform: 'openai', status: 'active', schedulable: true, group_ids: [1], credentials: { base_url: 'https://foreign.test', api_key: 'foreign-key', model_mapping: {} } }]
  const scheduler = createServer(async (req, res) => {
    assert.equal(req.headers['x-api-key'], 'admin-private')
    res.setHeader('Content-Type', 'application/json')
    const url = new URL(req.url, 'http://localhost'), send = data => res.end(JSON.stringify({ code: 0, data }))
    if (url.pathname.endsWith('/groups')) return send({ page: 1, page_size: 100, total: 1, items: [{ id: 1, name: 'Codex Plus', platform: 'openai', status: 'active', rate_multiplier: 0.3 }] })
    if (req.method === 'GET' && url.pathname.endsWith('/accounts')) return send({ page: 1, page_size: 100, total: remote.length, items: remote })
    if (url.pathname.endsWith('/data')) return send({ accounts: [remote.find(account => account.id === Number(url.searchParams.get('ids')))] })
    if (req.method === 'POST' && url.pathname.endsWith('/accounts')) {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks)); created++
      assert.equal(body.credentials.api_key, 'local-private')
      assert.equal(body.concurrency, 1000)
      assert.equal(body.priority, 1)
      assert.deepEqual(body.credentials.model_mapping, { 'gpt-test': 'gpt-test' })
      remote.push({ ...body, id: 100, schedulable: true, status: 'active' }); return send(remote.at(-1))
    }
    const id = Number(url.pathname.split('/').at(-1)), account = structuredClone(remote.find(account => account.id === id))
    delete account.credentials.api_key; send(account)
  })
  scheduler.listen(0, '127.0.0.1'); await once(scheduler, 'listening')
  const source = { id: 'local', provider: 'sub2api', name: '本站上游', endpoint: 'https://local-upstream.test', balance: { status: 'ok', amount: 1 }, userGroups: { status: 'ok', groups: [{ id: 'g', rate: 0.1 }] },
    probeTokens: [{ id: 't', name: '本站令牌', groupId: 'g', groupName: 'Codex Plus', key: 'local-private', status: 'active', probeEnabled: true,
      probeModels: [{ id: 'gpt-test', protocol: 'chat', status: 'ok', lastProbeAt: new Date(clock).toISOString() }] }] }
  let sites = []
  const api = monitorAPI({ channelStore: { load: () => [source], save: rows => { savedChannels = rows } }, secondaryStore: { load: () => sites, save: rows => { sites = rows } }, now: () => clock })
  const server = createServer((req, res) => api(req, res, () => res.end()))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { await api.routing.stop(); await api.probes.stop(); server.close(); scheduler.close() })
  const base = `http://127.0.0.1:${server.address().port}`
  const post = async (path, body) => {
    const r = await fetch(base + path, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    assert.equal(r.status, 200); return r.json()
  }
  const { site } = await post('/api/secondary-sites', { name: '调度', endpoint: `http://127.0.0.1:${scheduler.address().port}`, token: 'admin-private' })
  await post(`/api/secondary-sites/${site.id}/automation`, { enabled: true })
  await api.routing.runDue()
  assert.equal(created, 1); assert.equal(savedChannels.length, 1)
  assert.equal(remote[0].name, 'scheduler-only'); assert.equal(remote[0].schedulable, true)
  const response = await fetch(base + '/api/secondary-sites').then(r => r.json())
  assert.equal(response.sites[0].automation.routes[0].upstreamName, '本站上游')
  assert.ok(!JSON.stringify(response).includes('local-private'))
  assert.ok(!JSON.stringify(response).includes('foreign-key'))
  clock += 5000; await api.routing.runDue(); assert.equal(created, 1)
})


test('routing logs separate confirmed writes, failed writes, model changes and target configuration without logging secrets', async () => {
  const f = fixture()
  f.results('ok', 'ok'); await f.step()
  const initial = f.entries.length
  await f.step(5000)
  assert.equal(f.entries.length, initial, 'Unchanged healthy cycles must not flood the log')
  f.results('ok', 'error'); await f.step(5000)
  const change = f.entries.find(entry => entry.action === '模型名单写入已确认')
  assert.deepEqual(change.details.modelsBefore, ['good', 'bad'])
  assert.deepEqual(change.details.modelsAfter, ['good'])
  assert.equal(change.channelId, 'channel'); assert.equal(change.tokenId, 'token')
  f.timeout(); f.results('error', 'error'); await f.step(5000)
  assert.ok(f.entries.some(entry => entry.action === '线路推送或核对失败' && entry.level === 'error'))
  assert.ok(!f.entries.some(entry => entry.action === '关闭调度已确认'), 'A timed-out write must not be logged as confirmed')
  f.restart(); f.results('error', 'error'); await f.step(60000)
  assert.ok(f.entries.some(entry => entry.action === '回读确认上次修改'))
  assert.throws(() => f.configure({ routeId: f.view().routes[0].id, enabled: false }), /统一自动管理/)
  f.configure({ routeId: f.view().routes[0].id, groupId: 1 })
  assert.ok(f.entries.some(entry => entry.action === '更新目标分组' && entry.actor === 'user'))
  assert.ok(!JSON.stringify(f.entries).includes('private-key'))
  assert.ok(!JSON.stringify(f.entries).includes('private-admin'))
})

test('upgrade removes legacy manual ownership and per-route stops without turning on disabled probes', async () => {
  for (const probing of [true, false]) {
    const f = fixture(); f.results('ok', 'ok'); await f.step(5000)
    const routeId = f.view().routes[0].id
    delete f.current().automation.management
    Object.assign(f.current().automation.accounts[1], { managed: false, state: 'manual', reason: 'old manual stop' })
    f.current().automation.routes[routeId].enabled = false
    f.channel.probeTokens[0].probeEnabled = probing
    f.raw.schedulable = false
    f.configure({ enabled: true }) // Persist the legacy snapshot before restart.
    f.restart()
    assert.equal(f.current().automation.management, 'automatic')
    assert.equal(f.current().automation.routes[routeId].enabled, undefined)
    assert.equal(f.view().accounts[0].managed, true)
    assert.notEqual(f.view().accounts[0].state, 'manual')
    assert.equal(f.channel.probeTokens[0].probeEnabled, probing)
    await f.step(5000); await f.step(5000)
    f.results('ok', 'ok'); await f.step(5000)
    assert.equal(f.raw.schedulable, false)
    f.results('ok', 'ok'); await f.step(5000)
    assert.equal(f.raw.schedulable, probing)
    assert.ok(f.entries.some(entry => entry.action === '统一自动管理'))
  }
})


test('a model verified via Responses clears stale forced Chat routing, with confirmed remote readback', async () => {
  const f = fixture()
  f.raw.extra.openai_responses_mode = 'force_chat_completions'
  f.raw.extra.keep = 'unchanged'
  f.channel.probeTokens[0].probeModels[0].protocol = 'responses'
  f.results('ok', 'error')
  await f.step(5000)
  assert.equal(f.raw.schedulable, true)
  assert.equal(f.raw.extra.openai_responses_mode, 'auto')
  assert.equal(f.raw.extra.keep, 'unchanged')
  assert.deepEqual(f.raw.credentials.model_mapping, { good: 'good' })
  assert.ok(f.entries.some(entry => entry.action === '接口协议修正已确认'))
  const writes = f.writes.filter(write => write.body?.extra)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].method, 'PUT')
  assert.equal(writes[0].body.credentials, undefined)
})

test('shadow and freeze skip scheduler writes until lifted', async () => {
  const f = fixture()
  f.configure({ shadow: true })
  f.results('ok', 'error', { reason: 'authentication' })
  await f.step(5000)
  assert.equal(f.writes.length, 0)
  assert.equal(f.view().accounts[0].state, 'shadow')
  f.configure({ shadow: false, freeze: true })
  await f.step(5000)
  assert.equal(f.writes.length, 0)
  assert.equal(f.view().accounts[0].state, 'frozen')
  f.configure({ freeze: false })
  await f.step(5000)
  assert.equal(f.raw.schedulable, true)
  assert.deepEqual(f.raw.credentials.model_mapping, { good: 'good' })
})

test('approval holds schedulable changes until the next round is approved', async () => {
  const f = fixture()
  f.results('ok', 'ok')
  await f.step(5000)
  f.writes.length = 0
  f.configure({ approve: true })
  f.results('error', 'error', { reason: 'authentication' })
  await f.step(5000)
  assert.equal(f.raw.schedulable, true)
  assert.equal(f.view().accounts[0].state, 'approval')
  f.configure({ approveOnce: true })
  await f.step(5000)
  assert.equal(f.raw.schedulable, false)
})

test('ownership gate does not modify accounts this station did not create', async () => {
  const f = fixture()
  f.configure({ ownedOnly: true })
  f.results('ok', 'error', { reason: 'authentication' })
  await f.step(5000)
  assert.equal(f.writes.length, 0)
  assert.equal(f.view().accounts[0].state, 'foreign')
})

test('manual hold is not cleared by healthy probes', async () => {
  const f = fixture()
  f.results('ok', 'ok')
  await f.step(5000)
  const routeId = f.view().routes[0].id
  f.configure({ routeId, hold: true })
  await f.step(5000)
  assert.equal(f.raw.schedulable, false)
  assert.equal(f.view().accounts[0].state, 'hold')
  f.results('ok', 'ok')
  await f.step(5000)
  assert.equal(f.raw.schedulable, false)
  f.configure({ routeId, hold: false })
  f.results('ok', 'ok')
  await f.step(5000)
  assert.equal(f.raw.schedulable, true)
})

test('speed rank assigns the lowest priority number to the only healthy route', async () => {
  const f = fixture()
  f.results('ok', 'ok')
  for (const model of f.channel.probeTokens[0].probeModels) model.latencyMs = 120
  f.configure({ rank: 'speed' })
  await f.step(5000)
  assert.equal(f.raw.priority, 101)
  assert.equal(f.writes.some(write => write.body?.priority === 101 && write.method === 'PUT'), true)
})
