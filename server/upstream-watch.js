import { createHash } from 'node:crypto'
import { accountSite } from './channel-balance.js'
import { SyncError, isRecord, textValue, upstream } from './upstream-client.js'

const rateText = value => value == null ? '自动' : `${value}×`
const clip = (value, max) => value.length > max ? `${value.slice(0, max - 1)}…` : value
const shortId = (...parts) => createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16)

function changePercent(from, to) {
  if (from === to) return 0
  if (from === 0) return 100
  return Math.abs(to - from) / Math.abs(from) * 100
}

function snapshot(groups) {
  const rates = {}
  for (const group of groups ?? []) {
    if (!group?.id) continue
    rates[String(group.id)] = { name: clip(textValue(group.name) || String(group.id), 80), rate: Number.isFinite(group.rate) ? group.rate : null }
  }
  return rates
}

export function applyRateSnapshot(channel, groups, minPercent, now) {
  const watch = channel.upstreamWatch ?? {}
  const next = snapshot(groups)
  const at = new Date(now).toISOString()
  if (!watch.rateBaselined) {
    channel.upstreamWatch = { ...watch, rateBaselined: true, rates: next, updatedAt: at }
    return null
  }
  const previous = watch.rates ?? {}
  const added = [], removed = [], changed = []
  for (const [id, item] of Object.entries(next)) {
    if (!Object.hasOwn(previous, id)) added.push({ name: item.name, rate: item.rate })
    else if (previous[id].rate !== item.rate) {
      const from = previous[id].rate, to = item.rate
      const percent = from == null || to == null ? null : changePercent(from, to)
      if (percent == null || percent + 1e-9 >= minPercent) changed.push({ name: item.name, from, to, percent })
    }
  }
  for (const [id, item] of Object.entries(previous)) if (!Object.hasOwn(next, id)) removed.push({ name: item.name, rate: item.rate })
  let rateAlert = watch.rateAlert ?? null
  const rateChanges = watch.rateChanges ?? []
  if (added.length || removed.length || changed.length) {
    const parts = []
    if (added.length) parts.push(`新增 ${added.length}：${added.slice(0, 6).map(item => `${item.name} ${rateText(item.rate)}`).join('、')}`)
    if (removed.length) parts.push(`删除 ${removed.length}：${removed.slice(0, 6).map(item => `${item.name} ${rateText(item.rate)}`).join('、')}`)
    if (changed.length) parts.push(`变化 ${changed.length}：${changed.slice(0, 6).map(item => `${item.name} ${rateText(item.from)}→${rateText(item.to)}${item.percent == null ? '' : `（${Math.round(item.percent)}%）`}`).join('、')}`)
    rateAlert = { key: `rate:${channel.id}:${at}`, text: clip(`倍率变动：${channel.name}。${parts.join('。')}`, 350) }
    rateChanges.unshift({ at, added, removed, changed })
  }
  const stored = { ...watch, rateBaselined: true, rates: next, rateAlert, updatedAt: at }
  if (added.length || removed.length || changed.length) stored.rateChanges = rateChanges.slice(0, 30)
  channel.upstreamWatch = stored
  return added.length || removed.length || changed.length ? rateAlert : null
}

function rememberAnnouncements(channel, items, now) {
  const watch = channel.upstreamWatch ?? {}
  const at = new Date(now).toISOString()
  const seen = new Set(watch.announcementSeen ?? [])
  const fresh = watch.announcementBaselined ? items.filter(item => !seen.has(item.id)) : []
  const alerts = channel.ignoreAnnouncements ? [] : [...fresh.map(item => ({
    key: `announce:${channel.id}:${item.id}`, text: clip(`上游公告：${channel.name}。${item.title}`, 180),
  })), ...(watch.announcementAlerts ?? [])].slice(0, 20)
  channel.upstreamWatch = { ...watch, announcementBaselined: true, announcementSeen: items.map(item => item.id).slice(0, 300),
    announcements: items.slice(0, 40), announcementAlerts: alerts, announcementsError: null, updatedAt: at }
  return channel.ignoreAnnouncements ? [] : fresh.map(item => alerts.find(alert => alert.key.endsWith(`:${item.id}`))).filter(Boolean)
}

export function normalizeSubscriptionProgress(data) {
  if (!Array.isArray(data)) throw new SyncError('上游订阅用量格式无效。', 502)
  return data.flatMap(item => {
    if (!isRecord(item)) return []
    const progress = isRecord(item.progress) ? item.progress : item
    const subscription = isRecord(item.subscription) ? item.subscription : {}
    const id = Number.isSafeInteger(progress.id) ? progress.id : Number.isSafeInteger(subscription.id) ? subscription.id : null
    if (!id) return []
    const windowOf = value => {
      if (!isRecord(value)) return null
      const limit = Number(value.limit_usd), remaining = Number(value.remaining_usd)
      if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(remaining)) return null
      return { limit, used: Number.isFinite(Number(value.used_usd)) ? Number(value.used_usd) : null, remaining,
        remainingPercent: Math.round(Math.max(0, Math.min(100, remaining / limit * 100)) * 10) / 10 }
    }
    return [{ id: String(id), groupName: textValue(progress.group_name) || textValue(subscription.group?.name) || `订阅 #${id}`,
      status: textValue(subscription.status) || 'unknown', expiresAt: textValue(progress.expires_at) || textValue(subscription.expires_at) || null,
      expiresInDays: Number.isInteger(progress.expires_in_days) ? progress.expires_in_days : null,
      daily: windowOf(progress.daily), weekly: windowOf(progress.weekly), monthly: windowOf(progress.monthly) }]
  }).slice(0, 30)
}

