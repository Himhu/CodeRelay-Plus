import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { paginationRange, normalizePageSize } from '../src/pagination-data.js'

test('pagination handles empty/shrinking lists and keeps current and end pages reachable', () => {
  for (const total of [0, 1, 5, 6, 25, 26, 105, 5001]) for (const requested of [-1, NaN, 1, 4, 15, 9999]) {
    const range = paginationRange(total, requested)
    assert.equal(range.pageSize, 5)
    assert.equal(normalizePageSize('20'), 20)
    assert.equal(normalizePageSize('7'), 5)
    assert.ok(range.pageNumbers.length <= 5)
    assert.ok(range.pageNumbers.includes(range.page))
    assert.ok(range.pageNumbers.includes(1))
    assert.ok(range.pageNumbers.includes(range.pages))
    assert.ok(range.start >= 0 && (total === 0 || range.start < total))
  }
})

const list = (n, make) => Array.from({ length: n }, (_, i) => make(i + 1))

test('all workspaces paginate nested lists, keep pages on polling and preserve batch scope and model selection', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-pagination-'))
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false, plugins: [react()], cacheDir: join(directory, '.vite'), server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  const browser = await chromium.launch()
  t.after(async () => { await browser.close(); await server.close(); rmSync(directory, { recursive: true, force: true }) })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  await page.clock.install()
  const now = new Date().toISOString(), errors = [], writes = []
  const models = list(8, i => ({ id: `claude-model-${i}`, protocol: 'messages', status: 'ok', lastProbeAt: now, history: [] }))
  const groups = list(12, i => ({ id: i, name: `Claude 分组 ${i}`, platform: 'anthropic', status: 'active', rate: 1 }))
  const accounts = list(12, i => ({ id: i, name: `账号 ${i}`, platform: 'anthropic', type: 'apikey', status: 'active', schedulable: true, groupIds: [1], models: [] }))
  const sites = list(6, i => ({ id: `site-${i}`, name: `调度站 ${i}`, endpoint: `https://scheduler-${i}.example.test`, groups, accounts, syncedAt: now, accountsSyncedAt: now,
    routes: { accounts, groups: [], orphanBindings: [] }, automation: { enabled: false, accounts: [],
      routes: list(12, n => ({ id: `r-${n}`, upstreamName: `上游 ${n}`, tokenId: String(n), tokenName: `令牌 ${n}`, platform: 'anthropic', groupName: 'Claude', groups: [groups[0]], availableModels: models.map(m => m.id), excludedModels: [], state: 'waiting', enabled: false })),
      events: list(8, n => ({ at: now, accountId: n, name: `账号 ${n}`, action: '更新', reason: '测试记录' })) } }))
  const channels = list(6, i => ({ id: `c-${i}`, name: `上游 ${i}`, provider: 'sub2api', endpoint: `https://upstream-${i}.example.test`, needsAuthorization: true,
    userGroups: { status: 'ok', groups: groups.map(g => ({ ...g, id: String(g.id) })) },
    apiKeys: { status: 'ok', items: list(7, n => ({ id: String(n), name: `令牌 ${n}`, status: 'active', groupId: '1' })) } }))
  let tokens = channels.flatMap(c => list(7, n => ({ id: String(n), channelId: c.id, channelName: c.name, provider: c.provider, endpoint: c.endpoint,
    name: `${c.name} 令牌 ${n}`, groupName: 'Claude', probeEnabled: true, probeModels: models })))
  const job = { id: 'job-1', status: 'complete', config: { groupId: 1, targetRate: 1 }, errors: [], completed: 6, total: 6, created: 0,
    upstreams: channels.map(c => ({ upstreamId: c.id, name: c.name, status: 'complete', routes: 7 })),
    rows: channels.flatMap(c => list(7, n => ({ upstreamId: c.id, upstreamName: c.name, groupId: String(n), groupName: `候选线路 ${n}`, status: 'eligible', costRate: .1, targetRate: 1, tokenState: 'existing', tokenId: String(n), models, keywords: ['Claude'], accountSuggestions: [] }))) }
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/api/**', route => {
    const request = route.request(), url = new URL(request.url())
    if (request.method() !== 'GET') writes.push({ path: url.pathname, body: request.postDataJSON() })
    if (url.pathname === '/api/settings') return route.fulfill({ json: { settings: { lowBalanceThreshold: 5 }, balanceNotices: { low: [], unavailable: [] } } })
    if (url.pathname === '/api/upstream-channels') return route.fulfill({ json: { channels } })
    if (url.pathname === '/api/secondary-sites') return route.fulfill({ json: { sites } })
    if (url.pathname.endsWith('/discovery')) return route.fulfill({ json: { job } })
    if (url.pathname.endsWith('/bindings')) return route.fulfill({ json: { version: 1, context: {}, routes: sites[0].routes,
      upstreams: [{ id: 'c-1', name: '上游 1', tokens: [{ id: '1', name: '令牌 1', models }] }] } })
    if (url.pathname === '/api/probe-tokens/batch-disable') {
      const targets = request.postDataJSON().tokens
      tokens = tokens.map(token => ({ ...token, probeEnabled: false }))
      return route.fulfill({ json: { probeTokens: tokens, batch: { disabled: targets.length, failures: [] } } })
    }
    if (url.pathname === '/api/probe-tokens') return route.fulfill({ json: { probeTokens: tokens, policy: { intervalSec: 60 }, channelSetup: [] } })
    return route.fulfill({ status: 404, json: {} })
  })
  const base = server.resolvedUrls.local[0]
  const nav = name => page.getByRole('navigation', { name: `${name}分页`, exact: true })
  const next = name => nav(name).getByRole('button', { name: '下一页', exact: true }).click()
  await page.goto(base + '#secondary-channels')
  await expect(page.locator('.secondary-site')).toHaveCount(5)
  const firstSite = page.locator('.secondary-site').first()
  await expect(firstSite.getByRole('link', { name: '查看分组倍率与模型状态' })).toBeVisible()
  await expect(firstSite.locator('table')).toHaveCount(0)
  await next('调度站点')
  await expect(page.locator('.secondary-site')).toHaveCount(1)
  await expect(page.locator('.site-identity h3')).toContainText('调度站 6')
  await page.clock.fastForward(15000)
  await expect(nav('调度站点').getByRole('button', { name: '第 2 页', exact: true })).toHaveAttribute('aria-current', 'page')

  for (const [hash, table, label] of [['route-bindings', '.rw-group-table', '调度分组'], ['route-accounts', '.rw-account-table', '调度账号'], ['route-automation', '.ra-table', '自动调度线路']]) {
    await page.goto(`${base}#${hash}?site=site-1`)
    await expect(page.locator(`${table} tbody tr`)).toHaveCount(5)
    await nav(label).getByRole('button', { name: '第 3 页', exact: true }).click()
    await expect(page.locator(`${table} tbody tr`)).toHaveCount(2)
    await page.clock.fastForward(15000)
    await expect(nav(label).getByRole('button', { name: '第 3 页', exact: true })).toHaveAttribute('aria-current', 'page')
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 900 })
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
  }
  await expect(page.getByRole('link', { name: '运行日志', exact: true })).toBeVisible()

  await page.goto(base + '#route-discovery?site=site-1&group=1')
  await expect(page.locator('.rd-upstream')).toHaveCount(5)
  await page.getByRole('button', { name: '展开上游 上游 1', exact: true }).click()
  await expect(page.locator('.rd-table tbody tr:visible')).toHaveCount(5)
  await next('上游 1 线路')
  await expect(page.locator('.rd-table tbody tr:visible')).toHaveCount(2)
  await next('选线上游')
  await expect(page.locator('.rd-upstream')).toHaveCount(1)

  await page.goto(base + '#route-accounts?site=site-1')
  await page.getByRole('button', { name: '关联账号 账号 1', exact: true }).click()
  const editor = page.getByRole('dialog', { name: '关联上游令牌', exact: true })
  await editor.getByLabel('上游站点', { exact: true }).selectOption('c-1')
  await editor.getByLabel('上游令牌', { exact: true }).selectOption('1')
  await editor.getByRole('button', { name: '全选模型', exact: true }).click()
  await expect(editor.locator('.rb-model-option')).toHaveCount(5)
  await editor.getByLabel('调度站点模型名', { exact: true }).first().fill('')
  await next('模型映射')
  await expect(editor.locator('.rb-model-option')).toHaveCount(3)
  await expect(editor.locator('.rb-model-option input[type="checkbox"]:checked')).toHaveCount(3)
  await editor.getByRole('checkbox', { name: '确认所选令牌及模型与调度站点账号配置一致' }).check()
  await editor.getByRole('button', { name: '保存关联', exact: true }).click()
  await expect(editor.getByRole('alert')).toContainText('包括其他页中的模型')
  assert.equal(writes.length, 0)
  await page.keyboard.press('Escape')

  await page.goto(base + '#probe-tokens')
  await expect(page.locator('.endpoint-group')).toHaveCount(5)
  await page.locator('.endpoint-group > summary').first().click()
  const endpoint = page.locator('.endpoint-group').first()
  await expect(endpoint.locator('.token-table > tbody > tr')).toHaveCount(5)
  await endpoint.locator('.probe-models summary').first().click()
  await expect(endpoint.locator('.probe-models li:visible')).toHaveCount(5)
  await next('上游 1 令牌 1 支持模型')
  await expect(endpoint.locator('.probe-models li:visible')).toHaveCount(3)
  await next('https://upstream-1.example.test 令牌')
  await expect(endpoint.locator('.token-table > tbody > tr')).toHaveCount(2)
  await next('Endpoint')
  await expect(page.locator('.endpoint-group')).toHaveCount(1)
  await page.clock.fastForward(5000)
  await expect(nav('Endpoint').getByRole('button', { name: '第 2 页', exact: true })).toHaveAttribute('aria-current', 'page')
  await page.getByRole('button', { name: '批量停止（42）', exact: true }).click()
  await expect.poll(() => writes.length).toBe(1)
  assert.equal(writes[0].body.tokens.length, 42, 'Batch action includes every page')
  assert.equal(new Set(writes[0].body.tokens.map(token => `${token.channelId}/${token.id}`)).size, 42)
  await expect(page.getByRole('status').filter({ hasText: '已停止 42' })).toBeVisible()

  await page.goto(base + '#overview?sort=name-asc')
  await page.getByRole('button', { name: '查看 上游 1 的线路倍率', exact: true }).click()
  const detail = page.getByRole('dialog', { name: '上游 1', exact: true })
  await expect(detail.locator('.route-groups > li')).toHaveCount(5)
  await next('可用线路分组')
  await expect(detail.locator('.route-groups > li').first()).toContainText('Claude 分组 6')
  await detail.locator('.created-keys summary').click()
  await expect(detail.locator('.created-keys li')).toHaveCount(5)
  await next('已创建令牌')
  await expect(detail.locator('.created-keys li')).toHaveCount(2)
  await page.setViewportSize({ width: 320, height: 900 })
  assert.ok(await detail.evaluate(element => element.scrollWidth <= element.clientWidth))
  assert.deepEqual(errors, [])
})
