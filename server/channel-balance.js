import { SyncError, isRecord, textValue, upstream } from './upstream-client.js'

export const accountSite = channel => ({ ...channel,
  endpoint: channel.endpoint.replace(/\/(?:api\/v1|api|v1)\/?$/, '').replace(/\/$/, '') })

const finite = value => typeof value === 'number' && Number.isFinite(value)
const positive = value => {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value
  return finite(number) && number > 0 ? number : null
}
const recharge = value => positive(value) || 1

export function sub2APIBalance(user) {
  if (!isRecord(user) || !finite(user.balance)) throw new SyncError('上游未返回有效账户余额，已保留上次结果。', 502)
  return { amount: user.balance, currency: 'USD', symbol: '$', quota: null, notice: null }
}

export function newAPIBalance(user, settings) {
  if (!isRecord(user) || !Number.isSafeInteger(user.quota)) throw new SyncError('上游未返回有效账户额度，已保留上次结果。', 502)
  // quota is already the remaining balance; used_quota must not be subtracted.
  const raw = { amount: user.quota, currency: 'QUOTA', symbol: '', quota: user.quota,
    notice: '未取得完整的金额换算设置，暂按原始额度显示。' }
  if (!isRecord(settings)) return raw
  const type = settings.quota_display_type ?? (settings.display_in_currency === true ? 'USD' : settings.display_in_currency === false ? 'TOKENS' : null)
  if (type === 'TOKENS') return { ...raw, notice: '上游设置为原始额度显示。' }
  const unit = positive(settings.quota_per_unit)
  const rate = type === 'USD' ? 1 : type === 'CNY' ? positive(settings.usd_exchange_rate)
    : type === 'CUSTOM' ? positive(settings.custom_currency_exchange_rate) : null
  const symbol = type === 'USD' ? '$' : type === 'CNY' ? '¥' : textValue(settings.custom_currency_symbol)
  if (!unit || !rate || !symbol || symbol.length > 16) return raw
  const amount = user.quota / unit * rate
  if (!finite(amount)) return raw
  return { amount, usdAmount: user.quota / unit, currency: type, symbol, quota: user.quota, notice: null }
}

export async function readNewAPIBalance(channel) {
  const site = accountSite(channel)
  const user = await upstream(site, '/api/user/self')
  if (!isRecord(user) || !Number.isSafeInteger(user.id) || user.id <= 0) throw new SyncError('上游未返回有效用户身份，无法确认账户余额。', 502)
  // Status is public. A failed currency lookup must never turn quota into an
  // invented cash amount or send credentials to an unauthenticated endpoint.
  let settings
  try { settings = await upstream({ ...site, token: '', userId: '' }, '/api/status') } catch { /* Show raw quota. */ }
  return newAPIBalance(user, settings)
}

export function saveBalance(channel, value, now) {
  const multiplier = recharge(channel.rechargeRate)
  const rawUsdAmount = value.currency === 'USD' ? value.amount : finite(value.usdAmount) ? value.usdAmount : null
  channel.balance = { ...value, rawAmount: value.amount, rawCurrency: value.currency,
    rawUsdAmount, usdAmount: rawUsdAmount == null ? null : rawUsdAmount / multiplier,
    amount: value.amount / multiplier, status: 'ok', updatedAt: new Date(now).toISOString(),
    checkedAt: new Date(now).toISOString(), error: null }
}

export function failBalance(channel, error, now) {
  const unauthorized = !error.policyBlocked && (error.status === 401 || error.status === 403)
  channel.balance = { ...channel.balance,
    status: error.storage ? 'storage-error' : unauthorized ? 'unauthorized' : 'error',
    checkedAt: new Date(now).toISOString(),
    error: error.storage ? '余额尚未保存，请检查本机磁盘空间和目录权限后重试。'
      : unauthorized ? channel.provider === 'newapi'
        ? '请重新授权，并核对系统访问令牌及其所属用户 ID。' : '登录授权已失效，请重新授权后查询余额。'
      : error instanceof SyncError ? error.message : '余额查询失败，稍后自动重试。' }
}

export function channelBalanceView(channel) {
  const balance = channel.balance ?? {}
  const multiplier = recharge(channel.rechargeRate)
  const sourceAmount = finite(balance.rawAmount) ? balance.rawAmount : finite(balance.amount) ? balance.amount : null
  const sourceUSD = balance.currency === 'USD' ? sourceAmount : finite(balance.rawUsdAmount) ? balance.rawUsdAmount : null
  return { status: balance.status ?? (channel.token ? 'unchecked' : 'missing'),
    usdAmount: sourceUSD == null ? null : sourceUSD / multiplier,
    amount: sourceAmount == null ? null : sourceAmount / multiplier, rawAmount: sourceAmount,
    rawCurrency: balance.rawCurrency ?? null, currency: balance.currency ?? null,
    symbol: balance.symbol ?? '', quota: balance.quota ?? null, notice: balance.notice ?? null,
    updatedAt: balance.updatedAt ?? null, checkedAt: balance.checkedAt ?? null, error: balance.error ?? null }
}
