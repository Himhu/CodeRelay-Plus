import { SyncError, isRecord, textValue, upstream } from './upstream-client.js'
import { accountSite as authSite, sub2APIBalance, readNewAPIBalance, saveBalance, failBalance } from './channel-balance.js'
import { readUserGroups } from './user-groups.js'
import { readUserAPIKeys, usableAPIKey } from './user-api-keys.js'
import { normalizeSettings } from './console-settings.js'
import { syncUpstreamWatch } from './upstream-watch.js'

export function setTokens(site, tokens, now = Date.now()) {
  if (!textValue(tokens?.access_token) || /\s/.test(tokens.access_token)) throw new SyncError('上游站点没有返回有效的用户访问令牌。', 502)
  site.token = tokens.access_token
  site.refreshToken = textValue(tokens.refresh_token)
  const ttl = Number.isFinite(tokens.expires_in) && tokens.expires_in > 0 ? tokens.expires_in * 1000 : null
  site.expiresAt = ttl ? now + ttl : null
  site.refreshAt = ttl ? site.expiresAt - Math.min(60000, ttl / 2) : null
  site.authStatus = 'authorized'
  site.authCheckedAt = new Date(now).toISOString()
  site.authError = null
}

export async function loginSub2API(site, input) {
  if (!site.email || typeof input.password !== 'string' || !input.password) throw new SyncError('请填写用户邮箱和密码。')
  if (input.turnstileToken != null && (typeof input.turnstileToken !== 'string' || input.turnstileToken.length > 2048)) {
    throw new SyncError('请填写有效的人机验证凭证，长度不能超过 2048 个字符。')
  }
  const proof = textValue(input.turnstileToken)
  // A user-supplied proof is forwarded once to the site's normal verifier.
  // It is never cached, persisted, retried or used for session refresh.
  let tokens = await upstream(authSite(site), '/api/v1/auth/login', { email: site.email, password: input.password,
    ...(proof ? { turnstile_token: proof } : {}) })
  if (tokens?.requires_2fa) {
    if (!/^\d{6}$/.test(input.totpCode ?? '')) throw new SyncError(`该账号已开启两步验证，请输入当前六位验证码${proof ? '及新的人机验证凭证后重试' : ''}。`)
    tokens = await upstream(authSite(site), '/api/v1/auth/login/2fa', { temp_token: tokens.temp_token, totp_code: input.totpCode })
  }
  setTokens(site, tokens)
}

export function channelAuthView(channel, now = Date.now()) {
  let status = channel.authStatus || (channel.token ? 'unchecked' : 'missing')
  if (channel.provider === 'newapi') status = channel.token ? 'configured' : 'missing'
  else if (status === 'authorized' && channel.expiresAt && channel.expiresAt <= now) status = 'unchecked'
  return { status, checkedAt: channel.authCheckedAt ?? null, expiresAt: channel.expiresAt ?? null,
    refreshedAt: channel.authRefreshedAt ?? null, error: channel.authError ?? null,
    autoRefresh: channel.provider === 'sub2api' && Boolean(channel.refreshToken) }
}

