import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

test('log center supports filters, stable paging, details and mobile navigation without mutations', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-log-ui-'))
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false, plugins: [react()],
    cacheDir: join(directory, '.vite'), server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  const browser = await chromium.launch()
  t.after(async () => { await browser.close(); await server.close(); rmSync(directory, { recursive: true, force: true }) })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = [], writes = [], queries = []
  let fail = false
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/api/**', route => {
    const request = route.request(), url = new URL(request.url())
    if (request.method() !== 'GET') writes.push(request.url())
    if (url.pathname === '/api/logs') {
      const params = url.searchParams; queries.push(Object.fromEntries(params))
      if (fail) return route.fulfill({ status: 400, json: { error: '测试日志读取失败' } })
      const probe = params.get('kind') === 'probes', second = params.get('page') === '2'
      return route.fulfill({ json: { total: 6, page: Number(params.get('page')), pageSize: 5, until: '2026-09-20T00:00:00.000Z',
        sites: [{ id: 's', name: '测试调度站' }], channels: [{ id: 'c', name: '测试上游' }], items: [{ id: second ? '2' : '1', at: '2026-09-20T00:00:00.000Z',
          category: probe ? 'probes' : 'routing', actor: 'system', level: 'success', action: probe ? '模型探测' : second ? '恢复调度' : '模型名单写入已确认',
          message: '已确认上游模型名单调整', siteId: 's', siteName: '测试调度站', channelId: 'c', channelName: '测试上游', tokenId: '7',
          model: probe ? 'claude-sonnet-4-6' : null, details: probe ? { latencyMs: 230 } : { modelsBefore: ['claude-sonnet-4-6','gpt-5.2'], modelsAfter: ['claude-sonnet-4-6'], retainedModels: ['claude-sonnet-4-6'], modelResults: ['claude-sonnet-4-6 · error · 探测超时'], state: 'observing' } }] } })
    }
    const data = { '/api/settings': { settings: { lowBalanceThreshold: 5 }, balanceNotices: { low: [], unavailable: [] } },
      '/api/upstream-channels': { channels: [] }, '/api/probe-tokens': { probeTokens: [], channelSetup: [] }, '/api/secondary-sites': { sites: [] } }[url.pathname]
    return route.fulfill({ status: data ? 200 : 404, json: data || {} })
  })
  const base = server.resolvedUrls.local[0]
  await page.goto(`${base}#alerts`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('日志中心')
  await expect(page.getByRole('button', { name: '日志中心', exact: true })).toBeVisible()
  await page.getByText('模型名单写入已确认', { exact: true }).click()
  await expect(page.getByText('原模型名单', { exact: true })).toBeVisible()
  await expect(page.getByText('gpt-5.2', { exact: true })).toBeVisible()
  await expect(page.getByText('观察期保留模型', { exact: true })).toBeVisible()
  await expect(page.getByText('决策时的模型结果', { exact: true })).toBeVisible()
  await expect(page.getByText('claude-sonnet-4-6 · error · 探测超时', { exact: true })).toBeVisible()
  await expect(page.getByText('短暂异常观察', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '下一页', exact: true }).click()
  await expect(page.getByText('恢复调度', { exact: true })).toBeVisible()
  assert.equal(queries.at(-1).until, '2026-09-20T00:00:00.000Z')
  await page.getByLabel('上游渠道', { exact: true }).selectOption('c')
  await expect(page.getByText('模型名单写入已确认', { exact: true })).toBeVisible()
  assert.equal(queries.at(-1).page, '1'); assert.equal(queries.at(-1).channel, 'c')
  await page.getByLabel('搜索记录', { exact: true }).fill('模型')
  await page.getByRole('button', { name: '搜索日志' }).click()
  await expect.poll(() => queries.at(-1).q).toBe('模型')
  await page.getByRole('button', { name: '模型探测', exact: true }).click()
  await expect(page.locator('.lc-event b')).toHaveText('模型探测')
  assert.equal(queries.at(-1).kind, 'probes')
  await page.locator('.lc-record>summary').click()
  await expect(page.getByText('230', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: '查看该上游探针' })).toHaveAttribute('href', '#probes?channel=c')
  for (const width of [320, 390, 760]) {
    await page.setViewportSize({ width, height: 844 })
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const nav = page.getByRole('navigation', { name: '移动端主导航' })
    await expect(nav.getByRole('button', { name: '日志中心', exact: true })).toBeVisible()
  }
  await page.setViewportSize({ width: 390, height: 844 })
  assert.ok(await page.getByRole('button', { name: '下一页', exact: true }).evaluate(node => parseFloat(getComputedStyle(node).fontSize)) >= 12)
  await page.screenshot({ path: '/tmp/signal-logs-mobile.png', fullPage: true })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole('button', { name: '操作记录', exact: true }).click()
  await expect(page.getByText('模型名单写入已确认', { exact: true })).toBeVisible()
  if (!await page.locator('.lc-record').evaluate(node => node.open)) await page.locator('.lc-record>summary').click()
  await expect(page.getByText('原模型名单', { exact: true })).toBeVisible()
  await page.screenshot({ path: '/tmp/signal-logs-desktop.png', fullPage: true })
  fail = true
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('测试日志读取失败')
  await expect(page.getByText('模型名单写入已确认', { exact: true })).toBeVisible()
  fail = false
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.goto(`${base}#logs?site=s`)
  await expect(page.getByRole('combobox', { name: '调度站点', exact: true })).toHaveValue('s')
  await page.reload()
  await expect(page.getByRole('combobox', { name: '调度站点', exact: true })).toHaveValue('s')
  assert.equal(queries.at(-1).site, 's')
  assert.deepEqual(errors, []); assert.deepEqual(writes, [])
})
