import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { createServer as createHTTPServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { chromium, expect } from '@playwright/test'
import { createServer } from 'vite'

test('secondary navigation, admin connection and account groups work on desktop and mobile', async t => {
  let denied = false
  const remote = createHTTPServer((req, res) => {
    assert.equal(req.method, 'GET')
    assert.equal(req.headers['x-api-key'], 'admin-browser-secret')
    assert.equal(req.headers.authorization, undefined)
    const resource = new URL(req.url, 'http://localhost').pathname
    assert.ok(['/api/v1/admin/groups', '/api/v1/admin/accounts'].includes(resource))
    const items = resource.endsWith('/groups') ? [
      { id: 1, name: 'Codex 稳定线路', platform: 'openai', status: 'active', rate_multiplier: 0.2, subscription_type: 'standard' },
      { id: 2, name: 'Claude 专属线路', platform: 'anthropic', status: 'inactive', rate_multiplier: 0, is_exclusive: true,
        peak_rate_enabled: true, peak_start: '12:00', peak_end: '18:00', peak_rate_multiplier: 1.5, subscription_type: 'subscription' },
    ] : [{ id: 10, name: 'Codex 账号 A', platform: 'openai', type: 'oauth', status: 'active', schedulable: false, group_ids: [1] }]
    res.writeHead(denied ? 403 : 200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(denied ? { code: 'FORBIDDEN' } : { code: 0, data: { items, page: 1, page_size: 100, total: items.length } }))
  })
  remote.listen(0, '127.0.0.1'); await once(remote, 'listening')
  t.after(() => remote.close())
  const directory = mkdtempSync(join(tmpdir(), 'signal-secondary-ui-'))
  const previous = process.env.SIGNAL_DATA_DIR
  process.env.SIGNAL_DATA_DIR = directory
  t.after(() => {
    if (previous === undefined) delete process.env.SIGNAL_DATA_DIR
    else process.env.SIGNAL_DATA_DIR = previous
    rmSync(directory, { recursive: true, force: true })
  })
  const config = { root: fileURLToPath(new URL('../', import.meta.url)), cacheDir: join(directory, 'node_modules', '.vite'),
    server: { host: '127.0.0.1', port: 0 } }
  let server = await createServer(config)
  t.after(() => server.close())
  await server.listen()
  const base = server.resolvedUrls.local[0]
  const browser = await chromium.launch()
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(base)
  await expect(page.getByRole('button', { name: '调度站点', exact: true })).toBeVisible()
  const navigation = await page.locator('.nav-group').first().getByRole('button').allTextContents()
  assert.ok(!navigation.includes('主站渠道'))
  assert.equal(navigation[1], '调度站点')
  await page.getByRole('button', { name: '调度站点', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: '调度站点' })).toBeVisible()
  await expect(page.getByText('还没有调度站点', { exact: true })).toBeVisible()
  await page.reload()
  assert.equal(new URL(page.url()).hash, '#secondary-channels')
  await page.getByRole('button', { name: '添加调度站点', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: '添加调度站点', exact: true })
  await dialog.getByLabel('调度站点名称').fill('测试 Sub2API 调度站点')
  await dialog.getByLabel('调度站点地址').fill(`http://127.0.0.1:${remote.address().port}`)
  await dialog.getByLabel('Admin API Key', { exact: true }).fill('admin-browser-secret')
  await expect(dialog.getByLabel('Admin API Key', { exact: true })).toHaveAttribute('type', 'password')
  await dialog.getByRole('button', { name: '显示Admin API Key' }).click()
  await expect(dialog.getByLabel('Admin API Key', { exact: true })).toHaveAttribute('type', 'text')
  denied = true
  await dialog.getByRole('button', { name: '保存并同步', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('调度站点拒绝管理员访问')
  denied = false
  await dialog.getByRole('button', { name: '保存并同步', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  let site = page.getByRole('region', { name: '测试 Sub2API 调度站点', exact: true })
  await expect(site.locator('table')).toHaveCount(0)
  await site.getByRole('link', { name: '查看分组倍率与模型状态' }).click()
  await expect(page.locator('.rw-group-table')).toContainText('0.2×')
  await expect(page.locator('.rw-group-table')).toContainText('0×')
  await page.getByRole('button', { name: 'Codex 稳定线路', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('1 个账号')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '调度站点', exact: true }).click()
  await site.getByRole('button', { name: '编辑连接' }).click()
  dialog = page.getByRole('dialog', { name: '编辑调度站点' })
  await expect(dialog.getByLabel('Admin API Key', { exact: true })).toHaveValue('')
  await dialog.getByLabel('调度站点名称').fill('已编辑的调度站点')
  await dialog.getByRole('button', { name: '保存并同步', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  site = page.getByRole('region', { name: '已编辑的调度站点', exact: true })
  denied = true
  await site.getByRole('button', { name: '同步调度站点' }).click()
  await expect(site.getByRole('alert').first()).toContainText('保留上次分组快照')
  await expect(site.getByRole('link', { name: '查看分组倍率与模型状态' })).toBeVisible()
  denied = false
  await site.getByRole('button', { name: '同步调度站点' }).click()
  await expect(site.getByRole('alert')).toHaveCount(0)
  assert.equal(await page.getByRole('button', { name: '主站渠道', exact: true }).count(), 0)
  assert.deepEqual((await page.request.get(base + 'api/upstream-channels').then(res => res.json())).channels, [])
  await page.goto(base + '#secondary-channels')
  await expect(page.getByRole('heading', { level: 1, name: '调度站点' })).toBeVisible()
  config.server.port = Number(new URL(base).port)
  await server.close()
  server = await createServer(config)
  await server.listen()
  await page.reload()
  await expect(site.getByText('2 个分组', { exact: true })).toBeVisible()
  const stored = await page.request.get(base + 'api/secondary-sites').then(res => res.json())
  assert.equal(stored.sites.length, 1)
  assert.ok(!JSON.stringify(stored).includes('admin-browser-secret'))
  assert.deepEqual((await page.request.get(base + 'api/upstream-channels').then(res => res.json())).channels, [])
  await expect(site.getByRole('link', { name: '线路管理', exact: true })).toBeVisible()
  const screenshots = process.env.SECONDARY_SCREENSHOTS
  if (screenshots) { mkdirSync(screenshots, { recursive: true }); await page.screenshot({ path: join(screenshots, 'desktop.png'), fullPage: true }) }
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('button', { name: '调度站点', exact: true })).toBeVisible()
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  if (screenshots) await page.screenshot({ path: join(screenshots, 'mobile.png'), fullPage: true })
  await site.getByRole('button', { name: '编辑连接' }).click()
  await expect(page.getByRole('dialog', { name: '编辑调度站点' })).toBeVisible()
  if (screenshots) await page.screenshot({ path: join(screenshots, 'mobile-editor.png') })
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  assert.deepEqual(errors, [])
})
