import { createHash, randomUUID } from 'node:crypto'
import { accountSite } from './channel-balance.js'
import { SyncError, isRecord, readJSON, textValue, upstream } from './upstream-client.js'

const finite = value => typeof value === 'number' && Number.isFinite(value)
const number = value => (typeof value === 'number' || (typeof value === 'string' && value.trim())) && Number.isFinite(Number(value)) ? Number(value) : null
const label = value => typeof value === 'string' ? value.slice(0, 100) : ''
const methods = { alipay: '支付宝', wxpay: '微信支付', alipay_direct: '支付宝', wxpay_direct: '微信支付', stripe: 'Stripe', easypay: '易支付', airwallex: 'Airwallex' }
const uncertain = '上游处理结果暂未确认。请先在上游核对兑换记录或充值订单，勿重复提交。'

// Match Sub2API's currency precision and decimal fee rounding without floating-point ceilings.
function paymentStep(currency) {
  if ('BIF CLP DJF GNF JPY KMF KRW MGA PYG RWF VND VUV XAF XOF XPF ISK UGX'.split(' ').includes(currency)) return 1
  return 'BHD IQD JOD KWD LYD OMR TND'.split(' ').includes(currency) ? 0.001 : 0.01
}

function payableWithFee(amount, fee, step) {
  const units = Math.round(amount / step)
  const [coefficient, exponent = '0'] = String(fee).split('e')
  const denominator = 100n * 10n ** BigInt((coefficient.split('.')[1]?.length || 0) - Number(exponent))
  const feeUnits = (BigInt(units) * BigInt(coefficient.replace('.', '')) + denominator - 1n) / denominator
  return (units + Number(feeUnits)) / Math.round(1 / step)
}

function safeLink(value) {
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' && !url.username && !url.password && value.length <= 8192) return url.href
  } catch { /* Unsupported payment links stay unavailable. */ }
  return null
}

// Payment APIs have different envelopes from the ordinary account APIs.
// Send mutations once, never follow redirects or return raw upstream errors.
async function fundingRequest(channel, path, body) {
  const site = accountSite(channel)
  const headers = { Accept: 'application/json', Authorization: `Bearer ${site.token}`, 'User-Agent': 'Signal-Monitor/0.1' }
  if (channel.provider === 'newapi' && channel.userId) headers['New-Api-User'] = channel.userId
  if (body) headers['Content-Type'] = 'application/json'
  let response, payload
  try {
    response = await fetch(site.endpoint + path, { method: body ? 'POST' : 'GET', headers,
      body: body ? JSON.stringify(body) : undefined, redirect: 'manual', signal: AbortSignal.timeout(20000) })
    payload = await readJSON(response.body, 512 * 1024)
  } catch { throw new SyncError('无法确认上游响应，请稍后查询。', 502) }
  const success = channel.provider === 'sub2api' ? payload?.code === 0 : payload?.success === true || payload?.message === 'success'
  if (!response.ok || !success) {
    const code = payload?.reason || payload?.code
    const reasons = {
      REDEEM_CODE_NOT_FOUND: '兑换码无效，请检查后重试。', REDEEM_CODE_USED: '该兑换码已使用。',
      REDEEM_CODE_EXPIRED: '该兑换码已过期。', REDEEM_RATE_LIMITED: '上游限制了兑换频率，请稍后重试。',
      REDEEM_CODE_LOCKED: '该兑换码正在处理，请先查询上游记录。',
    }
    const status = response.status === 401 || response.status === 403 ? response.status
      : response.status === 404 ? 404 : response.status === 429 ? 429 : response.status >= 500 || (response.status >= 300 && response.status < 400) ? 502 : 400
    throw new SyncError(status === 401 || status === 403 ? '上游拒绝此操作，请检查用户授权和接口权限。'
      : reasons[code] || (status === 404 ? '此上游版本未提供该充值接口。'
      : status === 429 ? '上游请求过于频繁，请稍后重试。'
      : path.endsWith('/topup') ? '兑换未成功，请检查兑换码状态或上游兑换设置。' : '上游未接受请求，请检查支付方式、金额限制或上游配置。'), status)
  }
  return payload
}

