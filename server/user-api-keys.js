import { SyncError, isRecord, textValue, upstream } from './upstream-client.js'
import { accountSite } from './channel-balance.js'

function date(value, seconds = false) {
  if (value == null || value === '' || (seconds && value <= 0)) return null
  const milliseconds = seconds ? value * 1000 : typeof value === 'string' ? Date.parse(value) : NaN
  if (!Number.isFinite(milliseconds) || !Number.isFinite(new Date(milliseconds).getTime())) throw new SyncError('API 密钥的时间字段无效，已保留上次结果。', 502)
  return new Date(milliseconds).toISOString()
}

export function normalizeAPIKey(provider, item) {
  if (!isRecord(item) || !Number.isSafeInteger(item.id) || item.id <= 0 || typeof item.name !== 'string') {
    throw new SyncError('上游返回的 API 密钥信息无效，已保留上次结果。', 502)
  }
  const sub = provider === 'sub2api'
  if (sub ? !Object.hasOwn(item, 'group_id') || (item.group_id != null && (!Number.isSafeInteger(item.group_id) || item.group_id <= 0)) || typeof item.status !== 'string'
    : typeof item.group !== 'string' || !Number.isInteger(item.status)) throw new SyncError('API 密钥的分组或状态无效，已保留上次结果。', 502)
  // The upstream list can include plaintext keys. Never copy key contents,
  // nested users, IP restrictions or other unrelated fields into snapshots.
  return { id: String(item.id), name: textValue(item.name) || `令牌 #${item.id}`,
    groupId: sub ? item.group_id == null ? null : String(item.group_id) : item.group || null,
    groupName: sub ? textValue(item.group?.name) : item.group,
    status: sub ? ['active', 'inactive', 'expired', 'quota_exhausted'].includes(item.status) ? item.status : 'unknown'
      : ({ 1: 'active', 2: 'inactive', 3: 'expired', 4: 'quota_exhausted' })[item.status] || 'unknown',
    createdAt: date(sub ? item.created_at : item.created_time, !sub),
    lastUsedAt: date(sub ? item.last_used_at : item.accessed_time, !sub),
    expiresAt: date(sub ? item.expires_at : item.expired_time, !sub) }
}

export const usableAPIKey = (item, now = Date.now()) => item.status === 'active' && (!item.expiresAt || Date.parse(item.expiresAt) > now)

export async function readUserAPIKeys(channel, options = {}) {
  const site = accountSite(channel)
  const sub = channel.provider === 'sub2api'
  const keys = new Map(), raw = new Map()
  let total, pageSize = 100
  // ponytail: up to 10,000 keys per account in the local console. A larger
  // deployment should use a paginated view instead of keeping one snapshot.
  for (let page = 1; ; page++) {
    const path = sub ? `/api/v1/keys?page=${page}&page_size=${pageSize}&sort_by=id&sort_order=asc`
      : `/api/token/?p=${page}&page_size=${pageSize}`
    const data = await upstream(site, path)
    if (!isRecord(data) || !Array.isArray(data.items) || !Number.isSafeInteger(data.total) || data.total < 0 ||
      !Number.isSafeInteger(data.page_size) || data.page_size < 1 || data.page_size > 1000 || (sub ? data.page : data.p ?? data.page) !== page
      || (!sub && data.p != null && data.page != null && data.p !== data.page)) {
      throw new SyncError('上游未返回完整的 API 密钥分页信息，已保留上次结果。', 502)
    }
    if (data.total > 10000) throw new SyncError('API 密钥超过单次查询上限（10,000 个），已保留上次结果。', 502)
    if (page === 1) { total = data.total; pageSize = data.page_size }
    if (data.total !== total || data.page_size !== pageSize || data.items.length !== Math.min(pageSize, total - keys.size)) {
      throw new SyncError('API 密钥列表不完整或分页期间发生变化，请重新刷新。', 502)
    }
    for (const item of data.items) {
      const key = normalizeAPIKey(channel.provider, item)
      if (keys.has(key.id)) throw new SyncError('上游分页返回重复的 API 密钥，请重新刷新。', 502)
      keys.set(key.id, key)
      raw.set(key.id, item)
    }
    if (keys.size === total) {
      const items = [...keys.values()]
      if (!options.credentials) return items
      const credentials = [], credentialErrors = []
      for (const item of items) {
        if (!usableAPIKey(item, options.now)) continue
        try {
          let secret
          if (sub) secret = textValue(raw.get(item.id)?.key)
          else secret = textValue((await upstream(site, `/api/token/${item.id}/key`, {} , 'POST'))?.key)
          if (!secret || secret.length > 4096 || /[\s*•]/.test(secret)) throw new SyncError('上游未返回有效的探针令牌。', 502)
          credentials.push({ ...item, key: secret })
        } catch (error) {
          credentialErrors.push(error instanceof SyncError ? error.message : '探针令牌读取失败。')
        }
      }
      return { items, credentials, credentialError: credentialErrors.length ? '部分 API 密钥无法读取完整内容；有历史配置的保留上次结果，其余等待重试。' : null }
    }
  }
}

export function userAPIKeysView(channel) {
  const snapshot = channel.apiKeys ?? {}
  return { items: snapshot.items ?? null, status: snapshot.status ?? 'unchecked',
    updatedAt: snapshot.updatedAt ?? null, error: snapshot.error ?? null }
}

export async function createUserAPIKey(channel, { name, groupId }) {
  const site = accountSite(channel)
  if (channel.provider === 'sub2api') {
    const body = { name }
    if (groupId) body.group_id = Number(groupId)
    await upstream(site, '/api/v1/keys', body)
    return
  }
  await upstream(site, '/api/token/', { name, expired_time: -1, remain_quota: 0, unlimited_quota: true, group: groupId || '' })
}

export async function deleteUserAPIKey(channel, id) {
  const site = accountSite(channel)
  await upstream(site, channel.provider === 'sub2api' ? `/api/v1/keys/${id}` : `/api/token/${id}`, undefined, 'DELETE')
}
