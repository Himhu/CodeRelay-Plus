import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { chromium, expect } from '@playwright/test'
import { createServer } from 'vite'
import { createChannelStore, createSecondarySiteStore } from '../server/site-store.js'

test('discovery shows the complete catalog, keeps criteria consistent and fills exact-token associations on desktop and mobile', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-discovery-ui-')), previous = process.env.SIGNAL_DATA_DIR
  process.env.SIGNAL_DATA_DIR = directory
  t.after(() => { if (previous === undefined) delete process.env.SIGNAL_DATA_DIR; else process.env.SIGNAL_DATA_DIR = previous; rmSync(directory, { recursive: true, force: true }) })
  const at = new Date().toISOString(), later = new Date(Date.now() + 86400000).toISOString()
  createChannelStore(directory).save([{ id: 'upstream', name: '测试上游', endpoint: 'http://127.0.0.1:9', provider: 'sub2api',
    probeTokens: [{ id: '2', name: '自动线路令牌', groupId: '1', key: 'sk-test-only', status: 'active', probeEnabled: false,
      modelsNextRefreshAt: later, probeModels: [{ id: 'gpt-5', protocol: 'responses', status: 'unknown' }] }] }])
  createSecondarySiteStore(directory).save([{ id: 'side', name: '测试调度站点', endpoint: 'http://127.0.0.1:9', provider: 'sub2api',
    groups: [{ id: 10, name: 'Codex', platform: 'openai', status: 'active', rate: 0.5 }], syncedAt: at, accountsSyncedAt: at,
    accounts: [{ id: 1, name: '测试上游账号', platform: 'openai', type: 'apikey', status: 'active', schedulable: true, groupIds: [10] }] }])
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), cacheDir: join(directory, '.vite'),
    server: { host: '127.0.0.1', port: 0 } })
  t.after(() => server.close()); await server.listen()
  const browser = await chromium.launch(); t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [], writes = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (request.method() === 'POST') writes.push(new URL(request.url()).pathname) })
  let job = null, scans = 0
  await page.route('**/api/secondary-sites/side/discovery', async route => {
    const post = route.request().method() === 'POST'
    if (post) {
      const input = route.request().postDataJSON()
      assert.equal(input.minMargin, undefined); assert.equal(input.saleRate, undefined); assert.equal(input.mainGroups, undefined)
      assert.equal(input.createMissing, undefined)
      const config = { ...input, targetRate: 0.5 }
      scans++
      const row = { upstreamId: 'upstream', upstreamName: '测试上游', groupId: '1', groupName: 'Codex 优选', platform: 'openai',
        keywords: ['Codex'], status: 'eligible', reason: '名称 / 平台匹配，成本倍率低于调度站分组倍率。', rawRate: 0.8, rechargeRate: 2,
        peakFactor: 1, costRate: 0.499, targetRate: 0.5,
        tokenState: 'existing', tokenId: '2',
        tokenName: '已有线路令牌', tokenError: null,
        models: [{ id: 'gpt-5', protocol: 'responses' }], accountSuggestions: [{ id: 1, name: '测试上游账号' }] }
      job = { id: String(scans), config, status: 'running', total: 1, completed: 0, upstreams: [], rows: [], errors: [], created: 0 }
      await route.fulfill({ status: 202, json: { job } })
      job = { ...job, status: 'complete', completed: 1, upstreams: [{ upstreamId: 'upstream', name: '测试上游', status: 'complete', routes: 3 }],
        reused: 1, rows: [row,
          { ...row, groupId: '2', groupName: 'Codex 高价', status: 'cost-too-high', reason: '成本不低于调度站分组倍率。', costRate: 0.5, tokenState: 'missing', tokenId: null, models: [] },
          { ...row, groupId: '3', groupName: 'Claude Kiro', status: 'unmatched', keywords: [], reason: '未识别到一致的名称关键词或平台。', tokenState: 'missing', tokenId: null, models: [] }] }
    } else await route.fulfill({ json: { job } })
  })
  await page.goto(server.resolvedUrls.local[0] + '#secondary-channels')
  await expect(page.locator('.rb-accounts')).toHaveCount(0)
  await page.getByRole('link', { name: '查看分组倍率与模型状态' }).click()
  await page.getByRole('button', { name: 'Codex', exact: true }).click()
  await page.getByRole('link', { name: '智能选线', exact: true }).click()
  const view = page.getByRole('region', { name: '智能选线', exact: true })
  assert.equal(new URL(page.url()).hash, '#route-discovery?site=side&group=10')
  await expect(page.getByRole('heading', { level: 1, name: '线路管理' })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(view.locator('.rd-settings')).not.toHaveAttribute('open', '')
  await view.locator('.rd-settings>summary').click()
  await expect(view.getByLabel('参考售价倍率')).toHaveCount(0)
  await expect(view.getByLabel('最低预计毛利率（%）')).toHaveCount(0)
  await expect(view.locator('.rd-settings')).toContainText('调度站分组倍率 0.5×')
  await expect(view.getByLabel('自动补齐缺失令牌')).toHaveCount(0)
  await view.getByRole('button', { name: '开始选线', exact: true }).click()
  await expect(view.locator('.rd-progress')).toContainText('识别完成')
  await expect(view.locator('.rd-settings')).not.toHaveAttribute('open', '')
  await expect(view.getByRole('button', { name: '展开上游 测试上游', exact: true })).toHaveAttribute('aria-expanded', 'false')
  await view.getByRole('button', { name: '展开全部上游' }).click()
  await expect(view.locator('tbody tr:visible')).toHaveCount(3)
  await expect(view.locator('.rd-progress')).toContainText('已找到 1')
  await view.getByRole('button', { name: /^符合条件/ }).click()
  await expect(view.locator('tbody tr:visible')).toHaveCount(1)
  await view.getByRole('button', { name: /^全部 3/ }).click()
  await view.getByLabel('搜索上游线路').fill('Kiro')
  await expect(view.locator('tbody tr:visible')).toHaveCount(1)
  await view.getByLabel('搜索上游线路').fill('不存在')
  await expect(view.getByText('没有匹配的上游线路')).toBeVisible()
  await view.getByLabel('搜索上游线路').fill('')
  await view.locator('.rd-settings>summary').click()
  const secondScan = page.waitForResponse(async response => response.url().endsWith('/api/secondary-sites/side/discovery') && response.request().method() === 'GET' && (await response.json()).job?.id === '2')
  await view.getByRole('button', { name: '开始选线', exact: true }).click()
  await secondScan
  await expect(view.locator('.rd-progress')).toContainText('识别完成')
  await expect(view.locator('.rd-progress')).toContainText('已找到 1')
  await view.getByRole('button', { name: '展开全部上游' }).click()
  const eligible = view.locator('tbody tr').filter({ hasText: 'Codex 优选' })
  await expect(eligible).toContainText('已复用')
  await expect(eligible).toContainText('0.499×')
  await expect(eligible).toContainText('0.5×')
  await expect(view.locator('th')).not.toContainText(['预计毛利'])
  await expect(eligible.locator('select')).toHaveCount(0)
  const screenshots = process.env.SECONDARY_SCREENSHOTS
  if (screenshots) { mkdirSync(screenshots, { recursive: true }); await page.screenshot({ path: join(screenshots, 'discovery-desktop.png') }) }
  await eligible.getByRole('button', { name: '查看 测试上游 Codex 优选 详情', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: 'Codex 优选', exact: true })
  await expect(dialog.getByLabel('关联调度站点账号', { exact: true })).toHaveValue('1')
  if (screenshots) await page.screenshot({ path: join(screenshots, 'discovery-detail-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.ok(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth))
  if (screenshots) await page.screenshot({ path: join(screenshots, 'discovery-detail-mobile.png') })
  await dialog.getByRole('button', { name: '填入关联' }).click()
  dialog = page.getByRole('dialog', { name: '关联上游令牌', exact: true })
  await expect(dialog.getByLabel('上游站点', { exact: true })).toHaveValue('upstream')
  await expect(dialog.getByLabel('上游令牌', { exact: true })).toHaveValue('2')
  await expect(dialog.getByRole('checkbox', { name: /gpt-5 responses/ })).toBeChecked()
  await expect(dialog.getByRole('checkbox', { name: '确认所选令牌及模型与调度站点账号配置一致' })).not.toBeChecked()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(view.getByRole('button', { name: '展开上游 测试上游', exact: true })).toHaveAttribute('aria-expanded', 'true')
  await page.reload()
  await expect(view.locator('.rd-progress')).toContainText('识别完成')
  assert.equal(new URL(page.url()).hash, '#route-discovery?site=side&group=10')
  await view.getByRole('button', { name: '展开全部上游' }).click()
  if (screenshots) await page.screenshot({ path: join(screenshots, 'discovery-mobile.png'), fullPage: true })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), JSON.stringify(await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
    offenders: [...document.querySelectorAll('*')].filter(e => e.scrollWidth > e.clientWidth && !e.closest('table')).map(e => ({tag:e.tagName,class:e.className,scroll:e.scrollWidth,client:e.clientWidth,overflow:getComputedStyle(e).overflow,position:getComputedStyle(e).position})).slice(0,20) }))))
  await page.getByRole('link', { name: '账号关联', exact: true }).click()
  await expect(page.getByRole('heading', { name: '账号关联', exact: true })).toBeVisible()
  await page.goBack()
  await expect(view.locator('.rd-progress')).toContainText('识别完成')
  await page.setViewportSize({ width: 320, height: 844 })
  await view.getByRole('button', { name: '展开全部上游' }).click()
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await view.getByRole('button', { name: 'Codex 优选', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Codex 优选', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.route('**/api/secondary-sites/side/discovery', route => route.fulfill({ status: 502, json: { error: '读取识别结果失败' } }))
  await page.reload()
  await expect(page.getByRole('alert')).toContainText('读取识别结果失败')
  await expect(page.getByRole('button', { name: '重新读取', exact: true })).toBeVisible()
  await page.goto(server.resolvedUrls.local[0] + '#route-discovery?site=removed')
  await expect(page.getByText('找不到此调度站点')).toBeVisible()
  assert.equal(scans, 2)
  assert.ok(writes.every(path => path === '/api/secondary-sites/side/discovery'))
  assert.ok(createChannelStore(directory).load().flatMap(channel => channel.probeTokens).every(token => !token.probeEnabled))
  assert.deepEqual(errors, [])
})
