import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { chromium, expect } from '@playwright/test'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

test('balance funding dialog confirms redemption and payment separately, displays QR and refreshes balance', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-funding-browser-'))
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false,
    plugins: [react()], cacheDir: join(directory, '.vite'), server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  const browser = await chromium.launch()
  t.after(async () => { await browser.close(); await server.close(); rmSync(directory, { recursive: true, force: true }) })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const channel = { id: 'sample', name: '测试上游', provider: 'sub2api', endpoint: 'https://upstream.example.test',
    rechargeRate: 2, needsAuthorization: false, auth: { status: 'authorized' },
    balance: { status: 'ok', amount: 5, currency: 'USD', symbol: '$' } }
  let redeemed = 0, ordered = 0, quoted = 0, refreshed = 0, failed = false, latest = null
  let online = true, purchaseLinks = [], expiredQuote = true, payRequests = 0
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/api/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname
    const data = req.method() === 'POST' ? req.postDataJSON() : null
    let result
    if (path === '/api/settings') return route.fulfill({ json: { settings: { lowBalanceThreshold: 5 }, balanceNotices: { low: [], unavailable: [] } } })
    if (path === '/api/upstream-channels') result = { channels: [channel] }
    else if (path.endsWith('/balance/check')) { refreshed++; result = { channels: [channel] } }
    else if (path.endsWith('/funding/options')) result = { redeem: true, upstreamUrl: 'https://upstream.example.test/purchase', latest, purchaseLinks,
      methods: online ? [{ id: 'alipay', name: '支付宝', min: 10, max: 1000, currency: 'CNY', amountUnit: '充值金额', step: 0.01 }] : [] }
    else if (path.endsWith('/funding/redeem')) {
      redeemed++; assert.equal(data.code, 'private-redeem-code')
      await new Promise(resolve => setTimeout(resolve, 150))
      channel.balance.amount = 15
      latest = { id: data.requestId, action: 'redeem', status: failed ? 'unknown' : 'success', message: failed ? '上游处理结果暂未确认。请先核对记录。' : '兑换成功，账户余额已重新查询。' }
      result = { result: latest, channels: [channel] }
    } else if (path.endsWith('/funding/quote')) {
      quoted++; assert.deepEqual(data, { amount: 10, method: 'alipay' })
      result = { quote: { id: 'quoted-order', amount: 10, payable: 10.2, currency: 'CNY', method: 'alipay' } }
    } else if (path.endsWith('/funding/pay')) {
      payRequests++
      if (expiredQuote) return route.fulfill({ status: 409, json: { code: 'QUOTE_EXPIRED', error: '金额确认已过期，请重新核算。' } })
      ordered++; assert.deepEqual(data, { quoteId: 'quoted-order' })
      latest = { id: 'order', status: 'success', action: 'pay', message: '充值订单已创建，完成付款后查询到账状态。',
        order: { id: '5', payable: 10.2, currency: 'CNY', qr: 'https://pay.example.test/qr', payUrl: 'https://pay.example.test/order' } }
      result = { result: latest }
    } else if (path.endsWith('/funding/status')) {
      latest.order.status = 'COMPLETED'; result = { result: latest }
    } else throw new Error(`Unexpected request ${path}`)
    await route.fulfill({ json: result })
  })
  await page.goto(server.resolvedUrls.local[0])
  await page.getByRole('button', { name: '充值兑换 测试上游', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '充值与兑换', exact: true })
  await dialog.getByLabel('兑换码 / 激活码', { exact: true }).fill('private-redeem-code')
  await dialog.getByRole('button', { name: '显示兑换码', exact: true }).click()
  assert.equal(await dialog.getByLabel('兑换码 / 激活码', { exact: true }).getAttribute('type'), 'text')
  await dialog.getByRole('button', { name: '确认兑换', exact: true }).click()
  await expect(dialog.getByRole('button', { name: '正在兑换…', exact: true })).toBeDisabled()
  await dialog.getByText('兑换成功，账户余额已重新查询。', { exact: true }).waitFor()
  await expect(page.getByLabel('测试上游 账户余额', { exact: true }).locator(':scope > strong')).toContainText('$15.00')
  assert.equal(redeemed, 1)
  assert.ok(refreshed >= 1)
  assert.ok(!(await dialog.textContent()).includes('private-redeem-code'))
  await dialog.getByRole('button', { name: '进行下一笔操作', exact: true }).click()
  await dialog.getByRole('tab', { name: '在线充值 · 1', exact: true }).click()
  await dialog.getByLabel('充值金额（CNY）', { exact: true }).fill('10')
  await dialog.getByRole('button', { name: '核算充值金额', exact: true }).click()
  await dialog.getByText('CNY 10.20', { exact: true }).waitFor()
  assert.equal(quoted, 1)
  assert.equal(ordered, 0)
  await dialog.getByRole('button', { name: '确认创建充值订单', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('本次未创建订单')
  await expect(dialog.getByRole('button', { name: '核算充值金额', exact: true })).toBeVisible()
  assert.equal(payRequests, 1)
  assert.equal(ordered, 0)
  expiredQuote = false
  await dialog.getByRole('button', { name: '核算充值金额', exact: true }).click()
  await expect(dialog.getByRole('button', { name: '确认创建充值订单', exact: true })).toBeVisible()
  assert.equal(ordered, 0, 'Requoting still requires explicit order confirmation')
  await dialog.getByRole('button', { name: '确认创建充值订单', exact: true }).click()
  await dialog.getByText('使用对应支付应用扫码', { exact: true }).waitFor()
  assert.equal(ordered, 1)
  assert.equal(await dialog.getByRole('link', { name: '打开支付页面' }).getAttribute('href'), 'https://pay.example.test/order')
  await dialog.getByRole('button', { name: '查询订单并刷新余额', exact: true }).click()
  await dialog.getByText('已到账', { exact: true }).waitFor()
  assert.equal(await dialog.getByRole('link', { name: '打开支付页面' }).count(), 0)
  assert.equal(await dialog.getByText('使用对应支付应用扫码', { exact: true }).count(), 0)
  await page.screenshot({ path: join(tmpdir(), 'signal-funding-desktop.png'), fullPage: true })
  await dialog.getByRole('button', { name: '关闭充值与兑换', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '充值兑换 测试上游', exact: true }).click()
  await dialog.getByText('已到账', { exact: true }).waitFor()
  await page.screenshot({ path: join(tmpdir(), 'signal-funding-mobile.png'), fullPage: true })
  const box = await dialog.boundingBox()
  assert.ok(box.x >= 0 && box.x + box.width <= 390 && box.height <= 844)
  assert.ok(Number.parseFloat(await dialog.getByRole('button', { name: '查询订单并刷新余额', exact: true }).evaluate(element => getComputedStyle(element).fontSize)) >= 12)
  await dialog.getByRole('button', { name: '进行下一笔操作', exact: true }).click()
  failed = true
  await dialog.getByLabel('兑换码 / 激活码', { exact: true }).fill('private-redeem-code')
  await dialog.getByRole('button', { name: '确认兑换', exact: true }).click()
  await dialog.getByText('上游处理结果暂未确认。请先核对记录。', { exact: true }).waitFor()
  assert.equal(await dialog.getByRole('button', { name: '确认兑换', exact: true }).count(), 0)
  await expect(dialog.getByRole('button', { name: '已在上游核对，进行下一笔操作', exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '关闭充值与兑换', exact: true }).click()
  online = false; latest = null
  purchaseLinks = [{ name: '购买兑换码', url: 'https://shop.example.test/codes', host: 'shop.example.test' }]
  await page.getByRole('button', { name: '充值兑换 测试上游', exact: true }).click()
  const purchase = dialog.getByRole('link', { name: '购买兑换码 shop.example.test', exact: true })
  await expect(purchase).toBeVisible()
  assert.equal(await purchase.getAttribute('href'), 'https://shop.example.test/codes')
  assert.equal(await purchase.getAttribute('target'), '_blank')
  assert.match(await purchase.getAttribute('rel'), /noreferrer/)
  await dialog.getByLabel('兑换码 / 激活码', { exact: true }).waitFor()
  await dialog.getByRole('tab', { name: '在线充值', exact: true }).click()
  await expect(purchase).toBeVisible()
  assert.equal(await dialog.getByRole('button', { name: '核算充值金额' }).count(), 0)
  await page.screenshot({ path: join(tmpdir(), 'signal-code-purchase-mobile.png') })
  await dialog.getByRole('button', { name: '关闭充值与兑换', exact: true }).click()
  purchaseLinks = []
  await page.getByRole('button', { name: '充值兑换 测试上游', exact: true }).click()
  await expect(dialog.getByText('上游未提供兑换码购买地址，请前往上游查看或联系站点客服。', { exact: true })).toBeVisible()
  assert.equal(ordered, 1)
  assert.equal(redeemed, 2)
  assert.deepEqual(errors, [])
})

test('announcement funding works outside overview, fetches only the chosen station and keeps the result after low-balance notices disappear', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-notice-funding-'))
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false,
    plugins: [react()], cacheDir: join(directory, '.vite'), server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  const browser = await chromium.launch()
  t.after(async () => { await browser.close(); await server.close(); rmSync(directory, { recursive: true, force: true }) })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const channels = ['newapi', 'sub2api'].map((provider, i) => ({ id: provider, name: `公告上游 ${i + 1}`, provider,
    endpoint: `https://${provider}.example.test`, needsAuthorization: false, rechargeRate: 1, auth: { status: 'authorized' },
    balance: { amount: i + 1, currency: 'USD', symbol: '$', status: 'ok', updatedAt: new Date().toISOString() } }))
  const optionReads = [], redeemed = [], errors = []
  let channelReads = 0, optionsFail = true, failedOptionReads = 0
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (path === '/api/settings') return route.fulfill({ json: { settings: { lowBalanceThreshold: 5 }, balanceNotices: {
      low: channels.filter(channel => channel.balance.amount <= 5).map(channel => ({ id: channel.id, name: channel.name,
        provider: channel.provider, endpoint: channel.endpoint, needsAuthorization: false, amount: channel.balance.amount, updatedAt: channel.balance.updatedAt })), unavailable: [],
    } } })
    if (path === '/api/upstream-channels') { channelReads++; return route.fulfill({ json: { channels } }) }
    const match = path.match(/^\/api\/upstream-channels\/([^/]+)\/funding\/(options|redeem)$/)
    assert.ok(match, `Unexpected request ${path}; opening the dialog must not create an order`)
    const channel = channels.find(channel => channel.id === match[1])
    assert.ok(channel)
    if (match[2] === 'options') {
      assert.equal(request.method(), 'GET')
      optionReads.push(channel.id)
      if (optionsFail) return route.fulfill({ status: 502, json: { error: '上游暂时无法连接，请重试。' } })
      return route.fulfill({ json: { redeem: true, upstreamUrl: `${channel.endpoint}/purchase`, methods: channel.provider === 'sub2api'
        ? [{ id: 'alipay', name: '支付宝', min: 10, currency: 'CNY', amountUnit: '充值金额', step: 0.01 }] : [],
        purchaseLinks: channel.provider === 'newapi' ? [{ name: '购买兑换码', url: 'https://shop.example.test/codes', host: 'shop.example.test' }] : [],
      } })
    }
    assert.equal(request.method(), 'POST')
    assert.equal(request.postDataJSON().code, `code-${channel.id}`)
    redeemed.push(channel.id)
    channel.balance.amount = 20
    return route.fulfill({ json: { channels, result: { status: 'success', message: '兑换成功，账户余额已重新查询。' } } })
  })
  await page.goto(`${server.resolvedUrls.local[0]}#settings`)
  const notice = page.getByRole('region', { name: '上游余额公告' })
  await notice.locator('summary').click()
  await expect(notice.locator('li')).toHaveCount(2)
  assert.deepEqual(optionReads, [], 'Reading or expanding notices must not query upstream funding')
  assert.equal(channelReads, 0, 'Funding notices must work without fetching the overview')
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    const button = await notice.getByRole('button', { name: '充值兑换 公告上游 1', exact: true }).boundingBox()
    assert.ok(button.x >= 0 && button.x + button.width <= width && button.height >= (width <= 600 ? 44 : 36))
    await page.screenshot({ path: join(tmpdir(), `signal-notice-funding-${width}.png`) })
  }
  const dialog = page.getByRole('dialog', { name: '充值与兑换', exact: true })
  for (const channel of channels) {
    await notice.getByRole('button', { name: `充值兑换 ${channel.name}`, exact: true }).click()
    await expect(dialog.locator('.funding-account')).toContainText(channel.name)
    await expect(dialog.locator('.funding-account')).toContainText(channel.endpoint)
    if (optionsFail) {
      await expect(dialog.getByRole('alert')).toContainText('上游暂时无法连接')
      failedOptionReads = optionReads.length
      optionsFail = false
      await dialog.getByRole('button', { name: '重新读取充值方式', exact: true }).click()
    }
    await dialog.getByLabel('兑换码 / 激活码', { exact: true }).waitFor()
    assert.equal(optionReads.at(-1), channel.id)
    if (channel.provider === 'newapi') await expect(dialog.getByRole('link', { name: '购买兑换码 shop.example.test', exact: true })).toHaveAttribute('href', 'https://shop.example.test/codes')
    else await expect(dialog.getByRole('tab', { name: '在线充值 · 1', exact: true })).toBeVisible()
    await dialog.getByLabel('兑换码 / 激活码', { exact: true }).fill(`code-${channel.id}`)
    await dialog.getByRole('button', { name: '确认兑换', exact: true }).click()
    await expect(notice.getByRole('button', { name: `充值兑换 ${channel.name}`, exact: true })).toHaveCount(0)
    await expect(dialog.getByText('兑换成功，账户余额已重新查询。', { exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: '关闭充值与兑换', exact: true }).click()
  }
  await expect(notice).toHaveCount(0)
  assert.deepEqual(optionReads, [...Array(failedOptionReads).fill('newapi'), 'newapi', 'sub2api'])
  assert.deepEqual(redeemed, ['newapi', 'sub2api'])
  assert.equal(channelReads, 0)
  await page.evaluate(() => { window.location.hash = 'overview' })
  for (const channel of channels) await expect(page.getByLabel(`${channel.name} 账户余额`, { exact: true }).locator(':scope > strong')).toContainText('$20.00')
  assert.deepEqual(errors, [])
})
