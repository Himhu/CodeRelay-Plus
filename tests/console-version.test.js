import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { chromium, expect } from '@playwright/test'

test('production upgrade preserves unsaved forms, blocks stale writes and recovers after a manual refresh', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-version-ui-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const dist = process.env.SIGNAL_TEST_DIST || join(directory, 'dist')
  if (!process.env.SIGNAL_TEST_DIST) execFileSync('npm', ['run', 'build', '--', '--outDir', dist], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, SIGNAL_DATA_DIR: join(directory, 'empty-data') }, stdio: 'pipe',
  })
  const { build } = JSON.parse(readFileSync(join(dist, 'version.json'), 'utf8'))
  let serverBuild = build, writes = 0
  const requests = [], errors = []
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname
    if (path.startsWith('/api/')) {
      requests.push(path)
      if (req.method !== 'GET') writes++
      res.setHeader('X-Signal-Build', serverBuild)
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Cache-Control', 'no-store')
      const matching = req.headers['x-signal-build'] === serverBuild
      const payloads = {
        '/api/auth/session': { authenticated: true, username: '测试管理员' },
        '/api/settings': { settings: { lowBalanceThreshold: 5 }, balanceNotices: { low: [], unavailable: [] } },
    '/api/upstream-channels': { channels: [] },
        '/api/probe-tokens': { probeTokens: [], policy: { intervalSec: 60 } },
      }
      res.statusCode = matching ? 200 : 409
      return res.end(JSON.stringify(matching ? payloads[path] : { code: 'CLIENT_OUTDATED', error: '页面版本已更新' }))
    }
    try {
      const file = path === '/' ? 'index.html' : path.slice(1)
      res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[extname(file)] || 'application/octet-stream')
      res.setHeader('Cache-Control', 'no-store')
      res.end(readFileSync(join(dist, file)))
    } catch { res.writeHead(404); res.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  await page.getByRole('heading', { name: '总览', exact: true }).waitFor()
  await page.getByRole('button', { name: '添加渠道', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '添加上游渠道', exact: true })
  await dialog.locator('[name="channel-name"]').fill('尚未提交的配置')
  await dialog.locator('[name="endpoint"]').fill('https://example.test')
  await dialog.locator('[name="access-token"]').fill('unsaved-test-token')
  serverBuild = 'new-release'
  // Session checks run on visibility changes, including when returning to an old tab.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(page.locator('.console-update')).toHaveCount(1)
  await expect(dialog.locator('[name="channel-name"]')).toHaveValue('尚未提交的配置')
  await expect(dialog.locator('[name="access-token"]')).toHaveValue('unsaved-test-token')
  await dialog.getByRole('button', { name: '保存配置', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('页面版本已更新')
  assert.equal(writes, 0)
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.getByRole('button', { name: '刷新页面', exact: true })).toBeVisible()
  // The test server now serves a matching frontend/backend pair after the refresh.
  serverBuild = build
  await page.getByRole('button', { name: '刷新页面', exact: true }).click()
  await page.getByRole('heading', { name: '总览', exact: true }).waitFor()
  await expect(page.locator('.console-update')).toHaveCount(0)
  await page.getByRole('button', { name: '探针监控', exact: true }).click()
  await expect(page.getByRole('heading', { name: '探针监控', exact: true })).toBeVisible()
  assert.equal(requests.some(path => path.startsWith('/api/main-sites')), false)
  assert.deepEqual(errors, [])
})
