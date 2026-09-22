import { randomUUID } from 'node:crypto'
import { SyncError, isRecord, textValue, localHost, readJSON, upstream } from './upstream-client.js'
import { automationView, createRouteAutomation } from './route-automation.js'
import { accountConnection, createRouteBindings, publicAccount, routingSignature } from './route-bindings.js'

const rate = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const siteFields = site => ({ id: site.id, name: site.name, endpoint: site.endpoint, provider: 'sub2api',
  groups: site.groups, accounts: (site.accounts ?? []).map(publicAccount), syncedAt: site.syncedAt, error: site.error,
  accountsSyncedAt: site.accountsSyncedAt ?? null, accountsError: site.accountsError ?? null, needsAuthorization: !site.token })

async function readList(site, resource, normalize) {
  const items = [], ids = new Set()
  let total, pageSize = 100
  for (let page = 1; page <= 1000; page++) {
    const params = new URLSearchParams({ page: String(page), page_size: String(pageSize), sort_by: 'id', sort_order: 'asc' })
    if (resource === 'accounts') params.set('lite', 'true')
    const data = await upstream(site, `/api/v1/admin/${resource}?${params}`)
    if (!isRecord(data) || !Array.isArray(data.items) || data.items.length > data.page_size || !Number.isSafeInteger(data.total) || data.total < 0 || data.total > 100000 ||
      data.page !== page || !Number.isSafeInteger(data.page_size) || data.page_size < 1 || data.page_size > 100 ||
      (total != null && (data.total !== total || data.page_size !== pageSize))) {
      throw new SyncError('调度站点分页数据不完整或同步期间发生变化，请重新同步。', 502)
    }
    total = data.total
    pageSize = data.page_size
    for (const item of data.items) {
      if (!isRecord(item) || !Number.isSafeInteger(item.id) || item.id <= 0 || ids.has(item.id)) {
        throw new SyncError('调度站点返回重复或无效的分组/账号，请重新同步。', 502)
      }
      ids.add(item.id)
      // Persist display fields and matching fingerprints, never raw account credentials.
      items.push(normalize(item))
    }
    if (items.length === total) return items
    if (items.length > total || data.items.length !== pageSize) throw new SyncError('调度站点分页数据不完整，请重新同步。', 502)
  }
  throw new SyncError('调度站点数据超过单次同步范围。', 502)
}

async function readAccounts(site) {
  const accounts = await readList(site, 'accounts', account => {
    if (account.group_ids != null && (!Array.isArray(account.group_ids) || account.group_ids.some(id => !Number.isSafeInteger(id) || id <= 0))) {
      throw new SyncError('调度站点账号分组归属格式无效。', 502)
    }
    return { id: account.id, name: textValue(account.name) || `#${account.id}`, platform: textValue(account.platform),
      type: textValue(account.type), status: textValue(account.status), schedulable: typeof account.schedulable === 'boolean' ? account.schedulable : null,
      groupIds: account.group_ids ?? [], lastUsedAt: account.last_used_at ?? null,
      cooldownUntil: account.temp_unschedulable_until ?? null, rateLimitUntil: account.rate_limit_reset_at ?? null, overloadUntil: account.overload_until ?? null,
      routingSignature: routingSignature(account),
      ...(account.type === 'apikey' ? { connection: accountConnection(account) } : {}) }
  })
  let permissionError
  for (const account of accounts) {
    if (!account.connection?.endpoint || account.connection.keyHash) continue
    if (permissionError) { account.connection.error = permissionError; continue }
    try {
      // Current Sub2API redacts list/detail keys. Its authorized export accepts an
      // exact account ID; request one at a time because exports omit account IDs.
      const data = await upstream(site, `/api/v1/admin/accounts/data?ids=${account.id}&include_proxies=false`)
      const item = data?.accounts?.[0]
      if (!Array.isArray(data?.accounts) || data.accounts.length !== 1 || !isRecord(item) ||
          (item.id != null && item.id !== account.id) || (textValue(item.name) || `#${account.id}`) !== account.name || item.type !== account.type || item.platform !== account.platform) {
        throw new SyncError('调度站点未返回该账号的完整配置。', 502)
      }
      const connection = accountConnection(item)
      if (!connection.keyHash || connection.endpoint !== account.connection.endpoint) throw new SyncError('调度站点凭据不完整或配置已变化。', 502)
      account.connection = connection
    } catch (error) {
      const denied = [401, 403].includes(error.status)
      account.connection.error = denied ? '调度站点未授权读取完整 Key，请检查凭据导出权限或手动关联。' : '暂未读取到完整 Key，请重新同步调度站点或手动关联。'
      if (denied) permissionError = account.connection.error
    }
  }
  return accounts
}

