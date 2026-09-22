import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { chromium, expect } from '@playwright/test'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

test('automation controls, ownership, model details and events work on desktop and mobile', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-automation-ui-'))
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false, plugins: [react()], cacheDir: join(directory, '.vite'), server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  const browser = await chromium.launch()
  t.after(async () => { await browser.close(); await server.close(); rmSync(directory, { recursive: true, force: true }) })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [], writes = []
  const site = { id: 'site', name: '调度测试站', endpoint: 'https://scheduler.example.test', groups: [], accounts: [
    { id: 1, name: '正常线路', type: 'apikey', platform: 'openai', status: 'active', schedulable: true, groupIds: [] },
    { id: 2, name: '余额不足线路', type: 'apikey', platform: 'anthropic', status: 'active', schedulable: false, groupIds: [] },
  ], automation: { enabled: false, lastRunAt: new Date().toISOString(), accounts: [
    { accountId: 1, managed: true, state: 'healthy', availableModels: ['gpt-5'], excludedModels: ['bad-model'], reason: '已验证 1 个模型' },
    { accountId: 2, managed: true, state: 'cooldown', availableModels: [], excludedModels: [], reason: '余额不足，等待恢复' },
  ], routes: [
    { id: 'source-1', upstreamName: '正常上游', tokenName: '令牌 A', tokenId: '1', platform: 'openai', cost: 0.099, targetRate: 0.1, endpoint: 'https://upstream.test', groupId: 1, accountId: 1, enabled: true, state: 'healthy', availableModels: ['gpt-5'], excludedModels: ['bad-model'], groups: [{ id: 1, name: 'Codex Plus' }] },
    { id: 'source-2', upstreamName: '余额不足上游', tokenName: '令牌 B', tokenId: '2', platform: 'anthropic', endpoint: 'https://other.test', groupId: null, enabled: true, state: 'cooldown', availableModels: [], excludedModels: [], groups: [{ id: 2, name: 'Claude Kiro' }] },
    { id: 'source-3', channelId: 'observed-channel', upstreamName: '观察上游', tokenName: '令牌 C', tokenId: '3', platform: 'openai', endpoint: 'https://observed.test', groupId: 1, accountId: 3, enabled: true, state: 'observing', reason: '本轮超时，保留近期成功模型', availableModels: [], retainedModels: ['gpt-5'], excludedModels: ['gpt-5'], groups: [{ id: 1, name: 'Codex Plus' }] },
  ], events: [{ at: new Date().toISOString(), accountId: 1, name: '正常线路', action: '更新可用模型', reason: '保留 1 个模型' }] } }
  site.automation.routes.push(
    { ...site.automation.routes[0], id: 'source-kimi', family: 'Kimi', modelCount: 2, accountId: null, groupId: null, state: 'waiting', availableModels: ['kimi-k3'], excludedModels: ['kimi-k2.7-code'], groups: [{ id: 3, name: 'Kimi 标准' }, { id: 4, name: 'Kimi 特惠' }] },
    { ...site.automation.routes[0], id: 'source-minimax', family: 'MiniMax', modelCount: 1, accountId: null, groupId: null, state: 'waiting', reason: '未匹配调度分组：MiniMax', availableModels: ['MiniMax-M3'], excludedModels: [], groups: [] },
  )
  page.on('pageerror', e => errors.push(e.message))
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (path === '/api/settings') return route.fulfill({ json: { settings: { lowBalanceThreshold: 5 }, balanceNotices: { low: [], unavailable: [] } } })
    if (path === '/api/secondary-sites') return route.fulfill({ json: { sites: [site] } })
    assert.equal(path, '/api/secondary-sites/site/automation')
    const input = request.postDataJSON(); writes.push(input)
    if (input.routeId) { const row = site.automation.routes.find(item => item.id === input.routeId); row.enabled = input.enabled; row.state = 'waiting'; if (input.groupId) row.groupId = input.groupId }
    else site.automation.enabled = input.enabled
    return route.fulfill({ json: { site } })
  })
  await page.clock.install()
  await page.goto(server.resolvedUrls.local[0] + '#route-automation?site=site')
  await expect(page.getByRole('heading', { name: '自动调度', exact: true })).toBeVisible()
  const control = page.getByRole('switch', { name: '启用自动推送', exact: true })
  await expect(control).toHaveAttribute('aria-checked', 'false')
  await expect(page.locator('.ra-table')).toContainText('上游成本 0.099× · 调度分组 0.1×')
  await expect(page.locator('.ra-table')).not.toContainText('预计毛利')
  await control.click()
  await expect(control).toHaveAttribute('aria-checked', 'true')
  site.automation.lastRunAt = '2026-09-21T01:02:03.000Z'
  await page.clock.fastForward(15000)
  await expect(page.locator('.ra-summary')).toContainText(new Date(site.automation.lastRunAt).toLocaleString('zh-CN', { hour12: false }))
  await page.getByRole('group', { name: '调度线路筛选' }).getByRole('button', { name: /^全部/ }).click()
  await expect(page.getByRole('button', { name: /接管并推送|停止推送/ })).toHaveCount(0)
  await expect(page.locator('.route-automation')).not.toContainText('手动管理')
  await page.locator('.ra-table summary').first().click()
  await expect(page.getByText('异常：bad-model', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /^参与调度/ })).toBeVisible()
  await expect(page.locator('.route-automation')).not.toContainText('推荐主用')
  await expect(page.locator('.ra-rules')).toContainText('同一个模型可由多条线路同时承接')
  const observed = page.locator('.ra-table tr').filter({ hasText: '令牌 C' })
  await expect(observed).toContainText('短暂异常观察')
  await expect(observed.locator('summary')).toHaveText('可用 0 · 异常 1 · 观察 1')
  await observed.locator('summary').click()
  await expect(observed).toContainText('观察期保留：gpt-5（上次成功仍在两分钟内）')
  await expect(observed.getByRole('link', { name: '查看探测记录' })).toHaveAttribute('href', '#probes?channel=observed-channel')
  const search = page.getByRole('searchbox', { name: '搜索线路' })
  await search.fill('Kimi')
  await expect(page.locator('.ra-table tbody tr')).toHaveCount(1)
  await expect(page.locator('.ra-family')).toHaveText('Kimi')
  await expect(page.locator('.ra-table summary')).toHaveText('共 2 · 可用 1 · 异常 1')
  await page.getByRole('combobox', { name: '目标分组 正常上游 1 openai Kimi', exact: true }).selectOption('3')
  await expect(page.locator('.ra-table')).toContainText('Kimi 标准')
  await search.fill('MiniMax')
  await expect(page.locator('.ra-table select')).toHaveCount(0)
  await page.locator('.ra-table summary').click()
  await expect(page.locator('.ra-table')).toContainText('未匹配调度分组：MiniMax')
  await search.clear()
  await expect(page.locator('.ra-events')).toHaveCount(0)
  await expect(page.getByRole('link', { name: '运行日志', exact: true })).toHaveAttribute('href', '#logs?site=site')
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `No overflow at ${width}`)
    await page.screenshot({ path: join(tmpdir(), `signal-automation-${width}.png`), fullPage: true })
  }
  await control.click(); await expect(control).toHaveAttribute('aria-checked', 'false')
  assert.deepEqual(writes, [{ enabled: true }, { routeId: 'source-kimi', groupId: 3 }, { enabled: false }])
  assert.deepEqual(errors, [])
})
