import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { chromium, expect } from '@playwright/test'

test('slow authentication is visible and retryable; a hung browser cache cannot block the console', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-startup-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const dist = process.env.SIGNAL_TEST_DIST || join(directory, 'dist')
  if (!process.env.SIGNAL_TEST_DIST) execFileSync('npm', ['run', 'build', '--', '--outDir', dist], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), env: { ...process.env, SIGNAL_DATA_DIR: join(directory, 'empty-data') }, stdio: 'pipe',
  })
  const { build } = JSON.parse(readFileSync(join(dist, 'version.json'), 'utf8'))
  let hangAuth = true, reads = 0
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname
    if (path.startsWith('/api/')) {
      res.setHeader('Content-Type', 'application/json'); res.setHeader('X-Signal-Build', build)
      if (path === '/api/auth/session' && hangAuth) { reads++; return }
      const payloads = {
        '/api/auth/session': { authenticated: true, username: 'test' },
        '/api/upstream-channels': { channels: [] },
        '/api/settings': { settings: { lowBalanceThreshold: 5 }, balanceNotices: { low: [], unavailable: [] } },
      }
      return res.end(JSON.stringify(payloads[path] || {}))
    }
    try {
      const file = path === '/' ? 'index.html' : path.slice(1)
      res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[extname(file)] || 'application/octet-stream')
      res.end(readFileSync(join(dist, file)))
    } catch { res.writeHead(404); res.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const browser = await chromium.launch()
  t.after(() => browser.close())
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', err => errors.push(err.message))
  await page.clock.install()
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await expect(page.getByRole('status')).toContainText('正在验证登录状态')
  await expect.poll(() => reads).toBe(1)
  await page.clock.fastForward(15001)
  await expect(page.getByRole('alert')).toContainText('连接服务器超时')
  await expect(page.getByRole('button', { name: '重新连接' })).toBeVisible()
  await expect(page.locator('.app-shell')).toHaveCount(0)
  hangAuth = false
  await page.getByRole('button', { name: '重新连接' }).click()
  await expect(page.locator('.channels-panel')).toBeVisible()
  const hung = await browser.newPage()
  hung.on('pageerror', err => errors.push(err.message))
  await hung.addInitScript(() => Object.defineProperty(window, 'indexedDB', { value: { open() { return {} } } }))
  await hung.goto(`http://127.0.0.1:${server.address().port}`)
  await expect(hung.getByRole('status')).toContainText('正在验证登录状态')
  await expect(hung.locator('.channels-panel')).toBeVisible({ timeout: 5000 })
  assert.deepEqual(errors, [])
})
