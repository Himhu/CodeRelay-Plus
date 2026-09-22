import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { chromium, expect } from '@playwright/test'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

test('mobile navigation, subsidiary, token controls and dialogs remain usable at narrow and short sizes', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-mobile-'))
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false,
    plugins: [react()], cacheDir: join(directory, '.vite'), server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  const browser = await chromium.launch()
  t.after(async () => { await browser.close(); await server.close(); rmSync(directory, { recursive: true, force: true }) })
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  const errors = [], mutations = []
  page.on('pageerror', error => errors.push(error.message))
  const endpoint = `https://${'long-upstream-'.repeat(8)}example.test`
  const group = 'ClaudeCode-LongGroupName-WithoutSpaces-ForMobile'
  const at = new Date().toISOString()
  const payloads = {
    '/api/settings': { settings: { lowBalanceThreshold: 5 }, balanceNotices: { low: [], unavailable: [] } },
    '/api/upstream-channels': { channels: [{ id: 'upstream', name: '测试上游', provider: 'sub2api', endpoint,
      auth: { status: 'authorized', checkedAt: at }, balance: { status: 'ok', amount: 2.5, currency: 'USD', symbol: '$', updatedAt: at } }] },
    '/api/secondary-sites': { sites: [] },
    '/api/probe-tokens': { policy: { intervalSec: 60 }, probeTokens: [{ id: 1, channelId: 'upstream', channelName: '测试上游',
      name: '移动端令牌', provider: 'sub2api', endpoint, groupName: group, status: 'active', probeEnabled: false,
      models: ['claude-sonnet-4-6'], probeModels: [{ id: 'claude-sonnet-4-6', protocol: 'messages', status: 'unknown', history: [] }] }] },
  }
  await page.route('**/api/**', route => {
    if (route.request().method() !== 'GET') mutations.push(route.request().url())
    const payload = payloads[new URL(route.request().url()).pathname]
    return route.fulfill({ status: payload ? 200 : 404, json: payload || { error: 'Unexpected test request' } })
  })
  const noOverflow = () => expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const insideWidth = async locator => {
    const rect = await locator.boundingBox()
    assert.ok(rect && rect.x >= 0 && rect.x + rect.width <= page.viewportSize().width + 1)
  }
  await page.goto(server.resolvedUrls.local[0])
  const nav = page.getByRole('navigation', { name: '移动端主导航' })
  await expect(nav).toBeVisible()
  await expect(page.locator('.sidebar')).toBeHidden()
  await page.getByRole('button', { name: '打开导航' }).click()
  let dialog = page.getByRole('dialog', { name: '导航', exact: true })
  await expect(dialog.getByRole('button')).toHaveCount(7)
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).overflow)).toBe('hidden')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('button', { name: '打开导航' })).toBeFocused()
  await page.getByRole('button', { name: '打开导航' }).click()
  await dialog.getByRole('button', { name: '设置', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('设置')
  await page.goBack()
  await expect(nav.getByRole('button', { name: '总览', exact: true })).toHaveAttribute('aria-current', 'page')

  for (const width of [320, 390, 430]) {
    await page.setViewportSize({ width, height: 844 })
    await nav.getByRole('button', { name: '总览', exact: true }).click()
    await expect(page.locator('.channel-table tbody tr')).toHaveCount(1)
    await noOverflow()
    const edit = page.getByRole('button', { name: '编辑 测试上游', exact: true })
    await insideWidth(edit)
    await edit.click()
    dialog = page.getByRole('dialog', { name: '编辑上游渠道', exact: true })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByLabel('充值倍率')).toHaveValue('1')
    await page.setViewportSize({ width, height: 420 })
    await dialog.getByRole('button', { name: '取消', exact: true }).scrollIntoViewIfNeeded()
    const cancel = await dialog.getByRole('button', { name: '取消', exact: true }).boundingBox()
    assert.ok(cancel.y >= 0 && cancel.y + cancel.height <= 420)
    await insideWidth(dialog.locator('form'))
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await page.setViewportSize({ width, height: 844 })

    await nav.getByRole('button', { name: '调度站点', exact: true }).click()
    await expect(page.getByText('还没有调度站点', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '添加调度站点', exact: true }).click()
    dialog = page.getByRole('dialog', { name: '添加调度站点', exact: true })
    await insideWidth(dialog)
    await page.keyboard.press('Escape')
    await noOverflow()

    await nav.getByRole('button', { name: '探针监控', exact: true }).click()
    await page.getByRole('tab', { name: '令牌管理', exact: true }).click()
    await page.locator('.endpoint-group > summary').click()
    const toggle = page.getByRole('switch', { name: '探测 移动端令牌 #1', exact: true })
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await insideWidth(toggle)
    assert.ok((await toggle.boundingBox()).height >= 44)
    await page.locator('.probe-models > summary').click()
    await noOverflow()
    await expect(nav.getByRole('button', { name: '探针监控', exact: true })).toHaveAttribute('aria-current', 'page')
  }
  await page.getByRole('button', { name: '打开导航' }).click()
  await page.setViewportSize({ width: 1280, height: 900 })
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(nav).toBeHidden()
  await expect(page.locator('.sidebar')).toBeVisible()
  await page.getByRole('button', { name: '调度站点', exact: true }).click()
  await expect(page.getByText('还没有调度站点', { exact: true })).toBeVisible()
  await page.setViewportSize({ width: 768, height: 1024 })
  await noOverflow()
  assert.deepEqual(mutations, [])
  assert.deepEqual(errors, [])
})
