import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { chromium, expect } from '@playwright/test'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { createChannelStore, createSecondarySiteStore } from '../server/site-store.js'
import { accountConnection } from '../server/route-bindings.js'

test('subsidiary groups show account and token health without main sites, persist and work on mobile without enabling probes', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-routing-ui-'))
  const previous = process.env.SIGNAL_DATA_DIR
  process.env.SIGNAL_DATA_DIR = directory
  t.after(() => { if (previous === undefined) delete process.env.SIGNAL_DATA_DIR; else process.env.SIGNAL_DATA_DIR = previous; rmSync(directory, { recursive: true, force: true }) })
  const at = new Date().toISOString(), later = new Date(Date.now() + 86400000).toISOString()
  createChannelStore(directory).save([{ id: 'upstream', name: '测试上游', endpoint: 'http://127.0.0.1:9', provider: 'sub2api',
    rechargeRate: 10, userGroups: { status: 'ok', groups: [{ id: '1', rate: 0.6 }, { id: '2', rate: 1.2 }] },
    probeTokens: [1, 2].map(id => ({ id: String(id), name: `令牌 ${id}`, groupId: String(id), groupName: `分组 ${id}`, key: `sk-test-secret-${id}`, status: 'active',
      probeEnabled: false, modelsNextRefreshAt: later, probeModels: [{ id: 'gpt-5', protocol: 'responses', status: 'unknown' }, { id: 'gpt-5-mini', protocol: 'responses', status: 'unknown' }] })) }])
  createSecondarySiteStore(directory).save([{ id: 'secondary', name: '测试调度站点', endpoint: 'http://127.0.0.1:9', provider: 'sub2api',
    groups: [{ id: 10, name: 'Codex 稳定分组', platform: 'openai', status: 'active', rate: 0.2 }], syncedAt: at, accountsSyncedAt: at,
    mainBindings: [{ mainSiteId: 'main', mainName: '测试主站', channelId: 101, channelName: '主站 Codex', groupId: 10, groupName: 'Codex 稳定分组' }],
    accounts: [{ id: 1, name: '账号 A', platform: 'openai', type: 'apikey', status: 'active', schedulable: true, groupIds: [10] },
      ...Array.from({ length: 22 }, (_, i) => ({ id: i + 2, name: `备用账号 ${i + 2}`, platform: 'openai', type: 'apikey', status: 'active', schedulable: true, groupIds: [],
        ...(i === 0 ? { connection: accountConnection({ credentials: { base_url: 'http://127.0.0.1:9/v1/', api_key: 'sk-test-secret-1' } }) } : {}) }))] }])
  const config = { root: fileURLToPath(new URL('../', import.meta.url)), cacheDir: join(directory, '.vite'), server: { host: '127.0.0.1', port: 0 } }
  let server = await createServer(config)
  t.after(() => server.close())
  await server.listen()
  const base = server.resolvedUrls.local[0], browser = await chromium.launch()
  const publicTokens = (await (await fetch(base + 'api/probe-tokens')).json()).probeTokens
  assert.equal(publicTokens[0].name, '测试上游 · 0.06×')
  assert.equal(publicTokens[0].upstreamTokenName, '令牌 1')
  assert.equal(createChannelStore(directory).load()[0].probeTokens[0].name, '令牌 1')
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = [], writes = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { assert.ok(!new URL(request.url()).pathname.startsWith('/api/main-sites')); if (request.method() === 'POST') writes.push(new URL(request.url()).pathname) })
  await page.goto(base + '#secondary-channels')
  await page.getByRole('link', { name: '线路管理', exact: true }).click()
  if (!await page.locator('.rw-advanced').getAttribute('open').then(value => value !== null)) await page.locator('.rw-advanced > summary').click()
  await page.getByRole('link', { name: '账号关联', exact: true }).click()
  await expect(page.locator('.rb-account')).toHaveCount(5)
  await page.getByRole('navigation', { name: '调度账号分页' }).getByRole('button', { name: '第 5 页', exact: true }).click()
  await expect(page.locator('.rb-account')).toHaveCount(3)
  await page.getByLabel('搜索账号或令牌', { exact: true }).fill('账号 A')
  await expect(page.locator('.rb-account')).toHaveCount(1)
  await page.getByLabel('搜索账号或令牌', { exact: true }).fill('')
  await page.getByLabel('按调度站点分组筛选账号', { exact: true }).selectOption('10')
  await expect(page.locator('.rb-account')).toHaveCount(1)
  const bindingResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/secondary-sites/secondary/bindings')
  await page.getByRole('button', { name: '关联账号 账号 A', exact: true }).click()
  const bindingResult = await bindingResponse
  assert.equal(bindingResult.status(), 200, await bindingResult.text())
  let dialog = page.getByRole('dialog', { name: '关联上游令牌', exact: true })
  await expect(dialog.locator('select').first()).toBeVisible()
  assert.deepEqual(errors, [])
  await dialog.getByLabel('上游站点', { exact: true }).selectOption('upstream')
  await dialog.getByLabel('上游令牌', { exact: true }).selectOption('2')
  await dialog.getByRole('checkbox', { name: 'gpt-5 responses', exact: false }).first().check()
  await dialog.getByLabel('调度站点模型名', { exact: true }).fill('codex-public')
  await dialog.getByRole('checkbox', { name: '确认所选令牌及模型与调度站点账号配置一致' }).check()
  await dialog.getByRole('button', { name: '保存关联', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const account = page.locator('.rb-account').filter({ has: page.getByRole('button', { name: '关联账号 账号 A', exact: true }) })
  await expect(account).toContainText('测试上游 · 0.12×')
  await expect(page.locator('.rb-model-table')).toHaveCount(0)
  await account.getByRole('button', { name: '账号 A', exact: true }).click()
  let detail = page.getByRole('dialog', { name: '账号 A', exact: true })
  await expect(detail.getByText('codex-public', { exact: true })).toBeVisible()
  await expect(detail.getByText('探测未启用', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('link', { name: '分组状态', exact: true }).click()
  await expect(page.getByRole('table').getByText('暂无可用线路', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Codex 稳定分组', exact: true }).click()
  detail = page.getByRole('dialog', { name: 'Codex 稳定分组', exact: true })
  await expect(detail.getByRole('link', { name: '智能选线', exact: true })).toHaveAttribute('href', '#route-discovery?site=secondary&group=10')
  await detail.getByLabel('查看 codex-public 的上游线路', { exact: true }).click()
  const routes = detail.getByRole('list', { name: 'codex-public 的上游线路', exact: true })
  await expect(routes).toContainText('账号 A')
  await expect(routes).toContainText('账号 #1 · 令牌 #2')
  await expect(routes).toContainText('测试上游 · 0.12×')
  await expect(routes).toContainText('探测未启用')
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(routes).toBeVisible()
  assert.ok(await detail.evaluate(element => element.scrollWidth <= element.clientWidth))
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.keyboard.press('Escape')
  assert.equal(await page.getByRole('button', { name: '主站渠道', exact: true }).count(), 0)
  const screenshots = process.env.SECONDARY_SCREENSHOTS
  if (screenshots) { mkdirSync(screenshots, { recursive: true }); await page.screenshot({ path: join(screenshots, 'groups-desktop.png'), fullPage: true }) }
  if (!await page.locator('.rw-advanced').getAttribute('open').then(value => value !== null)) await page.locator('.rw-advanced > summary').click()
  await page.getByRole('link', { name: '账号关联', exact: true }).click()
  if (screenshots) await page.screenshot({ path: join(screenshots, 'accounts-desktop.png'), fullPage: true })
  await account.getByRole('button', { name: '账号 A', exact: true }).click()
  detail = page.getByRole('dialog', { name: '账号 A', exact: true })
  const read = page.waitForResponse(response => new URL(response.url()).pathname === '/api/secondary-sites' && response.request().method() === 'GET')
  await read
  await expect(detail).toBeVisible()
  if (screenshots) await page.screenshot({ path: join(screenshots, 'bindings-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  assert.ok(await detail.evaluate(element => element.scrollWidth <= element.clientWidth))
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '关联账号 账号 A', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '关联上游令牌', exact: true })
  await expect(dialog.getByLabel('上游令牌', { exact: true })).toHaveValue('2')
  await expect(dialog.getByLabel('调度站点模型名', { exact: true })).toHaveValue('codex-public')
  assert.ok(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth))
  if (screenshots) await page.screenshot({ path: join(screenshots, 'bindings-mobile-editor.png') })
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await page.getByRole('link', { name: '分组状态', exact: true }).click()
  if (screenshots) await page.screenshot({ path: join(screenshots, 'groups-mobile.png'), fullPage: true })
  await server.close(); server = await createServer(config); await server.listen(); await page.reload()
  await expect(page.getByRole('table').getByText('暂无可用线路', { exact: true })).toBeVisible()
  if (!await page.locator('.rw-advanced').getAttribute('open').then(value => value !== null)) await page.locator('.rw-advanced > summary').click()
  await page.getByRole('link', { name: '账号关联', exact: true }).click()
  await expect(account).toContainText('测试上游 · 0.12×')
  const savedSite = createSecondarySiteStore(directory).load()[0]
  assert.equal(savedSite.accountBindings[0].tokenId, '2')
  assert.equal(savedSite.mainGroupBindings, undefined)
  await page.getByRole('button', { name: '关联账号 账号 A', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '关联上游令牌', exact: true })
  await dialog.getByRole('button', { name: '解除关联', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(account.getByText('尚未关联上游令牌', { exact: true })).toBeVisible()
  const automatic = page.locator('.rb-account').filter({ has: page.getByRole('button', { name: '关联账号 备用账号 2', exact: true }) })
  await expect(automatic).toContainText('已自动关联')
  await expect(automatic).toContainText('测试上游 · 0.06×')
  await automatic.getByRole('button', { name: '关联账号 备用账号 2', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '关联上游令牌', exact: true })
  await expect(dialog.getByLabel('上游令牌', { exact: true })).toHaveValue('1')
  await dialog.getByRole('button', { name: '解除关联', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(automatic).toContainText('已手动关闭自动关联')
  await automatic.getByRole('button', { name: '关联账号 备用账号 2', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '关联上游令牌', exact: true })
  await dialog.getByRole('button', { name: '恢复自动关联', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(automatic).toContainText('已自动关联')
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  assert.ok(writes.every(path => path === '/api/secondary-sites/secondary/bindings'))
  assert.equal(createChannelStore(directory).load().flatMap(channel => channel.probeTokens).filter(token => token.probeEnabled).length, 0)
  assert.deepEqual(errors, [])
})

test('group model summaries distinguish usable routes, explain exclusions, filter, and keep expansion during polling', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-group-model-ui-'))
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false,
    plugins: [react()], cacheDir: join(directory, '.vite'), server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  const browser = await chromium.launch()
  t.after(async () => { await browser.close(); await server.close(); rmSync(directory, { recursive: true, force: true }) })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [], requests = []
  const at = new Date().toISOString(), group = { id: 10, name: 'Codex Plus', platform: 'openai', status: 'active' }
  const names = ['老莫渠道 · 0.12×', 'Reverse API · 0.12×', '超超站 · 0.08×', '故障线路 · 0.1×']
  const accounts = names.map((name, index) => ({ id: index + 1, name, status: 'active', schedulable: index !== 1, groupIds: [10] }))
  const routes = names.map((name, index) => ({ accountId: index + 1, accountName: name, tokenName: name, upstreamId: `u${index}`, tokenId: String(index + 20),
    bindingStatus: 'confirmed', eligible: index !== 1, status: index === 2 ? 'paused' : index === 3 ? 'error' : 'ok', lastProbeAt: at, latencyMs: 150,
    error: index === 3 ? '上游请求超时，请稍后复测。' : null }))
  const model = (name, members) => ({ model: name, protocol: 'responses', routes: members, passed: members.filter(r => r.eligible && r.status === 'ok').length,
    failed: members.filter(r => r.eligible && r.status === 'error').length, unknown: members.filter(r => r.eligible && !['ok', 'error'].includes(r.status)).length,
    unavailable: members.filter(r => !r.eligible).length, independentTokens: members.filter(r => r.eligible && r.status === 'ok').length })
  const site = { id: 'site', name: '调度站点', endpoint: 'https://scheduler.example.test', groups: [group], accounts,
    routes: { accounts, orphanBindings: [], groups: [{ groupId: 10, unboundAccounts: 0, reviewAccounts: 0,
      models: [model('gpt-5.5', routes), model('gpt-5.6-luna', [routes[2]]), model('gpt-5.6-sol-openai-compact', [routes[0]])] }] } }
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    requests.push({ path, method: request.method() })
    if (path === '/api/settings') return route.fulfill({ json: { settings: { lowBalanceThreshold: 5 }, balanceNotices: { low: [], unavailable: [] } } })
    assert.equal(path, '/api/secondary-sites')
    return route.fulfill({ json: { sites: [site] } })
  })
  await page.goto(server.resolvedUrls.local[0] + '#route-bindings?site=site')
  await page.getByRole('button', { name: group.name, exact: true }).click()
  const detail = page.getByRole('dialog', { name: group.name, exact: true }), panel = detail.getByRole('region', { name: '分组模型状态' })
  await expect(panel.locator('h3')).toContainText('2 / 3 个模型有可用线路')
  await expect(panel).not.toContainText('失败 0')
  await expect(panel.locator('.rb-group-model')).toHaveCount(3)
  const summary = panel.getByLabel('查看 gpt-5.5 的上游线路', { exact: true })
  await expect(summary).toContainText('1 条可用')
  await expect(summary).toContainText('3 条暂不可用')
  await summary.focus(); await page.keyboard.press('Enter')
  const expanded = panel.locator('.rb-group-model').first()
  await expect(expanded.getByRole('list', { name: 'gpt-5.5 的上游线路', exact: true }).getByRole('listitem')).toHaveCount(1)
  await expect(expanded.getByText(names[0], { exact: true })).toHaveCount(1, { timeout: 1000 })
  await expect(expanded.locator('.rb-model-other')).not.toHaveAttribute('open', '')
  await expanded.locator('.rb-model-other > summary').click()
  await expect(expanded).toContainText('账号未开启调度')
  await expect(expanded).toContainText('探测通过')
  await expect(expanded).toContainText('上游请求超时，请稍后复测。')
  const poll = page.waitForResponse(response => new URL(response.url()).pathname === '/api/secondary-sites')
  await poll
  await expect(expanded).toHaveAttribute('open', '')
  await expect(expanded.locator('.rb-model-other')).toHaveAttribute('open', '')
  const filter = panel.getByRole('group', { name: '模型可用性筛选' })
  await filter.getByRole('button', { name: /暂无可用/ }).click()
  await expect(panel.locator('.rb-group-model')).toHaveCount(1)
  await panel.getByLabel('查看 gpt-5.6-luna 的上游线路').click()
  await expect(panel.getByText('探测暂停', { exact: true })).toBeVisible()
  await filter.getByRole('button', { name: /有可用线路/ }).click()
  await expect(panel.locator('.rb-group-model')).toHaveCount(2)
  const search = panel.getByRole('searchbox', { name: '搜索分组内模型' })
  await search.fill('compact'); await expect(panel.locator('.rb-group-model')).toHaveCount(1)
  await search.fill('does-not-exist'); await expect(panel.getByText('没有符合条件的模型')).toBeVisible()
  await search.fill(''); await filter.getByRole('button', { name: /全部/ }).click()
  await summary.click()
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 })
    assert.ok(await detail.evaluate(element => element.scrollWidth <= element.clientWidth), `No dialog overflow at ${width}`)
    assert.ok(await panel.evaluate(element => element.scrollWidth <= element.clientWidth), `No model overflow at ${width}`)
    await page.screenshot({ path: join(tmpdir(), `signal-group-model-${width}.png`) })
  }
  assert.ok(requests.every(request => request.method === 'GET'))
  assert.deepEqual(errors, [])
})
