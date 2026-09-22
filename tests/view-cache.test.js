import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { chromium, expect } from '@playwright/test'

test('cached views survive navigation and reload, refresh silently and are cleared on logout', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-view-cache-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const dist = process.env.SIGNAL_TEST_DIST || join(directory, 'dist')
  if (!process.env.SIGNAL_TEST_DIST) execFileSync('npm', ['run', 'build', '--', '--outDir', dist], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), env: { ...process.env, SIGNAL_DATA_DIR: join(directory, 'empty-data') }, stdio: 'pipe',
  })
  const { build } = JSON.parse(readFileSync(join(dist, 'version.json'), 'utf8'))
  const at = new Date().toISOString()
  let authenticated = true, username = 'alice', failure = false
  const payloads = {
    '/api/upstream-channels': { channels: [{ id: 'a', name: '已保存上游', provider: 'sub2api', endpoint: 'https://example.test',
      auth: { status: 'authorized' }, balance: { amount: 8, currency: 'USD', symbol: '$', status: 'ok', updatedAt: at } }] },
    '/api/probe-tokens': { probeTokens: [{ id: '1', channelId: 'a', channelName: '已保存上游', name: '已保存令牌', provider: 'sub2api', endpoint: 'https://example.test',
      status: 'active', probeEnabled: false, probeModels: [{ id: 'gpt-5', protocol: 'chat', status: 'unknown', history: [] }] }], policy: { intervalSec: 60 } },
    '/api/secondary-sites': { sites: [{ id: 'side', name: '已保存调度站点', provider: 'sub2api', endpoint: 'https://sub.example.test', groups: [], accounts: [] }] },
    '/api/settings': { settings: { lowBalanceThreshold: 5 }, balanceNotices: { low: [], unavailable: [] } },
  }
  const held = new Set(), pending = new Map(), requests = [], writes = []
  const hold = path => { held.add(path); return () => { held.delete(path); for (const release of pending.get(path) || []) release(); pending.delete(path) } }
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname
    if (path.startsWith('/api/')) {
      requests.push(path)
      res.setHeader('Content-Type', 'application/json'); res.setHeader('X-Signal-Build', build)
      res.setHeader('Cache-Control', 'no-store')
      if (path === '/api/auth/logout') authenticated = false
      if (path === '/api/auth/login') { authenticated = true; username = 'bob' }
      if (path.startsWith('/api/auth/')) return res.end(JSON.stringify({ authenticated, username }))
      if (req.method !== 'GET') writes.push(path)
      if (!authenticated) { res.statusCode = 401; return res.end(JSON.stringify({ code: 'LOGIN_REQUIRED', error: '请登录' })) }
      assert.equal(req.headers['x-signal-build'], build)
      if (held.has(path)) await new Promise(resolve => { pending.set(path, [...(pending.get(path) || []), resolve]) })
      if (res.destroyed) return
      if (failure && path === '/api/upstream-channels') { res.statusCode = 500; return res.end(JSON.stringify({ error: '暂时无法读取' })) }
      return res.end(JSON.stringify(payloads[path] || {}))
    }
    try {
      const file = path === '/' ? 'index.html' : path.slice(1)
      res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[extname(file)] || 'application/octet-stream')
      res.setHeader('Cache-Control', 'no-store'); res.end(readFileSync(join(dist, file)))
    } catch { res.writeHead(404); res.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { for (const releases of pending.values()) for (const release of releases) release(); server.close(resolve); server.closeAllConnections() }))
  const browser = await chromium.launch()
  t.after(() => browser.close())
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const base = `http://127.0.0.1:${server.address().port}`
  const cachedPaths = () => page.evaluate(() => new Promise(resolve => {
    const request = indexedDB.open('signal-display-cache', 1)
    request.onsuccess = () => { const db = request.result, read = db.transaction('views').objectStore('views').getAll(); read.onsuccess = () => { db.close(); resolve(read.result.map(record => record.path)) } }
  }))
  await page.goto(base)
  const channel = page.locator('.channels-panel').getByText('已保存上游', { exact: true })
  await expect(channel).toBeVisible()
  await expect.poll(cachedPaths).toContain('/api/upstream-channels')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  let release = hold('/api/upstream-channels')
  await page.getByRole('button', { name: '总览', exact: true }).click()
  await expect(channel).toBeVisible()
  await expect(page.getByText('正在读取上游渠道…', { exact: true })).toHaveCount(0)
  release()
  release = hold('/api/upstream-channels')
  await page.reload()
  await expect(channel).toBeVisible()
  await expect(page.locator('.cached-data-note').filter({ hasText: '上次数据' }).first()).toBeVisible()
  await expect(page.getByText('正在读取上游渠道…', { exact: true })).toHaveCount(0)
  payloads['/api/upstream-channels'].channels[0].balance.amount = 12
  release()
  await expect(page.getByLabel('已保存上游 账户余额')).toContainText('$12.00')
  await expect(page.locator('.cached-data-note')).toHaveCount(0)
  failure = true
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '总览', exact: true }).click()
  await expect(channel).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('暂时无法读取')
  failure = false
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)

  await page.getByRole('button', { name: '探针监控', exact: true }).click()
  await page.getByRole('tab', { name: '令牌管理', exact: true }).click()
  await expect(page.locator('.probe-endpoint-list')).toBeVisible()
  await expect.poll(cachedPaths).toContain('/api/probe-tokens')
  release = hold('/api/probe-tokens')
  await page.reload()
  await expect(page.locator('.probe-endpoint-list')).toBeVisible()
  await expect(page.getByText('正在读取探针令牌…', { exact: true })).toHaveCount(0)
  await page.getByRole('tab', { name: '模型状态', exact: true }).click()
  await expect(page.getByRole('button', { name: '刷新记录', exact: true })).toBeVisible()
  await expect(page.getByText('正在读取探测记录…', { exact: true })).toHaveCount(0)
  release()

  await page.getByRole('button', { name: '调度站点', exact: true }).click()
  await expect(page.locator('.secondary-site h3')).toBeVisible()
  await expect.poll(cachedPaths).toContain('/api/secondary-sites')
  release = hold('/api/secondary-sites')
  await page.reload()
  await expect(page.locator('.secondary-site')).toBeVisible()
  await expect(page.getByText('正在读取调度站点…', { exact: true })).toHaveCount(0)
  release()

  await page.getByRole('button', { name: '设置', exact: true }).click()
  release = hold('/api/settings')
  await page.reload()
  const threshold = page.getByLabel('最低余额阈值 USD')
  await expect(threshold).toHaveValue('5')
  payloads['/api/settings'].settings.lowBalanceThreshold = 7
  release()
  await expect(threshold).toHaveValue('7', { timeout: 3000 })
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible()
  await expect.poll(cachedPaths).toEqual([])
  await expect(page.locator('.app-shell')).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible()
  assert.deepEqual(await cachedPaths(), [])
  await page.getByLabel('账号', { exact: true }).fill('bob')
  await page.getByLabel('密码', { exact: true }).fill('test-password')
  release = hold('/api/settings')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByText('正在读取设置…', { exact: true })).toBeVisible()
  await expect(threshold).toHaveCount(0)
  release()
  await expect(threshold).toHaveValue('7')
  await expect.poll(cachedPaths).toContain('/api/settings')
  // A large history snapshot can take longer than 800 ms to read. It must not
  // be discarded just before it becomes available and trigger a blank reload.
  const slow = await page.context().newPage()
  await slow.addInitScript(() => {
    const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete')
    let first = true
    Object.defineProperty(IDBTransaction.prototype, 'oncomplete', { ...descriptor, set(callback) {
      if (!first) return descriptor.set.call(this, callback)
      first = false
      descriptor.set.call(this, event => setTimeout(() => callback(event), 1000))
    } })
  })
  release = hold('/api/settings')
  await slow.goto(base + '/#settings')
  await expect(slow.getByLabel('最低余额阈值 USD')).toHaveValue('7')
  await expect(slow.getByText('正在读取设置…', { exact: true })).toHaveCount(0)
  release()
  await slow.close()
  assert.ok(requests.includes('/api/auth/session'))
  assert.deepEqual(writes, [])
  assert.deepEqual(errors, [])

  const blocked = await browser.newPage()
  await blocked.addInitScript(() => Object.defineProperty(window, 'indexedDB', { get() { throw new Error('Storage disabled') } }))
  await blocked.goto(base)
  await expect(blocked.locator('.channels-panel')).toBeVisible()
})
