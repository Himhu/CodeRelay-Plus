import { channelBalanceView } from './channel-balance.js'
import { SyncError, isRecord } from './upstream-client.js'

export const defaultSettings = Object.freeze({
  lowBalanceThreshold: 5, rateChangeMinPercent: 1,
  subscriptionDailyRemainingPercent: 20, subscriptionWeeklyRemainingPercent: 20, subscriptionMonthlyRemainingPercent: 20,
  subscriptionExpiryDays: 3,
})
export const validBalanceThreshold = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1000000 && Number(value.toFixed(2)) === value
const integerBetween = (value, min, max) => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
const pick = (value, min, max, fallback) => integerBetween(value, min, max) ? value : fallback

export function normalizeSettings(input = {}) {
  const source = isRecord(input) ? input : {}
  return {
    lowBalanceThreshold: validBalanceThreshold(source.lowBalanceThreshold) ? source.lowBalanceThreshold : defaultSettings.lowBalanceThreshold,
    rateChangeMinPercent: pick(source.rateChangeMinPercent, 0, 100, defaultSettings.rateChangeMinPercent),
    subscriptionDailyRemainingPercent: pick(source.subscriptionDailyRemainingPercent, 0, 100, defaultSettings.subscriptionDailyRemainingPercent),
    subscriptionWeeklyRemainingPercent: pick(source.subscriptionWeeklyRemainingPercent, 0, 100, defaultSettings.subscriptionWeeklyRemainingPercent),
    subscriptionMonthlyRemainingPercent: pick(source.subscriptionMonthlyRemainingPercent, 0, 100, defaultSettings.subscriptionMonthlyRemainingPercent),
    subscriptionExpiryDays: pick(source.subscriptionExpiryDays, 0, 365, defaultSettings.subscriptionExpiryDays),
  }
}

export function applySettings(current, input) {
  if (!isRecord(input) || !validBalanceThreshold(input.lowBalanceThreshold)) throw new SyncError('最低余额阈值须为 0 至 1,000,000 美元，最多两位小数。')
  const next = normalizeSettings({ ...current, lowBalanceThreshold: input.lowBalanceThreshold })
  const fields = {
    rateChangeMinPercent: '倍率变化百分比须为 0 到 100 的整数。',
    subscriptionDailyRemainingPercent: '订阅日剩余百分比须为 0 到 100 的整数。',
    subscriptionWeeklyRemainingPercent: '订阅周剩余百分比须为 0 到 100 的整数。',
    subscriptionMonthlyRemainingPercent: '订阅月剩余百分比须为 0 到 100 的整数。',
    subscriptionExpiryDays: '订阅到期提醒天数须为 0 到 365 的整数。',
  }
  for (const [key, message] of Object.entries(fields)) if (input[key] != null) {
    const limit = key === 'subscriptionExpiryDays' ? 365 : 100
    if (!integerBetween(input[key], 0, limit)) throw new SyncError(message)
    next[key] = input[key]
  }
  return next
}

export function balanceNotices(channels, threshold, now) {
  const low = [], unavailable = []
  for (const channel of channels) {
    if (channel.routingSource) continue
    const balance = channelBalanceView(channel)
    const updated = Date.parse(balance.updatedAt)
    const stale = !Number.isFinite(updated) || now - updated > 15 * 60000
    const problem = balance.status !== 'ok' ? '余额查询未成功' : stale ? '余额超过 15 分钟未更新' : null
    const amount = Number.isFinite(balance.usdAmount) ? balance.usdAmount : null
    const item = { id: channel.id, name: channel.name, provider: channel.provider, endpoint: channel.endpoint,
      needsAuthorization: !channel.token, amount, updatedAt: balance.updatedAt }
    if (typeof amount === 'number' && Number.isFinite(amount) && amount <= threshold) {
      low.push({ ...item, problem })
    } else if (problem || amount == null) {
      unavailable.push({ ...item, problem: problem || '缺少美元换算信息，等待余额更新' })
    }
  }
  low.sort((a, b) => a.amount - b.amount || a.name.localeCompare(b.name))
  return { low, unavailable }
}
