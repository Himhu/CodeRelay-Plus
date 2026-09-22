import { createHash, randomUUID } from 'node:crypto'
import { SyncError, isRecord, textValue } from './upstream-client.js'
import { usableAPIKey } from './user-api-keys.js'
import { accountSite } from './channel-balance.js'
import { probeRouteName } from './route-name.js'

const canonical = value => Array.isArray(value) ? value.map(canonical) : isRecord(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const sorted = values => [...values].sort()
const timeIsFresh = (value, now, ttl) => Number.isFinite(Date.parse(value)) && Date.parse(value) <= now && now - Date.parse(value) <= ttl
const configFresh = (site, now) => !site.error && !site.accountsError && timeIsFresh(site.syncedAt, now, 86400000) && timeIsFresh(site.accountsSyncedAt, now, 86400000)
const tokenFor = (channels, binding) => channels.get(binding.upstreamId)?.probeTokens?.find(token => String(token.id) === binding.tokenId)
const accountRevision = (site, account) => digest([site.endpoint, account?.id, account?.platform, account?.type,
  sorted(account?.groupIds ?? []), account?.routingSignature ?? null, ...(account?.connection ? [account.connection] : [])])
const tokenRevision = (channel, token) => digest([channel?.endpoint, channel?.provider, token?.id, token?.key, token?.groupId])
const groupRevision = (site, group) => digest([site.endpoint, group?.id, group?.platform])
const bindingVersion = site => site.bindingVersion ?? 'initial'

// Hash configuration only; raw credentials, headers and model mappings never enter public responses.
export function routingSignature(item) {
  const credentials = isRecord(item.credentials) ? item.credentials : {}
  return digest([item.base_url ?? null, item.models ?? null, item.model_mapping ?? null, item.proxy_id ?? null,
    Object.keys(credentials).sort().map(key => [key, credentials[key]])])
}

// Keep paths and schemes distinct; only the conventional trailing /v1 is equivalent.
export function connectionEndpoint(value) {
  try {
    const url = new URL(textValue(value))
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null
    return url.origin + url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')
  } catch { return null }
}

const keyHash = value => typeof value === 'string' && value.trim() && value.length <= 4096 && !/[\s*•…]/.test(value.trim()) && !value.includes('...')
  ? digest(value.trim()) : null

export function accountConnection(item) {
  const credentials = isRecord(item.credentials) ? item.credentials : {}
  const mapping = credentials.model_mapping
  const validModel = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value)
  return { endpoint: connectionEndpoint(credentials.base_url ?? item.base_url), keyHash: keyHash(credentials.api_key),
    mapping: mapping == null ? {} : isRecord(mapping) && Object.entries(mapping).every(([from, to]) => validModel(from) && validModel(to)) ? mapping : null,
    passthrough: item.platform === 'openai' && (typeof item.extra?.openai_passthrough === 'boolean'
      ? item.extra.openai_passthrough : item.extra?.openai_oauth_passthrough === true) }
}

function automaticModels(account, token) {
  const mapping = account.connection.mapping
  if (!mapping || !['openai', 'anthropic', 'gemini', 'grok', 'deepseek', 'zhipu', 'kimi', 'minimax'].includes(account.platform)) return []
  const catalog = new Map((token.probeModels ?? []).filter(model => model.protocol !== 'unsupported').map(model => [model.id, model]))
  if (account.connection.passthrough || !Object.keys(mapping).length) {
    return [...catalog.values()].map(model => ({ model: model.id, upstreamModel: model.id, protocol: model.protocol }))
  }
  const wildcards = Object.keys(mapping).filter(name => name.endsWith('*')).sort((a, b) => b.length - a.length || a.localeCompare(b))
  const names = new Set([...Object.keys(mapping).filter(name => !name.includes('*')), ...catalog.keys()])
  return [...names].flatMap(name => {
    const pattern = Object.hasOwn(mapping, name) ? name : wildcards.find(pattern => name.startsWith(pattern.slice(0, -1)))
    const target = pattern === undefined ? undefined : mapping[pattern]
    const model = catalog.get(target)
    return model ? [{ model: name, upstreamModel: model.id, protocol: model.protocol }] : []
  })
}

