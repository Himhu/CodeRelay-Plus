import { SyncError, isRecord, textValue, upstream } from './upstream-client.js'
import { accountSite } from './channel-balance.js'

const rate = value => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new SyncError('上游返回的分组倍率无效，已保留上次结果。', 502)
  return value
}

export function normalizeSub2APIGroups(groups, rates = {}) {
  if (!Array.isArray(groups) || (rates !== null && !isRecord(rates))) {
    throw new SyncError('上游站点未返回可用分组或专属倍率。', 502)
  }
  const seen = new Set()
  return groups.map(group => {
    if (!isRecord(group) || !Number.isSafeInteger(group.id) || group.id <= 0 || !textValue(group.name)) {
      throw new SyncError('上游站点返回的分组格式无效。', 502)
    }
    if (seen.has(group.id)) throw new SyncError('上游返回重复分组，已保留上次结果。', 502)
    seen.add(group.id)
    const defaultRate = rate(group.rate_multiplier)
    const override = rates?.[group.id]
    const userRate = override == null ? null : rate(override)
    return { id: String(group.id), name: group.name, description: textValue(group.description),
      platform: textValue(group.platform), defaultRate, userRate,
      status: textValue(group.status) || 'unknown', subscriptionType: textValue(group.subscription_type) || 'unknown',
      longContextPricing: group.long_context_pricing_enabled === true,
      // A user rate replaces the default; zero is a valid override.
      rate: userRate ?? defaultRate, source: userRate === null ? 'default' : 'custom',
      peak: group.peak_rate_enabled === true
        ? { start: textValue(group.peak_start), end: textValue(group.peak_end), factor: rate(group.peak_rate_multiplier) }
        : null }
  })
}

export function normalizeNewAPIUserGroups(groups) {
  if (!isRecord(groups)) throw new SyncError('上游未返回当前账户的可用分组。', 502)
  return Object.entries(groups).map(([name, group]) => {
    if (!name.trim() || !isRecord(group)) throw new SyncError('上游返回的分组格式无效。', 502)
    const automatic = name === 'auto' && ['自动', 'auto'].includes(group.ratio)
    return { id: name, name, description: textValue(group.desc), platform: '',
      status: 'active', subscriptionType: 'standard', longContextPricing: false,
      rate: automatic ? null : rate(group.ratio), defaultRate: null, userRate: null,
      source: automatic ? 'automatic' : 'account', peak: null }
  })
}

export async function readUserGroups(channel) {
  const site = accountSite(channel)
  if (channel.provider === 'newapi') {
    // This authenticated route includes the current user's special ratio.
    // /api/user/groups is public and cannot supply account-specific pricing.
    return normalizeNewAPIUserGroups(await upstream(site, '/api/user/self/groups'))
  }
  const groups = await upstream(site, '/api/v1/groups/available')
  const rates = await upstream(site, '/api/v1/groups/rates')
  return normalizeSub2APIGroups(groups, rates)
}

export function userGroupsView(channel) {
  const snapshot = channel.userGroups ?? {}
  return { groups: snapshot.groups ?? null, status: snapshot.status ?? 'unchecked',
    updatedAt: snapshot.updatedAt ?? null, error: snapshot.error ?? null }
}

export function effectiveRouteCost(channel, group) {
  const recharge = channel.rechargeRate ?? 1
  if (!Number.isFinite(group?.rate) || group.rate < 0 || group.source === 'automatic' ||
      !Number.isFinite(recharge) || recharge <= 0 || group.peak && (!Number.isFinite(group.peak.factor) || group.peak.factor < 0)) return null
  // Use the peak ceiling because the upstream billing timezone is not known.
  const cost = group.rate * Math.max(1, group.peak?.factor ?? 1) / recharge
  return Number.isFinite(cost) ? cost : null
}

export function probeTokenPricing(channel, token) {
  const snapshot = channel.userGroups
  const group = token.groupId == null ? null : snapshot?.groups?.find(group => String(group.id) === String(token.groupId))
  // Match the token's billing group, never another group with a similar name.
  return { rate: group?.rate ?? null, source: group?.source ?? (token.groupId === 'auto' ? 'automatic' : null),
    peak: group?.peak ? { start: group.peak.start, end: group.peak.end, factor: group.peak.factor } : null,
    status: snapshot?.status ?? 'unchecked', updatedAt: snapshot?.updatedAt ?? null }
}
