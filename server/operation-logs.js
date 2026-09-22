import { createHash, randomUUID } from 'node:crypto'
import { SyncError } from './upstream-client.js'

export const logCategories = { routing: '自动调度', upstream: '上游同步与授权', probes: '探测配置与模型', discovery: '线路识别', funding: '充值兑换', settings: '系统设置', system: '服务运行' }
const levels = ['info', 'success', 'warning', 'error']
const fields = ['siteId', 'siteName', 'channelId', 'channelName', 'tokenId', 'accountId', 'accountName', 'model']
const detailFields = new Set(['before', 'after', 'modelsBefore', 'modelsAfter', 'addedModels', 'removedModels', 'availableModels', 'retainedModels', 'modelResults', 'excludedModels', 'state', 'previousState', 'reason', 'httpStatus', 'latencyMs', 'enabled', 'groupId', 'count', 'succeeded', 'failed', 'unchanged', 'status', 'orderId', 'requestId', 'rechargeRate', 'lowBalanceThreshold', 'imported', 'retention', 'error'])

// Only explicit public fields enter logs. Never serialize requests, credentials or payment responses.
export function createOperationLogs({ store, channels = new Map(), now = Date.now }) {
  let sites = new Map(), storageError = null, dropped = 0
  const queue = [], outcomes = new Map()
  const secrets = () => [...channels.values(), ...sites.values()].flatMap(item => [item.token, item.refreshToken,
    ...(item.probeTokens ?? []).map(token => token.key)]).filter(value => typeof value === 'string' && value.length >= 6)
  function redact(value) {
    let result = String(value ?? '')
    for (const secret of secrets()) result = result.replaceAll(secret, '[已隐藏]')
    return result.replace(/\bBearer\s+\S+/gi, 'Bearer [已隐藏]').replace(/\bsk-[A-Za-z0-9_-]+/g, '[已隐藏]')
      .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|turnstile[_-]?token|cookie|authorization)\s*[=:]\s*)[^\s,;]+/gi, '$1[已隐藏]').slice(0, 2000)
  }
  function cleanDetails(value) {
    return Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => detailFields.has(key)).map(([key, item]) => [key,
      Array.isArray(item) ? [...item.slice(0, 500).map(redact), ...(item.length > 500 ? [`仅记录前 500 项，共 ${item.length} 项`] : [])] : typeof item === 'number' || typeof item === 'boolean' || item == null ? item : redact(item)]))
  }
  function flush() {
    if (!store?.appendLog) return
    try {
      while (queue.length) {
        store.appendLog(queue[0])
        queue.shift()
      }
      storageError = null
    } catch {
      if (!storageError) console.error('[operation-logs] 日志写入失败，请检查磁盘和数据库；待写入日志暂存在当前进程。')
      storageError = '日志写入失败，请检查磁盘空间和数据库。部分记录暂存在进程内，重启可能丢失。'
    }
  }
  function record(input) {
    if (!store?.appendLog) return
    const entry = { id: input.id || randomUUID(), at: Number.isFinite(Date.parse(input.at)) ? new Date(input.at).toISOString() : new Date(now()).toISOString(),
      category: Object.hasOwn(logCategories, input.category) ? input.category : 'system',
      level: levels.includes(input.level) ? input.level : 'info', actor: input.actor === 'user' ? 'user' : input.actor === 'legacy' ? 'legacy' : 'system',
      action: redact(input.action), message: redact(input.message), details: cleanDetails(input.details) }
    const context = { ...input, siteName: input.siteName ?? sites.get(input.siteId)?.name,
      channelName: input.channelName ?? channels.get(input.channelId)?.name,
      accountName: input.accountName ?? sites.get(input.siteId)?.accounts?.find(account => String(account.id) === String(input.accountId))?.name }
    for (const field of fields) if (context[field] != null) entry[field] = redact(context[field])
    queue.push(entry)
    if (queue.length > 1000) { queue.shift(); dropped++ }
    flush()
  }
  function changed(key, value, input) {
    const signature = JSON.stringify(value)
    if (outcomes.get(key) === signature) return
    outcomes.set(key, signature)
    record(input)
  }
  function query(params) {
    if (!store?.queryLogs) throw new SyncError('日志数据库尚未配置。', 503)
    flush()
    const kind = params.get('kind') || 'operations'
    const category = params.get('category') || '', level = params.get('level') || ''
    const page = Number(params.get('page') || 1), pageSize = Number(params.get('pageSize') || 5)
    const hours = Number(params.get('hours') || 24)
    const until = params.has('until') ? Date.parse(params.get('until')) : now()
    const q = (params.get('q') || '').trim(), siteId = params.get('site') || '', channelId = params.get('channel') || ''
    if (!['operations', 'probes'].includes(kind) || category && !Object.hasOwn(logCategories, category) || level && !levels.includes(level)
      || !Number.isSafeInteger(page) || page < 1 || ![5, 10, 20, 50, 100].includes(pageSize) || !Number.isSafeInteger((page - 1) * pageSize) || ![1, 24, 168, 720, 0].includes(hours)
      || kind === 'probes' && level === 'info' || until < 0 || !Number.isFinite(until) || until > now() + 60000 || q.length > 200 || siteId.length > 100 || channelId.length > 100) throw new SyncError('日志筛选参数无效。', 400)
    const from = hours ? until - hours * 3600000 : 0
    const channelIds = kind === 'probes' && siteId ? [...new Set([
      ...Object.values(sites.get(siteId)?.automation?.routes ?? {}).map(route => route.channelId),
      ...Object.values(sites.get(siteId)?.automation?.accounts ?? {}).map(account => account.channelId),
    ].filter(Boolean))] : undefined
    const result = store.queryLogs({ kind, from, until, category, level, siteId, channelId, channelIds, q, page, pageSize })
    if (kind === 'probes') result.items = result.items.map(item => {
      const channel = channels.get(item.channelId)
      return { id: item.id, at: item.at, category: 'probes', level: item.status === 'ok' ? 'success' : item.status === 'error' ? 'error' : 'warning',
        actor: 'system', action: '模型探测', channelId: item.channelId, channelName: channel?.name || item.channelId,
        tokenId: item.tokenId, model: item.model, message: item.status === 'ok' ? '模型响应验证通过' : redact(item.error || item.reason || '本次结果待确认'),
        details: cleanDetails({ httpStatus: item.httpStatus, latencyMs: item.latencyMs, reason: item.reason, status: item.status }) }
    })
    // Also redact historical entries against currently configured credentials.
    result.items = result.items.map(item => ({ ...item, action: redact(item.action), message: redact(item.message), details: cleanDetails(item.details),
      ...Object.fromEntries(fields.filter(field => item[field] != null).map(field => [field, redact(item[field])])) }))
    return { ...result, page, pageSize, until: new Date(until).toISOString(), storage: 'sqlite',
      warning: [storageError, dropped ? `日志存储故障期间有 ${dropped} 条记录未能保留。` : null].filter(Boolean).join('；') || null,
      categories: logCategories, sites: [...sites.values()].map(site => ({ id: site.id, name: site.name })),
      channels: [...channels.values()].filter(channel => !channel.routingArchived).map(channel => ({ id: channel.id, name: channel.name })) }
  }
  return { record, changed, query, flush,
    reset(key) { outcomes.delete(key) }, setSites(value) { sites = value },
    importEvents(site) {
      for (const entry of (site.automation?.events ?? [])) {
        if (entry.logId) continue
        const state = site.automation.accounts?.[entry.accountId]
        record({ id: `legacy:${createHash('sha256').update(JSON.stringify([site.id,entry])).digest('hex')}`,
          at: entry.at, category: 'routing', actor: 'legacy', level: /暂停|错误|停用/.test(entry.action) ? 'warning' : 'info',
          action: entry.action, message: entry.reason, siteId: site.id, siteName: site.name, accountId: entry.accountId, accountName: entry.name,
          channelId: state?.channelId, channelName: channels.get(state?.channelId)?.name, tokenId: state?.tokenId,
          details: { imported: true } })
      }
    },
  }
}
