// NewAPI user-gateway connection: admin log attribution plus downstream probe keys.
// This is the site end users actually call, so probes here exercise the real
// billing path and are deliberately kept separate from upstream channel probes.
import { randomUUID } from 'node:crypto'
import { SyncError, isRecord, textValue, localHost } from './upstream-client.js'

const MAX_KEYS = 200
const MAX_MODELS = 10000

// Reuse the shared site client shape so credential handling and error text
// stay identical to the existing upstream synchronization.
const siteOf = gateway => ({ endpoint: gateway.endpoint, token: gateway.token, provider: 'newapi', userId: textValue(gateway.userId) || undefined })

export function validGatewayEndpoint(value) {
  let url
  try { url = new URL(value) } catch { return null }
  if (url.username || url.password || url.search || url.hash) return null
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && localHost(url.hostname)))) return null
  return url.href.replace(/\/$/, '')
}

export function publicGateway(gateway, now = Date.now()) {
  return {
    id: gateway.id, name: gateway.name, endpoint: gateway.endpoint, userId: gateway.userId ?? '',
    status: gateway.status ?? 'unknown', error: gateway.error ?? null,
    version: gateway.version ?? null, username: gateway.username ?? null, role: gateway.role ?? null,
    checkedAt: gateway.checkedAt ?? null, modelsSyncedAt: gateway.modelsSyncedAt ?? null,
    keys: (gateway.keys ?? []).map(key => publicGatewayKey(key, now)),
  }
}

export function publicGatewayKey(key, now = Date.now()) {
  const models = key.models ?? []
  return {
    id: key.id, name: key.name, groupId: key.groupId ?? null, groupName: key.groupName ?? null,
    masked: maskKey(key.key), status: key.status ?? 'active',
    probeEnabled: key.probeEnabled === true, capacity: key.capacity ?? null,
    modelsCount: models.length,
    modelsError: key.modelsError ?? null, modelsSyncedAt: key.modelsSyncedAt ?? null,
    lastProbeAt: key.lastProbeAt ?? null, nextProbeAt: key.nextProbeAt ?? null,
    // Never return the downstream key itself; the UI only needs to identify it.
    models: models.map(model => ({ id: model.id, status: model.status ?? 'unknown', latencyMs: model.latencyMs ?? null,
      lastProbeAt: model.lastProbeAt ?? null, error: model.error ?? null, httpStatus: model.httpStatus ?? null,
      reason: model.reason ?? null })),
    updatedAt: key.updatedAt ?? null,
  }
}

export function maskKey(value) {
  const text = textValue(value)
  if (!text) return null
  if (text.length <= 8) return `${text.slice(0, 2)}${'*'.repeat(Math.max(1, text.length - 2))}`
  return `${text.slice(0, 4)}${'*'.repeat(6)}${text.slice(-4)}`
}

function adminPath(path) {
  if (!path.startsWith('/api/')) throw new SyncError('主站路径无效。', 400)
  return path
}

