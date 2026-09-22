import { createHash } from 'node:crypto'
import { accountConnection, connectionEndpoint } from './route-bindings.js'
import { SyncError, isRecord, upstream } from './upstream-client.js'
import { effectiveRouteCost, probeTokenPricing } from './user-groups.js'
import { usableAPIKey } from './user-api-keys.js'
import { isLowerRouteCost, isWithinRouteRate, routeFamilies, routeTier } from './route-discovery.js'
import { probeRouteName } from './route-name.js'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const stable = value => Array.isArray(value) ? value.map(stable) : isRecord(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value
const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b))
const transientReasons = new Set(['timeout', 'connection_error', 'upstream_unavailable', 'rate_limit'])
const failureLabels = { timeout: '探测超时', connection_error: '连接异常', upstream_unavailable: '上游暂时异常', rate_limit: '上游限流', authentication: '认证失败', permission: '无访问权限', quota: '模型额度不足', model_unsupported: '模型不支持', request_invalid: '探测参数被拒绝' }
const lastSuccessAt = model => {
  const observation = model.probeHistory?.findLast(item => item.status === 'ok')
  return model.status === 'ok' ? model.lastProbeAt : model.probeHistorySummary?.lastSuccessAt || observation?.completedAt || observation?.at
}
const fresh = (at, now) => Number.isFinite(Date.parse(at)) && Date.parse(at) <= now && now - Date.parse(at) <= 120000
const identity = account => hash([account.id, account.platform, account.type, accountConnection(account).endpoint,
  accountConnection(account).keyHash, [...(account.group_ids ?? [])].sort(), account.proxy_id ?? null,
  stable(Object.fromEntries(Object.entries(account.credentials ?? {}).filter(([key]) => key !== 'model_mapping'))), accountConnection(account).passthrough, account.extra?.openai_responses_mode])
const mappingOf = account => accountConnection(account).mapping
const cooling = (account, now) => ['temp_unschedulable_until', 'rate_limit_reset_at', 'overload_until'].some(key => Date.parse(account[key]) > now)
const quotaError = account => /insufficient|balance|quota|余额|额度|配额/i.test(`${account.error_message || ''} ${account.temp_unschedulable_reason || ''}`)
const unavailableBalance = channel => channel.balance?.status === 'ok' && Number.isFinite(channel.balance.amount) && channel.balance.amount <= 0
const activeModels = token => (token?.probeModels ?? []).filter(model => model.protocol !== 'unsupported')
const platformOf = model => model.protocol === 'messages' ? 'anthropic' : model.protocol === 'gemini' ? 'gemini' : /^grok/i.test(model.id) ? 'grok' : 'openai'
function missingModelReason(models, token, now) {
  const current = models.filter(model => fresh(model.lastProbeAt, now))
  if (!current.length) return token.modelsError ? '模型列表读取失败且已无近期验证通过的模型，暂停调度' : '此线路没有近两分钟内验证通过的模型，暂停调度'
  const failures = current.filter(model => model.status === 'error')
  const counts = new Map()
  for (const model of failures) { const label = failureLabels[model.reason] || model.reason || '其他错误'; counts.set(label, (counts.get(label) || 0) + 1) }
  return `本轮无当前通过的模型${failures.length ? `，${failures.length} 个失败（${[...counts].map(([label, count]) => `${label} ${count}`).join('、')}）` : '，响应结果待确认'}；没有可继续使用的近期成功模型，暂停调度`
}
const destinationIdentity = (channel, token, route) => hash([connectionEndpoint(channel?.endpoint), channel?.provider === 'newapi' ? token?.key?.replace(/^sk-/, '') : token?.key, route.accountPlatform, route.groupId, route.family])
const sourceIdentity = (channel, token) => hash([connectionEndpoint(channel.endpoint), token.key, token.groupId])
const matchesSource = (account, channel, token, platform) => typeof token.key === 'string' && account.type === 'apikey' && account.platform === platform &&
  account.connection?.endpoint === connectionEndpoint(channel.endpoint) && [token.key, ...(channel.provider === 'newapi' ? [token.key.replace(/^sk-/, ''), `sk-${token.key.replace(/^sk-/, '')}`] : [])]
    .some(key => account.connection?.keyHash === accountConnection({ credentials: { api_key: key } }).keyHash)

const groupFamilies = group => {
  const named = routeFamilies(group?.name)
  return named.length ? named : routeFamilies(group?.platform)
}
const modelFamily = (model, token) => {
  const named = routeFamilies(model.id)
  if (named.length === 1) return named[0]
  if (named.length > 1) return '未识别系列'
  const fallback = routeFamilies(token.groupName || token.name)
  return fallback.length === 1 ? fallback[0] : '未识别系列'
}
const modelsForRoute = (token, route) => activeModels(token).filter(model => platformOf(model) === route.platform && modelFamily(model, token) === route.family)
const nativePlatforms = { DeepSeek: 'deepseek', GLM: 'zhipu', Kimi: 'kimi', MiniMax: 'minimax' }
const compatibleGroup = (group, platform, family, models) => group.status === 'active' && !/image|视频|video|生图|绘图/i.test(group.name) &&
  (group.platform === platform || group.platform === 'composite' || group.platform === nativePlatforms[family] &&
    models.every(model => ['chat', 'messages', ...(family === 'GLM' ? [] : ['responses'])].includes(model.protocol)) && new Set(models.map(model => model.protocol)).size <= 1)
const routeRecord = route => ({ channelId: route.channelId, tokenId: route.tokenId, platform: route.platform, family: route.family, accountPlatform: route.accountPlatform })
// Match an account to a particular destination and model scope, not just its key.
function matchesTarget(account, channel, token, route) {
  if (!matchesSource(account, channel, token, route.accountPlatform ?? route.platform) || !route.groupId || account.groupIds.length !== 1 || account.groupIds[0] !== route.groupId) return false
  const mapping = account.connection?.mapping
  if (!mapping) return false
  const catalog = new Map(activeModels(token).map(model => [model.id, model]))
  const values = Object.values(mapping)
  // Empty/wildcard legacy mappings can only be adopted for a single-family source.
  if (!values.length || account.connection?.passthrough || Object.keys(mapping).some(name => name.includes('*'))) {
    return new Set(activeModels(token).filter(model => platformOf(model) === route.platform).map(model => modelFamily(model, token))).size === 1
  }
  return values.every(id => modelFamily(catalog.get(id) ?? { id }, token) === route.family)
}

// Preserve legacy route IDs and ownership while splitting additional families.
function routeScopes(site, channel, token) {
  const records = Object.entries(site.automation?.routes ?? {}).filter(([, record]) => record.channelId === channel.id && record.tokenId === String(token.id))
  const scopes = new Map()
  const add = (platform, family) => {
    const key = JSON.stringify([platform, family])
    if (!scopes.has(key)) scopes.set(key, { platform, family })
  }
  for (const model of activeModels(token)) add(platformOf(model), modelFamily(model, token))
  for (const [, record] of records) if (record.family) add(record.platform, record.family)
  for (const [id, record] of records.filter(([, record]) => !record.family)) {
    const families = [...scopes.values()].filter(scope => scope.platform === record.platform).map(scope => scope.family)
    const target = site.groups.find(group => group.id === record.groupId)
    const named = groupFamilies(target)
    const family = families.length === 1 ? families[0] : named.length === 1 ? named[0] : '未识别系列'
    add(record.platform, family)
    Object.assign(scopes.get(JSON.stringify([record.platform, family])), { legacyId: id, legacy: record })
  }
  if (!scopes.size) {
    const named = routeFamilies(token.groupName || token.name)
    add('openai', named.length === 1 ? named[0] : '未识别系列')
  }
  return [...scopes.values()].map(scope => {
    const stored = records.find(([, record]) => record.platform === scope.platform && record.family === scope.family)
    const id = stored?.[0] ?? scope.legacyId ?? hash([channel.id, String(token.id), scope.platform, scope.family]).slice(0, 24)
    return { ...scope, id, saved: stored?.[1] ?? scope.legacy ?? {} }
  })
}