export async function readFundingOptions(channel, includePurchaseLinks = false) {
  const site = accountSite(channel)
  const result = { redeem: true, methods: [], notice: null, purchaseLinks: [], purchaseNotice: null,
    upstreamUrl: site.endpoint + (channel.provider === 'sub2api' ? '/purchase' : '/console/topup') }
  function addPurchaseLink(value, name) {
    if (typeof value !== 'string' || !value.trim() || value.length > 8192) return
    try {
      const url = new URL(value.trim(), site.endpoint + '/')
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return
      if (result.purchaseLinks.length < 10 && !result.purchaseLinks.some(item => item.url === url.href)) {
        result.purchaseLinks.push({ name, url: url.href, host: url.host })
      }
    } catch { /* Only expose valid links explicitly supplied by the upstream. */ }
  }
  try {
    if (channel.provider === 'newapi') {
      const info = (await fundingRequest(channel, '/api/user/topup/info')).data
      if (!isRecord(info)) throw new SyncError('充值配置格式无效。', 502)
      result.redeem = info.enable_redemption !== false && info.payment_compliance_confirmed !== false
      addPurchaseLink(info.topup_link, '购买兑换码')
      for (const entry of Array.isArray(info.pay_methods) ? info.pay_methods : []) {
        const stripe = entry?.type === 'stripe'
        if (!entry || typeof entry.type !== 'string' || !/^[a-z0-9_-]{1,40}$/i.test(entry.type)) continue
        if (stripe ? !info.enable_stripe_topup : !info.enable_online_topup || ['creem', 'waffo', 'waffo_pancake', 'waffo-pancake'].includes(entry.type)) continue
        result.methods.push({ id: entry.type, name: label(entry.name) || methods[entry.type] || entry.type,
          min: number(entry.min_topup ?? (stripe ? info.stripe_min_topup : info.min_topup)) ?? 1,
          max: stripe ? 10000 : null, currency: stripe ? null : 'CNY', amountUnit: '上游充值数量', step: 1 })
      }
      result.presets = Array.isArray(info.amount_options) ? info.amount_options.filter(value => Number.isSafeInteger(value) && value > 0).slice(0, 20) : []
    } else {
      // Public purchase settings remain useful even when the payment API is absent or disabled.
      const [configRead, settingsRead] = await Promise.allSettled([
        fundingRequest(channel, '/api/v1/payment/config'),
        includePurchaseLinks ? upstream({ ...site, token: '', userId: '' }, '/api/v1/settings/public') : null,
      ])
      if (includePurchaseLinks) {
        const settings = settingsRead.status === 'fulfilled' ? settingsRead.value : null
        if (isRecord(settings)) {
          if (settings.purchase_subscription_enabled === true) addPurchaseLink(settings.purchase_subscription_url, '上游购买入口')
          for (const item of Array.isArray(settings.custom_menu_items) ? settings.custom_menu_items : []) {
            if (!isRecord(item) || item.visibility === 'admin') continue
            if (item.id === 'migrated_purchase_subscription' || /兑换码|激活码|充值卡|卡密|购卡|发卡|购买|充值|订阅|\b(?:purchase|buy|recharge|top[\s_-]?up|redeem)\b/i.test(label(item.label))) {
              addPurchaseLink(item.url, label(item.label) || '上游购买入口')
            }
          }
          // This field is a general recharge page, not necessarily a code shop.
          result.upstreamUrl = safeLink(settings.balance_low_notify_recharge_url) || result.upstreamUrl
        } else result.purchaseNotice = '暂时无法读取上游购买地址，请前往上游查看。'
      }
      if (configRead.status === 'rejected') throw configRead.reason
      const config = configRead.value.data
      if (!isRecord(config) || !(config.enabled === true || config.payment_enabled === true)) {
        result.notice = '上游当前未启用在线充值，可使用兑换码。'
        return result
      }
      const info = (await fundingRequest(channel, '/api/v1/payment/checkout-info')).data
      if (!isRecord(info) || !isRecord(info.methods)) throw new SyncError('充值配置格式无效。', 502)
      if (!info.balance_disabled) for (const [id, entry] of Object.entries(info.methods)) {
        if (!Object.hasOwn(methods, id) || !isRecord(entry) || entry.available === false) continue
        const fee = number(info.recharge_fee_rate)
        if (fee == null || fee < 0 || fee > 100) continue
        result.methods.push({ id, name: label(entry.display_name) || methods[id], min: number(entry.single_min) || 0.01,
          max: number(entry.single_max) || null, currency: /^[A-Z]{3}$/.test(entry.currency) ? entry.currency : null,
          amountUnit: '充值金额', step: paymentStep(entry.currency), fee })
      }
    }
    if (!result.methods.length) result.notice = '上游暂未提供可在此使用的在线支付方式，可使用兑换码或前往上游充值。'
  } catch (error) {
    result.notice = error instanceof SyncError ? error.message : '暂时无法读取上游充值配置。'
    if (channel.provider === 'newapi') result.purchaseNotice = '暂时无法读取上游购买地址，请前往上游查看。'
  }
  return result
}