export function createUserGateways({ store, request, now = Date.now, logs } = {}) {
  const gateways = new Map((store?.load() ?? []).map(gateway => [gateway.id, gateway]))
  // Fail loudly with an actionable message rather than a TypeError when the
  // caller forgets to inject the shared site client.
  const call = (...args) => {
    if (typeof request !== 'function') throw new SyncError('主站客户端尚未配置。', 503)
    return request(...args)
  }

  const persist = gateway => {
    if (!store) throw new SyncError('主站存储尚未配置。', 503)
    try { store.saveChannels ? store.saveChannels([gateway]) : store.save([...gateways.values()].map(item => item.id === gateway.id ? gateway : item)) }
    catch { throw new SyncError('无法保存主站配置，内容尚未写入本机，请检查磁盘空间及目录权限后重试。', 500) }
    gateways.set(gateway.id, gateway)
  }

  // A successful read here proves the administrator token is accepted and that
  // channel attribution data will be available when a fault needs explaining.
  async function verify(gateway) {
    const data = await call(siteOf(gateway), '/api/user/self')
    if (!isRecord(data)) throw new SyncError('主站账户接口响应格式不符。', 502)
    const role = Number(data.role)
    if (!Number.isFinite(role) || role < 10) {
      throw new SyncError('该令牌不是管理员身份，线路归因需要主站管理员权限（角色 ≥ 10）。', 403)
    }
    let status = {}
    try { status = await call(siteOf(gateway), '/api/status') } catch { /* version display is optional */ }
    return { username: textValue(data.username) || textValue(data.display_name) || null, role,
      version: textValue(status?.version) || null }
  }

  // Read the model catalog the downstream key can actually reach. This is the
  // user-visible surface, not the upstream token's declared catalog.
  async function readModels(gateway, key) {
    const data = await call({ ...siteOf(gateway), token: key.key, userId: '' }, '/v1/models')
    const items = data?.data ?? data?.models
    if (!isRecord(data) && !Array.isArray(items)) throw new SyncError('主站模型列表响应格式不符。', 502)
    if (!Array.isArray(items)) throw new SyncError('主站未返回模型列表。', 502)
    const models = new Map()
    for (const item of items) {
      const id = typeof item === 'string' ? item : textValue(item?.id ?? item?.name)
      if (!id || id.length > 256 || /[\x00-\x1f\x7f]/.test(id)) throw new SyncError('主站返回无效的模型名称。', 502)
      models.set(id, { id, status: 'unknown', latencyMs: null, lastProbeAt: null, error: null })
    }
    if (models.size > MAX_MODELS) throw new SyncError(`模型超过单次读取上限（${MAX_MODELS} 个）。`, 502)
    return [...models.values()]
  }

  function validateKeyInput(input) {
    if (!isRecord(input)) throw new SyncError('请填写下游密钥信息。')
    const key = textValue(input.key)
    if (!key || key.length > 512 || /[\s*•]/.test(key)) throw new SyncError('请填写有效的下游 API 密钥。')
    const groupId = input.groupId == null || input.groupId === '' ? null : input.groupId
    if (groupId !== null && (!Number.isSafeInteger(Number(groupId)) || Number(groupId) < 0)) throw new SyncError('分组 ID 必须为非负整数。')
    return { key, groupId: groupId === null ? null : Number(groupId), name: textValue(input.name).slice(0, 100) || null, groupName: textValue(input.groupName).slice(0, 100) || null }
  }

  return {
    gateways,
    async save(input) {
      if (!isRecord(input) || !textValue(input.name) || input.name.length > 100) throw new SyncError('请填写主站名称。')
      const endpoint = validGatewayEndpoint(textValue(input.endpoint))
      if (!endpoint) throw new SyncError('请填写有效的 HTTPS 主站地址（本机站点支持 HTTP），不包含账号、查询参数或锚点。')
      const previous = input.id ? gateways.get(input.id) : null
      if (input.id && !previous) throw new SyncError('主站配置不存在，请刷新列表。', 404)
      const token = textValue(input.token).replace(/^Bearer\s+/i, '')
      if (/\s/.test(token)) throw new SyncError('请填写有效的主站管理员令牌。')
      if (!token && !previous) throw new SyncError('请填写主站管理员令牌。')
      if (!token && previous && input.token != null) throw new SyncError('请填写主站管理员令牌。')
      const gateway = { ...(previous ?? {}), id: previous?.id ?? input.id ?? randomId(), name: textValue(input.name).trim(),
        endpoint, userId: textValue(input.userId) || previous?.userId || '',
        token: token || previous.token, createdAt: previous?.createdAt ?? new Date(now()).toISOString(),
        keys: previous?.keys ?? [], status: 'checking', error: null }
      const verified = await verify(gateway)
      Object.assign(gateway, verified, { status: 'authorized', error: null, checkedAt: new Date(now()).toISOString() })
      persist(gateway)
      logs?.record?.({ category: 'gateway', actor: 'user', level: 'success', action: previous ? '编辑主站连接' : '添加主站连接',
        message: `已连接 ${gateway.name}`, details: { endpoint: gateway.endpoint, role: verified.role } })
      return publicGateway(gateway, now())
    },
    async check(id) {
      const gateway = gateways.get(id)
      if (!gateway) throw new SyncError('主站配置不存在，请刷新列表。', 404)
      try {
        const verified = await verify(gateway)
        Object.assign(gateway, verified, { status: 'authorized', error: null, checkedAt: new Date(now()).toISOString() })
      } catch (error) {
        gateway.status = error instanceof SyncError && [401, 403].includes(error.status) ? 'unauthorized' : 'error'
        gateway.error = error.message
        throw error
      } finally { persist(gateway) }
      return publicGateway(gateway, now())
    },
    async addKey(id, input) {
      const gateway = gateways.get(id)
      if (!gateway) throw new SyncError('主站配置不存在，请刷新列表。', 404)
      const parsed = validateKeyInput(input)
      if ((gateway.keys ?? []).length >= MAX_KEYS) throw new SyncError(`单个主站最多保存 ${MAX_KEYS} 把下游密钥。`)
      if ((gateway.keys ?? []).some(item => item.key === parsed.key)) throw new SyncError('该下游密钥已存在于此主站。', 409)
      const key = { id: randomId(), ...parsed, status: 'active', probeEnabled: false, models: [], modelsError: null,
        modelsSyncedAt: null, lastProbeAt: null, nextProbeAt: null, updatedAt: new Date(now()).toISOString() }
      // Validate before persisting so a bad key never enters storage.
      key.models = await readModels(gateway, key)
      key.modelsSyncedAt = new Date(now()).toISOString()
      gateway.keys = [...(gateway.keys ?? []), key]
      persist(gateway)
      logs?.record?.({ category: 'gateway', actor: 'user', level: 'success', action: '添加主站下游密钥',
        message: `已校验并保存下游密钥（${key.models.length} 个模型）`, details: { gatewayId: gateway.id, groupId: key.groupId } })
      return publicGateway(gateway, now())
    },
    async removeKey(id, keyId) {
      const gateway = gateways.get(id)
      if (!gateway) throw new SyncError('主站配置不存在，请刷新列表。', 404)
      const keys = gateway.keys ?? []
      if (!keys.some(item => item.id === keyId)) throw new SyncError('下游密钥不存在，请刷新列表。', 404)
      gateway.keys = keys.filter(item => item.id !== keyId)
      persist(gateway)
      logs?.record?.({ category: 'gateway', actor: 'user', level: 'info', action: '移除主站下游密钥', message: '已移除下游密钥', details: { gatewayId: gateway.id } })
      return publicGateway(gateway, now())
    },
    async syncModels(id, keyId) {
      const gateway = gateways.get(id)
      if (!gateway) throw new SyncError('主站配置不存在，请刷新列表。', 404)
      const key = (gateway.keys ?? []).find(item => item.id === keyId)
      if (!key) throw new SyncError('下游密钥不存在，请刷新列表。', 404)
      try {
        const models = await readModels(gateway, key)
        const previous = new Map((key.models ?? []).map(model => [model.id, model]))
        // A catalog refresh is not a new probe; retain the existing observation.
        key.models = models.map(model => ({ ...model, ...previous.get(model.id) }))
        key.modelsError = null
      } catch (error) {
        // A failed read must not look like an empty catalog.
        key.modelsError = error instanceof SyncError ? error.message : '主站模型列表读取失败。'
        key.status = error instanceof SyncError && [401, 403].includes(error.status) ? 'invalid' : key.status
        persist(gateway)
        throw error
      }
      key.modelsSyncedAt = new Date(now()).toISOString()
      persist(gateway)
      return publicGateway(gateway, now())
    },
    async remove(id) {
      const gateway = gateways.get(id)
      if (!gateway) throw new SyncError('主站配置不存在，请刷新列表。', 404)
      gateways.delete(id)
      if (store) store.save([...gateways.values()])
      logs?.record?.({ category: 'gateway', actor: 'user', level: 'info', action: '移除主站连接', message: `已移除 ${gateway.name}` })
      return true
    },

    // Explain a fault by reading who actually served the failing requests.
    // The main site answers this on the admin log API: the public `channel`
    // field names the channel, and other.admin_info.use_channel lists every
    // channel that was attempted for one request. Normal users cannot see
    // either, which is why this path requires the administrator token.
    async attribute(id, input = {}) {
      const gateway = gateways.get(id)
      if (!gateway) throw new SyncError('主站配置不存在，请刷新列表。', 404)
      const model = textValue(input.model)
      if (!model || model.length > 256) throw new SyncError('请指定要归因的模型名称。')
      const minutes = Number(input.minutes ?? 30)
      if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1440) throw new SyncError('归因时间范围须为 1 至 1,440 分钟。')
      const end = now(), start = end - minutes * 60000
      const tokenName = textValue(input.tokenName)
      // Successful requests live in consume logs (type 2); each failed channel
      // attempt writes its own error log (type 5) and those are the rows that
      // carry the channel that actually broke. Error rows only exist when the
      // main site enables ERROR_LOG_ENABLED, so both are read and merged.
      const readType = async type => {
        const query = new URLSearchParams({ model_name: model, type: String(type), p: '1', page_size: '100',
          start_timestamp: String(Math.floor(start / 1000)), end_timestamp: String(Math.ceil(end / 1000)) })
        if (tokenName) query.set('token_name', tokenName)
        const data = await call(siteOf(gateway), adminPath(`/api/log/?${query}`))
        if (!Array.isArray(data?.items)) throw new SyncError('主站日志接口响应格式不符。', 502)
        return { items: data.items, total: Number(data?.total) || 0 }
      }
      const consume = await readType(2)
      let errorRows
      try { errorRows = await readType(5) } catch { errorRows = { items: [], total: 0 } }
      const attempts = []
      const collect = (rows, kind) => {
        for (const item of rows.items) {
          // other is a JSON string in the log row and can carry privileged keys.
          let other = item?.other
          if (typeof other === 'string' && other) { try { other = JSON.parse(other) } catch { other = null } }
          const admin = isRecord(other?.admin_info) ? other.admin_info : {}
          const used = Array.isArray(admin.use_channel) ? admin.use_channel.map(Number).filter(Number.isSafeInteger) : []
          const channelId = Number.isSafeInteger(Number(item?.channel)) ? Number(item.channel) : null
          attempts.push({ kind, at: item?.created_at ? new Date(Number(item.created_at) * 1000).toISOString() : null,
            model: textValue(item?.model_name) || model, channelId, channelName: textValue(item?.channel_name) || null,
            usedChannelIds: used.length ? used : channelId == null ? [] : [channelId],
            useTimeSeconds: Number.isFinite(Number(item?.use_time)) ? Number(item.use_time) : null,
            isStream: item?.is_stream === true, tokenName: textValue(item?.token_name) || null,
            errorType: textValue(other?.error_type) || null, errorCode: textValue(other?.error_code) || null,
            statusCode: Number.isFinite(Number(other?.status_code)) ? Number(other.status_code) : null,
            requestId: textValue(item?.request_id) || null, upstreamRequestId: textValue(item?.upstream_request_id) || null })
        }
      }
      collect(consume, 'consume')
      collect(errorRows, 'error')
      attempts.sort((a, b) => String(a.at).localeCompare(String(b.at)))
      // Channel names are resolved from the public field on either row kind.
      const channelNames = new Map()
      for (const item of attempts) if (item.channelId != null && item.channelName) channelNames.set(item.channelId, item.channelName)
      const channelIds = [...new Set(attempts.flatMap(item => item.usedChannelIds))]
      const failedChannelIds = [...new Set(attempts.filter(item => item.kind === 'error' && item.channelId != null).map(item => item.channelId))]
      return { gatewayId: gateway.id, model, from: new Date(start).toISOString(), to: new Date(end).toISOString(),
        sampleSize: attempts.length, truncated: consume.total > consume.items.length || errorRows.total > errorRows.items.length,
        total: consume.total + errorRows.total, consumeTotal: consume.total, errorTotal: errorRows.total,
        // A missing error log means the main site has error logging disabled, so
        // absence of failed rows is not evidence that nothing failed.
        errorLogAvailable: errorRows.total > 0,
        channelIds, failedChannelIds,
        channels: channelIds.map(id => ({ id, name: channelNames.get(id) ?? null })),
        attempts }
    },
  }
}

const randomId = () => randomUUID()
