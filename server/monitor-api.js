import { randomUUID, createHash } from 'node:crypto'
import { createOperationLogs } from './operation-logs.js'
import { createChannelStore, createSecondarySiteStore, createConsoleSettingsStore, createUserGatewayStore, createQQBotStore } from './site-store.js'
import { createQQBot, qqIncidents, readBody } from './qq-bot.js'
import { applySettings, balanceNotices, normalizeSettings } from './console-settings.js'
import { createSecondarySitesAPI } from './secondary-sites.js'
import { createRouteDiscovery } from './route-discovery.js'
import { SyncError, isRecord, textValue, localHost, readJSON, upstream } from './upstream-client.js'
import { channelAuthView, createChannelAuth, loginSub2API } from './sub2api-auth.js'
import { channelBalanceView } from './channel-balance.js'
import { probeTokenPricing, userGroupsView } from './user-groups.js'
import { watchView } from './upstream-watch.js'
import { createUserAPIKey, deleteUserAPIKey, userAPIKeysView, usableAPIKey } from './user-api-keys.js'
import { executeHealthProbe, HEALTH_PROBE_TIMEOUT_MS, listProbeModels, probeProtocol } from './probe-request.js'
import { createChannelFunding } from './channel-funding.js'
import { channelProbeSummary } from './channel-probes.js'
import { recentProbeHistory, summarizeProbeHistory } from './probe-history.js'
import { probeRouteName } from './route-name.js'
import { createUserGateways, publicGateway } from './user-gateway.js'

const validRechargeRate = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1000000

function publicChannel(channel, nextCheckAt, now, probeCosts) {
  return { id: channel.id, name: channel.name, provider: channel.provider, endpoint: channel.endpoint,
    email: channel.email, userId: channel.userId, createdAt: channel.createdAt,
    rechargeRate: validRechargeRate(channel.rechargeRate) ? channel.rechargeRate : 1, autoProbeNewTokens: channel.autoProbeNewTokens === true, needsAuthorization: !channel.token,
    auth: channelAuthView(channel), balance: { ...channelBalanceView(channel), nextCheckAt }, userGroups: userGroupsView(channel), apiKeys: userAPIKeysView(channel), upstreamWatch: watchView(channel),
    probeSummary: channelProbeSummary(channel, now, probePolicy.intervalSec, token => probeCosts(channel, token)) }
}

function publicProbeTokens(channels, now, probeCosts) {
  return [...channels.values()].filter(channel => !channel.routingArchived).flatMap(channel => (channel.probeTokens ?? []).map(token => {
    const costBlocks = probeCosts(channel, token)
    return {
    id: token.id, channelId: channel.id, channelName: channel.name, provider: channel.provider,
    endpoint: channel.endpoint, rechargeRate: validRechargeRate(channel.rechargeRate) ? channel.rechargeRate : 1,
    name: probeRouteName(channel, token), upstreamTokenName: token.name, groupId: token.groupId ?? null,
    groupName: token.groupName ?? null, status: token.status, stale: Boolean(token.stale),
    groupPricing: probeTokenPricing(channel, token),
    costBlockedModels: costBlocks.size,
    updatedAt: token.updatedAt ?? channel.probeTokensUpdatedAt ?? null,
    autoRecoverModels: token.autoRecoverModels === true,
    probeEnabled: token.probeEnabled === true, probePaused: !token.key || !usableAPIKey(token, now) || Boolean(token.stale || channel.probeTokensUnavailable),
    probeBlockReason: insufficientBalance(channel) ? 'balance'
      : !token.key || !usableAPIKey(token, now) || token.stale || channel.probeTokensUnavailable ? 'credentials'
        : token.modelsError && !token.probeModels?.length ? 'models' : null,
    nextProbeAt: token.probeEnabled === true ? nextTokenProbeAt(token, costBlocks) : null,
    lastProbeAt: token.lastProbeAt ?? null, probeStatus: token.probeStatus ?? null,
    probeLatencyMs: token.probeLatencyMs ?? null, probeError: token.probeError ?? null, lastProbeModel: token.lastProbeModel ?? null,
    modelsUpdatedAt: token.modelsUpdatedAt ?? null, modelsError: token.modelsError ?? null,
    modelsNextRefreshAt: token.modelsNextRefreshAt ?? null,
    probeModels: (token.probeModels ?? []).map(model => ({ id: model.id, protocol: model.protocol ?? null, status: model.status ?? 'unknown', latencyMs: model.latencyMs ?? null, lastProbeAt: model.lastProbeAt ?? null, error: model.error ?? null, usage: model.usage ?? null,
      reason: model.reason ?? null, httpStatus: model.httpStatus ?? null, timeoutMs: model.timeoutMs ?? null,
      costBlocked: costBlocks.has(model.id), costBlockReason: costBlocks.get(model.id)?.reason ?? null,
      autoPaused: model.autoPaused === true, pausedAt: model.pausedAt ?? null, revalidatePending: model.revalidatePending === true,
      nextProbeAt: token.probeEnabled === true && model.protocol !== 'unsupported' && !model.autoPaused && !costBlocks.has(model.id) ? new Date(nextModelProbeTime(token, model)).toISOString() : null,
      historySummary: model.probeHistorySummary ?? summarizeProbeHistory(model.probeHistory ?? []),
      history: Array.isArray(model.probeHistory) ? recentProbeHistory(model.probeHistory, now).map(item => ({ at: item?.at ?? null, status: item?.status ?? 'unknown', latencyMs: item?.latencyMs ?? null,
        reason: item?.reason ?? null, error: item?.error ?? null, httpStatus: item?.httpStatus ?? null, timeoutMs: item?.timeoutMs ?? null,
        completedAt: item?.completedAt ?? null, protocol: item?.protocol ?? null })).filter(item => item.at && !Number.isNaN(Date.parse(item.at))) : [] })),
    }
  }))
}

const probePolicy = Object.freeze({ intervalSec: 60, scope: 'model', timeoutMs: HEALTH_PROBE_TIMEOUT_MS })
const probeIntervalMs = probePolicy.intervalSec * 1000
function nextModelProbeTime(token, model) {
  // Honor existing model deadlines; old snapshots inherit their previous reservation once.
  const scheduled = Date.parse(model.nextProbeAt)
  return Number.isFinite(scheduled) ? scheduled : Math.max(Date.parse(token.nextProbeAt) || 0,
    Number.isFinite(Date.parse(model.lastProbeAt)) ? Date.parse(model.lastProbeAt) + probeIntervalMs : 0)
}
function nextTokenProbeAt(token, costBlocks) {
  const deadlines = (token.probeModels ?? []).filter(model => model.protocol !== 'unsupported' && !model.autoPaused && !costBlocks.has(model.id)).map(model => nextModelProbeTime(token, model))
  return deadlines.length ? new Date(Math.min(...deadlines)).toISOString() : null
}
const insufficientBalance = channel => channel.balance?.status === 'ok' && typeof channel.balance.amount === 'number' && Number.isFinite(channel.balance.amount) && channel.balance.amount <= 0