async function paymentQuote(channel, input, options) {
  const method = options.methods.find(item => item.id === input.method)
  if (!method) throw new SyncError('请选择上游当前可用的支付方式。')
  const amount = input.amount
  if (!finite(amount) || amount <= 0 || amount > 1000000 || amount < method.min || (method.max && amount > method.max) ||
      (channel.provider === 'newapi' ? !Number.isSafeInteger(amount) : Math.abs(amount / method.step - Math.round(amount / method.step)) > 1e-6)) {
    throw new SyncError('充值数量或金额不符合上游限制，请检查最小值、最大值和小数位。')
  }
  let payable
  if (channel.provider === 'newapi') {
    const path = method.id === 'stripe' ? '/api/user/stripe/amount' : '/api/user/amount'
    payable = number((await fundingRequest(channel, path, { amount, payment_method: method.id })).data)
  } else payable = payableWithFee(amount, method.fee, method.step)
  if (!finite(payable) || payable <= 0) throw new SyncError('上游未返回有效支付金额，请前往上游核对。', 502)
  return { amount, method: method.id, methodName: method.name, payable, currency: method.currency }
}

function normalizeOrder(channel, payload, quote) {
  const data = payload.data
  if (!isRecord(data)) throw new SyncError(uncertain, 502)
  if (channel.provider === 'newapi') {
    let payUrl = safeLink(quote.method === 'stripe' ? data.pay_link : payload.url)
    if (payUrl && quote.method !== 'stripe') {
      const url = new URL(payUrl)
      for (const [key, value] of Object.entries(data)) {
        if (!/^[a-z0-9_]{1,60}$/i.test(key) || typeof value !== 'string' || value.length > 8192) throw new SyncError(uncertain, 502)
        url.searchParams.set(key, value)
      }
      payUrl = url.href
    }
    if (!payUrl) throw new SyncError('订单可能已创建，但未取得有效支付链接，请前往上游核对。', 502)
    return { payUrl, id: label(data.out_trade_no) || null, payable: quote.payable, currency: quote.currency,
      notice: !data.out_trade_no ? '上游未返回订单编号，请在上游查询订单；可刷新余额确认到账。' : null }
  }
  if (!Number.isSafeInteger(data.order_id) || data.order_id <= 0) throw new SyncError(uncertain, 502)
  const qr = typeof data.qr_code === 'string' && data.qr_code.length <= 4096 ? data.qr_code : null
  const payUrl = safeLink(data.pay_url)
  return { id: String(data.order_id), payUrl, qr, payable: finite(data.pay_amount) ? data.pay_amount : null,
    currency: /^[A-Z]{3}$/.test(data.currency) ? data.currency : quote.currency,
    expiresAt: Number.isFinite(Date.parse(data.expires_at)) ? data.expires_at : null,
    // SDK/OAuth-only methods are completed on the upstream rather than exposing SDK secrets.
    notice: !payUrl && !qr ? '该订单需要上游收银台完成支付，请前往上游查看订单。' : null }
}

