import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { chromium, expect } from '@playwright/test'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { monitorAPI } from '../server/monitor-api.js'
import { createConsoleSettingsStore } from '../server/site-store.js'

test('static balance notice lists all stations and uses persisted settings on desktop and mobile without upstream requests', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-balance-ui-'))
  const store = createConsoleSettingsStore(directory)
  let failSave = false, failRead = false, reads = 0
  const channels = Array.from({ length: 8 }, (_, i) => ({ id: String(i), name: `测试站点 ${i}`, provider: 'sub2api', endpoint: 'https://example.test', rechargeRate: 10,
    balance: { status: 'ok', rawAmount: i * 10, amount: i, currency: 'USD', updatedAt: new Date().toISOString() } }))
  const createAPI = () => monitorAPI({ channelStore: { load: () => channels }, settingsStore: { load: () => store.load(), save: values => {
    if (failSave) throw new Error('Disk full')
    store.save(values)
  } } })
  let api = createAPI()
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false,
    plugins: [react(), { name: 'balance-test-api', configureServer(server) { server.middlewares.use((req, res, next) => {
      if (req.url === '/api/settings' && req.method === 'GET') {
        reads++
        if (failRead) { res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: '读取失败' })) }
      }
      return api(req, res, next)
    }) } }], cacheDir: join(directory, '.vite'), server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  const browser = await chromium.launch()
  t.after(async () => { await browser.close(); await server.close(); rmSync(directory, { recursive: true, force: true }) })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  await page.clock.install()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(server.resolvedUrls.local[0])
  const notice = page.getByRole('region', { name: '上游余额公告' })
  await expect(notice.locator('.balance-notice-label')).toHaveText('低余额 6 站')
  await expect(notice.locator('.balance-notice-copy')).toHaveCount(1)
  await expect(notice.locator('.balance-notice-copy > span')).toHaveCount(6)
  await expect(notice.getByRole('button', { name: /滚动余额公告/ })).toHaveCount(0)
  assert.equal(await notice.locator('.balance-notice-copy').evaluate(el => getComputedStyle(el).animationName), 'none')
  await notice.locator('summary').click()
  await expect(notice.locator('li')).toHaveCount(5)
  await expect(notice.locator('li').filter({ hasText: '测试站点 4' })).toContainText('US$4.00')
  await expect(notice.getByRole('link', { name: '前往总览授权 测试站点 4', exact: true })).toHaveAttribute('href', '#overview')
  await notice.getByRole('navigation', { name: '余额提醒分页' }).getByRole('button', { name: '下一页', exact: true }).click()
  await expect(notice.locator('li')).toHaveCount(1)
  await expect(notice.locator('li')).toContainText('测试站点 5')
  await notice.getByRole('link', { name: '设置阈值' }).click()
  const threshold = page.getByLabel('最低余额阈值 USD')
  await expect(threshold).toHaveValue('5')
  await threshold.fill('0')
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('设置已保存')
  await expect(notice.locator('.balance-notice-label')).toHaveText('低余额 1 站')
  assert.equal(store.load()[0].lowBalanceThreshold, 0)
  failSave = true
  await threshold.fill('10.5')
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('原阈值未改变')
  await expect(threshold).toHaveValue('10.5')
  await expect(notice.locator('.balance-notice-label')).toHaveText('低余额 1 站')
  failSave = false
  api = createAPI()
  await page.reload()
  await expect(threshold).toHaveValue('0')
  await threshold.fill('2.55')
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  await expect(notice.locator('.balance-notice-label')).toHaveText('低余额 3 站')
  const previousReads = reads
  channels[2].balance.rawAmount = 100
  await page.clock.fastForward(30000)
  await expect(notice.locator('.balance-notice-label')).toHaveText('低余额 2 站')
  assert.ok(reads > previousReads)
  await threshold.fill('6')
  await page.clock.fastForward(30000)
  await expect(threshold).toHaveValue('6', { timeout: 3000 })
  failRead = true
  await page.clock.fastForward(30000)
  await expect(notice.locator('.balance-notice-error')).toContainText('公告更新失败，以下为上次结果')
  await expect(notice.locator('.balance-notice-label')).toHaveText('低余额 2 站')
  failRead = false
  await notice.getByRole('button', { name: '重试', exact: true }).click()
  await expect(notice.locator('.balance-notice-error')).toHaveCount(0)
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 })
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: join(tmpdir(), `signal-balance-settings-${width}.png`) })
  }
  await page.emulateMedia({ reducedMotion: 'reduce' })
  assert.equal(await notice.locator('.balance-notice-copy').evaluate(el => getComputedStyle(el).animationName), 'none')
  assert.deepEqual(errors, [])
})