function automaticBinding(site, account, index, endpoints) {
  const connection = account.connection
  const missing = reason => ({ binding: null, autoMatchReason: reason })
  if (site.autoBindingDisabled?.includes(account.id)) return missing('已手动关闭自动关联，可在关联窗口恢复。')
  if (account.type !== 'apikey') return missing('此账号不是 API Key 类型，需手动关联。')
  if (!connection) return missing('同步调度站点后，将自动匹配 URL 和 Key。')
  if (!connection.endpoint) return missing('调度站点账号未提供有效的上游 URL。')
  if (!endpoints.has(connection.endpoint)) return missing('监控站尚未接入此 URL 对应的上游，请先添加上游渠道。')
  if (!connection.keyHash) return missing(connection.error || '调度站点未返回完整 Key，无法确认具体令牌。')
  const candidates = index.get(JSON.stringify([connection.endpoint, connection.keyHash])) ?? []
  if (!candidates.length) return missing('未找到 URL 和 Key 一致的令牌，请先同步对应上游的令牌。')
  if (candidates.length !== 1) return missing('URL 和 Key 匹配到多个令牌记录，请手动选择。')
  const { channel, token } = candidates[0]
  const models = automaticModels(account, token)
  return { autoMatchReason: models.length ? null : '令牌已匹配；请同步支持模型或手动确认模型映射。',
    binding: { accountId: account.id, upstreamId: channel.id, tokenId: String(token.id), source: 'auto', models,
      confirmedAt: site.accountsSyncedAt, accountRevision: accountRevision(site, account), tokenRevision: tokenRevision(channel, token) } }
}

export const publicAccount = account => ({ id: account.id, name: account.name, platform: account.platform,
  type: account.type, status: account.status, schedulable: account.schedulable, groupIds: account.groupIds,
  lastUsedAt: account.lastUsedAt ?? null, cooldownUntil: account.cooldownUntil ?? null, rateLimitUntil: account.rateLimitUntil ?? null, overloadUntil: account.overloadUntil ?? null })

function probeState(channel, token, model, now) {
  if (!model) return 'missing'
  if (!token.probeEnabled) return 'disabled'
  if (model.autoPaused) return 'excluded'
  if (model.protocol === 'unsupported') return 'unsupported'
  if (!token.key || !usableAPIKey(token, now) || token.stale || token.modelsError || channel.probeTokensUnavailable ||
      (channel.balance?.status === 'ok' && channel.balance.amount <= 0)) return 'paused'
  if (model.revalidatePending || !model.lastProbeAt) return 'unknown'
  if (!timeIsFresh(model.lastProbeAt, now, 120000)) return 'stale'
  return ['ok', 'error', 'inconclusive'].includes(model.status) ? model.status : 'unknown'
}

function healthView(channel, token, selected, now) {
  const model = token?.probeModels?.find(item => item.id === selected.upstreamModel)
  const history = (model?.probeHistory ?? []).filter(item => Date.parse(item.at) <= now && Date.parse(item.at) >= now - 3600000)
  const success = history.filter(item => item.status === 'ok').length
  const failed = history.filter(item => item.status === 'error').length
  const lastSuccess = (model?.probeHistory ?? []).filter(item => item.status === 'ok' && Date.parse(item.at) <= now)
    .map(item => item.at).sort().at(-1) ?? null
  return { model: selected.model, upstreamModel: selected.upstreamModel, protocol: model?.protocol ?? selected.protocol,
    status: token ? probeState(channel, token, model, now) : 'missing', lastProbeAt: model?.lastProbeAt ?? null,
    lastSuccessAt: model?.status === 'ok' && model.lastProbeAt ? model.lastProbeAt : model?.probeHistorySummary?.lastSuccessAt ?? lastSuccess,
    error: model?.error ?? null, reason: model?.reason ?? null, latencyMs: model?.latencyMs ?? null,
    success, failed, successRate: success + failed ? success / (success + failed) * 100 : null }
}