async function readAnnouncements(channel) {
  try { return await readAnnouncementItems(channel) }
  catch (error) { if (error.status === 404) return []; throw error }
}

async function readAnnouncementItems(channel) {
  const site = accountSite(channel)
  if (channel.provider === 'newapi') {
    const publicSite = { ...site, token: '', userId: '' }
    const status = await upstream(publicSite, '/api/status')
    const items = []
    if (Array.isArray(status?.announcements)) for (const item of status.announcements) {
      const content = textValue(item?.content)
      if (!content) continue
      const at = textValue(item.publishDate)
      items.push({ id: shortId('status', at, content), title: clip(textValue(item.extra) || '站点公告', 120), content: content.slice(0, 500), at: at || null })
    }
    try {
      const notice = await upstream(publicSite, '/api/notice')
      const text = typeof notice === 'string' ? notice.trim() : ''
      if (text) items.push({ id: shortId('notice', text), title: '站点通知', content: text.slice(0, 500), at: null })
    } catch (error) { if (error.status !== 404) throw error }
    return items
  }
  const data = await upstream(site, '/api/v1/announcements')
  if (!Array.isArray(data)) throw new SyncError('上游公告格式无效。', 502)
  return data.flatMap(item => {
    if (!isRecord(item) || !Number.isSafeInteger(item.id) || item.id <= 0) return []
    return [{ id: String(item.id), title: clip(textValue(item.title) || '上游公告', 120), content: textValue(item.content).slice(0, 500),
      at: textValue(item.created_at) || textValue(item.updated_at) || null }]
  })
}

async function readSubscriptions(channel) {
  try { return normalizeSubscriptionProgress(await upstream(accountSite(channel), '/api/v1/subscriptions/progress')) }
  catch (error) { if (error.status === 404) return []; throw error }
}

export async function syncUpstreamWatch(channel, groups, now, settings) {
  const rateAlert = applyRateSnapshot(channel, groups, settings.rateChangeMinPercent, now)
  const [announcements, subscriptions] = await Promise.allSettled([
    readAnnouncements(channel), channel.provider === 'sub2api' ? readSubscriptions(channel) : Promise.resolve(null)])
  const at = new Date(now).toISOString()
  let newAnnouncements = []
  if (announcements.status === 'fulfilled') newAnnouncements = rememberAnnouncements(channel, announcements.value, now)
  else channel.upstreamWatch = { ...channel.upstreamWatch, announcementsError: announcements.reason instanceof SyncError ? announcements.reason.message : '上游公告读取失败。', updatedAt: at }
  if (subscriptions.status === 'fulfilled' && subscriptions.value) {
    channel.upstreamWatch = { ...channel.upstreamWatch, subscriptions: subscriptions.value, subscriptionsError: null, updatedAt: at }
  } else if (subscriptions.status === 'rejected') {
    channel.upstreamWatch = { ...channel.upstreamWatch, subscriptionsError: subscriptions.reason instanceof SyncError ? subscriptions.reason.message : '订阅用量读取失败。', updatedAt: at }
  }
  return { rateAlert, newAnnouncements }
}

const labels = { daily: '日', weekly: '周', monthly: '月' }
const windows = ['daily', 'weekly', 'monthly']

export function watchIncidents(channel, settings) {
  const watch = channel.upstreamWatch
  if (!watch || channel.routingSource) return []
  const items = []
  if (watch.rateAlert?.key && watch.rateAlert.text) items.push(watch.rateAlert)
  if (!channel.ignoreAnnouncements) for (const alert of watch.announcementAlerts ?? []) if (alert?.key && alert.text) items.push(alert)
  for (const sub of watch.subscriptions ?? []) {
    if (['revoked', 'disabled', 'inactive'].includes(sub.status)) continue
    if (sub.status === 'active') for (const name of windows) {
      const value = sub[name]
      const threshold = name === 'daily' ? settings.subscriptionDailyRemainingPercent : name === 'weekly' ? settings.subscriptionWeeklyRemainingPercent : settings.subscriptionMonthlyRemainingPercent
      if (value && value.remainingPercent <= threshold) items.push({ key: `sub:${name}:${channel.id}:${sub.id}`, text: clip(`订阅余量：${channel.name} / ${sub.groupName} ${labels[name]}剩余 ${value.remainingPercent}%`, 180) })
    }
    const expiring = sub.status === 'expired' || (sub.status === 'active' && sub.expiresInDays != null && sub.expiresInDays <= settings.subscriptionExpiryDays)
    if (expiring) items.push({ key: `sub:exp:${channel.id}:${sub.id}`, text: clip(`订阅到期：${channel.name} / ${sub.groupName} ${sub.status === 'expired' ? '已到期' : `剩余 ${sub.expiresInDays} 天`}`, 180) })
  }
  return items
}

export function watchView(channel) {
  const watch = channel.upstreamWatch ?? {}
  const change = item => ({ name: item.name, rate: item.rate ?? null })
  return {
    ignoreAnnouncements: channel.ignoreAnnouncements === true,
    rateChanges: (watch.rateChanges ?? []).slice(0, 8).map(entry => ({ at: entry.at,
      added: (entry.added ?? []).map(change), removed: (entry.removed ?? []).map(change),
      changed: (entry.changed ?? []).map(item => ({ name: item.name, from: item.from ?? null, to: item.to ?? null, percent: item.percent == null ? null : Math.round(item.percent) })) })),
    announcements: (watch.announcements ?? []).slice(0, 8),
    subscriptions: (watch.subscriptions ?? []).slice(0, 12),
    announcementsError: watch.announcementsError ?? null, subscriptionsError: watch.subscriptionsError ?? null, updatedAt: watch.updatedAt ?? null,
  }
}
