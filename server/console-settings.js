import { channelBalanceView } from './channel-balance.js'

export const defaultSettings = Object.freeze({ lowBalanceThreshold: 5 })
export const validBalanceThreshold = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1000000 && Number(value.toFixed(2)) === value

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