// Probe eligibility and push destinations must use the same family, tier and saved selection.
function routeDestination(site, channel, token, scope, saved, models) {
  const groups = site.groups.filter(group => compatibleGroup(group, scope.platform, scope.family, models) &&
    (scope.family === '未识别系列' || groupFamilies(group).includes(scope.family)))
  const tier = routeTier(token.groupName || token.name || '', [scope.family])
  const candidates = scope.family === '未识别系列' ? [] : groups.filter(group => !tier || routeTier(group.name, [scope.family]) === tier)
  const accounts = saved.groupId == null ? (site.accounts ?? []).filter(account => groups.some(group => matchesTarget(account, channel, token,
    { ...scope, groupId: group.id, accountPlatform: group.platform === nativePlatforms[scope.family] ? group.platform : scope.platform }))) : []
  const groupId = saved.groupId ?? (accounts.length === 1 ? accounts[0].groupIds[0] : candidates.length === 1 ? candidates[0].id : null)
  return { groups, groupId, group: groups.find(group => group.id === groupId), candidates }
}

function routeCost(channel, token) {
  const pricing = probeTokenPricing(channel, token)
  return pricing.status === 'ok' ? effectiveRouteCost(channel, pricing) : null
}
const formatRate = value => `${Number(value.toPrecision(8))}×`
const costExceeds = (cost, targetRate) => isLowerRouteCost(targetRate, cost)
const costReason = (cost, targetRate) => `实际成本 ${formatRate(cost)} 高于调度分组 ${formatRate(targetRate)}`

// Return only confirmed cost blocks. A cheaper destination on another site keeps
// the shared model probe useful; missing/failed pricing is not proof of high cost.
export function probeCostBlocks(sites, channel, token) {
  const blocked = new Map(), cost = routeCost(channel, token)
  if (cost == null || channel.routingSource || channel.provider === 'direct') return blocked
  const scopes = new Map()
  for (const site of sites.values()) {
    if (site.automation?.direction !== 'push' || !site.automation.enabled) continue
    for (const scope of routeScopes(site, channel, token)) {
      const models = modelsForRoute(token, scope)
      if (!models.length) continue
      const { groupId, group, candidates } = routeDestination(site, channel, token, scope, scope.saved, models)
      const targets = groupId != null ? group ? [group] : [] : candidates
      if (!targets.length) continue
      const key = JSON.stringify([scope.platform, scope.family])
      if (!scopes.has(key)) scopes.set(key, { models, targets: [], uncertain: false })
      const state = scopes.get(key)
      if (site.error || targets.some(group => !Number.isFinite(group.rate) || group.rate < 0)) state.uncertain = true
      else state.targets.push(...targets.map(group => ({ siteId: site.id, siteName: site.name, groupId: group.id, groupName: group.name, rate: group.rate })))
    }
  }
  for (const { models, targets, uncertain } of scopes.values()) {
    if (uncertain || !targets.length || targets.some(group => !costExceeds(cost, group.rate))) continue
    const targetRate = Math.max(...targets.map(group => group.rate))
    const reason = `${costReason(cost, targetRate)}（${targets.map(group => `${group.siteName || group.siteId} / ${group.groupName}`).join('、')}），暂停探测，倍率恢复后自动继续。`
    for (const model of models) blocked.set(model.id, { cost, targetRate, reason, targets })
  }
  return blocked
}

// Only locally connected upstreams are sources. Scheduler groups define destinations.
export function pushRoutes(site, channels, now = Date.now()) {
  const routes = [...channels.values()].filter(channel => !channel.routingSource && channel.provider !== 'direct').flatMap(channel => (channel.probeTokens ?? []).flatMap(token => {
    return routeScopes(site, channel, token).map(({ id, platform, family, saved }) => {
      const scope = { id, platform, family }
      const models = modelsForRoute(token, scope)
      const availableModels = models.filter(model => model.status === 'ok' && !model.autoPaused && fresh(model.lastProbeAt, now)).map(model => model.id)
      const { groups, groupId, group: targetGroup } = routeDestination(site, channel, token, scope, saved, models)
      const selected = saved.accountId ? site.accounts?.find(account => account.id === saved.accountId) : null
      const accountPlatform = targetGroup ? targetGroup.platform === nativePlatforms[family] ? targetGroup.platform : platform : saved.accountPlatform ?? platform
      const matches = (site.accounts ?? []).filter(account => matchesTarget(account, channel, token, { ...scope, groupId, accountPlatform }))
      const account = saved.accountId ? selected : matches.length === 1 ? matches[0] : null
      const group = targetGroup, pricing = probeTokenPricing(channel, token), cost = routeCost(channel, token)
      const targetRate = group?.rate ?? null
      const costBlocked = !site.error && costExceeds(cost, targetRate)
      const scopeBlocked = !group ? groupId ? '目标分组已移除、停用或与模型系列 / 协议不兼容，请核对'
        : !groups.length ? `未匹配调度分组：${family}` : '请选择目标调度分组，存在多个候选或等级尚未匹配' : null
      let reason = null
      if (!token.probeEnabled) reason = '请先在探针监控启用此令牌'
      else if (!token.key || !usableAPIKey(token, now) || token.stale || channel.probeTokensUnavailable) reason = '等待令牌授权恢复'
      else if (unavailableBalance(channel)) reason = '上游余额不足，等待充值'
      else if (scopeBlocked) reason = scopeBlocked
      else if (!saved.accountId && matches.length > 1) reason = '同一目标分组匹配到多个调度账号，请人工核对'
      else if (costBlocked) reason = `${costReason(cost, targetRate)}，暂停推送与调度`
      else if (!account && (!Number.isFinite(cost) || !Number.isFinite(targetRate) || pricing.source === 'automatic')) reason = '倍率成本未确认，暂不新建调度线路'
      else if (!account && !isWithinRouteRate(cost, targetRate)) reason = '折算倍率高于调度站分组倍率，暂不新建调度线路'
      else if (!availableModels.length) reason = '等待此系列的模型探测成功'
      const managed = account && site.automation?.accounts?.[account.id]
      return { id, channelId: channel.id, tokenId: String(token.id), upstreamName: channel.name, tokenName: probeRouteName(channel, token), groupName: token.groupName,
        endpoint: channel.endpoint, platform, accountPlatform, family, groupId, targetGroupName: group?.name ?? null, accountId: account?.id ?? saved.accountId ?? null, enabled: true,
        sourceIdentity: sourceIdentity(channel, token), availableModels, excludedModels: models.filter(model => model.status === 'error' || model.autoPaused).map(model => model.id),
        modelCount: models.length, cost, targetRate, costBlocked, scopeBlocked, reason: saved.error || scopeBlocked || managed?.error || managed?.reason || reason, blockReason: reason,
        state: saved.error || managed?.error ? 'error' : scopeBlocked ? 'waiting' : managed?.state ?? (reason ? 'waiting' : 'ready'),
        pausedBySystem: Boolean(managed?.pausedBySystem), hold: Boolean(managed?.hold), retainedModels: managed?.retainedModels ?? [], groups: groups.map(group => ({ id: group.id, name: group.name })), pendingCreate: Boolean(saved.pendingCreate) }
    })
  }))
  return routes
}