export function monitorAPI({ channelStore = null, secondaryStore = null, settingsStore = null, gatewayStore = null, qqStore = null, now = Date.now, publicOrigin = null } = {}) {
  const publicURL = publicOrigin ? new URL(publicOrigin) : null
  if (publicURL && (publicURL.protocol !== 'https:' || publicURL.origin !== publicOrigin)) {
    throw new Error('Public origin must be a canonical HTTPS origin without a path.')
  }
  const channels = new Map((channelStore?.load({ recent: true, now: now() }) ?? []).map(channel => [channel.id, channel]))
  let settings = normalizeSettings(settingsStore?.load()?.[0])
  const settingsView = () => ({ settings, balanceNotices: balanceNotices(channels.values(), settings.lowBalanceThreshold, now()) })
  const logs = createOperationLogs({ store: channelStore, channels, now })
  const auth = createChannelAuth({ channels, store: channelStore, now, logs, watchSettings: () => settings })
  const discovery = createRouteDiscovery({ channels, auth, now, refreshModels, logs })
  const secondarySites = createSecondarySitesAPI({ store: secondaryStore, channels, channelStore, auth, discovery, now, logs })
  const probeCosts = (channel, token) => secondarySites.automation.probeCosts(channel, token)
  const funding = createChannelFunding({ channels, store: channelStore, auth, now, logs })
  const userGateways = createUserGateways({ store: gatewayStore, request: upstream, now, logs })
  const qq = createQQBot({ store: qqStore, now, publicOrigin, log: entry => logs.record({ category: 'settings', ...entry }),
    incidents: () => qqIncidents({ channels: [...channels.values()], sites: secondarySites.snapshot(), settings, now: now() }) })
  const publicChannels = () => {
    const time = now()
    return [...channels.values()].filter(channel => !channel.routingSource).map(channel => publicChannel(channel, auth.nextCheckAt(channel.id), time, probeCosts))
  }
  const publicProbeSetup = () => [...channels.values()].filter(channel => !channel.routingSource).flatMap(channel => {
    const tokenCount = channel.probeTokens?.length ?? 0
    const modelCount = (channel.probeTokens ?? []).reduce((count, token) => count + (token.probeModels?.length ?? 0), 0)
    const error = channel.probeTokensError || channel.apiKeys?.error
    if (tokenCount && modelCount && !error) return []
    const status = !channel.token ? 'unauthorized' : error ? 'error' : tokenCount ? 'models'
      : channel.apiKeys?.status === 'ok' ? 'empty' : 'syncing'
    return [{ channelId: channel.id, name: channel.name, status,
      detail: status === 'unauthorized' ? '请先在总览完成上游授权。' : error || (status === 'models'
        ? (channel.probeTokens.find(token => token.modelsError)?.modelsError || '令牌已同步，正在自动获取模型。')
        : status === 'empty' ? channel.autoProbeNewTokens ? '此上游暂无可用令牌，可在令牌管理中创建。' : '自动接入未开启，可在渠道编辑中开启；已有手动停用令牌保持关闭。' : '正在自动同步上游 API 令牌。') }]
  })
  let probeTimer, probesStopped = false
  const probeTasks = new Map()
  const probeControllers = new Map()
  const routingUpdates = new Set()
  const probeId = (channel, token) => `${channel.id}/${token.id}`
  const costStates = new Map()
  function checkedProbeCosts(channel, token) {
    const blocked = probeCosts(channel, token), id = probeId(channel, token)
    const signature = JSON.stringify([...blocked].map(([model, block]) => [model, block.reason]))
    if ((blocked.size || costStates.has(id)) && costStates.get(id) !== signature) {
      logs.record({ category: 'probes', channelId: channel.id, channelName: channel.name, tokenId: token.id,
        level: blocked.size ? 'warning' : 'success', action: blocked.size ? '成本过高，暂停模型探测' : '模型探测成本限制解除',
        message: blocked.size ? [...new Set([...blocked.values()].map(block => block.reason))].join('；') : '成本限制已解除，已启用的模型按正常探测条件自动继续。',
        details: { excludedModels: [...blocked.keys()] } })
      if (blocked.size) costStates.set(id, signature)
      else costStates.delete(id)
    }
    return blocked
  }
  function saveProbes(records = [...channels.values()]) {
    try {
      if (channelStore.saveChannels) channelStore.saveChannels(records)
      else channelStore.save([...channels.values()])
      for (const channel of records) channelStore.compact?.(channel, now())
    }
    catch { throw Object.assign(new SyncError('探针数据保存失败，已暂停本次请求；请检查本机存储。', 500), { storage: true }) }
  }
  // Reservations and results share one transaction across concurrent tokens.
  // Each caller still awaits durable storage before issuing a paid request.
  let pendingProbeSave
  const dirtyChannels = new Set()
  function saveProbeBatch(channel) {
    dirtyChannels.add(channel.id)
    if (!pendingProbeSave) pendingProbeSave = new Promise((resolve, reject) => {
      setTimeout(() => {
        pendingProbeSave = null
        const records = [...dirtyChannels].map(id => channels.get(id)).filter(Boolean)
        dirtyChannels.clear()
        try { saveProbes(records); resolve() } catch (error) { reject(error) }
      }, 100)
    })
    return pendingProbeSave
  }
  function setProbeEnabled(channel, token, enabled) {
    if (enabled && insufficientBalance(channel)) throw new SyncError('上游余额不足，无法启动探测。', 402)
    if (enabled && (!usableAPIKey(token, now()) || !token.key || token.stale || channel.probeTokensUnavailable)) throw new SyncError('令牌不可用，请检查上游授权；后台会继续自动同步。', 409)
    if (enabled !== (token.probeEnabled === true)) {
      token.probeEnabled = enabled
      // Keep the previous reservation when toggling off/on; do not bypass the rate limit.
      if (enabled && !(Date.parse(token.nextProbeAt) > now())) token.nextProbeAt = new Date(now()).toISOString()
    }
  }
  const pendingProbeActions = new Map()
  const actionKey = (channelId, tokenId) => JSON.stringify([channelId, tokenId])
  async function queueProbeAction(channelId, tokenIds, operation) {
    const ticket = Symbol(), keys = tokenIds.map(id => actionKey(channelId, id))
    for (const key of keys) pendingProbeActions.set(key, ticket)
    try {
      return await auth.exclusive(channelId, () => operation(id => pendingProbeActions.get(actionKey(channelId, id)) === ticket))
    } finally {
      for (const key of keys) if (pendingProbeActions.get(key) === ticket) pendingProbeActions.delete(key)
    }
  }
  function changeProbeTokens(channelId, tokenIds, enabled, current = () => true) {
    const channel = channels.get(channelId), changes = [], failures = []
    let unchanged = 0
    for (const id of tokenIds) {
      const token = channel?.probeTokens?.find(item => item.id === id)
      try {
        if (!current(id)) throw new SyncError('此前请求已被后续操作取消。', 409)
        if (!token) throw new SyncError('探针令牌不存在，请等待自动同步。', 404)
        if ((token.probeEnabled === true) === enabled) { unchanged++; continue }
        const previous = { probeEnabled: token.probeEnabled, nextProbeAt: token.nextProbeAt }
        setProbeEnabled(channel, token, enabled)
        changes.push({ channel, token, previous })
      } catch (error) {
        failures.push({ channelId, id, channelName: channel?.name ?? channelId, name: token ? probeRouteName(channel, token) : id,
          error: error instanceof SyncError ? error.message : '修改探测开关失败，请重试。', status: error.status ?? 500 })
      }
    }
    // Each channel commits synchronously; one slow channel does not block the others.
    const previousDisabled = channel?.probeDisabledTokenIds
    const failedIds = new Set(failures.map(item => item.id)), disabled = new Set(previousDisabled ?? [])
    for (const id of tokenIds) if (!failedIds.has(id)) { if (enabled) disabled.delete(id); else disabled.add(id) }
    const preferencesChanged = JSON.stringify([...disabled]) !== JSON.stringify(previousDisabled ?? [])
    if (channel && preferencesChanged) channel.probeDisabledTokenIds = [...disabled]
    try { if (changes.length || preferencesChanged) saveProbes([channel]) }
    catch (error) {
      for (const { token, previous } of changes) Object.assign(token, previous)
      if (channel && preferencesChanged) {
        if (previousDisabled === undefined) delete channel.probeDisabledTokenIds
        else channel.probeDisabledTokenIds = previousDisabled
      }
      throw error
    }
    if (!enabled) for (const id of tokenIds) {
      pendingProbeActions.delete(actionKey(channelId, id))
      probeControllers.get(probeId({ id: channelId }, { id }))?.abort()
    }
    return { changes, failures, unchanged }
  }
  async function refreshModels(channel, token, signal) {
    // Persist retry spacing before I/O, including across restarts.
    token.modelsNextRefreshAt = new Date(now() + 60000).toISOString()
    await saveProbeBatch(channel)
    if (signal?.aborted) return
    try {
      const configuredModels = () => (token.seedModels ?? []).map(id => ({ id, protocol: channel.probePlatform === 'gemini' && probeProtocol(id) !== 'unsupported' ? 'gemini' : probeProtocol(id) }))
      let listed
      try {
        listed = await listProbeModels(channel, token, { signal })
        token.modelsSource = 'upstream'
      } catch (error) {
        // A catalog restriction does not prove the configured model endpoints fail.
        if (!channel.routingSource || !token.seedModels?.length || !([404, 405].includes(error.status) || error.status === 403 && error.reason === 'permission')) throw error
        listed = configuredModels()
        token.modelsSource = 'account-mapping'
      }
      if (channel.routingSource) for (const model of configuredModels()) if (!listed.some(item => item.id === model.id)) listed.push(model)
      const previous = new Map((token.probeModels ?? []).map(model => [model.id, model]))
      token.probeModels = listed.map(model => ({ ...previous.get(model.id), ...model,
        protocol: previous.get(model.id)?.protocolOverride ?? model.protocol,
        status: model.protocol === 'unsupported' ? 'unsupported' : previous.get(model.id)?.status ?? 'unknown' }))
      // A suspended model may disappear from /models. Keep its history and revalidation control.
      const listedIds = new Set(listed.map(model => model.id))
      token.probeModels.push(...[...previous.values()].filter(model => !listedIds.has(model.id) && (model.pausedAt || model.autoPaused || model.revalidatePending)))
      token.modelsUpdatedAt = new Date(now()).toISOString()
      token.modelsNextRefreshAt = new Date(now() + 600000).toISOString()
      token.modelsError = null; token.modelsErrorReason = null
    } catch (error) {
      token.modelsErrorReason = error.reason ?? 'connection_error'
      token.modelsError = error instanceof SyncError ? error.message : '模型列表读取失败，已保留上次列表。'
      token.modelsNextRefreshAt = new Date(now() + 60000).toISOString()
      throw new SyncError(token.modelsError, 502)
    } finally {
      await saveProbeBatch(channel)
      logs.changed(`models:${channel.id}:${token.id}`, [token.modelsError, (token.probeModels ?? []).map(model => model.id).sort()], {
        category: 'probes', channelId: channel.id, channelName: channel.name, tokenId: token.id,
        level: token.modelsError ? 'error' : 'success', action: token.modelsError ? '读取模型列表失败' : '模型列表已同步',
        message: token.modelsError || `当前 ${token.probeModels?.length ?? 0} 个模型`, details: { modelsAfter: (token.probeModels ?? []).map(model => model.id) } })
    }
  }
  async function runTokenProbes(channel, token) {
    if (channel.routingSource && !secondarySites.automation.sourceEnabled(channel.routingSource)) return
    if (channel.balanceSourceId) channel.balance = channels.get(channel.balanceSourceId)?.balance
    if (probesStopped || !token.key || !usableAPIKey(token, now()) || token.stale || channel.probeTokensUnavailable) return
    const modelsDue = token.modelsNextRefreshAt
      ? !(Date.parse(token.modelsNextRefreshAt) > now())
      : !token.modelsUpdatedAt || token.modelsError || !(Date.parse(token.modelsUpdatedAt) > now() - 600000)
    const canProbe = () => {
      if (channel.balanceSourceId) channel.balance = channels.get(channel.balanceSourceId)?.balance
      return token.probeEnabled && !insufficientBalance(channel) && !(channel.balanceSourceId && channel.balance?.status === 'checking')
    }
    if (!modelsDue && !canProbe()) return
    const controller = new AbortController()
    probeControllers.set(probeId(channel, token), controller)
    try {
      if (modelsDue) {
        try { await refreshModels(channel, token, controller.signal) }
        catch (error) { if (!token.probeModels?.length || error.storage) throw error }
      }
      if (!canProbe() || controller.signal.aborted) return
      const costBlocks = checkedProbeCosts(channel, token)
      const models = (token.probeModels ?? []).filter(model => !costBlocks.has(model.id) && model.protocol !== 'unsupported' && (!model.autoPaused || token.autoRecoverModels && (!(Date.parse(model.recoveryCheckAt) > now()) || channel.balance?.status === 'ok' && channel.balance.amount > 0 && Date.parse(channel.balance.updatedAt) > Date.parse(model.lastProbeAt))) && nextModelProbeTime(token, model) <= now())
      if (!models.length) return
      const started = now()
      const nextMinute = new Date((Math.floor(started / probeIntervalMs) + 1) * probeIntervalMs).toISOString()
      // Persist every model's reservation before sending the concurrent requests.
      // Align later runs to the clock minute so timer jitter cannot accumulate into blank minutes.
      for (const model of models) model.nextProbeAt = nextMinute
      await saveProbeBatch(channel)
      if (!canProbe() || controller.signal.aborted || probesStopped) return
      // A group rate can change while the reservation is being saved.
      const currentCosts = checkedProbeCosts(channel, token)
      const modelEvents = []
      await Promise.allSettled(models.filter(model => !currentCosts.has(model.id)).map(async model => {
        const wasPaused = model.autoPaused === true
        const requestedAt = new Date(now()).toISOString(), requestedProtocol = model.protocol
        const result = await executeHealthProbe(channel, token, now, model, { signal: controller.signal })
        if (controller.signal.aborted || result.status === 'cancelled') return
        token.lastProbeAt = new Date(now()).toISOString()
        token.probeStatus = result.status; token.probeLatencyMs = result.latencyMs; token.probeError = result.error
        token.lastProbeModel = model.id
        Object.assign(model, result, { lastProbeAt: token.lastProbeAt })
        model.revalidatePending = false
        model.successStreak = result.status === 'ok' ? (model.successStreak || 0) + 1 : 0
        model.failureStreak = result.status === 'error' ? (model.failureStreak || 0) + 1 : 0
        if (result.status === 'ok') { model.autoPaused = false; model.recoveryCheckAt = null }
        if (result.reason === 'model_unsupported' || token.autoRecoverModels && model.failureStreak >= 3) {
          model.autoPaused = true; model.pausedAt ||= token.lastProbeAt
        }
        if (model.autoPaused && token.autoRecoverModels) model.recoveryCheckAt = new Date(now() + 300000).toISOString()
        if (wasPaused !== (model.autoPaused === true)) modelEvents.push({ category: 'probes', channelId: channel.id, channelName: channel.name, tokenId: token.id, model: model.id,
          action: model.autoPaused ? '隔离异常模型' : '模型恢复验证通过', level: model.autoPaused ? 'warning' : 'success',
          message: model.autoPaused ? result.error || '模型连续失败，进入隔离复测' : '复测已通过，模型重新加入可用候选', details: { reason: result.reason } })
        if (result.retryProtocol === 'responses') model.protocol = model.protocolOverride = 'responses'
        if (result.omitParameter === 'temperature') model.omitTemperature = true
        if (result.omitParameter === 'reasoning') model.omitReasoning = true
        if (result.requireStream) model.requireStream = true
        const history = Array.isArray(model.probeHistory) ? model.probeHistory : []
        const observation = { at: requestedAt, completedAt: token.lastProbeAt, protocol: requestedProtocol, status: result.status, latencyMs: result.latencyMs,
          reason: result.reason ?? null, error: result.error, httpStatus: result.httpStatus, timeoutMs: result.timeoutMs }
        model.probeHistorySummary = summarizeProbeHistory([observation], model.probeHistorySummary ?? summarizeProbeHistory(history))
        model.probeHistory = [...history, observation].slice(-1440)
      }))
      await saveProbeBatch(channel)
      routingUpdates.add(channel.id)
      for (const entry of modelEvents) logs.record(entry)
    } catch (error) {
      if (canProbe() && !controller.signal.aborted) {
        token.probeError = error instanceof SyncError ? error.message : '探针请求未完成，稍后重试。'
        token.probeStatus = 'error'
      }
    } finally { probeControllers.delete(probeId(channel, token)) }
  }
  function runProbes() {
    for (const channel of channels.values()) {
      if (probesStopped) break
      if (auth.busy.has(channel.id)) continue
      const task = auth.exclusive(channel.id, () => Promise.allSettled((channel.probeTokens ?? []).map(token => runTokenProbes(channel, token))))
        .finally(() => { probeTasks.delete(channel.id); if (routingUpdates.delete(channel.id) && !probesStopped) secondarySites.automation.probesUpdated(channel.id) })
      probeTasks.set(channel.id, task)
    }
    return Promise.allSettled([...probeTasks.values()])
  }
  let probeResponseCache
  function tokenUsedBy(channelId, tokenId) {
    for (const site of secondaryStore?.load?.() ?? []) {
      const bound = (site.accountBindings ?? []).some(item => item.upstreamId === channelId && String(item.tokenId) === tokenId)
        || Object.values(site.automation?.accounts ?? {}).some(item => item?.channelId === channelId && String(item.tokenId) === tokenId)
        || Object.values(site.automation?.routes ?? {}).some(item => item?.channelId === channelId && String(item.tokenId) === tokenId)
      if (bound) return site.name || site.id
    }
    return ''
  }
  const qqResponse = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  async function handleQQWebhook(req, res) {
    try {
      if (req.method !== 'POST') return qqResponse(res, 405, { error: '该接口不支持此操作。' })
      const host = new URL(`http://${req.headers.host}`)
      const allowedHost = publicURL ? req.headers.host === publicURL.host : localHost(host.hostname)
      if (!allowedHost || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return qqResponse(res, 403, { error: '请求来源无效。' })
      if (!req.headers['content-type']?.startsWith('application/json')) return qqResponse(res, 415, { error: '请求格式无效。' })
      if (!String(req.headers['user-agent'] || '').includes('QQBot-Callback')) return qqResponse(res, 403, { error: '请求来源无效。' })
      const result = await qq.webhook(await readBody(req, 65536), req.headers)
      return qqResponse(res, result.status, result.body)
    } catch (error) {
      return qqResponse(res, error instanceof SyncError ? error.status : 500, { error: error instanceof SyncError ? error.message : '回调处理失败。' })
    }
  }
  const middleware = async (req, res, next) => {
    const path = req.url?.split('?')[0]
    if (path === '/api/qq/webhook') return handleQQWebhook(req, res)
    const authMatch = path?.match(/^\/api\/upstream-channels\/([^/]+)\/auth\/check$/)
    const balanceMatch = path?.match(/^\/api\/upstream-channels\/([^/]+)\/balance\/check$/)
    const groupsMatch = path?.match(/^\/api\/upstream-channels\/([^/]+)\/groups\/sync$/)
    const watchMatch = path?.match(/^\/api\/upstream-channels\/([^/]+)\/watch$/)
    const fundingMatch = path?.match(/^\/api\/upstream-channels\/([^/]+)\/funding\/(options|redeem|quote|pay|status)$/)
    const channelRoute = path === '/api/upstream-channels' || Boolean(authMatch || balanceMatch || groupsMatch || fundingMatch || watchMatch)
    const probeTokenRoute = path === '/api/probe-tokens'
    const probeCreateRoute = path === '/api/probe-tokens/create'
    const probeDeleteRoute = path?.match(/^\/api\/probe-tokens\/([^/]+)\/([^/]+)\/delete$/)
    const probeBatchRoute = ['/api/probe-tokens/batch-enable', '/api/probe-tokens/batch-disable'].includes(path)
    const probeModelsRoute = path?.match(/^\/api\/probe-tokens\/([^/]+)\/([^/]+)\/models$/)
    const probeRevalidateRoute = path?.match(/^\/api\/probe-tokens\/([^/]+)\/([^/]+)\/models\/revalidate$/)
    const probeTokenToggle = path?.match(/^\/api\/probe-tokens\/([^/]+)\/([^/]+)$/)
    const secondaryRoute = path === '/api/secondary-sites' || path?.startsWith('/api/secondary-sites/')
    const settingsRoute = path === '/api/settings'
    const qqRoute = path === '/api/qq-bot' || path === '/api/qq-bot/test'
    const logsRoute = path === '/api/logs'
    const gatewayRoute = path === '/api/user-gateways' || Boolean(path?.startsWith('/api/user-gateways/'))
    if (!qqRoute && !gatewayRoute && !logsRoute && !settingsRoute && !secondaryRoute && !channelRoute && !probeTokenRoute && !probeCreateRoute && !probeDeleteRoute && !probeBatchRoute && !probeModelsRoute && !probeRevalidateRoute && !probeTokenToggle) return next()
    let authorized = false, audit
    const channelId = (authMatch || balanceMatch || groupsMatch || fundingMatch || watchMatch || probeModelsRoute || probeRevalidateRoute || probeTokenToggle || probeDeleteRoute)?.[1]
    const siteId = secondaryRoute ? path.split('/')[3] : undefined
    const action = qqRoute ? (path.endsWith('/test') ? '发送 QQ 测试消息' : '保存 QQ 机器人') : settingsRoute ? '保存系统设置' : groupsMatch ? '手动同步上游分组' : balanceMatch ? '手动刷新余额' : authMatch ? '手动检查授权'
      : fundingMatch ? ({ redeem: '兑换码提交', pay: '创建充值订单', quote: '查询充值报价', status: '核对充值订单' })[fundingMatch[2]]
      : probeCreateRoute ? '创建上游令牌' : probeDeleteRoute ? '删除上游令牌'
        : probeBatchRoute ? path.endsWith('batch-enable') ? '批量启用探测' : '批量停止探测'
        : probeRevalidateRoute ? '请求重新验证模型' : probeModelsRoute ? '手动同步模型列表' : probeTokenToggle ? '修改令牌探测开关'
          : secondaryRoute ? path.endsWith('/automation') ? '修改自动调度配置' : path.endsWith('/bindings') ? '修改线路关联'
            : path.endsWith('/discovery') ? '启动线路识别' : path.endsWith('/sync') ? '手动同步调度站点' : '保存调度站点'
            : gatewayRoute ? path.endsWith('/attribute') ? '主站线路归因' : path.endsWith('/keys') ? '添加主站下游密钥' : path.endsWith('/models') ? '同步主站下游模型' : path.endsWith('/check') ? '检查主站连接' : '保存主站连接'
            : '保存上游渠道'
    audit = { category: gatewayRoute ? 'gateway' : qqRoute || settingsRoute ? 'settings' : fundingMatch ? 'funding' : probeCreateRoute || probeDeleteRoute || probeBatchRoute || probeModelsRoute || probeRevalidateRoute || probeTokenToggle ? 'probes' : secondaryRoute ? path.endsWith('/discovery') ? 'discovery' : 'routing' : 'upstream',
      action, channelId, channelName: channels.get(channelId)?.name, siteId, tokenId: (probeModelsRoute || probeRevalidateRoute || probeTokenToggle || probeDeleteRoute)?.[2] }
    const send = (status, data) => {
      if (authorized && req.method === 'POST' && !logsRoute) {
        const target = channels.get(audit.channelId)
        const problem = data.error || data.site?.error || data.site?.accountsError
          || (authMatch || balanceMatch ? target?.authError || target?.balance?.error : groupsMatch ? target?.userGroups?.error || target?.probeTokensError : null)
        const batch = data.batch
        // Financial outcomes and successful automation configuration are logged at their confirmed boundaries.
        if (!(status < 400 && (fundingMatch && ['redeem','pay'].includes(fundingMatch[2]) || secondaryRoute && path.endsWith('/automation')))) logs.record({ ...audit, actor: 'user',
          siteName: data.site?.name, siteId: data.site?.id || audit.siteId,
          level: status >= 400 || problem ? 'error' : batch?.failures?.length ? 'warning' : status === 202 ? 'info' : 'success',
          message: problem || (batch ? `已修改 ${batch.enabled ?? batch.disabled ?? 0} 个令牌，失败 ${batch.failures.length} 个` : status === 202 ? '已接受任务，完成结果另行记录' : '操作已完成'),
          details: { ...audit.details, httpStatus: status, failed: batch?.failures?.length, succeeded: batch?.enabled ?? batch?.disabled } })
      }
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(data))
    }
    try {
      const host = new URL(`http://${req.headers.host}`)
      const remote = req.socket.remoteAddress
      // Production accepts only the configured host from the loopback proxy.
      // Forwarded headers never grant access; nginx authenticates the caller.
      const allowedHost = publicURL ? req.headers.host === publicURL.host : localHost(host.hostname)
      if (!allowedHost || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
        throw new SyncError('渠道配置当前仅支持本机访问。', 403)
      }
      if (req.method !== 'GET' && (req.headers.origin !== (publicURL?.origin ?? host.origin) || !req.headers['content-type']?.startsWith('application/json'))) {
        throw new SyncError('请求来源无效。', 403)
      }
      authorized = true
      if (gatewayRoute) {
        if (!gatewayStore) throw new SyncError('主站存储尚未配置，无法读取或保存主站。', 503)
        if (path === '/api/user-gateways') {
          if (req.method === 'GET') return send(200, { gateways: [...userGateways.gateways.values()].map(gateway => publicGateway(gateway, now())) })
          if (req.method !== 'POST') throw new SyncError('该接口不支持此操作。', 405)
          const input = await readJSON(req, 16384)
          return send(200, { gateways: [...userGateways.gateways.values()].map(gateway => publicGateway(gateway, now())),
            gateway: await userGateways.save(input) })
        }
        const match = path.match(/^\/api\/user-gateways\/([^/]+)\/(check|keys|models|attribute)$/)
        const keyMatch = path.match(/^\/api\/user-gateways\/([^/]+)\/keys\/([^/]+)$/)
        const removeMatch = path.match(/^\/api\/user-gateways\/([^/]+)$/)
        if (keyMatch && req.method === 'DELETE') {
          return send(200, { gateway: await userGateways.removeKey(keyMatch[1], keyMatch[2]) })
        }
        if (removeMatch && req.method === 'DELETE') {
          await userGateways.remove(removeMatch[1])
          return send(200, { gateways: [...userGateways.gateways.values()].map(gateway => publicGateway(gateway, now())) })
        }
        if (!match || req.method !== 'POST') throw new SyncError('接口不存在。', 404)
        const input = await readJSON(req, 16384)
        const [, id, action] = match
        if (action === 'check') return send(200, { gateway: await userGateways.check(id) })
        if (action === 'keys') return send(200, { gateway: await userGateways.addKey(id, input) })
        if (action === 'models') {
          if (!isRecord(input) || typeof input.keyId !== 'string' || !input.keyId) throw new SyncError('请指定要同步的下游密钥。')
          return send(200, { gateway: await userGateways.syncModels(id, input.keyId) })
        }
        return send(200, await userGateways.attribute(id, input))
      }
      if (logsRoute) {
        if (req.method !== 'GET') throw new SyncError('日志接口只支持读取。', 405)
        return send(200, logs.query(new URL(req.url, host.origin).searchParams))
      }
      if (qqRoute) {
        if (path.endsWith('/test')) {
          if (req.method !== 'POST') throw new SyncError('该接口不支持此操作。', 405)
          await readJSON(req, 4096)
          return send(200, { qq: await qq.sendTest() })
        }
        if (req.method === 'GET') return send(200, { qq: qq.view() })
        if (req.method !== 'POST') throw new SyncError('该接口不支持此操作。', 405)
        const input = await readJSON(req, 4096)
        const saved = await qq.save(input)
        audit.details = { enabled: saved.enabled }
        return send(200, { qq: saved })
      }
      if (settingsRoute) {
        if (req.method === 'GET') return send(200, settingsView())
        if (req.method !== 'POST') throw new SyncError('该接口不支持此操作。', 405)
        const input = await readJSON(req, 4096)
        if (!settingsStore) throw new SyncError('设置存储尚未配置。', 503)
        const updated = applySettings(settings, input)
        try { settingsStore.save([updated]) }
        catch { throw new SyncError('设置保存失败，原阈值未改变，请检查存储后重试。', 500) }
        audit.details = { lowBalanceThreshold: updated.lowBalanceThreshold, rateChangeMinPercent: updated.rateChangeMinPercent,
          subscriptionDailyRemainingPercent: updated.subscriptionDailyRemainingPercent, subscriptionWeeklyRemainingPercent: updated.subscriptionWeeklyRemainingPercent,
          subscriptionMonthlyRemainingPercent: updated.subscriptionMonthlyRemainingPercent, subscriptionExpiryDays: updated.subscriptionExpiryDays }
        settings = updated
        return send(200, settingsView())
      }
      if (secondaryRoute) return await secondarySites(req, path, send)
      if (channelRoute) {
        if (!channelStore) throw new SyncError('上游渠道存储尚未配置，无法读取或保存渠道。', 503)
        if (fundingMatch) {
          const action = fundingMatch[2]
          if (req.method !== (action === 'options' ? 'GET' : 'POST')) throw new SyncError('该接口不支持此操作。', 405)
          const result = await funding(fundingMatch[1], action, action === 'options' ? {} : await readJSON(req, 4096))
          return send(200, { ...result, channels: publicChannels() })
        }
        if (watchMatch) {
          if (req.method !== 'POST') throw new SyncError('该接口不支持此操作。', 405)
          const input = await readJSON(req, 4096)
          if (!isRecord(input) || typeof input.ignoreAnnouncements !== 'boolean') throw new SyncError('公告开关无效。')
          const id = watchMatch[1]
          await auth.exclusive(id, async () => {
            const channel = channels.get(id)
            if (!channel || channel.routingSource) throw new SyncError('上游渠道不存在。', 404)
            const previous = channel.ignoreAnnouncements === true
            channel.ignoreAnnouncements = input.ignoreAnnouncements
            if (input.ignoreAnnouncements && channel.upstreamWatch) channel.upstreamWatch = { ...channel.upstreamWatch, announcementAlerts: [] }
            try {
              if (channelStore.saveChannels) channelStore.saveChannels([channel])
              else channelStore.save([...channels.values()])
            } catch {
              channel.ignoreAnnouncements = previous
              throw new SyncError('公告开关尚未保存，请检查磁盘后重试。', 500)
            }
          })
          audit.action = input.ignoreAnnouncements ? '静默上游公告' : '恢复上游公告'
          audit.details = { ignoreAnnouncements: input.ignoreAnnouncements }
          return send(200, { channels: publicChannels() })
        }
        if (authMatch || balanceMatch || groupsMatch) {
          if (req.method !== 'POST') throw new SyncError('该接口不支持此操作。', 405)
          await readJSON(req, 16384)
          if (authMatch && channels.get(authMatch[1])?.provider === 'newapi') throw new SyncError('当前授权检测仅适用于 Sub2API 用户登录。')
          await auth.check((authMatch || balanceMatch || groupsMatch)[1], { groups: Boolean(groupsMatch) })
          return send(200, { channels: publicChannels() })
        }
        if (req.method === 'GET') return send(200, { channels: publicChannels() })
        if (req.method !== 'POST') throw new SyncError('该接口不支持此操作。', 405)
        const input = await readJSON(req, 16384)
        if (!isRecord(input) || !['newapi', 'sub2api'].includes(input.provider) || !textValue(input.name) || input.name.length > 100) {
          throw new SyncError('请填写渠道名称并选择上游类型。')
        }
        if (input.rechargeRate != null && !validRechargeRate(input.rechargeRate)) throw new SyncError('充值倍率必须是大于 0 的有限数字。')
        if (input.autoProbeNewTokens != null && typeof input.autoProbeNewTokens !== 'boolean') throw new SyncError('自动探测设置无效。')
        let url
        try { url = new URL(input.endpoint) } catch { throw new SyncError('请填写有效的上游地址。') }
        if (url.username || url.password || url.search || url.hash ||
            !(url.protocol === 'https:' || (url.protocol === 'http:' && localHost(url.hostname)))) {
          throw new SyncError('请填写 HTTPS 上游地址（本机站点支持 HTTP），不包含账号、查询参数或锚点。')
        }
        const id = input.id || randomUUID()
        Object.assign(audit, { channelId: id, channelName: input.name, action: input.id ? input.edit ? '编辑上游渠道' : '重新授权上游渠道' : '添加上游渠道', details: { rechargeRate: input.rechargeRate } })
        return await auth.exclusive(id, async () => {
          const previous = input.id ? channels.get(input.id) : null
          if (input.id && !previous) throw new SyncError('上游渠道不存在，请刷新列表。', 404)
          if (input.edit && !previous) throw new SyncError('编辑目标不存在，请刷新列表。', 404)
          if (previous && (previous.provider !== input.provider || previous.endpoint !== url.href.replace(/\/$/, ''))) {
            throw new SyncError('重新授权时请保留原渠道的类型和地址。')
          }
          const editing = Boolean(input.edit && previous)
          const channel = { ...(previous ?? {}), id, name: input.name.trim(), provider: input.provider,
            endpoint: url.href.replace(/\/$/, ''), createdAt: previous?.createdAt || new Date().toISOString(),
            rechargeRate: input.rechargeRate == null ? (previous?.rechargeRate ?? 1) : input.rechargeRate,
            autoProbeNewTokens: input.autoProbeNewTokens ?? (previous ? previous.autoProbeNewTokens === true : true) }
          if (channel.provider === 'newapi') {
            channel.token = textValue(input.token).replace(/^Bearer\s+/i, '')
            if (editing && !channel.token) channel.token = previous.token || ''
            if (/\s/.test(channel.token)) throw new SyncError('请填写有效的系统访问令牌。')
            channel.userId = textValue(input.userId) || (editing ? previous?.userId : '') || ''
            if ((input.userId != null && typeof input.userId !== 'string') || (channel.userId && !/^[1-9]\d*$/.test(channel.userId))) throw new SyncError('用户 ID 必须为正整数。')
            if (previous && !editing && !channel.token) throw new SyncError('重新授权时请填写系统访问令牌。')
          } else {
            channel.email = textValue(input.email) || (editing ? previous?.email : '') || ''
            if (editing && !input.password && channel.email !== previous.email) throw new SyncError('修改 Sub2API 邮箱时必须同时填写新密码。')
            if (input.password) {
              delete channel.token
              delete channel.refreshToken
              await loginSub2API(channel, input)
            } else if (!editing && previous) throw new SyncError('重新授权时请填写用户邮箱和密码。')
          }
          if (previous && (!editing || input.password || input.token)) {
            // Keep observations and preferences, but verify ownership of keys
            // under the replacement login before allowing further probes.
            channel.probeTokensUnavailable = true
            channel.apiKeys = { ...channel.apiKeys, status: 'loading' }
            channel.probeTokensNextSyncAt = null
          }
          // Commit only after login and disk write succeed; failed reauthorization
          // retains the previous channel instead of creating a duplicate.
          // Stop actions remain immediate while login waits on the network.
          if (previous?.probeDisabledTokenIds) channel.probeDisabledTokenIds = previous.probeDisabledTokenIds
          try {
            if (channelStore.saveChannels) channelStore.saveChannels([channel])
            else channelStore.save(previous ? [...channels.values()].map(item => item.id === channel.id ? channel : item) : [...channels.values(), channel])
          }
          catch { throw new SyncError('无法保存上游渠道，配置尚未写入本机，请检查磁盘空间及目录权限后重试。', 500) }
          channels.set(channel.id, channel)
          auth.reset(channel.id)
          return send(200, { channels: publicChannels() })
        })
      }
      if (probeTokenRoute) {
        if (req.method === 'GET') {
          const revision = channelStore?.revision
          const version = `${revision}:${secondaryStore?.revision}:${Math.floor(now() / 5000)}`
          if (!probeResponseCache || revision == null || probeResponseCache.version !== version) {
            const json = JSON.stringify({ probeTokens: publicProbeTokens(channels, now(), probeCosts), policy: probePolicy, channelSetup: publicProbeSetup() })
            probeResponseCache = { version, json, etag: `"${createHash('sha256').update(json).digest('hex')}"` }
          }
          const { json, etag } = probeResponseCache
          // nginx weakens ETags when compressing JSON; GET uses weak comparison.
          const unchanged = String(req.headers['if-none-match'] ?? '').split(',').some(value =>
            value.trim().replace(/^W\//, '') === etag || value.trim() === '*')
          res.writeHead(unchanged ? 304 : 200, {
            'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-cache', ETag: etag,
          })
          return res.end(unchanged ? undefined : json)
        }
        throw new SyncError('该接口只支持读取。', 405)
      }
      if (probeBatchRoute) {
        if (req.method !== 'POST') throw new SyncError('该接口只支持批量修改探测开关。', 405)
        if (!channelStore) throw new SyncError('上游渠道存储尚未配置。', 503)
        const enabled = path.endsWith('/batch-enable')
        const input = await readJSON(req, 2 * 1024 * 1024)
        if (!isRecord(input) || !Array.isArray(input.tokens) || !input.tokens.length || input.tokens.length > 10000
          || input.tokens.some(item => !isRecord(item) || typeof item.channelId !== 'string' || !item.channelId || item.channelId.length > 100
            || typeof item.id !== 'string' || !item.id || item.id.length > 100)) throw new SyncError('请选择有效的探针令牌，每次最多 10,000 个。')
        const targets = new Map(input.tokens.map(item => [JSON.stringify([item.channelId, item.id]), item]))
        const grouped = new Map()
        for (const item of targets.values()) {
          const ids = grouped.get(item.channelId) ?? []
          ids.push(item.id); grouped.set(item.channelId, ids)
        }
        const groups = [...grouped]
        const results = await Promise.allSettled(groups.map(async ([channelId, ids]) => enabled
          ? queueProbeAction(channelId, ids, current => changeProbeTokens(channelId, ids, true, current))
          : changeProbeTokens(channelId, ids, false)))
        const changes = [], failures = []
        let unchanged = 0, storageError
        results.forEach((result, index) => {
          if (result.status === 'fulfilled') {
            changes.push(...result.value.changes); failures.push(...result.value.failures); unchanged += result.value.unchanged
          } else {
            const [channelId, ids] = groups[index], channel = channels.get(channelId), error = result.reason
            if (error.storage) storageError = error
            for (const id of ids) failures.push({ channelId, id, channelName: channel?.name ?? channelId, name: id,
              error: error instanceof SyncError ? error.message : '修改探测开关失败，请重试。' })
          }
        })
        if (storageError && !changes.length) throw storageError
        for (const { channel, token } of changes) logs.record({ category: 'probes', actor: 'user', level: 'success', action: enabled ? '启用令牌探测' : '停止令牌探测',
          channelId: channel.id, channelName: channel.name, tokenId: token.id, message: '批量操作已保存', details: { enabled } })
        for (const failure of failures) logs.record({ category: 'probes', actor: 'user', level: 'error', action: '修改令牌探测失败',
          channelId: failure.channelId, channelName: failure.channelName, tokenId: failure.id, message: failure.error })
        return send(200, { probeTokens: publicProbeTokens(channels, now(), probeCosts), policy: probePolicy,
          batch: enabled ? { enabled: changes.length, alreadyEnabled: unchanged, failures }
            : { disabled: changes.length, alreadyDisabled: unchanged, failures } })
      }
      if (probeCreateRoute || probeDeleteRoute) {
        if (req.method !== 'POST') throw new SyncError('该接口只支持提交。', 405)
        if (!channelStore) throw new SyncError('上游渠道存储尚未配置。', 503)
        const input = probeDeleteRoute ? {} : await readJSON(req, 4096)
        const id = probeDeleteRoute?.[1] || textValue(input?.channelId)
        if (!id || id.length > 100) throw new SyncError('请选择上游渠道。')
        audit.channelId = id
        audit.channelName = channels.get(id)?.name
        if (probeDeleteRoute) {
          const tokenId = probeDeleteRoute[2]
          if (!/^[1-9]\d*$/.test(tokenId)) throw new SyncError('令牌编号无效。')
          const channel = channels.get(id)
          const token = channel?.probeTokens?.find(item => item.id === tokenId) || channel?.apiKeys?.items?.find(item => item.id === tokenId)
          if (!channel || !token) throw new SyncError('探针令牌不存在，请先同步上游令牌。', 404)
          if (!['newapi', 'sub2api'].includes(channel.provider)) throw new SyncError('该渠道不支持在此删除令牌。', 409)
          const usedBy = tokenUsedBy(id, tokenId)
          if (usedBy) throw new SyncError(`该令牌已关联调度站点「${usedBy}」，请先解除线路关联后再删除。`, 409)
          await auth.withAccount(id, async (current, _verify, sync) => {
            await deleteUserAPIKey(current, tokenId)
            await sync(current)
          })
        } else {
          if (!isRecord(input)) throw new SyncError('请填写令牌名称。')
          const name = textValue(input.name)
          if (!name || name.length > 50) throw new SyncError('令牌名称需为 1 至 50 个字符。')
          const groupId = input.groupId == null || input.groupId === '' ? '' : textValue(input.groupId)
          if ((input.groupId != null && typeof input.groupId !== 'string') || groupId.length > 100) throw new SyncError('分组无效。')
          audit.details = { name, groupId: groupId || null }
          await auth.withAccount(id, async (current, _verify, sync) => {
            if (!['newapi', 'sub2api'].includes(current.provider)) throw new SyncError('该渠道不支持在此创建令牌。', 409)
            if (groupId && !(current.userGroups?.groups ?? []).some(group => String(group.id) === groupId)) throw new SyncError('所选分组不在该渠道的可用线路中，请先同步分组。', 409)
            if (current.provider === 'sub2api' && groupId && !/^[1-9]\d*$/.test(groupId)) throw new SyncError('Sub2API 分组编号无效。')
            await createUserAPIKey(current, { name, groupId })
            await sync(current)
          })
        }
        return send(200, { probeTokens: publicProbeTokens(channels, now(), probeCosts), policy: probePolicy, channelSetup: publicProbeSetup() })
      }
      if (probeModelsRoute || probeTokenToggle || probeRevalidateRoute) {
        if (req.method !== 'POST') throw new SyncError('该接口只支持修改探测配置或刷新模型。', 405)
        if (!channelStore) throw new SyncError('上游渠道存储尚未配置。', 503)
        const match = probeModelsRoute || probeTokenToggle || probeRevalidateRoute
        const channel = channels.get(match[1]); const token = channel?.probeTokens?.find(item => item.id === match[2])
        if (!channel || !token) throw new SyncError('探针令牌不存在，请先同步上游令牌。', 404)
        const input = await readJSON(req, 4096)
        if (probeRevalidateRoute) {
          if (!isRecord(input) || typeof input.model !== 'string' || !input.model || input.model.length > 256) throw new SyncError('请指定要重新验证的模型。')
          audit.model = input.model
          await queueProbeAction(channel.id, [token.id], current => {
            if (!current(token.id)) throw new SyncError('重新验证已被后续停止操作取消。', 409)
            const latest = channels.get(channel.id), latestToken = latest?.probeTokens?.find(item => item.id === token.id)
            if (!latestToken) throw new SyncError('探针令牌已移除。', 404)
            const model = latestToken.probeModels?.find(item => item.id === input.model)
            if (!model) throw new SyncError('模型记录不存在，请刷新后重试。', 404)
            if (model.protocol === 'unsupported') throw new SyncError('此模型暂不支持自动探测。', 409)
            if (!latestToken.probeEnabled) throw new SyncError('请先启用此令牌的探测。', 409)
            setProbeEnabled(latest, latestToken, true)
            const costBlock = probeCosts(latest, latestToken).get(model.id)
            if (costBlock) throw new SyncError(costBlock.reason, 409)
            if (!model.revalidatePending && (model.autoPaused || model.status !== 'ok')) {
              const previous = { ...model }
              Object.assign(model, { autoPaused: false, revalidatePending: true, status: 'unknown', error: null, reason: null,
                nextProbeAt: new Date(Math.max(now(), nextModelProbeTime(latestToken, model))).toISOString() })
              try { saveProbes([latest]) } catch (error) {
                for (const key of Object.keys(model)) delete model[key]
                Object.assign(model, previous); throw error
              }
            }
          })
        } else if (probeModelsRoute) {
          await auth.exclusive(channel.id, async () => {
            const current = channels.get(channel.id)
            const currentToken = current?.probeTokens?.find(item => item.id === token.id)
            if (!currentToken || !usableAPIKey(currentToken, now()) || currentToken.stale || current.probeTokensError) throw new SyncError('令牌状态需要确认，请先同步令牌。', 409)
            await refreshModels(current, currentToken)
          })
        } else {
          if (!isRecord(input) || typeof input.enabled !== 'boolean') throw new SyncError('探测开关参数无效。')
          audit.action = input.enabled ? '启用令牌探测' : '停止令牌探测'
          audit.details = { enabled: input.enabled }
          const result = input.enabled
            ? await queueProbeAction(channel.id, [token.id], current => changeProbeTokens(channel.id, [token.id], true, current))
            : changeProbeTokens(channel.id, [token.id], false)
          if (result.failures.length) throw new SyncError(result.failures[0].error, result.failures[0].status)
        }
        return send(200, { probeTokens: publicProbeTokens(channels, now(), probeCosts), policy: probePolicy })
      }
      throw new SyncError('接口不存在。', 404)
    } catch (error) { send(error instanceof SyncError ? error.status : 500, { error: error instanceof SyncError ? error.message : '请求处理失败，请重试。',
      ...(error instanceof SyncError && error.code ? { code: error.code } : {}) }) }
  }
  middleware.logs = logs
  middleware.closeStores = () => { logs.flush(); channelStore?.close?.(); secondaryStore?.close?.(); settingsStore?.close?.(); qqStore?.close?.() }
  middleware.auth = auth
  middleware.discovery = discovery
  middleware.routing = secondarySites.automation
  middleware.qq = qq
  middleware.probes = {
    runDue: runProbes,
    start() {
      if (!probeTimer) { probesStopped = false; probeTimer = setInterval(() => { void runProbes() }, 1000); probeTimer.unref(); void runProbes() }
      qq.start()
    },
    async stop() { probesStopped = true; clearInterval(probeTimer); probeTimer = null; qq.stop(); for (const controller of probeControllers.values()) controller.abort(); await Promise.allSettled([...probeTasks.values()]) },
  }
  return middleware
}

export function monitorPlugin() {
  const middleware = monitorAPI({ channelStore: createChannelStore(), secondaryStore: createSecondarySiteStore(), settingsStore: createConsoleSettingsStore(), gatewayStore: createUserGatewayStore(), qqStore: createQQBotStore() })
  return { name: 'signal-monitor',
    configureServer(server) { server.middlewares.use(middleware); middleware.auth.start(); middleware.probes.start() },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
      middleware.auth.start(); middleware.probes.start()
      server.httpServer.once('close', () => { void middleware.discovery.stop(); middleware.probes.stop(); void middleware.auth.stop() })
    },
    closeBundle() { return Promise.allSettled([middleware.discovery.stop(), middleware.probes.stop(), middleware.auth.stop()]).then(() => middleware.closeStores()) },
  }
}
