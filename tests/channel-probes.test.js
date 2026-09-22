import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { chromium, expect } from '@playwright/test'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { channelProbeSummary } from '../server/channel-probes.js'

test('overview renders and refreshes real channel summaries and filters statuses and models without main-site requests', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-overview-probes-'))
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false,
    plugins: [react()], cacheDir: join(directory, '.vite'), server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  const browser = await chromium.launch()
  t.after(async () => { await browser.close(); await server.close(); rmSync(directory, { recursive: true, force: true }) })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai' })
  let now = Date.parse('2026-09-18T00:10:30Z'), reads = 0
  await page.clock.install({ time: now - 1000 })
  await page.clock.pauseAt(now)
  const model = (id, status) => ({ id, protocol: 'chat', status, lastProbeAt: new Date(now - 1000).toISOString(),
    probeHistory: [{ status, at: new Date(now - 60000).toISOString() }] })
  const token = (models, enabled = true) => ({ id: 'key', status: 'active', key: 'private-key', probeEnabled: enabled, probeModels: models })
  const channels = [
    { id: 'a', name: '正常上游', probeTokens: [token([model('claude-sonnet', 'ok')])] },
    { id: 'b', name: '部分异常上游', probeTokens: [token([model('gpt-5', 'ok'), model('grok-4', 'error')])] },
    { id: 'c', name: '关闭探测上游', probeTokens: [token([model('gpt-5', 'error')], false)] },
  ]
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/api/**', async route => {
    assert.equal(route.request().method(), 'GET', 'Overview updates never trigger extra paid probes')
    const path = new URL(route.request().url()).pathname
    if (path === '/api/settings') return route.fulfill({ json: { settings: { lowBalanceThreshold: 5 }, balanceNotices: { low: [], unavailable: [] } } })
    if (path === '/api/upstream-channels') {
      reads++
      return route.fulfill({ json: { channels: channels.map(channel => ({ id: channel.id, name: channel.name, provider: 'newapi',
        endpoint: 'https://upstream.example.test', needsAuthorization: false, auth: { status: 'configured' },
        balance: { status: 'ok', amount: 5, currency: 'USD', symbol: '$' }, probeSummary: channelProbeSummary(channel, now) })) } })
    }
    assert.fail(`Unexpected overview request: ${path}`)
  })
  await page.goto(server.resolvedUrls.local[0])
  const table = page.locator('.channels-panel')
  const row = name => table.getByRole('row').filter({ has: page.getByText(name, { exact: true }) })
  await expect(row('正常上游').locator('.status-label')).toHaveText('正常')
  await expect(row('部分异常上游').locator('.status-label')).toHaveText('部分异常')
  await expect(row('关闭探测上游').locator('.status-label')).toHaveText('未启用')
  await expect(row('部分异常上游').getByRole('cell').nth(4)).toContainText('50.00%')
  await row('部分异常上游').getByRole('cell').nth(4).locator('summary').click()
  await expect(row('部分异常上游').getByRole('cell').nth(4)).toContainText('探测次数：2')
  assert.equal(await row('正常上游').locator('.last-seen time').getAttribute('datetime'), new Date(now - 1000).toISOString())
  await table.getByRole('button', { name: /^部分异常 / }).click()
  await expect(table.locator('tbody tr')).toHaveCount(1)
  await expect(row('部分异常上游')).toBeVisible()
  await table.getByRole('button', { name: '清除筛选', exact: true }).click()
  await table.getByPlaceholder('搜索渠道、模型或 URL').fill('claude-sonnet')
  await expect(table.locator('tbody tr')).toHaveCount(1)
  await expect(row('正常上游')).toBeVisible()
  await table.getByPlaceholder('搜索渠道、模型或 URL').fill('no-such-model')
  await expect(table.getByText('没有匹配的渠道，请调整状态筛选或搜索条件')).toBeVisible()
  await table.getByRole('button', { name: '清除筛选', exact: true }).click()
  const previousReads = reads
  now += 30000
  channels[0].probeTokens[0].probeModels[0] = model('claude-sonnet', 'error')
  await page.clock.fastForward(30000)
  await expect(row('正常上游').locator('.status-label')).toHaveText('全部失败')
  assert.ok(reads > previousReads)
  await expect(table.getByRole('button', { name: /^全部失败 / })).toContainText('1')
  await table.screenshot({ path: join(tmpdir(), 'signal-overview-probes-desktop.png') })
  now += 120001
  await page.clock.fastForward(120001)
  await expect(row('正常上游').locator('.status-label')).toHaveText('数据过期')
  await expect(row('部分异常上游').locator('.status-label')).toHaveText('数据过期')
  await expect(row('关闭探测上游').locator('.status-label')).toHaveText('未启用')
  await page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
  await table.screenshot({ path: join(tmpdir(), 'signal-overview-probes-mobile.png') })
  assert.deepEqual(errors, [])
})