export function createChannelFunding({ channels, store, auth, now = Date.now, logs }) {
  const quotes = new Map()
  // A saved quote/order must never move to another account after editing credentials.
  const accountKey = channel => createHash('sha256').update(JSON.stringify([channel.provider, accountSite(channel).endpoint,
    channel.provider === 'sub2api' ? channel.email : channel.userId, channel.provider === 'newapi' ? channel.token : null])).digest('hex')
  function persist(channel) {
    try {
      if (store.saveChannels) store.saveChannels([channel])
      else store.save([...channels.values()])
    }
    catch { throw new SyncError('充值操作状态无法保存，本次未继续提交；请检查存储后重试。', 500) }
  }
  const attempts = channel => (Array.isArray(channel.fundingAttempts) ? channel.fundingAttempts : []).filter(item => item.account === accountKey(channel))
  const view = attempt => ({ id: attempt.id, action: attempt.action, status: attempt.status === 'pending' ? 'unknown' : attempt.status,
    message: attempt.message || uncertain, order: attempt.order ?? null, at: attempt.at })

  async function mutate(channel, id, action, fingerprint, operation, verify) {
    const existing = attempts(channel).find(item => item.id === id || (fingerprint && item.fingerprint === fingerprint && item.status !== 'rejected'))
    if (existing) {
      if (existing.action !== action || existing.fingerprint !== fingerprint) throw new SyncError('该提交标识已被使用，请重新核对。', 409)
      return view(existing)
    }
    const before = channel.fundingAttempts
    const attempt = { id, account: accountKey(channel), action, fingerprint, status: 'pending', at: new Date(now()).toISOString() }
    channel.fundingAttempts = [...attempts(channel).slice(-49), attempt]
    try { persist(channel) } catch (error) { channel.fundingAttempts = before; throw error }
    try {
      const result = await operation()
      attempt.status = 'success'; attempt.message = result.message; attempt.order = result.order ?? null
    } catch (error) {
      attempt.status = error instanceof SyncError && error.status < 500 ? 'rejected' : 'unknown'
      attempt.message = attempt.status === 'unknown' ? uncertain : error instanceof SyncError ? error.message : '上游未接受此操作。'
    }
    // Keep the confirmed upstream outcome even if the balance read or local write fails.
    try { persist(channel) }
    catch { attempt.message += ' 本地结果保存失败，请先核对上游记录，勿重复提交。' }
    if (action === 'redeem') {
      await verify()
      if (channel.balance?.status !== 'ok' && attempt.status === 'success') attempt.message += ' 余额暂未刷新，可稍后手动刷新。'
    }
    logs?.record({ category: 'funding', channelId: channel.id, channelName: channel.name, actor: 'user',
      level: attempt.status === 'success' ? 'success' : attempt.status === 'unknown' ? 'warning' : 'error',
      action: action === 'redeem' ? '兑换码提交结果' : '充值订单创建结果', message: attempt.message,
      details: { status: attempt.status, orderId: attempt.order?.id, requestId: attempt.id } })
    return view(attempt)
  }

  return (id, action, input = {}) => auth.withAccount(id, async (channel, verify) => {
    if (action === 'options') return { ...(await readFundingOptions(channel, true)), latest: attempts(channel).length ? view(attempts(channel).at(-1)) : null }
    if (!isRecord(input)) throw new SyncError('请求格式无效。')
    if (action === 'quote') {
      for (const [key, value] of quotes) if (value.expires <= now()) quotes.delete(key)
      if (quotes.size > 100) quotes.clear()
      const quote = await paymentQuote(channel, input, await readFundingOptions(channel))
      const quoteId = randomUUID()
      quotes.set(quoteId, { ...quote, channelId: id, account: accountKey(channel), expires: now() + 300000 })
      return { quote: { ...quote, id: quoteId, expiresAt: new Date(now() + 300000).toISOString() } }
    }
    if (action === 'status') {
      const attempt = attempts(channel).find(item => item.id === input.id)
      if (!attempt) throw new SyncError('充值记录不存在。', 404)
      if (attempt.order?.id) {
        if (channel.provider === 'sub2api') {
          const result = (await fundingRequest(channel, `/api/v1/payment/orders/${encodeURIComponent(attempt.order.id)}`)).data
          if (String(result?.id) !== attempt.order.id) throw new SyncError('上游返回的订单不匹配。', 502)
          attempt.order.status = label(result.status)
        } else {
          const result = (await fundingRequest(channel, `/api/user/topup/self?p=1&page_size=100&keyword=${encodeURIComponent(attempt.order.id)}`)).data
          const order = result?.items?.find(item => item.trade_no === attempt.order.id)
          if (order) attempt.order.status = label(order.status)
        }
        persist(channel)
        await verify()
      }
      return { result: view(attempt) }
    }
    if (action === 'redeem') {
      const code = textValue(input.code)
      if (!code || code.length > 256 || /\s|[\x00-\x1f\x7f]/.test(code) || !/^[a-f0-9-]{36}$/i.test(input.requestId ?? '')) throw new SyncError('请输入有效的兑换码。')
      const fingerprint = createHash('sha256').update(code).digest('hex')
      return { result: await mutate(channel, input.requestId, action, fingerprint, async () => {
        const payload = await fundingRequest(channel, channel.provider === 'sub2api' ? '/api/v1/redeem' : '/api/user/topup',
          channel.provider === 'sub2api' ? { code } : { key: code })
        const type = payload.data?.type
        return { message: type === 'subscription' ? '兑换成功，订阅已在上游生效。' : type === 'concurrency' ? '兑换成功，并发额度已在上游生效。' : '兑换成功，账户余额已重新查询。' }
      }, verify) }
    }
    if (action === 'pay') {
      if (!/^[a-f0-9-]{36}$/i.test(input.quoteId ?? '')) throw new SyncError('请先核算充值金额。')
      const old = attempts(channel).find(item => item.id === input.quoteId && item.action === 'pay')
      if (old) return { result: view(old) }
      const quote = quotes.get(input.quoteId)
      if (!quote || quote.channelId !== id || quote.account !== accountKey(channel) || quote.expires <= now()) throw Object.assign(new SyncError('金额确认已过期或账户已变更，请重新核算。', 409), { code: 'QUOTE_EXPIRED' })
      const fresh = await paymentQuote(channel, quote, await readFundingOptions(channel))
      if (fresh.payable !== quote.payable || fresh.currency !== quote.currency) throw Object.assign(new SyncError('上游价格已变化，请重新核算后确认。', 409), { code: 'QUOTE_CHANGED' })
      return { result: await mutate(channel, input.quoteId, action, null, async () => {
        const path = channel.provider === 'sub2api' ? '/api/v1/payment/orders' : quote.method === 'stripe' ? '/api/user/stripe/pay' : '/api/user/pay'
        const body = channel.provider === 'sub2api' ? { amount: quote.amount, payment_type: quote.method, order_type: 'balance', is_mobile: false,
          payment_source: 'hosted_redirect', return_url: accountSite(channel).endpoint + '/payment/result' }
          : { amount: quote.amount, payment_method: quote.method }
        const order = normalizeOrder(channel, await fundingRequest(channel, path, body), quote)
        return { message: '充值订单已创建，完成付款后查询到账状态。', order }
      }, verify) }
    }
    throw new SyncError('充值接口不存在。', 404)
  })
}
