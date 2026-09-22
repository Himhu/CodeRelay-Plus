import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { balanceNotices, normalizeSettings } from './console-settings.js'
import { watchIncidents } from './upstream-watch.js'
import { channelProbeSummary } from './channel-probes.js'
import { SyncError, isRecord, textValue } from './upstream-client.js'

const seedPrefix = Buffer.from('302e020100300506032b657004220420', 'hex')
const pauseReasons = new Set(['quota', 'cost', 'error'])

export async function readBody(stream, limit) {
  const chunks = []
  let length = 0
  for await (const chunk of stream) {
    length += chunk.length
    if (length > limit) throw new SyncError('请求内容过大。', 413)
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

export function secretSeed(secret) {
  const piece = Buffer.from(secret, 'utf8')
  if (!piece.length) throw new SyncError('AppSecret 无效。')
  let seed = piece
  while (seed.length < 32) seed = Buffer.concat([seed, seed])
  return seed.subarray(0, 32)
}

function privateKey(secret) {
  return createPrivateKey({ key: Buffer.concat([seedPrefix, secretSeed(secret)]), format: 'der', type: 'pkcs8' })
}

export function ed25519PublicKey(secret) {
  return createPublicKey(privateKey(secret)).export({ type: 'spki', format: 'der' }).subarray(-32)
}

export function signText(secret, message) {
  return sign(null, Buffer.from(message), privateKey(secret)).toString('hex')
}

export function verifyQQSignature(secret, timestamp, body, signature, now) {
  if (typeof timestamp !== 'string' || !/^\d{10}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300) return false
  if (typeof signature !== 'string' || !/^[0-9a-f]{128}$/i.test(signature)) return false
  const sig = Buffer.from(signature, 'hex')
  if (sig.length !== 64 || (sig[63] & 224) !== 0) return false
  return verify(null, Buffer.concat([Buffer.from(timestamp), body]), createPublicKey(privateKey(secret)), sig)
}

export function validQQConfig(record) {
  return record?.id === 'config' && typeof record.appId === 'string' && record.appId.length <= 32
    && typeof record.secret === 'string' && record.secret.length <= 128 && typeof record.enabled === 'boolean'
}

function money(amount) {
  return amount.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
}

export function qqIncidents({ channels, sites, threshold, settings, now }) {
  const config = normalizeSettings({ ...(settings ?? {}), ...(threshold != null ? { lowBalanceThreshold: threshold } : {}) })
  const items = []
  for (const item of balanceNotices(channels, config.lowBalanceThreshold, now).low) {
    if (typeof item.amount !== 'number') continue
    items.push({ key: `balance:${item.id}`, text: `余额偏低：${item.name} 剩余 $${money(item.amount)}` })
  }
  for (const site of sites) {
    const names = new Map((site.accounts ?? []).map(account => [String(account.id), account.name]))
    for (const [id, state] of Object.entries(site.automation?.accounts ?? {})) {
      if (!state?.pausedBySystem || !pauseReasons.has(state.pauseReason)) continue
      const reason = typeof state.reason === 'string' && state.reason ? state.reason : '整条线路已暂停'
      items.push({ key: `route:${site.id}:${id}`, text: `线路暂停：${site.name || site.id} / ${names.get(String(id)) || id}。${reason}` })
    }
  }
  for (const channel of channels) {
    if (!channel.routingSource) items.push(...watchIncidents(channel, config))
    if (channel.routingSource) continue
    const summary = channelProbeSummary(channel, now)
    if (summary.status === 'down' && summary.monitoredModels >= 2) {
      items.push({ key: `probe:${channel.id}`, text: `探针失败：${channel.name} 受监测模型全部失败（${summary.monitoredModels} 个）` })
    }
  }
  return items
}

function stored(input = {}) {
  const open = isRecord(input.open) ? Object.fromEntries(Object.entries(input.open).filter(([, value]) => value === 1).slice(0, 200)) : {}
  return {
    id: 'config', appId: typeof input.appId === 'string' ? input.appId : '', secret: typeof input.secret === 'string' ? input.secret : '',
    enabled: input.enabled === true, groupOpenId: typeof input.groupOpenId === 'string' ? input.groupOpenId : '', open,
    lastError: typeof input.lastError === 'string' ? input.lastError.slice(0, 300) : '', lastSentAt: typeof input.lastSentAt === 'string' ? input.lastSentAt : null,
  }
}

export function applyQQInput(previous, input) {
  if (!isRecord(input) || typeof input.enabled !== 'boolean') throw new SyncError('QQ 机器人配置无效。')
  const appId = textValue(input.appId)
  if (appId && !/^[1-9]\d{4,31}$/.test(appId)) throw new SyncError('AppID 应为 5 到 32 位数字。')
  if (input.secret != null && typeof input.secret !== 'string') throw new SyncError('AppSecret 无效。')
  const replacing = typeof input.secret === 'string' && input.secret !== ''
  if (replacing && (input.secret.length < 8 || input.secret.length > 128 || /\s/.test(input.secret))) throw new SyncError('AppSecret 无效。')
  const appChanged = appId !== previous.appId
  const secret = appChanged ? (replacing ? input.secret : '') : (replacing ? input.secret : previous.secret)
  if (input.enabled && (!appId || !secret)) throw new SyncError('启用前请填写 AppID 和 AppSecret。')
  return stored({ ...previous, appId, secret, enabled: input.enabled, groupOpenId: appChanged ? '' : previous.groupOpenId, open: appChanged ? {} : previous.open, lastError: '' })
}

export function acceptWebhook(config, raw, headers, now) {
  if (!config?.secret || !config.appId) return { status: 503, body: { error: 'QQ 机器人尚未配置。' } }
  let payload
  try { payload = JSON.parse(raw.toString('utf8')) } catch { return { status: 400, body: { error: '回调不是有效 JSON。' } } }
  if (!isRecord(payload)) return { status: 400, body: { error: '回调格式无效。' } }
  const appId = headers['x-bot-appid']
  if (appId && appId !== config.appId) return { status: 401, body: { error: 'AppID 不匹配。' } }
  if (payload.op === 13) {
    const plain = payload.d?.plain_token, ts = payload.d?.event_ts
    if (typeof plain !== 'string' || !plain || plain.length > 128 || typeof ts !== 'string' || !/^\d{1,20}$/.test(ts)) return { status: 400, body: { error: '回调校验参数无效。' } }
    return { status: 200, body: { plain_token: plain, signature: signText(config.secret, ts + plain) } }
  }
  if (!verifyQQSignature(config.secret, headers['x-signature-timestamp'], raw, headers['x-signature-ed25519'], now)) return { status: 401, body: { error: '回调签名无效。' } }
  const group = payload.d?.group_openid
  const next = typeof group === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(group) && group !== config.groupOpenId
    ? stored({ ...config, groupOpenId: group, lastError: '' }) : null
  return { status: 200, body: { op: 12 }, config: next }
}

function publicError(error, config) {
  let text = error instanceof SyncError ? error.message : 'QQ 发送失败。'
  if (config.secret) text = text.replaceAll(config.secret, '[已隐藏]')
  return text.slice(0, 300)
}

export function createQQBot({ store = null, fetch = globalThis.fetch, now = Date.now, publicOrigin = '', log = () => {}, incidents = () => [] } = {}) {
  let cached, token, timer, tail = Promise.resolve()
  const exclusive = job => {
    const run = tail.then(job, job)
    tail = run.then(() => {}, () => {})
    return run
  }
  const current = () => {
    if (!cached) cached = stored(store?.load()?.[0])
    return cached
  }
  const persist = config => {
    if (!store) throw new SyncError('QQ 机器人存储尚未配置。', 503)
    const record = stored(config)
    store.save([record])
    cached = record
  }
  const view = () => {
    const config = current()
    return { appId: config.appId, enabled: config.enabled, hasSecret: Boolean(config.secret), groupOpenId: config.groupOpenId,
      webhookUrl: publicOrigin ? `${publicOrigin}/api/qq/webhook` : '', lastError: config.lastError, lastSentAt: config.lastSentAt }
  }
  async function accessToken(config, force) {
    if (!force && token?.appId === config.appId && token.until > now() + 60000) return token.value
    let response, payload
    try {
      response = await fetch('https://api.bot.qq.com/app/getAppAccessToken', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: config.appId, clientSecret: config.secret }), signal: AbortSignal.timeout(10000) })
      payload = await response.json()
    } catch { throw new SyncError('无法连接 QQ 机器人接口。', 502) }
    const value = payload?.access_token, expires = Number(payload?.expires_in)
    if (!response.ok || typeof value !== 'string' || !value || !Number.isFinite(expires) || expires <= 0) throw new SyncError('QQ 调用凭证获取失败。', 502)
    token = { appId: config.appId, value, until: now() + expires * 1000 }
    return value
  }
  async function deliver(config, text, retry = true) {
    const access = await accessToken(config, !retry)
    let response, payload = null
    try {
      response = await fetch(`https://api.bot.qq.com/v2/groups/${encodeURIComponent(config.groupOpenId)}/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `QQBot ${access}` },
        body: JSON.stringify({ msg_type: 0, content: String(text).slice(0, 400) }), signal: AbortSignal.timeout(10000) })
      payload = await response.json().catch(() => null)
    } catch { throw new SyncError('无法连接 QQ 机器人接口。', 502) }
    if (response.status === 401 && retry) { token = null; return deliver(config, text, false) }
    if (!response.ok) throw new SyncError(isRecord(payload) && typeof payload.message === 'string' ? payload.message : `QQ 返回 ${response.status}`, 502)
  }
  return {
    view, stop() { clearInterval(timer); timer = null },
    start() { if (timer) return; timer = setInterval(() => { void this.scan() }, 60000); timer.unref(); void this.scan() },
    save: input => exclusive(() => { persist(applyQQInput(current(), input)); token = null; return view() }),
    sendTest: () => exclusive(async () => {
      const config = current()
      if (!config.enabled || !config.secret || !config.appId) throw new SyncError('请先保存并启用 QQ 机器人。')
      if (!config.groupOpenId) throw new SyncError('还没有告警群。把机器人拉进群，或在群里 @ 它一次。')
      try {
        await deliver(config, 'Signal 监控已接入。之后只在余额偏低、倍率变化、上游公告、订阅余量或到期、整条线路暂停、探针大面积失败时发一条文本。')
        persist({ ...config, lastError: '', lastSentAt: new Date(now()).toISOString() })
      } catch (error) {
        const lastError = publicError(error, config)
        persist({ ...config, lastError })
        throw new SyncError(lastError, 502)
      }
      return view()
    }),
    webhook: (raw, headers) => exclusive(() => {
      const result = acceptWebhook(current(), raw, headers, now())
      if (result.config) {
        persist(result.config)
        log({ level: 'success', action: '记下 QQ 告警群', message: '已从入群或 @ 事件记下告警群。' })
      }
      return { status: result.status, body: result.body }
    }),
    scan: () => exclusive(async () => {
      const config = current()
      if (!config.enabled || !config.secret || !config.appId || !config.groupOpenId) return
      let found = []
      try { found = incidents() } catch { return }
      const live = new Set(found.map(item => item.key))
      const open = { ...config.open }
      let changed = false
      for (const key of Object.keys(open)) if (!live.has(key)) { delete open[key]; changed = true }
      try {
        for (const item of found.filter(item => !open[item.key]).slice(0, 5)) {
          await deliver(config, item.text)
          open[item.key] = 1
          config.lastSentAt = new Date(now()).toISOString()
          config.lastError = ''
          changed = true
          log({ level: 'warning', action: '发送 QQ 告警', message: item.text })
        }
      } catch (error) {
        config.lastError = publicError(error, config)
        changed = true
        log({ level: 'error', action: 'QQ 告警发送失败', message: config.lastError })
      }
      if (changed) persist({ ...config, open })
    }),
  }
}
