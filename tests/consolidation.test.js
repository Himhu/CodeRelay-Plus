import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { chromium, expect } from '@playwright/test'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

test('consolidated navigation and read-only details avoid redundant synchronization; manual sync respects channel scope', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-consolidated-ui-'))
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false,
    plugins: [react()], cacheDir: join(directory, '.vite'), server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1440, height: 950 } })
  t.after(async () => { await browser.close(); await server.close(); rmSync(directory, { recursive: true, force: true }) })
  const channels = ['a', 'b'].map(id => ({ id, name: `上游 ${id}`, provider: 'newapi', endpoint: `https://${id}.example.test`, autoProbeNewTokens: true,
    auth: { status: 'configured' }, balance: { status: 'ok', amount: 5, currency: 'USD', symbol: '$' }, userGroups: { groups: [], status: 'ok' }, apiKeys: { items: [], status: 'ok' } }))
  const writes = [], errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname
    if (route.request().method() !== 'GET') writes.push(path)
    const payload = path === '/api/settings' ? { settings: { lowBalanceThreshold: 0 }, balanceNotices: { low: [], unavailable: [] } }
      : path === '/api/probe-tokens' ? { probeTokens: [], channelSetup: [], policy: { intervalSec: 60 } }
        : path === '/api/upstream-channels' || path.endsWith('/groups/sync') ? { channels } : { sites: [] }
    return route.fulfill({ json: payload })
  })
  const base = server.resolvedUrls.local[0]
  await page.goto(base)
  await expect(page.locator('.channel-table th')).toHaveCount(6)
  await expect(page.getByRole('button', { name: '集成', exact: true })).toHaveCount(0)
  await expect(page.getByText('未连接工作区', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '查看 上游 a 的线路倍率', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '上游 a', exact: true })).toBeVisible()
  assert.deepEqual(writes, [], 'Viewing a synchronized snapshot must not force upstream network work')
  await page.keyboard.press('Escape')
  await page.goto(base+'#probe-tokens?channel=a')
  await expect(page.getByRole('button', { name: '刷新记录', exact: true })).toHaveCount(1)
  await page.locator('.pm-maintenance summary').click()
  await page.getByRole('button', { name: '同步本站令牌', exact: true }).click()
  await expect(page.getByRole('button', { name: '同步本站令牌', exact: true })).toBeEnabled()
  assert.deepEqual(writes, ['/api/upstream-channels/a/groups/sync'])
  await page.goto(base+'#integrations')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('总览')
  for (const width of [1440,390,320]) {
    await page.setViewportSize({ width, height: 950 })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await page.screenshot({path:join(tmpdir(),`signal-consolidated-overview-${width}.png`),fullPage:true})
  }
  assert.deepEqual(errors, [])
})