export function createChannelAuth({ channels, store, now = Date.now, logs, watchSettings = () => normalizeSettings() }) {
  const busy = new Set()
  const tasks = new Set()
  const locks = new Map()
  const nextChecks = new Map()
  const failures = new Map()
  const unsaved = new Set()
  const checks = new Map()
  let timer, stopped = false

  function exclusive(id, operation) {
    const previous = locks.get(id)
    if (busy.has(id) && !previous) throw new SyncError('该渠道正在同步，请稍后重试。', 409)
    // Reserve the channel while queued so the next probe cycle cannot overtake a user action.
    busy.add(id)
    const task = Promise.resolve(previous).catch(() => {}).then(operation).finally(() => {
      if (locks.get(id) === task) { locks.delete(id); busy.delete(id) }
      tasks.delete(task)
    })
    locks.set(id, task)
    tasks.add(task)
    return task
  }

  function persist(channel) {
    try {
      if (store.saveChannels) store.saveChannels([...new Set([channel.id, ...unsaved])].map(id => channels.get(id)).filter(Boolean))
      else store.save([...channels.values()])
      unsaved.clear()
    }
    catch {
      unsaved.add(channel.id)
      const error = new SyncError('渠道信息尚未保存到本机，后台检查与自动续期已暂停；请检查磁盘空间和目录权限后重试。', 500)
      error.storage = true
      throw error
    }
  }

  function retryLater(channel) {
    const attempts = Math.min((failures.get(channel.id) || 0) + 1, 5)
    failures.set(channel.id, attempts)
    nextChecks.set(channel.id, now() + Math.min(300000, 15000 * 2 ** attempts))
  }

  async function verifyNewAPI(channel) {
    try {
      if (unsaved.size) persist(channel)
      if (!channel.token) return
      channel.balance = { ...channel.balance, status: 'checking' }
      saveBalance(channel, await readNewAPIBalance(channel), now())
      failures.delete(channel.id)
      nextChecks.set(channel.id, now() + 300000)
      persist(channel)
    } catch (error) {
      failBalance(channel, error, now())
      retryLater(channel)
      if (!error.storage) {
        try { persist(channel) } catch (failure) { failBalance(channel, failure, now()) }
      }
    }
  }

  async function verify(channel) {
    const refreshedAt = channel.authRefreshedAt
    await verifyAccount(channel)
    const error = channel.authError || channel.balance?.error
    const empty = channel.balance?.status === 'ok' && channel.balance.amount <= 0
    logs?.changed(`auth:${channel.id}`, [error || null, empty, channel.balance?.status], {
      category: 'upstream', channelId: channel.id, channelName: channel.name,
      level: error ? 'error' : empty ? 'warning' : 'success', action: error ? '账户检查异常' : empty ? '账户余额不足' : '账户检查正常',
      message: error || (empty ? '余额已耗尽，探测和自动调度等待补充后恢复' : '账户授权和余额查询正常') })
    if (channel.authRefreshedAt && channel.authRefreshedAt !== refreshedAt) logs?.record({ category: 'upstream', channelId: channel.id,
      channelName: channel.name, level: 'success', action: '用户授权自动续期', message: '新的登录授权已保存' })
  }

  async function verifyAccount(channel) {
    if (channel.provider === 'newapi') return verifyNewAPI(channel)
    let refreshed = false
    try {
      // A rotated token stays in memory if disk writes fail. Save it before
      // any further network request so the old refresh token is never reused.
      if (unsaved.size) persist(channel)
      if (!channel.token) {
        if (channel.authStatus === 'storage-error') {
          channel.authStatus = 'expired'
          channel.authError = '用户授权已失效，请重新授权。'
          persist(channel)
        }
        return
      }
      channel.authStatus = 'checking'
      channel.balance = { ...channel.balance, status: 'checking' }
      const refresh = async () => {
        if (!channel.refreshToken) throw new SyncError('登录已过期，请重新授权。', 401)
        channel.authStatus = 'refreshing'
        const tokens = await upstream({ ...authSite(channel), token: '' }, '/api/v1/auth/refresh', { refresh_token: channel.refreshToken })
        setTokens(channel, tokens, now())
        channel.authRefreshedAt = new Date(now()).toISOString()
        refreshed = true
        persist(channel)
      }
      const refreshAt = channel.refreshAt ?? (channel.expiresAt ? channel.expiresAt - 60000 : null)
      if (channel.refreshToken && refreshAt && now() >= refreshAt) await refresh()
      let user
      try { user = await upstream(authSite(channel), '/api/v1/auth/me') }
      catch (error) {
        if (error.status !== 401 || error.authInvalidated || refreshed || !channel.refreshToken) throw error
        await refresh()
        user = await upstream(authSite(channel), '/api/v1/auth/me')
      }
      if (!isRecord(user) || !Number.isSafeInteger(user.id) || user.id <= 0) throw new SyncError('上游未返回有效的用户身份，无法确认授权状态。', 502)
      channel.authStatus = 'authorized'
      channel.authError = null
      channel.authCheckedAt = new Date(now()).toISOString()
      // Balance parsing is independent of successful user authentication.
      try { saveBalance(channel, sub2APIBalance(user), now()) }
      catch (error) { failBalance(channel, error, now()) }
      // Some sites change token lifetimes. A successful identity check wins
      // over a past expiry estimate when no refresh token is available.
      if (!channel.refreshToken && channel.expiresAt && channel.expiresAt <= now()) channel.expiresAt = null
      failures.delete(channel.id)
      // Manual balance/identity checks must not postpone a token's refresh
      // deadline beyond the next scheduler tick, especially with short TTLs.
      nextChecks.set(channel.id, Math.max(now() + 1000, Math.min(now() + 300000,
        channel.refreshToken ? channel.refreshAt ?? Infinity : channel.expiresAt ?? Infinity)))
      persist(channel)
    } catch (error) {
      failBalance(channel, error, now())
      const expired = !error.policyBlocked && (error.status === 401 || error.status === 403)
      channel.authStatus = error.storage ? 'storage-error' : expired ? 'expired' : 'error'
      channel.authError = expired ? '用户授权已失效或已被上游撤销，请重新授权。'
        : error instanceof SyncError ? error.message : '授权状态暂时无法确认，稍后自动重试。'
      channel.authCheckedAt = new Date(now()).toISOString()
      if (expired) { delete channel.token; delete channel.refreshToken; channel.expiresAt = null; channel.refreshAt = null }
      retryLater(channel)
      if (!error.storage) {
        try { persist(channel) }
        catch (failure) { channel.authStatus = 'storage-error'; channel.authError = failure.message; failBalance(channel, failure, now()) }
      }
    }
  }

  async function syncGroups(channel) {
    channel.probeTokensNextSyncAt = new Date(now() + 60000).toISOString()
    try {
      // Reserve key-discovery retries separately from balance/session checks.
      persist(channel)
      if (!channel.token) throw new SyncError('请先重新授权后查询可用线路。', 401)
      if (channel.provider === 'sub2api' && channel.authStatus !== 'authorized') throw new SyncError('当前无法确认登录授权，请检查授权后重试。', 502)
      if (channel.provider === 'newapi' && channel.balance?.status === 'unauthorized') throw new SyncError('请核对系统访问令牌及用户 ID 后重新授权。', 401)
      channel.userGroups = { ...channel.userGroups, status: 'loading', error: null }
      channel.apiKeys = { ...channel.apiKeys, status: 'loading', error: null }
      const [groups, keys] = await Promise.allSettled([readUserGroups(channel), readUserAPIKeys(channel, { credentials: true, now: now() })])
      if (keys.status === 'fulfilled') {
        const result = keys.value
        channel.apiKeys = { items: result.items, status: 'ok', updatedAt: new Date(now()).toISOString(), error: null }
        channel.probeTokensUnavailable = false
        const fresh = new Map(result.credentials.map(key => [key.id, key]))
        const previous = new Map((channel.probeTokens ?? []).map(key => [key.id, key]))
        // Keep failures individually, but always remove known deleted/disabled keys.
        channel.probeTokens = result.items.filter(key => usableAPIKey(key, now())).flatMap(key => {
          const saved = previous.get(key.id)
          const state = { probeEnabled: saved ? saved.probeEnabled === true : channel.autoProbeNewTokens === true && !channel.probeDisabledTokenIds?.includes(key.id),
            autoRecoverModels: saved?.autoRecoverModels === true, nextProbeAt: saved?.nextProbeAt ?? null, probeModels: saved?.probeModels ?? [],
            modelsUpdatedAt: saved?.modelsUpdatedAt ?? null, modelsError: saved?.modelsError ?? null, modelsNextRefreshAt: saved?.modelsNextRefreshAt ?? null,
            lastProbeAt: saved?.lastProbeAt ?? null, probeStatus: saved?.probeStatus ?? null, probeLatencyMs: saved?.probeLatencyMs ?? null,
            probeError: saved?.probeError ?? null, lastProbeModel: saved?.lastProbeModel ?? null }
          if (fresh.has(key.id)) return [{ ...fresh.get(key.id), ...state, updatedAt: new Date(now()).toISOString(), stale: false }]
          return saved ? [{ ...key, key: saved.key, ...state, updatedAt: saved.updatedAt, stale: true }] : []
        })
        channel.probeTokensError = result.credentialError
        channel.probeTokensUpdatedAt = new Date(now()).toISOString()
      } else {
        channel.apiKeys = { ...channel.apiKeys, status: 'error',
          error: keys.reason instanceof SyncError ? keys.reason.message : 'API 密钥查询失败，请稍后刷新。' }
        channel.probeTokensUnavailable = true
      }
      if (keys.status === 'rejected') channel.probeTokensError = channel.apiKeys.error
      if (groups.status === 'rejected') throw groups.reason
      channel.userGroups = { groups: groups.value, status: 'ok', updatedAt: new Date(now()).toISOString(), error: null }
      if (!channel.probeTokensError) channel.probeTokensNextSyncAt = new Date(now() + 300000).toISOString()
      const watch = await syncUpstreamWatch(channel, groups.value, now(), watchSettings())
      if (watch.rateAlert) logs?.record({ category: 'upstream', channelId: channel.id, channelName: channel.name, level: 'warning', action: '倍率变化', message: watch.rateAlert.text })
      for (const alert of watch.newAnnouncements) logs?.record({ category: 'upstream', channelId: channel.id, channelName: channel.name, level: 'info', action: '上游公告', message: alert.text })
    } catch (error) {
      channel.userGroups = { ...channel.userGroups, status: 'error',
        error: error instanceof SyncError ? error.message : '线路倍率查询失败，请稍后重试。' }
      if (channel.apiKeys?.status === 'loading' || !channel.token || unsaved.size ||
        (channel.provider === 'sub2api' && channel.authStatus !== 'authorized') ||
        (channel.provider === 'newapi' && channel.balance?.status === 'unauthorized')) {
        channel.apiKeys = { ...channel.apiKeys, status: 'error', error: '当前无法查询 API 密钥，请检查授权或本机存储后重试。' }
        channel.probeTokensError = channel.apiKeys.error
      }
    }
    try { persist(channel) }
    catch {
      channel.userGroups = { ...channel.userGroups, status: 'error', error: '线路倍率尚未保存，请检查本机磁盘空间和目录权限。' }
      channel.apiKeys = { ...channel.apiKeys, status: 'error', error: 'API 密钥记录尚未保存，请检查本机磁盘空间和目录权限。' }
      channel.probeTokensError = '探针令牌尚未保存，请检查本机磁盘空间和目录权限。'
    }
    const error = channel.userGroups?.error || channel.probeTokensError
    logs?.changed(`groups:${channel.id}`, [error, channel.userGroups?.groups, (channel.probeTokens ?? []).map(token => [token.id, token.groupId, token.stale])], {
      category: 'upstream', channelId: channel.id, channelName: channel.name, level: error ? 'error' : 'success',
      action: error ? '分组或令牌同步异常' : '分组与令牌已同步', message: error || `已同步 ${channel.userGroups?.groups?.length ?? 0} 个分组、${channel.probeTokens?.length ?? 0} 个令牌` })
  }

  function check(id, { groups = false } = {}) {
    return exclusive(id, async () => {
      const channel = channels.get(id)
      if (!channel) throw new SyncError('上游渠道不存在。', 404)
      await verify(channel)
      if (groups) await syncGroups(channel)
    })
  }

  function runDue() {
      for (const channel of channels.values()) {
        if (stopped) break
        if ((!channel.token && !unsaved.has(channel.id)) || busy.has(channel.id) || checks.has(channel.id)) continue
        if (channel.provider === 'newapi' && channel.balance?.status === 'unauthorized') continue
        const groupsDue = (channel.apiKeys?.status !== 'ok' || Boolean(channel.probeTokensError) || channel.userGroups?.status !== 'ok'
          || !(Date.parse(channel.userGroups?.updatedAt) > now() - 300000))
          && !(Date.parse(channel.probeTokensNextSyncAt) > now())
        if ((nextChecks.get(channel.id) || 0) > now() && !groupsDue) continue
        // A recent balance lookup must not postpone initial key discovery.
        // Each channel owns its queue. A slow site must not delay discovery or
        // token renewal for another site, even across scheduler ticks.
        const task = check(channel.id, { groups: groupsDue }).finally(() => checks.delete(channel.id))
        checks.set(channel.id, task)
      }
    return Promise.allSettled([...checks.values()])
  }

  function withAccount(id, operation) {
    return exclusive(id, async () => {
      const channel = channels.get(id)
      if (!channel) throw new SyncError('上游渠道不存在。', 404)
      await verify(channel)
      if (unsaved.size || !channel.token || channel.balance?.status !== 'ok' ||
          (channel.provider === 'sub2api' && channel.authStatus !== 'authorized')) {
        throw new SyncError('暂时无法确认上游账户，请先检查授权和余额后重试。', 409)
      }
      return operation(channel, () => verify(channel), () => syncGroups(channel))
    })
  }

  return { busy, check, runDue, withAccount, exclusive,
    nextCheckAt(id) {
      const channel = channels.get(id)
      if (stopped || !channel?.token || busy.has(id) || unsaved.size ||
        (channel.provider === 'newapi' && channel.balance?.status === 'unauthorized')) return null
      const due = nextChecks.get(id)
      return due == null ? null : new Date(due).toISOString()
    },
    start() {
      if (timer) return
      stopped = false
      timer = setInterval(() => { void runDue() }, 15000)
      timer.unref()
      void runDue()
    },
    async stop() {
      stopped = true
      clearInterval(timer)
      timer = null
      await Promise.allSettled([...checks.values(), ...tasks])
    },
    reset(id) { nextChecks.delete(id); failures.delete(id); unsaved.delete(id) },
  }
}