async function synchronize(site, now, requireGroups = false) {
  const [groups, accounts] = await Promise.allSettled([
    readList(site, 'groups', group => ({ id: group.id, name: textValue(group.name) || `#${group.id}`,
      platform: textValue(group.platform), status: textValue(group.status), rate: rate(group.rate_multiplier),
      exclusive: group.is_exclusive === true, subscriptionType: textValue(group.subscription_type),
      peak: group.peak_rate_enabled === true ? { start: textValue(group.peak_start), end: textValue(group.peak_end), factor: rate(group.peak_rate_multiplier) } : null })),
    readAccounts(site),
  ])
  const updated = { ...site }
  if (accounts.status === 'fulfilled') {
    updated.accounts = accounts.value
    updated.accountsSyncedAt = new Date(now()).toISOString()
    updated.accountsError = null
  } else updated.accountsError = accounts.reason instanceof SyncError ? accounts.reason.message : '调度站点账号同步失败，请稍后重试。'
  if (groups.status === 'fulfilled') {
    updated.groups = groups.value
    updated.syncedAt = new Date(now()).toISOString()
    updated.error = null
  } else {
    if (requireGroups) throw groups.reason
    updated.error = groups.reason instanceof SyncError ? groups.reason.message : '调度站点分组同步失败，请稍后重试。'
  }
  return updated
}