function policyOf(automation = {}) {
  return {
    shadow: automation.shadow === true, freeze: automation.freeze === true, approve: automation.approve === true, ownedOnly: automation.ownedOnly === true,
    rank: automation.rank === 'price' || automation.rank === 'speed' ? automation.rank : 'keep',
  }
}
const approvalActions = new Set(['create', 'schedulable', 'priority'])
// ponytail: speeds within 50ms tie-break by account id. Sticky previous order if crossing bands starts flapping.
function rankPlanFor(site, routes, channels, now) {
  const rank = policyOf(site.automation).rank
  const plan = new Map()
  if (rank === 'keep') return plan
  const groups = new Map()
  for (const route of routes) {
    if (!route.accountId || route.blockReason || route.costBlocked) continue
    const key = String(route.groupId)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(route)
  }
  for (const list of groups.values()) {
    const rows = list.map(route => {
      const channel = channels.get(route.channelId)
      const token = channel?.probeTokens?.find(item => String(item.id) === route.tokenId)
      const samples = token ? modelsForRoute(token, route).filter(model => model.status === 'ok' && fresh(model.lastProbeAt, now) && Number.isFinite(model.latencyMs)).map(model => model.latencyMs).sort((a, b) => a - b) : []
      const speed = samples.length ? 0.6 * samples[Math.floor((samples.length - 1) * 0.5)] + 0.4 * samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.9) - 1)] : null
      const score = rank === 'price' ? (Number.isFinite(route.cost) ? route.cost : Number.POSITIVE_INFINITY) : (speed ?? Number.POSITIVE_INFINITY)
      return { route, score, speed }
    })
    rows.sort((a, b) => rank === 'speed' && Number.isFinite(a.score) && Number.isFinite(b.score) && Math.abs(a.score - b.score) < 50 ? a.route.accountId - b.route.accountId : a.score - b.score || a.route.accountId - b.route.accountId)
    rows.forEach((row, index) => plan.set(row.route.accountId, { priority: 101 + index, speedMs: row.speed ?? null }))
  }
  return plan
}

export function automationView(site, channels = new Map(), now = Date.now()) {
  const state = site.automation ?? {}
  const policy = policyOf(state)
  return { direction: 'push', enabled: state.direction === 'push' && state.enabled === true, lastRunAt: state.lastRunAt ?? null, error: state.error ?? null,
    ...policy,
    routes: pushRoutes(site, channels, now).map(({ sourceIdentity: _private, ...route }) => route),
    accounts: Object.entries(state.accounts ?? {}).map(([id, item]) => ({ accountId: Number(id), managed: item.managed,
      state: item.state, reason: item.reason, error: item.error ?? null, changedAt: item.changedAt ?? null,
      channelId: item.channelId, tokenId: item.tokenId, availableModels: item.availableModels ?? [],
      excludedModels: item.excludedModels ?? [], retainedModels: item.retainedModels ?? [], pausedBySystem: Boolean(item.pausedBySystem) })),
    events: (state.events ?? []).slice(-100).reverse() }
}

