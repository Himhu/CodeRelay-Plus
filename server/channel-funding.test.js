import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { monitorAPI } from './monitor-api.js'

test('funding uses user credentials, confirms prices, redeems once and preserves uncertain results across restart', async t => {
  let balance = 2, quota = 500000, redeemCalls = 0, paymentCalls = 0, fee = 2, currency = 'CNY', failSave = false, failBalance = false
  let snapshot, held, release, received, newToken = 'account-secret'
  let online = true, paymentMissing = false, settingsUnavailable = false, topupLink = 'https://shop.example.test/newapi-codes'
  let publicSettings = { purchase_subscription_enabled: true, purchase_subscription_url: 'https://shop.example.test/codes' }
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null
    const send = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
    if (req.url === '/api/v1/settings/public') {
      assert.equal(req.headers.authorization, undefined, 'Public settings do not need account credentials')
      return settingsUnavailable ? send({ code: 503 }, 503) : send({ code: 0, data: publicSettings })
    }
    if (req.url === '/api/status') return send({ success: true, data: { quota_display_type: 'USD', quota_per_unit: 500000 } })
    assert.equal(req.headers.authorization, `Bearer ${req.url.startsWith('/api/user/') ? newToken : 'account-secret'}`)
    if (req.url === '/api/v1/auth/me') return failBalance ? send({ code: 503 }, 503) : send({ code: 0, data: { id: 1, balance } })
    if (req.url === '/api/user/self') { assert.equal(req.headers['new-api-user'], '7'); return send({ success: true, data: { id: 7, quota } }) }
    if (req.url === '/api/v1/payment/config') return paymentMissing ? send({ code: 404 }, 404) : send({ code: 0, data: { enabled: online } })
    if (req.url === '/api/v1/payment/checkout-info') return send({ code: 0, data: { balance_disabled: false, recharge_fee_rate: fee,
      methods: { alipay: { single_min: 10, single_max: 1000, currency }, disabled: { available: false } } } })
    if (req.url === '/api/user/topup/info') return send({ success: true, data: { enable_redemption: true, enable_online_topup: online, enable_stripe_topup: online, min_topup: 1, topup_link: topupLink,
      pay_methods: [{ type: 'alipay', name: '支付宝' }, { type: 'stripe', min_topup: '1' }] } })
    if (req.url === '/api/user/stripe/amount') return send({ message: 'success', data: '1.50' })
    if (req.url === '/api/user/stripe/pay') {
      assert.deepEqual(body, { amount: 1, payment_method: 'stripe' })
      paymentCalls++; return send({ message: 'success', data: { pay_link: 'https://checkout.stripe.com/test' } })
    }
    if (req.url === '/api/user/amount') return send({ message: 'success', data: '7.00' })
    if (req.url === '/api/user/pay') { paymentCalls++; return send({ message: 'success', url: 'https://pay.example.test/submit.php', data: { pid: '1', money: '7.00', out_trade_no: 'new-order', sign: 'payment-sign' } }) }
    if (req.url === '/api/v1/payment/orders') {
      assert.equal(body.amount, 10)
      assert.equal(body.payment_type, 'alipay')
      assert.equal(body.order_type, 'balance')
      assert.equal(body.is_mobile, false)
      assert.equal(body.payment_source, 'hosted_redirect')
      assert.ok(body.return_url.endsWith('/payment/result'))
      paymentCalls++; return send({ code: 0, data: { order_id: 5, pay_amount: 10.2, currency: 'CNY', qr_code: 'https://pay.example.test/qr', pay_url: 'https://pay.example.test/pay', expires_at: '2030-01-01T00:00:00Z' } })
    }
    if (req.url === '/api/v1/payment/orders/5') return send({ code: 0, data: { id: 5, status: 'COMPLETED', client_secret: 'do-not-expose' } })
    if (req.url.startsWith('/api/user/topup/self?')) return send({ success: true, data: { items: [{ trade_no: 'new-order', status: 'success' }] } })
    if (req.url === '/api/v1/redeem' || req.url === '/api/user/topup') {
      redeemCalls++
      const code = body.code || body.key
      if (code === 'already-used') return send({ code: 409, reason: 'REDEEM_CODE_USED', message: 'secret-code account-secret' }, 409)
      if (code === 'unknown-result') { res.destroy(); return }
      if (code === 'hold') { received(); await held }
      if (code === 'refresh-fails') failBalance = true
      if (req.url === '/api/user/topup') { assert.deepEqual(body, { key: 'new-code' }); quota += 500000; return send({ success: true, data: 500000 }) }
      balance += 20
      return send({ code: 0, data: { code, type: 'balance', value: 20, new_balance: 9999 } })
    }
    assert.fail(`Unexpected path ${req.url}`)
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening'); t.after(() => upstream.close())
  snapshot = ['sub2api', 'newapi'].map(provider => ({ id: provider, name: provider, provider,
    endpoint: `http://127.0.0.1:${upstream.address().port}/v1`, token: 'account-secret', userId: '7', rechargeRate: 2 }))
  const store = { load: () => structuredClone(snapshot), save: values => { if (failSave) throw Error('disk-full'); snapshot = structuredClone(values) } }
  let middleware = monitorAPI({ channelStore: store })
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end() }))
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  async function request(provider, action, body, origin = base) {
    const response = await fetch(`${base}/api/upstream-channels/${provider}/funding/${action}`, { method: body ? 'POST' : 'GET',
      headers: body ? { Origin: origin, 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
    return { status: response.status, ...await response.json() }
  }
  const redeem = (code, requestId = randomUUID()) => request('sub2api', 'redeem', { code, requestId })
  let options = await request('sub2api', 'options')
  assert.equal(options.status, 200)
  assert.equal(options.methods.length, 1)
  assert.equal(options.methods[0].min, 10)
  assert.equal(redeemCalls + paymentCalls, 0)
  assert.equal(options.purchaseLinks[0].url, 'https://shop.example.test/codes')
  online = false
  options = await request('sub2api', 'options')
  assert.equal(options.methods.length, 0)
  assert.equal(options.purchaseLinks[0].url, 'https://shop.example.test/codes')
  publicSettings = { purchase_subscription_enabled: false, purchase_subscription_url: 'https://disabled.example.test/', custom_menu_items: [
    { id: 'migrated_purchase_subscription', label: 'Purchase', url: 'https://shop.example.test/codes', visibility: 'user' },
    { label: '购买兑换码', url: 'https://shop.example.test/codes', visibility: 'user' },
    { label: '充值卡', url: '/shop', visibility: 'user' },
    { label: '管理员购卡', url: 'https://admin.example.test/', visibility: 'admin' },
    { label: '兑换码', url: 'javascript:alert(1)', visibility: 'user' },
    { label: '兑换码', url: 'https://account:secret@shop.example.test/', visibility: 'user' },
    { label: '文档', url: 'https://docs.example.test/', visibility: 'user' },
  ] }
  paymentMissing = true
  options = await request('sub2api', 'options')
  assert.deepEqual(options.purchaseLinks.map(item => item.url), ['https://shop.example.test/codes', `http://127.0.0.1:${upstream.address().port}/shop`])
  publicSettings = { balance_low_notify_recharge_url: 'https://upstream.example.test/' }
  options = await request('sub2api', 'options')
  assert.deepEqual(options.purchaseLinks, [], 'A generic recharge URL is not a code purchase address')
  assert.equal(options.upstreamUrl, 'https://upstream.example.test/')
  paymentMissing = false; settingsUnavailable = true; online = true
  options = await request('sub2api', 'options')
  assert.equal(options.methods.length, 1, 'Unavailable public settings do not disable payments')
  assert.match(options.purchaseNotice, /暂时无法读取/)
  settingsUnavailable = false; online = false
  options = await request('newapi', 'options')
  assert.equal(options.methods.length, 0)
  assert.equal(options.purchaseLinks[0].url, topupLink)
  assert.ok(options.upstreamUrl.endsWith('/console/topup'))
  topupLink = 'javascript:alert(1)'
  assert.deepEqual((await request('newapi', 'options')).purchaseLinks, [])
  online = true
  assert.equal((await request('sub2api', 'redeem', { code: 'secret', requestId: randomUUID() }, 'https://foreign.example')).status, 403)
  assert.equal((await request('sub2api', 'quote', { method: 'alipay', amount: 1 })).status, 400)
  fee = 2.5; currency = 'JPY'
  assert.equal((await request('sub2api', 'quote', { method: 'alipay', amount: 100 })).quote.payable, 103)
  assert.equal((await request('sub2api', 'quote', { method: 'alipay', amount: 100.5 })).status, 400)
  fee = 1; currency = 'KWD'
  assert.equal((await request('sub2api', 'quote', { method: 'alipay', amount: 12.345 })).quote.payable, 12.469)
  fee = 0.07; currency = 'CNY'
  assert.equal((await request('sub2api', 'quote', { method: 'alipay', amount: 10 })).quote.payable, 10.01)
  fee = 2
  const successful = await redeem('fresh-code')
  assert.equal(successful.result.status, 'success')
  assert.equal(successful.channels[0].balance.amount, 11)
  assert.equal(redeemCalls, 1)
  assert.ok(!JSON.stringify(successful).includes('fresh-code'))
  assert.ok(!JSON.stringify(snapshot).includes('fresh-code'))
  assert.equal((await redeem('fresh-code')).result.status, 'success')
  assert.equal(redeemCalls, 1)
  const used = await redeem('already-used')
  assert.equal(used.result.status, 'rejected')
  assert.match(used.result.message, /已使用/)
  assert.ok(!JSON.stringify(used).includes('account-secret'))
  let quote = (await request('sub2api', 'quote', { method: 'alipay', amount: 10 })).quote
  assert.equal(quote.payable, 10.2)
  assert.equal(paymentCalls, 0)
  fee = 3
  const changedQuote = await request('sub2api', 'pay', { quoteId: quote.id })
  assert.equal(changedQuote.status, 409)
  assert.equal(changedQuote.code, 'QUOTE_CHANGED')
  assert.equal(paymentCalls, 0)
  fee = 2
  let order = await request('sub2api', 'pay', { quoteId: quote.id })
  assert.equal(order.result.order.payable, 10.2)
  assert.equal(order.result.order.id, '5')
  assert.equal(paymentCalls, 1)
  await request('sub2api', 'pay', { quoteId: quote.id })
  assert.equal(paymentCalls, 1)
  assert.equal((await request('sub2api', 'status', { id: order.result.id })).result.order.status, 'COMPLETED')
  const unknownId = randomUUID()
  assert.equal((await redeem('unknown-result', unknownId)).result.status, 'unknown')
  const count = redeemCalls
  middleware = monitorAPI({ channelStore: store })
  assert.equal((await redeem('unknown-result', unknownId)).result.status, 'unknown')
  assert.equal((await redeem('unknown-result')).result.status, 'unknown')
  assert.equal(redeemCalls, count)
  await request('sub2api', 'pay', { quoteId: quote.id })
  assert.equal(paymentCalls, 1, 'Restart does not recreate a paid operation')
  failSave = true
  assert.equal((await redeem('must-not-send')).status, 409)
  assert.equal(redeemCalls, count)
  failSave = false
  const started = new Promise(resolve => { received = resolve })
  held = new Promise(resolve => { release = resolve })
  const heldId = randomUUID()
  const waiting = redeem('hold', heldId)
  await started
  const callsBeforeRetry = redeemCalls
  const retry = redeem('hold', heldId)
  release(); await waiting
  assert.equal((await retry).status, 200)
  assert.equal(redeemCalls, callsBeforeRetry, 'A queued duplicate returns the saved result without submitting again')
  const refreshFailure = await redeem('refresh-fails')
  assert.equal(refreshFailure.result.status, 'success')
  assert.match(refreshFailure.result.message, /余额暂未刷新/)
  failBalance = false
  const newRedeem = await request('newapi', 'redeem', { code: 'new-code', requestId: randomUUID() })
  assert.equal(newRedeem.result.status, 'success')
  assert.equal(newRedeem.channels[1].balance.amount, 1)
  quote = (await request('newapi', 'quote', { method: 'alipay', amount: 1 })).quote
  assert.equal(quote.payable, 7)
  order = await request('newapi', 'pay', { quoteId: quote.id })
  const link = new URL(order.result.order.payUrl)
  assert.equal(link.origin, 'https://pay.example.test')
  assert.equal(link.searchParams.get('money'), '7.00')
  assert.equal((await request('newapi', 'status', { id: order.result.id })).result.order.status, 'success')
  quote = (await request('newapi', 'quote', { method: 'stripe', amount: 1 })).quote
  assert.equal(quote.payable, 1.5)
  assert.equal(quote.currency, null, 'Never guess a Stripe account currency')
  order = await request('newapi', 'pay', { quoteId: quote.id })
  assert.equal(order.result.order.payUrl, 'https://checkout.stripe.com/test')
  assert.match(order.result.order.notice, /未返回订单编号/)
  const staleQuote = (await request('newapi', 'quote', { method: 'alipay', amount: 1 })).quote
  const paymentsBeforeEdit = paymentCalls
  const edited = await fetch(`${base}/api/upstream-channels`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'newapi', edit: true, provider: 'newapi', name: 'newapi', endpoint: snapshot.find(item => item.id === 'newapi').endpoint,
      token: 'changed-account-secret', userId: '7' }) })
  assert.equal(edited.status, 200)
  newToken = 'changed-account-secret'
  const expiredQuote = await request('newapi', 'pay', { quoteId: staleQuote.id })
  assert.equal(expiredQuote.status, 409)
  assert.equal(expiredQuote.code, 'QUOTE_EXPIRED')
  assert.equal((await request('newapi', 'options')).latest, null)
  assert.equal(paymentCalls, paymentsBeforeEdit, 'Changing credentials cannot transfer an earlier quote/order to another account')
  const publicData = await (await fetch(`${base}/api/upstream-channels`)).text()
  assert.ok(!/fundingAttempts|payment-sign|account-secret|do-not-expose/.test(publicData))
})