export function createSecondarySitesAPI({ store, channels = new Map(), channelStore, auth, discovery, now = Date.now, logs }) {
  const sites = new Map((store?.load() ?? []).map(site => [site.id, site]))
  logs?.setSites(sites)
  const bindings = createRouteBindings({ channels, now })
  const publicSite = site => ({ ...siteFields(site), automation: automationView(site, channels, now()), routes: bindings.view(site) })
  const busy = new Set()
  function save(site) {
    try { store.save([...sites.values()].filter(item => item.id !== site.id).concat(site)) }
    catch { throw Object.assign(new SyncError('调度站点配置保存失败，请检查磁盘空间和目录权限。', 500), { storage: true }) }
    sites.set(site.id, site)
  }
  const automation = createRouteAutomation({ sites, busy, save, synchronize, channels, channelStore, auth, now, logs })
  const handler = async (req, path, send) => {
    if (!store) throw new SyncError('调度站点存储尚未配置。', 503)
    if (path === '/api/secondary-sites' && req.method === 'GET') {
      return send(200, { sites: [...sites.values()].map(publicSite), storage: 'sqlite' })
    }
    if (path === '/api/secondary-sites' && req.method === 'POST') {
      const input = await readJSON(req, 16384)
      if (input.autoPush != null && typeof input.autoPush !== 'boolean') throw new SyncError('自动推送设置无效。')
      if (!isRecord(input) || !textValue(input.name) || input.name.length > 100 || (input.provider != null && input.provider !== 'sub2api')) {
        throw new SyncError('请填写调度站点名称，调度站点仅支持 Sub2API。')
      }
      let url
      try { url = new URL(input.endpoint) } catch { throw new SyncError('请填写有效的调度站点地址。') }
      if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || (url.protocol === 'http:' && localHost(url.hostname)))) {
        throw new SyncError('请填写 HTTPS 调度站点地址（本机支持 HTTP），不包含账号、查询参数或锚点。')
      }
      url.pathname = url.pathname.replace(/\/(?:api\/v1(?:\/admin)?|api|v1)\/?$/, '').replace(/\/$/, '')
      const endpoint = url.href.replace(/\/$/, '')
      const previous = sites.get(input.id)
      if (input.id && !previous) throw new SyncError('调度站点不存在，请刷新后重试。', 404)
      if (previous && busy.has(previous.id)) throw new SyncError('调度站点正在同步，请稍后重试。', 409)
      if (input.token != null && typeof input.token !== 'string') throw new SyncError('请填写有效的 Admin API Key。')
      const token = textValue(input.token) || (previous?.endpoint === endpoint ? previous.token : '')
      if (!token || /\s/.test(token) || token.length > 4096) throw new SyncError('请填写有效的 Admin API Key；更换调度站点地址时需重新填写。')
      const site = { ...(previous?.endpoint === endpoint ? previous : {}), id: previous?.id || randomUUID(),
        name: input.name.trim(), endpoint, provider: 'sub2api', authMode: 'admin-api-key', token,
        groups: previous?.endpoint === endpoint ? previous.groups : [], error: null }
      if (!previous) site.automation = { direction: 'push', enabled: input.autoPush !== false, routes: {}, accounts: {}, events: [] }
      busy.add(site.id)
      try {
        const updated = await synchronize(site, now, true)
        save(updated)
        return send(200, { site: publicSite(updated) })
      } finally { busy.delete(site.id) }
    }
    const automationMatch = path.match(/^\/api\/secondary-sites\/([^/]+)\/automation$/)
    if (automationMatch && req.method === 'POST') {
      const site = sites.get(automationMatch[1])
      if (!site) throw new SyncError('调度站点不存在。', 404)
      if (busy.has(site.id)) throw new SyncError('自动调度正在核对线路，请稍后重试。', 409)
      const input = await readJSON(req, 4096)
      if (!isRecord(input)) throw new SyncError('自动调度配置无效。')
      return send(200, { site: publicSite(automation.configure(site, input)) })
    }
    const discoveryMatch = path.match(/^\/api\/secondary-sites\/([^/]+)\/discovery$/)
    if (discoveryMatch && ['GET', 'POST'].includes(req.method)) {
      const input = req.method === 'POST' ? await readJSON(req, 65536) : null
      const site = sites.get(discoveryMatch[1])
      if (!site || !discovery) throw new SyncError('调度站点不存在或线路识别尚未配置。', 404)
      if (req.method === 'GET') return send(200, { job: discovery.view(site.id) })
      if (busy.has(site.id)) throw new SyncError('调度站点正在同步或识别，请稍后重试。', 409)
      busy.add(site.id)
      try {
        const job = discovery.start(site, input, async () => {
          const updated = await synchronize(sites.get(site.id), now)
          save(updated)
          return updated
        }, () => busy.delete(site.id))
        return send(202, { job })
      } catch (error) { busy.delete(site.id); throw error }
    }
    const bindingMatch = path.match(/^\/api\/secondary-sites\/([^/]+)\/bindings$/)
    if (bindingMatch && ['GET', 'POST'].includes(req.method)) {
      const input = req.method === 'POST' ? await readJSON(req, 524288) : null
      const site = sites.get(bindingMatch[1])
      if (!site) throw new SyncError('调度站点不存在，请刷新后重试。', 404)
      if (req.method === 'GET') return send(200, { ...bindings.options(site), routes: bindings.view(site) })
      if (busy.has(site.id)) throw new SyncError('调度站点正在同步，请稍后重试。', 409)
      const updated = bindings.update(site, input)
      save(updated)
      return send(200, { site: publicSite(updated) })
    }
    const match = path.match(/^\/api\/secondary-sites\/([^/]+)\/sync$/)
    if (match && req.method === 'POST') {
      await readJSON(req, 16384)
      const site = sites.get(match[1])
      if (!site) throw new SyncError('调度站点不存在，请刷新后重试。', 404)
      if (busy.has(site.id)) throw new SyncError('调度站点正在同步，请稍后重试。', 409)
      busy.add(site.id)
      try {
        const updated = await synchronize(site, now)
        save(updated)
        return send(200, { site: publicSite(updated) })
      } finally { busy.delete(site.id) }
    }
    throw new SyncError('调度站点接口不存在或不支持此操作。', 404)
  }
  handler.automation = automation
  handler.snapshot = () => [...sites.values()]
  return handler
}