// Probe station owns the sources; scheduler reads only confirm push destinations.
export function createRouteAutomation({ sites, busy, save, synchronize, channels, channelStore, auth, now = Date.now, request = upstream, logs }) {
  let timer, updateTimer, stopped = false, writesApproved = false
  let rankPlan = new Map()
  const updatedSites = new Set(), planGuards = new Map()
  const tasks = new Map()
  function heldReason(site, action) {
    const policy = policyOf(site.automation)
    if (policy.freeze) return '紧急冻结，未写入调度站'
    if (policy.shadow) return '影子模式，未写入调度站'
    if (policy.approve && approvalActions.has(action) && !writesApproved) return '待审批，未写入调度站'
    return null
  }
  function refuseWrite(site, account, state, action, reason) {
    const policy = policyOf(site.automation)
    state.state = policy.freeze ? 'frozen' : policy.shadow ? 'shadow' : 'approval'
    state.reason = reason
    if (state.holdNote !== reason) { state.holdNote = reason; event(site, account, '跳过写入', `${reason}（${action}）`) }
    save(site)
    throw Object.assign(new SyncError(reason, 409), { held: true })
  }
  function persistChannels(records) {
    if (channelStore.saveChannels) channelStore.saveChannels(records)
    else channelStore.save([...channels.values()])
  }
  const archived = [...channels.values()].filter(channel => channel.routingSource && !channel.routingArchived)
  for (const channel of archived) { channel.routingArchived = true; for (const token of channel.probeTokens ?? []) token.probeEnabled = false }
  if (archived.length) persistChannels(archived)
  for (const site of sites.values()) if (site.automation && site.automation.direction !== 'push') {
    save({ ...site, automationLegacy: site.automation, automation: { direction: 'push', enabled: false, routes: {}, accounts: {}, events: [] } })
  }
  function context(site, account, route) {
    const state = route || site.automation?.accounts?.[account?.id] || {}
    return { category: 'routing', siteId: site.id, siteName: site.name, accountId: account?.id, accountName: account?.name,
      channelId: state.channelId, channelName: channels.get(state.channelId)?.name, tokenId: state.tokenId }
  }
  for (const site of sites.values()) logs?.importEvents(site)
  // Upgrade only scheduling ownership; probe switches and credentials stay intact.
  for (const site of sites.values()) if (site.automation?.direction === 'push' && site.automation.management !== 'automatic' &&
      (Object.values(site.automation.routes ?? {}).some(route => Object.hasOwn(route, 'enabled') || route.retake) ||
        Object.values(site.automation.accounts ?? {}).some(state => !state.managed || state.state === 'manual'))) {
    const updated = structuredClone(site)
    for (const route of Object.values(updated.automation.routes ?? {})) { delete route.enabled; delete route.retake; route.retryAt = null }
    for (const state of Object.values(updated.automation.accounts ?? {})) {
      if (!state.managed || state.state === 'manual') Object.assign(state, { managed: true, state: 'verifying', reason: '已转为自动管理，等待验证', pausedBySystem: false, recovery: {} })
      state.lastEvidence = null
    }
    updated.automation.management = 'automatic'; updated.automation.nextRunAt = null
    save(updated)
    logs?.record({ ...context(updated), action: '统一自动管理', message: '已移除历史线路接管开关，按探测、倍率和余额重新核对全部已关联线路' })
  }
  function event(site, account, action, reason, details) {
    const at = new Date(now()).toISOString()
    const logId = hash([site.id, account.id, at, action, reason])
    site.automation.events = [...(site.automation.events ?? []), { logId, at, accountId: account.id, name: account.name, action, reason }].slice(-100)
    logs?.record({ ...context(site, account), id: logId, at, action: action === '暂停调度' ? '决定暂停调度' : action,
      level: /暂停|错误|停用/.test(action) ? 'warning' : 'success', message: reason, details })
  }
  async function readFull(site, account) {
    const data = await request(site, `/api/v1/admin/accounts/data?ids=${account.id}&include_proxies=false`)
    const raw = data?.accounts?.[0]
    if (!Array.isArray(data?.accounts) || data.accounts.length !== 1 || !isRecord(raw) ||
      (raw.id != null && raw.id !== account.id) || raw.name?.trim() !== account.name?.trim() || raw.type !== account.type || raw.platform !== account.platform) {
      throw new SyncError('未取得此账号的完整配置，自动调度已跳过。', 502)
    }
    // Export omits ID and runtime fields. Read them from the exact account endpoint.
    const live = await request(site, `/api/v1/admin/accounts/${account.id}`)
    if (live.id !== account.id || live.name?.trim() !== raw.name?.trim() || !same(mappingOf(live), mappingOf(raw)) ||
      accountConnection(live).endpoint !== accountConnection(raw).endpoint) throw new SyncError('账号配置正在变化，稍后重新核对。', 409)
    return { ...raw, ...live, credentials: raw.credentials, extra: live.extra ?? raw.extra }
  }
  async function enroll(site, account, raw, route) {
    const channel = channels.get(route.channelId), token = channel?.probeTokens?.find(token => String(token.id) === route.tokenId)
    const sameSource = token && matchesSource({ ...account, type: raw.type, platform: raw.platform, connection: accountConnection(raw) }, channel, token, route.accountPlatform ?? route.platform)
    if (!sameSource || raw.group_ids?.length !== 1 || raw.group_ids[0] !== route.groupId) {
      const previous = site.automation.accounts[account.id]
      if (previous?.identity === identity(raw)) await pauseMissingSource(site, account, previous, '探测源与目标配置不一致，暂停旧目标并等待同步')
      throw new SyncError('调度账号与探测源的 URL / Key 或目标分组不一致，等待配置同步后自动重试。', 409)
    }
    let state = site.automation.accounts[account.id]
    if (!state) {
      const legacy = site.automationLegacy?.accounts?.[account.id]
      const owned = legacy?.channelId === channel.id && legacy.tokenId === route.tokenId && legacy.identity === identity(raw) && same(legacy.expectedMapping, mappingOf(raw))
      state = site.automation.accounts[account.id] = owned ? { ...legacy } : { originalMapping: mappingOf(raw), state: 'verifying' }
      Object.assign(state, { channelId: channel.id, tokenId: route.tokenId })
      event(site, account, '关联推送目标', '使用探测站已有令牌和结果自动管理此线路')
    }
    Object.assign(state, { managed: true, routeId: route.id, family: route.family, identity: identity(raw), sourceIdentity: sourceIdentity(channel, token),
      createdByUs: state.createdByUs === true || site.automation.routes[route.id]?.createdByUs === true || /Signal 探测站推送/.test(raw.notes || '') })
    if (!state.pending) { state.expectedMapping = mappingOf(raw); state.expectedSchedulable = raw.schedulable }
    save(site)
    if (!token.autoRecoverModels) await auth.exclusive(channel.id, async () => {
      token.autoRecoverModels = true; persistChannels([channel])
    })
  }
  function desiredMapping(token, route) {
    return Object.fromEntries(modelsForRoute(token, route).filter(model => model.status === 'ok' && !model.autoPaused && fresh(model.lastProbeAt, now()))
      .map(model => [model.id, model.id]))
  }
  async function pushRoute(site, route) {
    const channel = channels.get(route.channelId), token = channel?.probeTokens?.find(token => String(token.id) === route.tokenId)
    if (!channel || !token || auth.busy?.has(channel.id)) return
    const record = site.automation.routes[route.id] ??= routeRecord(route)
    if (Date.parse(record.retryAt) > now()) return
    record.family = route.family
    if (token.probeEnabled && !token.autoRecoverModels) await auth.exclusive(channel.id, async () => {
      token.autoRecoverModels = true; persistChannels([channel])
    })
    if (route.scopeBlocked) {
      const account = site.accounts.find(account => account.id === record.accountId)
      if (account) await pauseMissingSource(site, account, site.automation.accounts[account.id], route.scopeBlocked)
      return
    }
    let account = site.accounts.find(account => account.id === route.accountId)
    if (!account) {
      const existing = site.accounts.filter(account => matchesTarget(account, channel, token, route))
      if (existing.length === 1 && (!route.groupId || existing[0].groupIds.includes(route.groupId))) account = existing[0]
      else if (existing.length) throw new SyncError('此分组和模型系列已存在多个相同 URL / Key 的账号，请核对，暂不重复创建。', 409)
    }
    if (record.accountId && !account) throw new SyncError('推送目标已被移除，请人工核对；不会自动重复创建。', 409)
    if (!account && record.pendingCreate) {
      // A timeout may have committed remotely. Only an exact name + source match
      // can adopt it; absence never authorizes another automatic POST.
      const matches = site.accounts.filter(account => account.name === record.pendingCreate.name && matchesTarget(account, channel, token, route))
      if (matches.length !== 1) throw new SyncError('上次推送创建结果待核对，暂不重复创建。', 409)
      account = matches[0]
    }
    if (!account) {
      if (route.blockReason) return
      const mapping = desiredMapping(token, route)
      if (!Object.keys(mapping).length) return // Empty Sub2API mappings allow every model.
      const destination = destinationIdentity(channel, token, route)
      if (Object.values(site.automation.routes).some(other => other !== record && other.pendingCreate?.destination === destination)) throw new SyncError('同一目标分组和系列的创建结果待核对，暂不重复创建。', 409)
      const name = probeRouteName(channel, token)
      const native = Object.values(nativePlatforms).includes(route.accountPlatform)
      const protocol = modelsForRoute(token, route)[0]?.protocol
      record.pendingCreate = { name, destination, groupId: route.groupId, family: route.family, models: Object.keys(mapping), at: new Date(now()).toISOString(), sourceIdentity: sourceIdentity(channel, token) }
      save(site)
      const held = heldReason(site, 'create')
      if (held) { delete record.pendingCreate; record.error = held; save(site); throw Object.assign(new SyncError(held, 409), { held: true }) }
      let result
      try {
        planGuards.get(site.id)?.()
        result = await request(site, '/api/v1/admin/accounts', { name, notes: `Signal 探测站推送 ${route.id}`, platform: route.accountPlatform, type: 'apikey',
          credentials: { ...(native ? { account_mode: 'payg', api_protocol: { chat: 'chat_completions', messages: 'anthropic', responses: 'responses' }[protocol] } : {}),
            base_url: connectionEndpoint(channel.endpoint) + (native ? '/v1' : ''), api_key: token.key, model_mapping: mapping },
          extra: { openai_passthrough: false, openai_oauth_passthrough: false,
            ...(route.accountPlatform === 'openai' && modelsForRoute(token, route).every(model => model.protocol === 'chat') ? { openai_responses_mode: 'force_chat_completions' } : {}) }, group_ids: [route.groupId], concurrency: 1000, priority: policyOf(site.automation).rank === 'keep' ? 1 : 101 }, 'POST')
      } catch (error) {
        if (error.upstreamRejected || error.probeChanged) { delete record.pendingCreate; save(site) }
        throw error
      }
      if (!Number.isSafeInteger(result?.id) || result.id <= 0) throw new SyncError('推送已提交，返回账号 ID 不完整，等待回读确认。', 502)
      const raw = await readFull(site, { id: result.id, name, type: 'apikey', platform: route.accountPlatform })
      account = { id: raw.id, name: raw.name, type: raw.type, platform: raw.platform, status: raw.status, schedulable: raw.schedulable,
        groupIds: raw.group_ids ?? [], connection: accountConnection(raw) }
      if (!matchesSource(account, channel, token, route.accountPlatform ?? route.platform) || !account.groupIds.includes(route.groupId)) throw new SyncError('推送后的账号配置不一致，请核对。', 502)
      site.accounts.push(account)
      record.createdByUs = true
      event(site, account, '推送新线路', `由探测站推送 ${Object.keys(mapping).length} 个已验证模型；所有符合条件的线路共同调度`)
    }
    record.accountId = account.id; record.groupId ??= route.groupId; record.pendingCreate = null; record.error = null
    route.accountId = account.id
    save(site)
    const owned = site.automation.accounts[account.id]
    if (owned && (owned.channelId !== channel.id || owned.tokenId !== route.tokenId || owned.routeId && owned.routeId !== route.id)) throw new SyncError('相同 URL / Key 已由另一条本站令牌管理，请合并重复来源。', 409)
    await reconcile(site, account, route)
  }
  async function pauseMissingSource(site, account, state, reason = '探测站已移除此来源，暂停调度') {
    if (!state?.managed) return
    const raw = await readFull(site, account)
    if (state.identity !== identity(raw)) {
      state.state = 'error'; state.reason = '目标凭据或分组已变化，等待核对来源后自动重试'; state.lastEvidence = null; save(site); return
    }
    state.expectedMapping = mappingOf(raw); state.expectedSchedulable = raw.schedulable
    state.pausedBySystem = true; state.state = 'cooldown'; state.reason = reason
    state.pausedAt ||= new Date(now()).toISOString(); state.recovery = {}; save(site)
    if (raw.schedulable) { await write(site, account, state, raw, 'schedulable', { schedulable: false }); event(site, account, '暂停调度', reason) }
  }
  async function write(site, account, state, raw, action, body, method = 'POST') {
    if (stopped) throw new SyncError('服务正在停止，本次调度修改已取消。', 409)
    const current = await readFull(site, account)
    if (identity(current) !== identity(raw) || !same(mappingOf(current), mappingOf(raw)) || current.schedulable !== raw.schedulable || current.status !== raw.status) {
      state.state = 'verifying'; state.lastEvidence = null; state.reason = '写入前账号配置已变化，稍后重新核对'
      save(site); throw new SyncError(state.reason, 409)
    }
    const held = heldReason(site, action)
    if (held) refuseWrite(site, account, state, action, held)
    try { planGuards.get(site.id)?.() }
    catch (error) {
      // If no disable was sent, discard the reserved pause decision instead of
      // presenting the newly successful route as cooling down.
      if (error.probeChanged && action === 'schedulable' && body.schedulable === false && !state.pending &&
          current.schedulable === true && state.expectedSchedulable === true) {
        state.pausedBySystem = false; state.pauseReason = null; state.state = 'verifying'; state.lastEvidence = null
        save(site)
      }
      throw error
    }
    if (action === 'models') {
      // Send the current non-secret credential fields. Sub2API preserves omitted
      // secrets, avoiding overwriting a concurrently rotated API key.
      const sensitive = new Set(['api_key','access_token','refresh_token','id_token','agent_private_key','session_key','cookie','password','sso_token','sso','sso-rw','clearTextPassword','aws_secret_access_key','aws_session_token','service_account_json','service_account','private_key'])
      body = { credentials: Object.fromEntries(Object.entries(body.credentials).filter(([key]) => !sensitive.has(key))) }
    }
    // Reserve intent durably before remote writes. A restart reconciles actual
    // state; a timed-out write is never interpreted as a confirmed success.
    state.pending = { action, body: action === 'models' ? { mapping: body.credentials.model_mapping } : body, at: new Date(now()).toISOString() }
    save(site)
    let result
    if (['models', 'name', 'status', 'protocol', 'priority'].includes(action)) result = await request(site, `/api/v1/admin/accounts/${account.id}`, body, 'PUT')
    else result = await request(site, `/api/v1/admin/accounts/${account.id}/${action}`, body, method)
    const modelsBefore = Object.keys(mappingOf(raw) ?? {})
    const nameBefore = raw.name
    const actual = await request(site, `/api/v1/admin/accounts/${account.id}`)
    if (actual.id !== account.id) throw new SyncError('调度站点写入后的账号校验失败。', 502)
    if (action === 'protocol' && actual.extra?.openai_responses_mode !== body.extra.openai_responses_mode || action === 'status' && actual.status !== body.status || action === 'name' && actual.name !== body.name || action === 'models' && !same(mappingOf(actual), body.credentials.model_mapping) || action === 'schedulable' && actual.schedulable !== body.schedulable || action === 'priority' && actual.priority !== body.priority ||
      action === 'clear-error' && actual.status !== 'active' || action === 'temp-unschedulable' && Date.parse(actual.temp_unschedulable_until) > now()) throw new SyncError('调度站点尚未确认修改，稍后核对。', 502)
    if (action === 'models') state.expectedMapping = body.credentials.model_mapping
    if (action === 'schedulable') state.expectedSchedulable = body.schedulable
    state.pending = null; state.changedAt = new Date(now()).toISOString()
    Object.assign(raw, actual, { credentials: { ...raw.credentials, ...actual.credentials } })
    account.name = actual.name; account.status = actual.status; account.schedulable = actual.schedulable
    account.connection = accountConnection(raw)
    save(site)
    logs?.record({ ...context(site, account), level: 'success',
      action: ({ protocol: '接口协议修正已确认', status: '恢复账号状态已确认', models: '模型名单写入已确认', name: '线路改名已确认', schedulable: body?.schedulable ? '开启调度已确认' : '关闭调度已确认', 'clear-error': '清除账号错误已确认', 'temp-unschedulable': '解除余额冷却已确认', priority: '调度优先级已确认' })[action],
      message: `调度站点已回读确认：${account.name}`,
      details: action === 'models' ? { modelsBefore, modelsAfter: Object.keys(state.expectedMapping ?? {}) } : action === 'name' ? { before: nameBefore, after: account.name } : { enabled: account.schedulable } })
    return result
  }
  async function reconcile(site, account, route) {
    if (account.type !== 'apikey') return
    const previous = site.automation.accounts[account.id]
    const previousChannel = channels.get(previous?.channelId)
    if (previousChannel && auth.busy?.has(previousChannel.id)) return
    const previousToken = previousChannel?.probeTokens?.find(token => String(token.id) === previous?.tokenId)
    const evidence = hash([route.family, route.groupId, route.cost, route.targetRate, route.costBlocked, site.accountsSyncedAt, previousChannel?.balance, previousChannel?.probeTokensUnavailable,
      previousChannel?.name, previousChannel?.rechargeRate, previousChannel?.userGroups,
      previousToken?.probeEnabled, previousToken?.modelsError, previousToken?.status, previousToken?.expiresAt, previousToken?.stale, Boolean(previousToken?.key),
      previousToken?.probeModels?.map(model => [model.id, model.lastProbeAt, model.status, model.autoPaused, model.reason, fresh(model.lastProbeAt, now()), lastSuccessAt(model), fresh(lastSuccessAt(model), now())])])
    const plannedPriority = rankPlan.get(account.id)?.priority
    if (previous?.lastEvidence === evidence && !previous.pending && (plannedPriority == null || previous.priority === plannedPriority)) return
    if (Date.parse(previous?.retryAt) > now()) return
    const raw = await readFull(site, account)
    if (stopped) return
    await enroll(site, account, raw, route)
    planGuards.get(site.id)?.()
    const state = site.automation.accounts[account.id]
    state.lastEvidence = evidence
    state.error = null
    if (!state.channelId) return
    if (policyOf(site.automation).ownedOnly && state.createdByUs !== true) {
      state.managed = false; state.state = 'foreign'; state.reason = '非本站创建的账号，所有权闸门已阻止写入'; save(site); return
    }
    if (state.hold) {
      state.pausedBySystem = true; state.pauseReason = 'hold'; state.pausedAt ||= new Date(now()).toISOString()
      if (raw.schedulable) await write(site, account, state, raw, 'schedulable', { schedulable: false })
      state.state = 'hold'; state.reason = '人工暂停，后台不会自动恢复'; save(site); return
    }
    const channel = channels.get(state.channelId), token = channel?.probeTokens?.find(token => String(token.id) === state.tokenId)
    if (!channel || !token) { state.state = 'waiting'; state.reason = '探针令牌已移除，等待重新接入'; return }
    // Reconcile uncertain writes using a fresh remote read before any new action.
    if (state.pending) {
      const p = state.pending
      const confirmed = p.action === 'protocol' && raw.extra?.openai_responses_mode === p.body.extra.openai_responses_mode || p.action === 'status' && raw.status === p.body.status || p.action === 'name' && raw.name === p.body.name || p.action === 'models' && same(mappingOf(raw), p.body.mapping)
        || p.action === 'schedulable' && raw.schedulable === p.body.schedulable || p.action === 'priority' && raw.priority === p.body.priority || p.action === 'clear-error' && raw.status === 'active'
        || p.action === 'temp-unschedulable' && !(Date.parse(raw.temp_unschedulable_until) > now())
      if (confirmed) logs?.record({ ...context(site, account), level: 'success', action: '回读确认上次修改',
        message: `已核对 ${account.name} 的未完成操作`, details: { status: p.action,
          ...(p.action === 'models' ? { modelsAfter: Object.keys(p.body.mapping ?? {}) } : p.action === 'name' ? { after: raw.name } : {}) } })
      if (p.action === 'name' && raw.name === p.body.name) account.name = raw.name
      else if (p.action === 'models' && same(mappingOf(raw), p.body.mapping)) state.expectedMapping = p.body.mapping
      else if (p.action === 'schedulable' && raw.schedulable === p.body.schedulable) {
        state.expectedSchedulable = p.body.schedulable
        if (p.body.schedulable) { state.pausedBySystem = false; state.pauseReason = null; event(site, account, '确认恢复调度', '已核对上次写入结果') }
      }
      state.pending = null; state.expectedMapping = mappingOf(raw); state.expectedSchedulable = raw.schedulable; save(site)
    }
    const models = modelsForRoute(token, route)
    state.availableModels = models.filter(model => model.status === 'ok' && !model.autoPaused && fresh(model.lastProbeAt, now())).map(model => model.id)
    state.retainedModels = []
    state.excludedModels = models.filter(model => model.autoPaused || model.status === 'error').map(model => model.id)
    // Remote enable/disable changes are observations, not an ownership mode.
    // A stopped account must pass new recovery checks before it rejoins.
    if (!state.pausedBySystem && (!raw.schedulable || raw.status !== 'active')) {
      Object.assign(state, { pausedBySystem: true, pausedAt: new Date(now()).toISOString(), pauseReason: quotaError(raw) ? 'quota' : 'error', recovery: {} })
      save(site)
    }
    const name = probeRouteName(channel, token)
    if (raw.name !== name) await write(site, account, state, raw, 'name', { name })
    const freshModels = models.filter(model => fresh(model.lastProbeAt, now()))
    // A model can expose an upstream sub-account's quota/auth error while the
    // same token still serves other models. Only account/token facts block all.
    const quota = unavailableBalance(channel) || token.status === 'quota_exhausted'
    const bad = freshModels.filter(model => model.status === 'error')
    let mapping = desiredMapping(token, route)
    // A transient failed sample must not erase a still-valid success and flap the
    // whole account. Only retain its existing explicit whitelist, never add a
    // model, reopen a paused account or extend the last success's 120s lifetime.
    if (!state.pausedBySystem && raw.status === 'active' && raw.schedulable && !accountConnection(raw).passthrough) {
      const retained = new Set(models.filter(model => !model.autoPaused && fresh(model.lastProbeAt, now()) && fresh(lastSuccessAt(model), now()) &&
        (model.status === 'error' && transientReasons.has(model.reason) || model.status === 'inconclusive')).map(model => model.id))
      const retainedMapping = Object.fromEntries(Object.entries(state.expectedMapping ?? {}).filter(([name, id]) => name !== '*' && !name.includes('*') && retained.has(id)))
      mapping = { ...retainedMapping, ...mapping }
      state.retainedModels = [...new Set(Object.values(retainedMapping))]
    }
    const good = Object.keys(mapping).length > 0
    const passthroughFailure = accountConnection(raw).passthrough && (bad.length > 0 ||
      activeModels(token).some(model => platformOf(model) === route.platform && modelFamily(model, token) !== route.family))
    const emptyCatalog = token.modelsUpdatedAt && !token.modelsError && token.probeModels?.length === 0
    const sourceBlocked = !token.probeEnabled || !token.key || !usableAPIKey(token, now()) || token.stale || channel.probeTokensUnavailable
    const rateUnconfirmed = !isWithinRouteRate(route.cost, route.targetRate) && !route.costBlocked
    const failed = route.costBlocked || rateUnconfirmed || sourceBlocked || emptyCatalog || quota || passthroughFailure || !good
    const reason = route.costBlocked ? `${costReason(route.cost, route.targetRate)}，暂停调度，倍率恢复后重新验证` : rateUnconfirmed ? '倍率成本未确认，暂停调度，等待重新同步' : quota ? '账户余额或令牌额度已确认不足，等待补充后复测' : sourceBlocked ? '探测源已停用或令牌不可用，暂停调度'
      : emptyCatalog ? '上游模型列表为空，暂停调度并等待模型恢复'
        : passthroughFailure ? '透传模式绕过模型白名单，无法隔离模型系列或失败模型，暂停整条线路'
          : !good ? missingModelReason(models, token, now())
            : '调度站点标记账号异常，等待连续两轮成功后清除错误'
    if (failed || raw.status !== 'active') state.retainedModels = []
    // Legacy standby pauses can resume immediately only while currently healthy.
    if ((failed || raw.status === 'error') && state.pauseReason === 'standby') {
      state.pauseReason = quota ? 'quota' : route.costBlocked ? 'cost' : 'error'
      state.pausedAt = new Date(now()).toISOString(); state.recovery = {}
    }
    const evidenceDetails = () => ({ availableModels: state.availableModels, retainedModels: state.retainedModels,
      modelResults: models.map(model => `${model.id} · ${model.status || 'unknown'} · ${failureLabels[model.reason] || model.reason || '无错误'} · 本轮 ${model.lastProbeAt || '未检测'} · 最近成功 ${lastSuccessAt(model) || '无'}`) })
    if ((failed || raw.status === 'error') && !state.pausedBySystem) {
      state.pausedBySystem = true; state.pausedAt = new Date(now()).toISOString(); state.pauseReason = quota ? 'quota' : route.costBlocked ? 'cost' : 'error'; state.recovery = {}
      save(site)
      event(site, account, failed ? '暂停调度' : '核对账号错误', reason, evidenceDetails())
    }
    if (quota) state.pauseReason = 'quota'
    if (failed && state.pausedBySystem && raw.schedulable) await write(site, account, state, raw, 'schedulable', { schedulable: false })
    if (failed) { logs?.reset(`observation:${site.id}:${account.id}`); state.state = 'cooldown'; state.reason = reason; return }
    // A previously chat-only account may now contain a model verified through
    // Responses. Keeping the old forced Chat mode would route it differently
    // from the successful probe, even when the model whitelist is unchanged.
    if (raw.platform === 'openai' && raw.extra?.openai_responses_mode === 'force_chat_completions' &&
        models.some(model => Object.values(mapping).includes(model.id) && model.protocol === 'responses')) {
      await write(site, account, state, raw, 'protocol', { extra: { ...raw.extra, openai_responses_mode: 'auto' } })
    }
    // An empty mapping means ALL models in Sub2API. Never write it when all
    // models failed; keep the last mapping and stop scheduling instead.
    if (!accountConnection(raw).passthrough && !same(mapping, state.expectedMapping)) {
      await write(site, account, state, raw, 'models', { credentials: { ...raw.credentials, model_mapping: mapping } })
      event(site, account, '更新可用模型', state.retainedModels.length ? `短暂异常观察中，保留 ${state.retainedModels.length} 个两分钟内成功过的原有模型` : `已验证 ${state.availableModels.length} 个可用模型，仅推送本站实际验证通过的模型`)
    }
    if (state.retainedModels.length) {
      state.state = cooling(raw, now()) ? 'cooldown' : 'observing'
      state.reason = state.state === 'cooldown' ? '调度站点原有冷却尚未结束，保留其限制' : `本轮 ${state.availableModels.length} 个模型通过，${state.retainedModels.length} 个模型短暂异常；保留最近两分钟成功过的原有模型，等待下一轮验证`
      logs?.changed(`observation:${site.id}:${account.id}`, [state.state, state.retainedModels], {
        ...context(site, account), level: 'warning', action: '短暂异常观察', message: state.reason, details: evidenceDetails() })
      await applyPriority(site, account, state, raw)
      return
    }
    logs?.reset(`observation:${site.id}:${account.id}`)
    if (state.pausedBySystem) {
      state.recovery ??= {}
      for (const model of freshModels) {
        if (Date.parse(model.lastProbeAt) <= Date.parse(state.pausedAt)) continue
        const previous = state.recovery[model.id]
        if (previous?.at === model.lastProbeAt) continue
        state.recovery[model.id] = { at: model.lastProbeAt, count: model.status === 'ok' ? (model.successStreak >= 2 ? (previous?.count || 0) + 1 : 1) : 0 }
      }
      const recovered = state.pauseReason === 'standby' || freshModels.some(model => Object.values(mapping).includes(model.id) && model.status === 'ok' && state.recovery[model.id]?.count >= 2)
      if (!recovered) {
        if (raw.status === 'active' && raw.schedulable) await write(site, account, state, raw, 'schedulable', { schedulable: false })
        state.state = 'recovering'; state.reason = '等待连续两轮探测成功后恢复'; return }
      if (raw.auto_pause_on_expired && raw.expires_at != null && raw.expires_at * 1000 <= now()) { state.state = 'cooldown'; state.reason = '账号已到期，等待续期后恢复'; return }
      const balanceRecovered = state.pauseReason === 'quota' && channel.balance?.status === 'ok' && Number.isFinite(channel.balance.amount) && channel.balance.amount > 0
      if (cooling(raw, now()) && !(balanceRecovered && quotaError(raw))) { state.state = 'cooldown'; state.reason = '等待调度站点原有冷却结束'; return }
      const clearBalanceCooldown = balanceRecovered && quotaError(raw)
      if (raw.status === 'inactive') await write(site, account, state, raw, 'status', { status: 'active' })
      if (raw.status === 'error') await write(site, account, state, raw, 'clear-error', {})
      if (clearBalanceCooldown && Date.parse(raw.temp_unschedulable_until) > now()) await write(site, account, state, raw, 'temp-unschedulable', null, 'DELETE')
      if (!raw.schedulable) await write(site, account, state, raw, 'schedulable', { schedulable: true })
      const wasStandby = state.pauseReason === 'standby'
      state.pausedBySystem = false; state.pauseReason = null
      event(site, account, wasStandby ? '恢复全部线路调度' : '恢复调度', wasStandby ? '已取消主用数量限制，此线路当前验证正常，恢复参与调度' : '连续两轮探测成功，可用模型已同步')
    }
    await applyPriority(site, account, state, raw)
    state.state = cooling(raw, now()) ? 'cooldown' : 'healthy'
    state.reason = state.state === 'cooldown' ? '调度站点原有冷却尚未结束，保留其限制'
      : `已验证 ${state.availableModels.length} 个模型可用${state.excludedModels.length ? `，已隔离 ${state.excludedModels.length} 个异常模型` : ''}`
  }
  async function applyPriority(site, account, state, raw) {
    const planned = rankPlan.get(account.id)
    if (!planned) return
    state.speedMs = planned.speedMs
    if (raw.priority === planned.priority) { state.priority = planned.priority; return }
    await write(site, account, state, raw, 'priority', { priority: planned.priority })
    state.priority = planned.priority
  }
  async function runSite(id) {
    if (busy.has(id) || stopped) return
    let site = sites.get(id)
    if (!site?.automation?.enabled || !updatedSites.has(id) && Date.parse(site.automation.nextRunAt) > now()) return
    busy.add(id)
    updatedSites.delete(id)
    try {
      site.automation.nextRunAt = new Date(now() + 5000).toISOString()
      save(site)
      if (!(Date.parse(site.accountsSyncedAt) > now() - 60000) || !(Date.parse(site.syncedAt) > now() - 60000)) {
        site = await synchronize(site, now)
        save(site)
      }
      if (site.error || site.accountsError) throw new SyncError('调度站点同步失败，本轮未修改任何线路。', 502)
      const routes = pushRoutes(site, channels, now())
      writesApproved = site.automation.approved === true
      if (writesApproved) { delete site.automation.approved; save(site) }
      rankPlan = rankPlanFor(site, routes, channels, now())
      // Upstream calls yield while probes and balances can change. Never write
      // a removal/addition decided from a superseded set of source observations.
      const evidence = () => hash([site.groups, [...channels.values()].filter(channel => !channel.routingSource).map(channel => [channel.id, channel.name, channel.endpoint,
        channel.balance, channel.rechargeRate, channel.userGroups, channel.probeTokensUnavailable, (channel.probeTokens ?? []).map(token => [token.id, token.key, token.groupId, token.groupName,
          token.probeEnabled, token.status, token.expiresAt, token.stale, (token.probeModels ?? []).map(model => [model.id, model.protocol, model.status, model.reason,
            model.autoPaused, model.successStreak, model.lastProbeAt, fresh(model.lastProbeAt, now()), fresh(lastSuccessAt(model), now())])])])])
      const plannedEvidence = evidence()
      planGuards.set(id, () => {
        if (evidence() !== plannedEvidence) {
          updatedSites.add(id)
          throw Object.assign(new SyncError('探测或倍率信息已更新，重新计算调度计划。', 409), { probeChanged: true })
        }
      })
      for (const [routeId, record] of Object.entries(site.automation.routes)) if (!routes.some(route => route.id === routeId)) {
        const account = site.accounts.find(account => account.id === record.accountId)
        if (account) await pauseMissingSource(site, account, site.automation.accounts[account.id])
      }
      const runRoutes = async batch => {
        const destinations = new Map()
        const operations = batch.map(async route => {
          const channel = channels.get(route.channelId), token = channel?.probeTokens?.find(token => String(token.id) === route.tokenId)
          const destination = destinationIdentity(channel, token, route)
          const previous = destinations.get(destination)
          let release
          destinations.set(destination, new Promise(resolve => { release = resolve }))
          try {
            await previous
            if (!stopped) {
              const previousError = site.automation.routes[route.id]?.error
              await pushRoute(site, route)
              const record = site.automation.routes[route.id]
              const state = site.automation.accounts[record?.accountId]
              if (previousError && !record?.error) logs?.record({ ...context(site, { id: record?.accountId }, route), level: 'success', action: '线路调度恢复核对', message: '此前的推送或核对错误已消除' })
              if (state) logs?.changed(`route:${site.id}:${route.id}`, [state.state, state.reason, state.managed, state.retainedModels], {
                ...context(site, { id: record.accountId }, route), action: '调度状态变化', level: state.state === 'healthy' ? 'success' : 'warning',
                message: state.reason, details: { state: state.state, availableModels: state.availableModels, excludedModels: state.excludedModels, retainedModels: state.retainedModels } })
            }
          }
          catch (error) {
            if (error.held) return
            if (error.probeChanged) {
              const state = site.automation.accounts[site.automation.routes[route.id]?.accountId]
              if (state) state.lastEvidence = null
              return
            }
            const state = site.automation.routes[route.id] ??= routeRecord(route)
            state.retryAt = new Date(now() + 60000).toISOString()
            state.error = error instanceof SyncError ? error.message : '线路推送未完成，请检查连接与存储。'
            logs?.record({ ...context(site, { id: state.accountId }, route), level: 'error', action: '线路推送或核对失败', message: state.error,
              details: { httpStatus: error.status, status: state.pendingCreate ? '创建结果待确认' : '等待重试' } })
          }
          finally { release() }
        })
        await Promise.allSettled(operations)
      }
      await runRoutes(routes)
      if (site.automation.error) {
        logs?.record({ ...context(site), level: 'success', action: '自动调度恢复', message: '调度站点同步已恢复，本轮核对完成' })
        logs?.reset(`site-error:${site.id}`)
      }
      site.automation.lastRunAt = new Date(now()).toISOString(); site.automation.error = null
      save(site)
    } catch (error) {
      if (error.probeChanged) return // The queued update will recompute; no remote failure occurred.
      site.automation.error = error instanceof SyncError ? error.message : '自动调度未完成，请检查连接和存储。'
      logs?.changed(`site-error:${site.id}`, [site.automation.error, site.error, site.accountsError], { ...context(site), level: 'error', action: '自动调度失败',
        message: [site.automation.error, site.error, site.accountsError].filter(Boolean).join('；') })
      try { save(site) } catch { /* Keep ownership in memory; never resume after a failed reservation. */ }
    } finally { planGuards.delete(id); busy.delete(id) }
  }
  function runDue() {
    if (stopped) return Promise.resolve([])
    // Discovery uses its own per-channel queue and must not hold up routing.
    for (const site of sites.values()) if (!tasks.has(site.id) && site.automation?.enabled) {
      const task = runSite(site.id).finally(() => { tasks.delete(site.id); if (updatedSites.has(site.id)) queueUpdate() })
      tasks.set(site.id, task)
    }
    return Promise.allSettled([...tasks.values()])
  }
  function queueUpdate() {
    if (stopped || !timer || updateTimer) return
    updateTimer = setTimeout(() => { updateTimer = null; void runDue() }, 100)
    updateTimer.unref()
  }
  function probesUpdated() {
    if (stopped) return
    for (const site of sites.values()) if (site.automation?.enabled) updatedSites.add(site.id)
    queueUpdate()
  }
  function applyPolicy(updated, input) {
    const before = JSON.stringify(policyOf(updated.automation))
    if ('shadow' in input) updated.automation.shadow = input.shadow === true
    if ('freeze' in input) updated.automation.freeze = input.freeze === true
    if ('approve' in input) updated.automation.approve = input.approve === true
    if ('ownedOnly' in input) updated.automation.ownedOnly = input.ownedOnly === true
    if ('rank' in input) {
      if (!['keep', 'price', 'speed'].includes(input.rank)) throw new SyncError('请选择保持、价格优先或速度优先。')
      updated.automation.rank = input.rank
    }
    if (input.approveOnce === true) updated.automation.approved = true
    if (JSON.stringify(policyOf(updated.automation)) !== before || input.approveOnce === true) {
      for (const item of Object.values(updated.automation.accounts ?? {})) item.lastEvidence = null
    }
  }
  function configure(site, input) {
    const updated = structuredClone(site)
    updated.automation ??= { direction: 'push', enabled: false, routes: {}, accounts: {}, events: [] }
    applyPolicy(updated, input)
    if (input.routeId != null) {
      const route = pushRoutes(site, channels, now()).find(route => route.id === input.routeId)
      if (!route || input.enabled === false || input.enabled != null && input.enabled !== true) throw new SyncError('线路统一自动管理，请选择目标分组；如需停止探测，请关闭对应探针。')
      if (input.groupId != null && (!Number.isSafeInteger(input.groupId) || !route.groups.some(group => group.id === input.groupId))) throw new SyncError('请选择模型系列和协议兼容的目标分组。')
      if (route.pendingCreate && input.groupId != null && input.groupId !== route.groupId) throw new SyncError('上次创建结果尚未确认，暂不能更换目标分组。', 409)
      if (route.accountId && input.groupId != null && !site.accounts.find(account => account.id === route.accountId)?.groupIds.includes(input.groupId)) throw new SyncError('已关联线路不能直接换组，请先在调度站点调整分组。', 409)
      const record = updated.automation.routes[route.id] ??= routeRecord(route)
      Object.assign(record, { retryAt: null, error: null })
      if (input.groupId != null) record.groupId = input.groupId
      const account = updated.automation.accounts[route.accountId]
      if (typeof input.hold === 'boolean') {
        if (!account) throw new SyncError('线路尚未关联调度账号，不能人工暂停。', 409)
        account.hold = input.hold
        if (!input.hold) account.pauseReason = 'standby'
      }
      if (account) account.lastEvidence = null
    } else if (typeof input.enabled === 'boolean') updated.automation.enabled = input.enabled
    else if (!('shadow' in input || 'freeze' in input || 'approve' in input || 'ownedOnly' in input || 'rank' in input || input.approveOnce === true)) {
      throw new SyncError('请指定是否启用自动推送。')
    }
    updated.automation.nextRunAt = null
    save(updated)
    const route = input.routeId ? pushRoutes(updated, channels, now()).find(item => item.id === input.routeId) : null
    logs?.record({ ...context(updated, route ? { id: route.accountId } : null, route), actor: 'user', level: 'success',
      action: input.routeId ? (typeof input.hold === 'boolean' ? (input.hold ? '人工暂停线路' : '解除人工暂停') : '更新目标分组') : input.enabled === true ? '开启自动调度' : input.enabled === false ? '关闭自动调度' : '更新调度闸门',
      message: input.routeId ? (typeof input.hold === 'boolean' ? '已保存人工暂停，后台不会自动恢复' : '已保存目标分组，后台自动核对符合条件的线路') : '已保存站点自动调度开关',
      details: { enabled: updated.automation.enabled, groupId: route?.groupId, shadow: updated.automation.shadow === true, freeze: updated.automation.freeze === true, approve: updated.automation.approve === true, ownedOnly: updated.automation.ownedOnly === true, rank: policyOf(updated.automation).rank } })
    return updated
  }
  return { configure, runDue, probesUpdated,
    probeCosts: (channel, token) => probeCostBlocks(sites, channel, token),
    sourceEnabled: () => false,
    start() { if (!timer) { stopped = false; timer = setInterval(() => { void runDue() }, 5000); timer.unref(); void runDue() } },
    async stop() { stopped = true; clearInterval(timer); clearTimeout(updateTimer); timer = updateTimer = null; await Promise.allSettled([...tasks.values()]) },
  }
}