export function createRouteBindings({ channels, now = Date.now }) {
  function options(site) {
    const upstreams = [...channels.values()].filter(channel => !channel.routingSource).map(channel => ({ id: channel.id, name: channel.name, endpoint: channel.endpoint,
      tokens: (channel.probeTokens ?? []).map(token => ({ id: String(token.id), name: probeRouteName(channel, token), groupName: token.groupName,
        status: token.status, models: (token.probeModels ?? []).map(model => ({ id: model.id, protocol: model.protocol,
          status: probeState(channel, token, model, now()) })) })) }))
    const context = digest([site.endpoint, (site.accounts ?? []).map(account => accountRevision(site, account)),
      site.groups.map(group => groupRevision(site, group)), [...channels.values()].map(channel => [channel.id, (channel.probeTokens ?? []).map(token =>
        [tokenRevision(channel, token), (token.probeModels ?? []).map(model => [model.id, model.protocol])])])])
    return { version: bindingVersion(site), context, upstreams }
  }

  function view(site) {
    const currentTime = now()
    const fresh = configFresh(site, currentTime)
    const bindings = site.accountBindings ?? []
    const index = new Map()
    const endpoints = new Set([...channels.values()].map(channel => connectionEndpoint(accountSite(channel).endpoint)))
    for (const channel of channels.values()) for (const token of channel.routingSource ? [] : channel.probeTokens ?? []) {
      const endpoint = connectionEndpoint(accountSite(channel).endpoint), hash = keyHash(token.key)
      if (!endpoint || !hash) continue
      // NewAPI's key endpoint returns the stored key; its gateway strips one
      // optional sk- prefix. Sub2API keys remain exact and case-sensitive.
      const hashes = new Set([hash, ...(channel.provider === 'newapi' ? [keyHash(`sk-${token.key.trim()}`)] : [])])
      for (const value of hashes) {
        if (!value) continue
        const identity = JSON.stringify([endpoint, value])
        if (!index.has(identity)) index.set(identity, [])
        index.get(identity).push({ channel, token })
      }
    }
    const accounts = (site.accounts ?? []).map(account => {
      const managed = site.automation?.enabled && site.automation.accounts?.[account.id]
      const managedChannel = managed?.managed && channels.get(managed.channelId)
      const managedToken = managedChannel?.probeTokens?.find(token => String(token.id) === managed.tokenId)
      const automatic = managedToken && { accountId: account.id, upstreamId: managedChannel.id, tokenId: String(managedToken.id), source: 'automation',
        models: automaticModels(account, managedToken), confirmedAt: site.accountsSyncedAt, accountRevision: accountRevision(site, account), tokenRevision: tokenRevision(managedChannel, managedToken) }
      const manual = automatic || bindings.find(item => item.accountId === account.id)
      const { binding, autoMatchReason = null } = manual ? { binding: manual } : automaticBinding(site, account, index, endpoints)
      const publicFields = { ...publicAccount(account), autoMatchReason, autoBindingDisabled: site.autoBindingDisabled?.includes(account.id) === true }
      if (!binding) return { ...publicFields, binding: null, models: [] }
      const channel = channels.get(binding.upstreamId), token = tokenFor(channels, binding)
      let status = !channel || !token ? 'missing' : binding.accountRevision !== accountRevision(site, account) ||
        binding.tokenRevision !== tokenRevision(channel, token) || binding.models.some(selected =>
          !token.probeModels?.some(model => model.id === selected.upstreamModel && model.protocol === selected.protocol)) ? 'changed' : 'confirmed'
      if (status === 'confirmed' && !fresh) status = 'stale'
      return { ...publicFields, binding: { upstreamId: binding.upstreamId, tokenId: binding.tokenId, source: binding.source || 'manual',
        upstreamName: channel?.name ?? binding.upstreamName, tokenName: token ? probeRouteName(channel, token) : binding.tokenName,
        endpoint: channel?.endpoint ?? null, confirmedAt: binding.confirmedAt, status },
        models: binding.models.map(selected => ({ ...healthView(channel, token, selected, currentTime),
          eligible: status === 'confirmed' && account.status === 'active' && account.schedulable === true && ![account.cooldownUntil, account.rateLimitUntil, account.overloadUntil].some(at => Date.parse(at) > currentTime) })) }
    })
    const groups = site.groups.map(group => {
      const members = accounts.filter(account => account.groupIds.includes(group.id))
      const models = new Map()
      for (const account of members) for (const model of account.models) {
        const identity = JSON.stringify([model.model, model.protocol])
        if (!models.has(identity)) models.set(identity, { model: model.model, protocol: model.protocol, routes: [] })
        models.get(identity).routes.push({ accountId: account.id, accountName: account.name, ...account.binding,
          bindingStatus: account.binding.status, ...model,
          eligible: model.eligible && group.status === 'active' })
      }
      return { groupId: group.id, unboundAccounts: members.filter(account => !account.binding).length,
        reviewAccounts: members.filter(account => account.binding && account.binding.status !== 'confirmed').length,
        models: [...models.values()].map(model => {
          const passing = model.routes.filter(route => route.eligible && route.status === 'ok')
          return { ...model, passed: passing.length, failed: model.routes.filter(route => route.eligible && route.status === 'error').length,
            unknown: model.routes.filter(route => route.eligible && !['ok', 'error'].includes(route.status)).length,
            unavailable: model.routes.filter(route => !route.eligible).length,
            independentTokens: new Set(passing.map(route => JSON.stringify([route.upstreamId, route.tokenId]))).size }
        }).sort((a, b) => a.model.localeCompare(b.model) || String(a.protocol).localeCompare(String(b.protocol))) }
    })
    return { version: bindingVersion(site), scope: 'upstream-direct', accounts, groups,
      orphanBindings: bindings.filter(binding => !site.accounts?.some(account => account.id === binding.accountId))
        .map(binding => ({ accountId: binding.accountId, accountName: binding.accountName, upstreamName: binding.upstreamName, tokenName: binding.tokenName })) }
  }

  function update(site, input) {
    if (!isRecord(input) || input.kind !== 'account' || input.version !== bindingVersion(site)) {
      throw new SyncError('关联配置已变化，请重新打开关联窗口。', 409)
    }
    const unlink = input.remove === true
    if (!unlink && (input.context !== options(site).context || !configFresh(site, now()))) throw new SyncError('站点配置已变化或过期，请同步后重新确认关联。', 409)
    const updated = { ...site, bindingVersion: randomUUID() }
    if (!Number.isSafeInteger(input.accountId) || input.accountId <= 0) throw new SyncError('账号参数无效。')
    updated.accountBindings = (site.accountBindings ?? []).filter(item => item.accountId !== input.accountId)
    updated.autoBindingDisabled = (site.autoBindingDisabled ?? []).filter(id => id !== input.accountId)
    if (unlink) { updated.autoBindingDisabled.push(input.accountId); return updated }
    const account = site.accounts?.find(item => item.id === input.accountId)
    if (input.automatic === true) {
      if (!account) throw new SyncError('调度站点账号已不存在，请刷新后重试。', 404)
      return updated
    }
    const channel = channels.get(input.upstreamId)
    const token = channel?.probeTokens?.find(item => String(item.id) === input.tokenId)
    if (!account || !channel || !token) throw new SyncError('账号或上游令牌已不存在，请刷新后重试。', 404)
    if (!Array.isArray(input.models) || !input.models.length || input.models.length > 1000) throw new SyncError('请选择 1 至 1,000 个关联模型。')
    const unique = new Set()
    const models = input.models.map(item => {
      if (!isRecord(item) || !textValue(item.model) || item.model.length > 256 || /[\x00-\x1f\x7f]/.test(item.model)) throw new SyncError('请填写有效的调度站点模型名称。')
      const model = token.probeModels?.find(model => model.id === item.upstreamModel)
      if (!model || model.protocol === 'unsupported') throw new SyncError('所选模型不存在或暂不支持探测。')
      const key = JSON.stringify([item.model.trim(), model.protocol])
      if (unique.has(key)) throw new SyncError('同一账号的模型名称和协议不能重复关联。')
      unique.add(key)
      return { model: item.model.trim(), upstreamModel: model.id, protocol: model.protocol }
    })
    updated.accountBindings.push({ accountId: account.id, accountName: account.name, upstreamId: channel.id, tokenId: String(token.id),
      upstreamName: channel.name, tokenName: probeRouteName(channel, token), models, confirmedAt: new Date(now()).toISOString(),
      accountRevision: accountRevision(site, account), tokenRevision: tokenRevision(channel, token) })
    return updated
  }
  return { options, view, update }
}
