import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { buildProbeTimeline, buildProbeModelGroups, buildProbeFamilyGroups, probeResultLabel, summarizeProbeCells, summarizeProbeRates, summarizeProbeAvailability, probeRecordSection } from '../src/probe-records-data.js'

const now = Date.parse('2026-09-17T06:30:30Z')
const minute = 60000
const boundary = Math.floor(now / minute) * minute
const at = delta => new Date(boundary + delta).toISOString()

test('minute history counts actual results, excludes unfinished minutes and preserves mixed outcomes', () => {
  const cells = buildProbeTimeline([
    { tokenId: 1, tokenName: 'same name', history: [
      { at: at(-60 * minute), status: 'ok', latencyMs: 0 },
      { at: at(-minute + 1000), completedAt: at(-minute + 1100), protocol: 'chat', timeoutMs: 45000, status: 'ok', latencyMs: 100 },
      { at: at(-minute + 2000), status: 'ok', latencyMs: 300 },
      { at: at(-minute + 3000), status: 'inconclusive', reason: 'output_limit', error: '已达到 8 token 输出上限', httpStatus: 200, latencyMs: null },
      { at: at(-60 * minute - 1), status: 'error' },
      { at: at(0), status: 'error' },
      { at: at(5000), status: 'error' },
      { at: 'invalid', status: 'error' },
    ] },
    { tokenId: 2, tokenName: 'same name', history: [{ at: at(-1), status: 'error', latencyMs: 500 }] },
  ], now)
  assert.equal(cells.length, 60)
  assert.equal(cells[0].time, boundary - 60 * minute)
  assert.equal(cells[0].latencyMs, 0)
  assert.equal(cells.at(-1).time, boundary - minute)
  assert.equal(cells.at(-1).status, 'partial_error')
  assert.equal(cells.at(-1).entries[0].completedAt, at(-minute + 1100))
  assert.equal(cells.at(-1).entries[0].timeoutMs, 45000)
  assert.equal(cells.at(-1).entries[0].protocol, 'chat')
  assert.equal(cells.at(-1).entries.find(entry => entry.status === 'inconclusive').reason, 'output_limit')
  assert.equal(cells.at(-1).entries.find(entry => entry.status === 'inconclusive').error, '已达到 8 token 输出上限')
  assert.equal(cells.at(-1).success, 2)
  assert.equal(cells.at(-1).failed, 1)
  assert.equal(cells.at(-1).uncertain, 1)
  assert.equal(cells.at(-1).latencyMs, 300)
  assert.deepEqual(summarizeProbeCells(cells), { success: 3, failed: 1, uncertain: 1, total: 5, coverage: 2, rate: '75%' })
  assert.equal(cells[1].status, 'empty')
  assert.equal(cells[1].latencyMs, null)
})

function token(id, channelId, models, changes = {}) {
  return { id, channelId, channelName: `上游 ${channelId}`, endpoint: `https://${channelId}.example.test`, provider: 'sub2api',
    name: `上游 ${channelId} · 0.1×`, upstreamTokenName: '相同令牌名', groupName: `线路 ${id}`, rechargeRate: 2, probeEnabled: true, probePaused: false,
    probeModels: models.map(model => ({ id: model, protocol: 'chat', status: 'ok', lastProbeAt: at(-10000), latencyMs: 123,
      history: [{ at: at(-minute + 1000), status: 'ok', latencyMs: 123 }] })), ...changes }
}

test('cost pauses supersede old successes and failures without changing minute history', () => {
  const source = token(1, 'cost', ['gpt-5'])
  Object.assign(source.probeModels[0], { costBlocked: true, costBlockReason: '实际成本 0.2× 高于调度分组 0.1×', autoPaused: true })
  const record = buildProbeModelGroups([source], now)[0].channels[0].records[0]
  assert.equal(record.currentStatus, 'cost_blocked')
  assert.equal(probeRecordSection(record), 'other')
  assert.equal(summarizeProbeAvailability([record]).status, 'cost_blocked')
  assert.equal(record.summary.success, 1, 'Actual past successes remain in the timeline')
  source.probeModels[0].costBlocked = false; source.probeModels[0].autoPaused = false
  assert.equal(buildProbeModelGroups([source], now)[0].channels[0].records[0].currentStatus, 'ok')
})

test('groups by exact model and channel IDs but keeps every token timeline and rate separate', () => {
  const groups = buildProbeModelGroups([
    token(1, 'a', ['gpt-5', 'gpt-5.1']), token(2, 'a', ['gpt-5'], { probeModels: [{ id: 'gpt-5', protocol: 'chat', status: 'error',
      lastProbeAt: at(-10000), latencyMs: 500, history: [{ at: at(-minute + 1000), status: 'error', latencyMs: 500 }] }] }),
    token(1, 'b', ['gpt-5'], { probeEnabled: false }),
    token(4, 'c', ['gpt-5'], { probeModels: [{ id: 'gpt-5', status: 'ok', lastProbeAt: at(-10 * minute), history: [] }] }),
  ], now)
  assert.equal(groups.length, 2)
  assert.equal(groups[0].channels.length, 3)
  assert.equal(groups[0].channels[0].records.length, 2)
  const [passed, failed] = groups[0].channels[0].records
  assert.equal(passed.summary.rate, '100%')
  assert.equal(failed.summary.rate, '0%')
  assert.equal(passed.cells.at(-1).status, 'ok')
  assert.equal(failed.cells.at(-1).status, 'error')
  assert.equal(passed.cells.at(-1).latencyMs, 123)
  assert.equal(failed.cells.at(-1).latencyMs, 500)
  assert.deepEqual(passed.cells.at(-1).entries.map(entry => entry.tokenId), [1])
  assert.deepEqual(failed.cells.at(-1).entries.map(entry => entry.tokenId), [2])
  assert.equal(groups[0].channels[1].records[0].currentStatus, 'disabled')
  assert.equal(groups[0].channels[1].records[0].summary.rate, '100%')
  assert.equal(groups[0].channels[2].records[0].currentStatus, 'stale')
  assert.equal(groups[0].channels[2].records[0].summary.rate, '—')
  assert.equal(groups[0].channels[2].records[0].summary.coverage, 0)
})

test('actual model multipliers normalize recharge and preserve different token prices and unknowns', () => {
  const priced = (id, rate, changes = {}) => token(id, 'a', ['gpt-5'], {
    rechargeRate: 10, groupPricing: { rate, source: 'custom', status: 'ok' }, ...changes,
  })
  const records = tokens => buildProbeModelGroups(tokens, now)[0].channels[0].records
  const display = tokens => summarizeProbeRates(records(tokens).map(record => record.pricing))
  assert.equal(display([priced(1, 1.5)]), '0.15×')
  assert.match(records([priced(1, 1.5)])[0].pricing.detail, /用户专属 1.5× ÷ 充值倍率 10× = 0.15×/)
  assert.equal(display([priced(1, 1.5, { rechargeRate: 1 })]), '1.5×')
  assert.equal(display([priced(1, 0)]), '0×')
  assert.equal(display([priced(1, 0.0000001)]), '1e-8×')
  assert.equal(display([priced(1, 1.5), priced(2, 1.5)]), '0.15×')
  assert.equal(display([priced(1, 10), priced(2, 0.8), priced(3, 3.5)]), '0.08×–1×')
  assert.equal(display([priced(1, null)]), '未获取')
  assert.equal(display([priced(1, 1.5), token(2, 'a', ['gpt-5'])]), '0.15× · 部分未知')
  assert.equal(display([priced(1, 1.5, { groupPricing: { rate: 1.5, status: 'error' } })]), '0.15× · 待更新')
  assert.equal(display([priced(1, null, { groupPricing: { source: 'automatic' } })]), '未获取')
  assert.match(records([priced(1, null, { groupPricing: { source: 'automatic' } })])[0].pricing.detail, /自动选择分组/)
  for (const rate of [NaN, Infinity, -1, '1.5']) assert.equal(display([priced(1, rate)]), '未获取')
  for (const rechargeRate of [NaN, Infinity, 0, -1]) assert.equal(display([priced(1, 1.5, { rechargeRate })]), '未获取')
  const peak = priced(1, 1.5, { groupPricing: { rate: 1.5, status: 'ok', peak: { start: '18:00', end: '22:00', factor: 2 } } })
  assert.equal(display([peak]), '0.15×–0.3×')
  assert.match(records([peak])[0].pricing.detail, /高峰 18:00–22:00 为 0.3×/)
  assert.equal(display([priced(1, 1.5, { probeModels: [{ id: 'gpt-image', protocol: 'unsupported' }] })]), '未获取')
})

test('family groups combine Claude variants, keep exact models and sort independently of upstream order', () => {
  const identities = { 'grok-10': 'Grok', 'claude-code': 'Claude Code', 'gpt-5.3-codex': 'Codex',
    'gpt-5': 'OpenAI', 'claude-sonnet': 'Claude', 'grok-2': 'Grok', 'gemini-3': 'Gemini', 'custom-model': '其他模型' }
  const groups = Object.keys(identities).map(id => ({ id, channels: [{ id: 'upstream', cells: [] }] }))
  const identify = id => ({ family: identities[id] })
  const categories = buildProbeFamilyGroups(groups, identify)
  assert.deepEqual(categories.map(category => category.family), ['Claude Code', 'Codex', 'Grok', 'Gemini', 'OpenAI', '其他模型'])
  assert.deepEqual(categories[0].models.map(model => model.id), ['claude-code', 'claude-sonnet'])
  assert.deepEqual(categories[2].models.map(model => model.id), ['grok-2', 'grok-10'])
  assert.equal(categories[2].models[1], groups[0], 'Grouping retains each model and its upstream timelines')
  assert.deepEqual(buildProbeFamilyGroups([...groups].reverse(), identify), categories)
  assert.deepEqual(buildProbeFamilyGroups([], identify), [])
})

test('each token retains its own failure, pending, paused or disabled status', () => {
  const model = status => [{ id: 'gpt-5', protocol: 'chat', status, lastProbeAt: at(-1000), history: [] }]
  const cases = [
    [{ probeModels: model('error') }, 'error'],
    [{ probeModels: model('inconclusive') }, 'inconclusive'],
    [{ probeModels: [{ id: 'gpt-5', status: 'unknown', history: [] }] }, 'unprobed'],
    [{ probeEnabled: false }, 'disabled'],
    [{ probePaused: true }, 'paused'],
    [{ probeModels: [{ id: 'gpt-5', status: 'ok', lastProbeAt: at(-10 * minute) }] }, 'stale'],
  ]
  for (const [changes, expected] of cases) {
    const group = buildProbeModelGroups([token(1, 'a', ['gpt-5']), token(2, 'a', ['gpt-5'], changes)], now)[0]
    assert.deepEqual(group.channels[0].records.map(record => record.currentStatus), ['ok', expected])
  }
  const errorAndPending = buildProbeModelGroups([token(1, 'a', ['gpt-5'], { probeModels: model('error') }),
    token(2, 'a', ['gpt-5'], { probeModels: [{ id: 'gpt-5', status: 'unknown' }] })], now)[0]
  assert.deepEqual(errorAndPending.channels[0].records.map(record => record.currentStatus), ['error', 'unprobed'])
  assert.equal(probeResultLabel({ status: 'inconclusive', reason: 'output_limit' }), '输出达到上限')
  assert.equal(probeResultLabel({ status: 'inconclusive' }), '响应未确认')
  assert.equal(probeResultLabel({ status: 'disabled', reason: 'output_limit' }), '探测已关闭')
  const manyModels = token(1, 'a', Array.from({ length: 20 }, (_, index) => `model-${index}`))
  for (const model of manyModels.probeModels) model.lastProbeAt = at(-3 * minute)
  assert.ok(buildProbeModelGroups([manyModels], now).every(group => group.channels[0].records[0].currentStatus === 'stale'), 'More models must not extend the freshness window')
})

test('model availability states why a line is unconfirmed and exposes every mixed-state count', () => {
  const summary = statuses => summarizeProbeAvailability(statuses.map(currentStatus => ({ currentStatus })))
  assert.equal(summary(['ok', 'error', 'unprobed']).label, '有可用线路 1/3')
  assert.equal(summary(['ok', 'ok']).label, '有可用线路 2/2')
  assert.equal(summary(['error', 'error']).label, '暂无可用线路')
  assert.equal(summary(['error']).status, 'error')
  for (const [status, label] of Object.entries({
    unprobed: '等待首次检测', revalidating: '等待重新验证', inconclusive: '响应未确认', stale: '结果已过期',
    disabled: '探测未启用', paused: '令牌待同步', unsupported: '暂不支持探测', models_error: '模型同步失败',
    balance_blocked: '余额不足 · 已暂停', invalid_time: '检测时间异常', unknown: '结果状态未识别',
  })) {
    assert.equal(summary([status]).label, `${label} 1`)
    const mixed = summary(['error', status])
    assert.equal(mixed.label, '尚无确认可用线路')
    assert.equal(mixed.breakdown, `探测失败 1 · ${label} 1`)
    assert.ok(!mixed.detail.includes('待验证'))
  }
  assert.equal(summary([]).label, '暂无线路')
  assert.equal(summary(['error', 'excluded']).breakdown, '探测失败 1 · 模型已隔离 1')
  const records = buildProbeModelGroups([token(1, 'a', ['gpt-5']), token(2, 'a', ['gpt-5'], { probeEnabled: false })], now + 3 * minute)[0].channels[0].records
  assert.equal(summarizeProbeAvailability(records).breakdown, '探测未启用 1 · 结果已过期 1')
})

test('current state respects blockers, distinguishes first detection from revalidation and rejects invalid timestamps', () => {
  const state = changes => buildProbeModelGroups([token(1, 'a', ['gpt-5'], changes)], now)[0].channels[0].records[0].currentStatus
  assert.equal(state({ probeBlockReason: 'balance' }), 'balance_blocked')
  assert.equal(state({ probeBlockReason: 'credentials' }), 'paused')
  assert.equal(state({ modelsError: 'HTTP 403' }), 'ok', 'A catalog error cannot override a fresh successful inference')
  assert.equal(state({ probeBlockReason: 'models' }), 'models_error')
  assert.equal(state({ probeEnabled: false, probeBlockReason: 'balance' }), 'disabled')
  for (const [model, expected] of [
    [{ lastProbeAt: null }, 'unprobed'], [{ lastProbeAt: 'bad-date' }, 'invalid_time'],
    [{ lastProbeAt: new Date(now + minute).toISOString() }, 'invalid_time'],
    [{ status: 'unknown' }, 'unknown'], [{ revalidatePending: true }, 'revalidating'],
    [{ revalidatePending: true, autoPaused: true }, 'excluded'], [{ protocol: 'unsupported' }, 'unsupported'],
  ]) assert.equal(state({ probeModels: [{ ...token(1, 'a', ['gpt-5']).probeModels[0], ...model }] }), expected)
})

test('auto-paused model pairs stay visible after expiry, with truthful history and availability', () => {
  const paused = token(1, 'a', ['gpt-5'])
  Object.assign(paused.probeModels[0], { status: 'error', reason: 'model_unsupported', autoPaused: true,
    lastProbeAt: at(-20 * minute), history: [{ at: at(-20 * minute), status: 'error', reason: 'model_unsupported' }] })
  const records = buildProbeModelGroups([paused], now)[0].channels[0].records
  assert.equal(records[0].currentStatus, 'excluded')
  assert.equal(records[0].summary.failed, 1)
  assert.equal(summarizeProbeAvailability(records).label, '暂无可用线路')
  assert.equal(probeResultLabel(paused.probeModels[0]), '模型已隔离')
  Object.assign(paused.probeModels[0], { autoPaused: false, revalidatePending: true })
  assert.equal(buildProbeModelGroups([paused], now)[0].channels[0].records[0].currentStatus, 'revalidating')
  assert.equal(probeResultLabel(paused.probeModels[0]), '等待重新验证')
})

test('persistent failures fold per token and remain folded until a successful probe, without removing history', () => {
  const statuses = Array(5).fill('error')
  const failed = token(1, 'a', ['gpt-5'])
  const model = failed.probeModels[0]
  const check = history => {
    Object.assign(model, { status: history.at(-1), history: history.map((status, index) => ({ status, at: at(-(history.length - index) * minute) })) })
    return buildProbeModelGroups([failed, token(2, 'a', ['gpt-5'])], now)[0].channels[0].records
  }
  assert.equal(probeRecordSection(check(statuses.slice(1))[0]), 'other')
  let records = check(statuses)
  assert.deepEqual(records.map(probeRecordSection), ['abnormal', 'available'])
  assert.equal(records[0].history.length, 5)
  assert.equal(probeRecordSection(check([...statuses, 'inconclusive'])[0]), 'abnormal')
  assert.equal(probeRecordSection(check([...statuses, 'ok'])[0]), 'available')
  assert.equal(probeRecordSection(check([...statuses, 'ok', 'error'])[0]), 'other')
  check(['error', 'inconclusive'])
  model.history[0].reason = 'model_unsupported'
  assert.equal(probeRecordSection(buildProbeModelGroups([failed], now)[0].channels[0].records[0]), 'excluded')
  model.revalidatePending = true
  assert.equal(probeRecordSection(buildProbeModelGroups([failed], now)[0].channels[0].records[0]), 'excluded')
  model.revalidatePending = false
  model.status = 'ok'
  assert.equal(probeRecordSection(buildProbeModelGroups([failed], now)[0].channels[0].records[0]), 'available')
})

test('probe records preserve scroll, filters and history focus across polling, with responsive layout', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-probe-records-'))
  // Only the frontend is served: test records never touch the user's store or probe worker.
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false,
    plugins: [react()], cacheDir: join(directory, '.vite'), server: { host: '127.0.0.1', port: 0 } })
  t.after(async () => { await server.close(); rmSync(directory, { recursive: true, force: true }) })
  await server.listen()
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.clock.install({ time: now - minute })
  await page.clock.pauseAt(now)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  const tokens = [token(1, 'a', ['claude-sonnet-4-6', 'gpt-5.1']), token(2, 'a', ['claude-sonnet-4-6', 'gpt-5.3-codex']), token(3, 'b', ['claude-sonnet-4-6'])]
  tokens[0].channelName = 'GPT【福利组】速度较慢/随时拉闸★ 超长上游渠道名称完整展示'
  tokens[1].channelName = tokens[0].channelName
  tokens[0].rechargeRate = tokens[1].rechargeRate = 10
  tokens[0].groupPricing = { rate: 1.5, source: 'custom', status: 'ok' }
  tokens[1].groupPricing = { rate: 3.5, source: 'default', status: 'ok' }
  tokens[0].probeModels[0].history.push({ at: at(-minute + 2000), status: 'ok', latencyMs: 500 })
  tokens[1].probeModels[0].status = 'error'
  tokens[1].probeModels[0].history[0].status = 'error'
  tokens[1].probeModels[0].history[0].error = '上游请求失败。'
  tokens[1].probeModels[0].history[0].httpStatus = 503
  Object.assign(tokens[2].probeModels[0], { status: 'inconclusive', reason: 'output_limit', error: '已达到本次 8 token 输出上限', httpStatus: 200,
    history: [{ at: at(-minute + 1000), status: 'inconclusive', reason: 'output_limit', error: '已达到本次 8 token 输出上限', httpStatus: 200, latencyMs: 123 }] })
  for (let i = 0; i < 22; i++) tokens[2].probeModels.push({ id: `grok-${i}`, protocol: 'chat', status: 'unknown', history: [] })
  let reads = 0, offline = false, rejectToggle = false, syncFailure = false, rejectRevalidate = false
  let channelSetup = [], addNewChannel = false
  let delayRead = false, releaseRead
  let releaseBatch, releaseStop, rejectStop = false
  const batches = []
  const stops = []
  const requests = []
  await page.route('**/api/**', async route => {
    const { pathname } = new URL(route.request().url())
    if (pathname === '/api/settings') return route.fulfill({ json: { settings: { lowBalanceThreshold: 5 }, balanceNotices: { low: [], unavailable: [] } } })
    requests.push({ pathname, method: route.request().method() })
    if (pathname === '/api/probe-tokens') {
      reads++
      const json = offline ? { error: '暂时无法读取' } : { probeTokens: structuredClone(tokens), policy: { intervalSec: 60 }, channelSetup }
      if (delayRead) {
        delayRead = false
        await new Promise(resolve => { releaseRead = resolve })
      }
      return route.fulfill({ json }).catch(() => {})
    }
    if (pathname === '/api/probe-tokens/a/1') {
      assert.equal(route.request().method(), 'POST')
      if (rejectToggle) return route.fulfill({ status: 400, json: { error: '上游余额不足，无法启动探测。' } })
      tokens[0].probeEnabled = route.request().postDataJSON().enabled
      return route.fulfill({ json: { probeTokens: tokens } })
    }
    if (pathname === '/api/probe-tokens/a/1/models/revalidate') {
      assert.equal(route.request().method(), 'POST')
      if (rejectRevalidate) return route.fulfill({ status: 400, json: { error: '上游余额不足，无法启动探测。' } })
      const model = tokens[0].probeModels.find(item => item.id === route.request().postDataJSON().model)
      assert.ok(model)
      Object.assign(model, { autoPaused: false, revalidatePending: true, status: 'unknown', reason: null, error: null })
      return route.fulfill({ json: { probeTokens: tokens } })
    }
    if (pathname === '/api/probe-tokens/batch-enable') {
      const targets = route.request().postDataJSON().tokens
      batches.push(targets)
      await new Promise(resolve => { releaseBatch = resolve })
      const failures = []
      let enabled = 0
      for (const target of targets) {
        const selected = tokens.find(token => token.channelId === target.channelId && String(token.id) === target.id)
        if (target.id === '2') failures.push({ ...target, name: selected.name, channelName: selected.channelName, error: '上游余额不足，无法启动探测。' })
        else { selected.probeEnabled = true; enabled++ }
      }
      return route.fulfill({ json: { probeTokens: tokens, batch: { enabled, alreadyEnabled: 0, failures } } })
    }
    if (pathname === '/api/probe-tokens/batch-disable') {
      const targets = route.request().postDataJSON().tokens
      stops.push(targets)
      if (rejectStop) return route.fulfill({ status: 503, json: { error: '停止状态保存失败，请重试。' } })
      await new Promise(resolve => { releaseStop = resolve })
      for (const target of targets) tokens.find(token => token.channelId === target.channelId && String(token.id) === target.id).probeEnabled = false
      return route.fulfill({ json: { probeTokens: tokens, batch: { disabled: targets.length, alreadyDisabled: 0, failures: [] } } })
    }
    if (pathname === '/api/upstream-channels') return route.fulfill({ json: { channels: [
      { id: 'a', needsAuthorization: false }, { id: 'b', needsAuthorization: true },
      ...(addNewChannel ? [{ id: 'c', name: '新渠道', needsAuthorization: false }] : []),
    ] } })
    if (pathname === '/api/upstream-channels/a/groups/sync') {
      return route.fulfill({ status: syncFailure ? 503 : 200, json: syncFailure ? { error: '令牌同步失败，请重试。' } : { channels: [] } })
    }
    if (pathname === '/api/upstream-channels/c/groups/sync') {
      tokens.push(token('new', 'c', ['gpt-5.1'], { probeEnabled: false }))
      channelSetup = []
      return route.fulfill({ json: { channels: [{ id: 'c', apiKeys: { status: 'ok' } }] } })
    }
    return route.fulfill({ json: { channels: [], sites: [] } })
  })
  await page.goto(`${server.resolvedUrls.local[0]}#probes`)
  await expect(page.getByRole('heading', { level: 1, name: '探针监控' })).toBeVisible()
  await expect(page.locator('.nav-item').filter({ hasText: '探针监控' })).toHaveCount(1)
  await expect(page.locator('.nav-item').filter({ hasText: /探针令牌|探针记录/ })).toHaveCount(0)
  await expect(page.getByRole('tab', { name: '模型状态' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.pr-panel-head')).toContainText('每个模型每 60 秒探测')
  await expect(page.locator('.pr-model')).toHaveCount(8)
  await expect(page.locator('.pr-category > summary h3')).toHaveText(['Claude Code', 'Codex', 'Grok', 'OpenAI'])
  const claude = page.locator('.pr-category').filter({ has: page.getByRole('heading', { name: 'Claude Code', exact: true }) })
  const grok = page.locator('.pr-category').filter({ has: page.getByRole('heading', { name: 'Grok', exact: true }) })
  await expect(claude).toHaveAttribute('open', '')
  await expect(claude.locator(':scope > summary')).toContainText('1 个模型2 个上游')
  await expect(grok).not.toHaveAttribute('open', '')
  const first = page.locator('.pr-model').first()
  await expect(first.locator('.pr-model-availability')).toHaveText('有可用线路 1/3')
  await first.locator(':scope > summary').click()
  await expect(first).not.toHaveAttribute('open', '')
  const previousStatuses = tokens.map(token => token.probeModels[0].status)
  for (const token of tokens) token.probeModels[0].status = 'error'
  await page.getByRole('button', { name: '刷新记录', exact: true }).click()
  await expect(first.locator('.pr-model-availability')).toHaveText('暂无可用线路')
  await expect(first).not.toHaveAttribute('open', '')
  tokens[2].probeModels[0].status = 'inconclusive'
  await page.getByRole('button', { name: '刷新记录', exact: true }).click()
  await expect(first.locator('.pr-model-availability')).toHaveText('尚无确认可用线路')
  await expect(first.locator('.pr-model-state-details')).toHaveText('探测失败 2 · 响应未确认 1')
  tokens.forEach((token, index) => { token.probeModels[0].status = previousStatuses[index] })
  await page.getByRole('button', { name: '刷新记录', exact: true }).click()
  await expect(first.locator('.pr-model-availability')).toHaveText('有可用线路 1/3')
  await first.locator(':scope > summary').click()
  await expect(first).toHaveAttribute('open', '')
  await expect(first.locator('.pr-channel')).toHaveCount(3)
  await expect(first.locator('.pr-model-count')).toHaveText('2 个上游 · 3 个令牌')
  const channel = first.locator('.pr-channel').first()
  const failedChannel = first.locator('.pr-channel').nth(1)
  await expect(channel.locator('.pr-route-identity h6')).toHaveText('线路 1')
  await expect(failedChannel.locator('.pr-route-identity h6')).toHaveText('线路 2')
  await expect(channel.locator('.pr-token-identity > span')).toHaveText('上游 a · 0.1×')
  await expect(failedChannel.locator('.pr-token-identity > span')).toHaveText('上游 a · 0.1×')
  await expect(channel.locator('.pr-token-identity > span')).toHaveText('上游 a · 0.1×')
  await expect(channel.locator('.pr-recharge')).toHaveText('实际倍率 0.15×')
  await expect(failedChannel.locator('.pr-recharge')).toHaveText('实际倍率 0.35×')
  await expect(first.locator('.pr-channel').nth(2).locator('.pr-recharge')).toHaveText('实际倍率 未获取')
  await expect(channel.locator('.pr-cell')).toHaveCount(60)
  await expect(failedChannel.locator('.pr-cell')).toHaveCount(60)
  await expect(channel.locator('.pr-cell').last()).toHaveClass('pr-cell ok')
  await expect(failedChannel.locator('.pr-cell').last()).toHaveClass('pr-cell error')
  await expect(channel.locator('.pr-current')).toContainText('当前可用')
  await expect(failedChannel.locator('.pr-current')).toContainText('探测失败')
  await expect(channel).toHaveClass(/pr-channel-available/)
  await expect(failedChannel).not.toHaveClass(/pr-channel-available/)
  await expect(channel.locator('.pr-channel-stats').last()).toContainText('成功率 100%')
  await expect(failedChannel.locator('.pr-channel-stats').last()).toContainText('成功率 0%')
  await expect(channel.locator('.pr-channel-stats').last()).toContainText('覆盖 1/60 分钟')
  await channel.locator('.pr-channel-meta button').click()
  await expect(channel.locator('.pr-token-panel li')).toHaveCount(1)
  await expect(channel.locator('.pr-token-rate')).toHaveText('实际倍率 0.15×')
  await expect(channel.locator('.pr-token-panel')).toContainText('用户专属 1.5× ÷ 充值倍率 10× = 0.15×（按 1:1 折算）')
  tokens[0].rechargeRate = tokens[1].rechargeRate = 5
  await page.getByRole('button', { name: '刷新记录', exact: true }).click()
  await expect(channel.locator('.pr-recharge')).toHaveText('实际倍率 0.3×')
  await expect(failedChannel.locator('.pr-recharge')).toHaveText('实际倍率 0.7×')
  await expect(channel.locator('.pr-token-rate')).toHaveText('实际倍率 0.3×')
  await expect(channel.locator('.pr-token-panel')).toBeVisible()
  await claude.locator(':scope > summary').click()
  await expect(channel).not.toBeVisible()
  await page.clock.runFor(5000)
  await expect(claude).not.toHaveAttribute('open', '')
  await claude.locator(':scope > summary').focus()
  await page.keyboard.press('Enter')
  await expect(channel.locator('.pr-token-panel')).toBeVisible()
  await page.getByRole('button', { name: '刷新记录', exact: true }).waitFor()
  await channel.locator('.pr-channel-meta button').click()

  const search = page.getByRole('searchbox')
  await search.fill('gpt-5.1')
  await expect(page.locator('.pr-model')).toHaveCount(1)
  await expect(page.locator('.pr-category > summary h3')).toHaveText(['OpenAI'])
  await expect(page.locator('.pr-model > summary')).toBeVisible()
  await search.fill('Claude Code')
  await expect(page.locator('.pr-category > summary h3')).toHaveText(['Claude Code'])
  await expect(page.locator('.pr-model')).toHaveCount(1)
  await search.fill('#2')
  await expect(first.locator('.pr-channel')).toHaveCount(1)
  await expect(first.locator('.pr-model-availability')).toHaveText('暂无可用线路')
  await expect(first.locator('.pr-token-identity')).toContainText('#2')
  await search.fill('线路 1')
  await expect(first.locator('.pr-channel')).toHaveCount(1)
  await expect(first.locator('.pr-model-availability')).toHaveText('有可用线路 1/1')
  await expect(first.locator('.pr-token-identity')).toContainText('#1')
  await search.fill('b.example.test')
  await expect(page.locator('.pr-model')).toHaveCount(6)
  await search.fill('')
  await page.getByLabel('模型类别', { exact: true }).selectOption('Grok')
  await expect(page.locator('.pr-model')).toHaveCount(5)
  await expect(grok).toHaveAttribute('open', '')
  await page.getByLabel('模型类别', { exact: true }).selectOption('all')
  await page.getByLabel('最近探测状态', { exact: true }).selectOption('error')
  await expect(page.locator('.pr-model')).toHaveCount(1)
  await expect(page.locator('.pr-channel')).toHaveCount(1)
  await expect(page.locator('.pr-channel .pr-token-identity')).toContainText('#2')
  await page.getByLabel('最近探测状态', { exact: true }).selectOption('all')

  const onlyAvailable = page.getByRole('button', { name: '只看可用', exact: true })
  await onlyAvailable.click()
  await expect(onlyAvailable).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByLabel('最近探测状态', { exact: true })).toHaveValue('ok')
  await expect(first.locator('.pr-channel')).toHaveCount(1)
  await expect(first.locator('.pr-route-identity h6')).toHaveText('线路 1')
  await expect(first.locator('.pr-token-identity > span')).toHaveText('上游 a · 0.1×')
  // Even a token with 100% historical success is not usable once disabled.
  tokens[0].probeEnabled = false
  await page.getByRole('button', { name: '刷新记录', exact: true }).click()
  await expect(page.locator('.pr-model > summary h4')).not.toContainText(['claude-sonnet-4-6'])
  tokens[0].probeEnabled = true
  await page.getByRole('button', { name: '刷新记录', exact: true }).click()
  await expect(first.locator('.pr-token-identity > span')).toHaveText('上游 a · 0.1×')
  await onlyAvailable.click()
  await expect(onlyAvailable).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByLabel('最近探测状态', { exact: true })).toHaveValue('all')

  await grok.locator(':scope > summary').click()
  await grok.getByRole('navigation', { name: 'Grok 模型分页' }).getByRole('button', { name: '第 5 页', exact: true }).click()
  const last = grok.locator('.pr-model').last()
  await last.locator('summary').click()
  await expect(last.locator('.pr-channel')).toBeVisible()
  const before = await page.evaluate(() => window.scrollY)
  assert.ok(before > 400)
  const previousReads = reads
  await page.clock.runFor(5000)
  await expect.poll(() => reads).toBeGreaterThan(previousReads)
  await expect(last).toHaveAttribute('open', '')
  await expect(grok).toHaveAttribute('open', '')
  const afterRefresh = await page.evaluate(() => window.scrollY)
  assert.ok(Math.abs(afterRefresh - before) < 4, `scroll changed from ${before} to ${afterRefresh}`)
  await last.locator('.pr-cell').nth(20).click()
  const beforeDialogClose = await page.evaluate(() => window.scrollY)
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('.pr-selected-minute')).toHaveCount(1)
  const position = await dialog.locator('.pr-history-scroll').evaluate(element => element.scrollTop)
  await expect(dialog.locator('tbody tr')).toHaveCount(5)
  await expect(dialog.getByRole('navigation', { name: '分钟历史分页' }).getByRole('button', { name: '第 8 页', exact: true })).toHaveAttribute('aria-current', 'page')
  await page.clock.runFor(5000)
  assert.equal(await dialog.locator('.pr-history-scroll').evaluate(element => element.scrollTop), position)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(last.locator('.pr-cell').nth(20)).toBeFocused()
  assert.ok(Math.abs(await page.evaluate(() => window.scrollY) - beforeDialogClose) < 4)

  await page.evaluate(() => window.scrollTo(0, 0))
  if (!await claude.evaluate(element => element.open)) await claude.locator(':scope > summary').click()
  await first.locator('.pr-cell').nth(59).click()
  await expect(dialog.locator('.pr-token-identity')).toContainText('#1 · 线路 1')
  await expect(dialog.locator('.pr-selected-minute td').nth(3)).toHaveText('2共 2 次')
  await expect(dialog.locator('.pr-selected-minute td').nth(1)).toContainText('探测通过')
  await dialog.locator('.pr-minute-details summary').click()
  await expect(dialog.locator('.pr-minute-entry')).toHaveCount(2)
  await expect(dialog.locator('.pr-entry-reason')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await failedChannel.locator('.pr-cell').last().click()
  await expect(dialog.locator('.pr-token-identity')).toContainText('#2 · 线路 2')
  await expect(dialog.locator('.pr-selected-minute td').nth(3)).toHaveText('0共 1 次')
  await dialog.locator('.pr-minute-details summary').click()
  await expect(dialog.locator('.pr-minute-entry')).toHaveCount(1)
  await expect(dialog.locator('.pr-entry-reason')).toContainText('HTTP 503 · 上游请求失败。')
  await page.keyboard.press('Escape')
  const limitedChannel = first.locator('.pr-channel').nth(2)
  await expect(limitedChannel.locator('.pr-current')).toContainText('输出达到上限')
  await limitedChannel.locator('.pr-cell').last().click()
  await expect(dialog.locator('.pr-selected-minute')).toContainText('输出达到上限')
  await dialog.locator('.pr-minute-details summary').click()
  await expect(dialog.locator('.pr-entry-reason')).toContainText('HTTP 200 · 已达到本次 8 token 输出上限')
  await page.keyboard.press('Escape')

  offline = true
  await page.getByRole('button', { name: '刷新记录', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('已保留上次记录')
  await expect(first).toHaveAttribute('open', '')
  offline = false
  await page.getByRole('button', { name: '刷新记录', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  Object.assign(tokens[0].probeModels[0], { costBlocked: true, costBlockReason: '实际成本 0.3× 高于调度分组 0.1×，暂停探测，倍率恢复后自动继续。' })
  await page.getByRole('button', { name: '刷新记录', exact: true }).click()
  await expect(channel.locator('.pr-current')).toContainText('成本过高 · 已暂停')
  await expect(channel.locator('.pr-state-hint')).toContainText('实际成本 0.3× 高于调度分组 0.1×')
  await expect(channel.locator('.pr-cell')).toHaveCount(60)
  await page.setViewportSize({ width: 320, height: 740 })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  tokens[0].probeModels[0].costBlocked = false; tokens[0].probeModels[0].costBlockReason = null
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('button', { name: '刷新记录', exact: true }).click()
  await expect(channel.locator('.pr-current')).toContainText('当前可用')
  const artifacts = process.env.PROBE_SCREENSHOTS || directory
  mkdirSync(artifacts, { recursive: true })
  await page.screenshot({ path: join(artifacts, 'probe-records-desktop.png') })
  await first.locator('.pr-cell').nth(59).click()
  await page.screenshot({ path: join(artifacts, 'probe-records-history.png') })
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => window.scrollTo(0, 0))
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await page.screenshot({ path: join(artifacts, 'probe-records-mobile.png') })
  await first.locator('.pr-axis button').first().click()
  assert.ok(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth))
  await page.screenshot({ path: join(artifacts, 'probe-records-mobile-history.png') })
  await dialog.getByRole('button', { name: '关闭分钟历史' }).click()
  await page.setViewportSize({ width: 320, height: 740 })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  assert.ok(requests.every(request => request.pathname === '/api/probe-tokens' && request.method === 'GET'))

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.evaluate(() => window.scrollTo(0, 0))
  await search.fill('claude-sonnet-4-6')
  await channel.locator('.pr-channel-meta button').click()
  const inlineSwitch = channel.getByRole('switch', { name: '探测 上游 a · 0.1× #1', exact: true })
  await expect(inlineSwitch).toBeChecked()
  delayRead = true
  await page.clock.runFor(5000)
  await expect.poll(() => Boolean(releaseRead)).toBe(true)
  await inlineSwitch.click()
  await expect(inlineSwitch).not.toBeChecked()
  releaseRead()
  await expect(inlineSwitch).not.toBeChecked()
  assert.equal(tokens[0].probeEnabled, false)
  rejectToggle = true
  await inlineSwitch.click()
  await expect(page.getByRole('alert')).toContainText('上游余额不足')
  await expect(inlineSwitch).not.toBeChecked()
  await page.clock.runFor(5000)
  await expect(page.getByRole('alert')).toContainText('上游余额不足')
  rejectToggle = false
  await inlineSwitch.click()
  await expect(inlineSwitch).toBeChecked()
  await expect(page.getByRole('alert')).toHaveCount(0)

  const tokensTab = page.getByRole('tab', { name: '令牌管理', exact: true })
  const modelsTab = page.getByRole('tab', { name: '模型状态', exact: true })
  await tokensTab.click()
  await expect(tokensTab).toHaveAttribute('aria-selected', 'true')
  assert.equal(new URL(page.url()).hash, '#probe-tokens')
  if (await page.locator('.pm-maintenance details').getAttribute('open') === null) await page.locator('.pm-maintenance summary').click()
  await expect(page.getByRole('button', { name: '同步全部令牌', exact: true })).toBeEnabled()
  await expect(page.locator('.endpoint-group')).toHaveCount(2)
  assert.equal(requests.filter(request => request.pathname.endsWith('/groups/sync')).length, 0)
  const tokenGroup = page.locator('.endpoint-group').first()
  await tokenGroup.locator(':scope > summary').click()
  await expect(tokenGroup.locator('tbody > tr')).toHaveCount(2)
  const managedSwitch = page.getByRole('tabpanel', { name: '令牌管理' }).getByRole('switch', { name: '探测 上游 a · 0.1× #1', exact: true })
  await expect(managedSwitch).toBeChecked()
  await managedSwitch.click()
  await expect(managedSwitch).not.toBeChecked()
  await modelsTab.click()
  await expect(search).toHaveValue('claude-sonnet-4-6')
  await expect(channel.locator('.pr-token-panel')).toBeVisible()
  await expect(inlineSwitch).not.toBeChecked()
  await tokensTab.click()
  await expect(tokenGroup).toHaveAttribute('open', '')
  await expect(managedSwitch).not.toBeChecked()
  assert.equal(requests.filter(request => request.pathname.endsWith('/groups/sync')).length, 0)
  await expect(managedSwitch).toBeEnabled()
  const beforePolling = reads
  await page.clock.runFor(5000)
  await expect.poll(() => reads).toBe(beforePolling + 1)
  await tokenGroup.locator('.probe-models > summary').first().click()
  await expect(tokenGroup.getByRole('button', { name: '刷新模型', exact: true })).toHaveCount(0)
  const managedModels = tokenGroup.locator('.probe-models').first()
  tokens[0].probeModels = []
  await page.clock.runFor(5000)
  await expect(managedModels.locator('summary')).toHaveText('等待自动获取')
  tokens[0].modelsError = '模型列表读取失败'
  tokens[0].modelsNextRefreshAt = at(minute)
  await page.clock.runFor(5000)
  await expect(managedModels.locator('summary')).toHaveText('获取失败，等待重试')
  await expect(managedModels).toContainText('自动重试：')
  tokens[0].modelsError = null
  tokens[0].modelsUpdatedAt = at(0)
  tokens[0].modelsNextRefreshAt = at(10 * minute)
  tokens[0].probeModels = [{ id: 'claude-sonnet-4-6', protocol: 'messages', status: 'unknown', history: [] }]
  await page.clock.runFor(5000)
  await expect(managedModels.locator('summary')).toHaveText('1 个模型')
  await expect(managedModels).toContainText('下次更新：')
  await expect(managedModels).toContainText('待探测')
  await expect(managedModels).toHaveAttribute('open', '')
  await expect(managedSwitch).not.toBeChecked()
  assert.equal(requests.filter(request => request.pathname.endsWith('/models')).length, 0)

  syncFailure = true
  if (await page.locator('.pm-maintenance details').getAttribute('open') === null) await page.locator('.pm-maintenance summary').click()
  await page.getByRole('button', { name: '同步全部令牌', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('令牌同步失败，请重试。')
  await page.clock.runFor(5000)
  await expect(page.getByRole('alert')).toHaveText('令牌同步失败，请重试。')
  syncFailure = false
  if (await page.locator('.pm-maintenance details').getAttribute('open') === null) await page.locator('.pm-maintenance summary').click()
  await page.getByRole('button', { name: '同步全部令牌', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(tokenGroup).toHaveAttribute('open', '')
  await page.screenshot({ path: join(artifacts, 'probe-monitor-tokens-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await page.screenshot({ path: join(artifacts, 'probe-monitor-tokens-mobile.png') })

  await page.reload()
  await expect(tokensTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.nav-item.active')).toHaveText('探针监控')
  if (await page.locator('.pm-maintenance details').getAttribute('open') === null) await page.locator('.pm-maintenance summary').click()
  await expect(page.getByRole('button', { name: '同步全部令牌', exact: true })).toBeEnabled()
  await tokensTab.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(modelsTab).toHaveAttribute('aria-selected', 'true')
  await expect(modelsTab).toBeFocused()
  assert.equal(new URL(page.url()).hash, '#probes')
  await page.goBack()
  await expect(tokensTab).toHaveAttribute('aria-selected', 'true')
  await page.goForward()
  await expect(modelsTab).toHaveAttribute('aria-selected', 'true')
  await page.reload()
  await expect(modelsTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.pr-model[open] > summary h4')).toHaveText('gpt-5.3-codex')
  await expect(page.locator('.pr-category[open]')).toHaveCount(1)
  await page.screenshot({ path: join(artifacts, 'probe-monitor-models-mobile.png') })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.screenshot({ path: join(artifacts, 'probe-monitor-models-desktop.png') })

  for (const token of tokens) token.probeEnabled = false
  tokens[0].probeModels.push({ id: 'claude-opus-4-6', protocol: 'messages', status: 'unknown', history: [] })
  await page.clock.runFor(5000)
  await search.fill('a.example.test')
  await page.getByLabel('模型类别', { exact: true }).selectOption('Claude Code')
  const batchButton = page.getByRole('button', { name: '批量启用检测（2）', exact: true })
  await expect(batchButton).toBeEnabled()
  await batchButton.click()
  await expect(page.getByRole('button', { name: '正在启用…', exact: true })).toBeDisabled()
  await expect.poll(() => batches.length).toBe(1)
  assert.deepEqual(batches[0], [{ channelId: 'a', id: '1' }, { channelId: 'a', id: '2' }])
  await page.clock.runFor(5000)
  assert.equal(batches.length, 1)
  releaseBatch()
  await expect(page.locator('.pr-batch-result')).toContainText('已启用 1 个令牌，1 个未启用')
  await page.locator('.pr-batch-result summary').click()
  await expect(page.locator('.pr-batch-result li')).toContainText('上游余额不足')
  assert.equal(tokens[2].probeEnabled, false, 'Filtered-out upstreams must remain disabled')
  await page.clock.runFor(5000)
  await expect(page.locator('.pr-batch-result')).toContainText('已启用 1 个令牌，1 个未启用')
  await page.screenshot({ path: join(artifacts, 'probe-batch-result-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await page.screenshot({ path: join(artifacts, 'probe-batch-result-mobile.png') })
  await search.fill('no-matching-upstream')
  await expect(page.getByRole('button', { name: '批量启用检测（0）', exact: true })).toBeDisabled()
  assert.ok(requests.every(request => request.pathname === '/api/probe-tokens' || request.pathname === '/api/probe-tokens/a/1'
    || request.pathname === '/api/probe-tokens/batch-enable' || request.pathname === '/api/upstream-channels' || request.pathname === '/api/upstream-channels/a/groups/sync'))
  Object.assign(tokens[0].probeModels[0], { autoPaused: true, revalidatePending: false, status: 'error', reason: 'model_unsupported',
    lastProbeAt: at(-20 * minute), history: [{ at: at(-20 * minute), status: 'error', reason: 'model_unsupported' }] })
  await search.fill('')
  await page.getByLabel('最近探测状态', { exact: true }).selectOption('excluded')
  await page.getByRole('button', { name: '刷新记录', exact: true }).click()
  await expect(page.locator('.pr-model')).toHaveCount(1)
  await expect(page.locator('.pr-model-availability')).toHaveText('暂无可用线路')
  if (await page.locator('.pr-model').getAttribute('open') === null) await page.locator('.pr-model > summary').click()
  await expect(page.locator('.pr-status.excluded')).toContainText('模型已隔离')
  await expect(page.locator('.pr-model-paused')).toContainText('历史记录保留')
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await page.screenshot({ path: join(artifacts, 'probe-paused-mobile.png') })
  const retry = page.getByRole('button', { name: /^重新验证/ })
  rejectRevalidate = true
  await retry.click()
  await expect(page.getByRole('alert')).toContainText('上游余额不足')
  await expect(retry).toBeEnabled()
  rejectRevalidate = false
  await retry.click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  assert.equal(tokens[0].probeModels[0].revalidatePending, true)
  assert.equal(tokens[0].probeModels[0].history.length, 1)
  await page.getByLabel('最近探测状态', { exact: true }).selectOption('all')
  const pendingFold = page.locator('.pr-folded-lines').first()
  if (await pendingFold.count() && await pendingFold.getAttribute('open') === null) await pendingFold.locator(':scope > summary').click()
  await expect(page.locator('.pr-model-paused').first()).toContainText('等待重新验证')
  await tokensTab.click()
  await tokenGroup.locator(':scope > summary').click()
  await tokenGroup.locator('.probe-models > summary').first().click()
  Object.assign(tokens[0].probeModels[0], { autoPaused: true, revalidatePending: false })
  tokens[0].probeEnabled = false
  await page.clock.runFor(5000)
  await expect(retry).toBeDisabled()
  await managedSwitch.click()
  await expect(retry).toBeEnabled()
  await retry.click()
  await expect(managedModels).toContainText('等待重新验证')
  assert.equal(requests.filter(request => request.pathname.endsWith('/models/revalidate')).length, 3)
  addNewChannel = true; syncFailure = true
  channelSetup = [{ channelId: 'c', name: '新渠道', status: 'syncing', detail: '正在自动同步上游 API 令牌。' }]
  await page.clock.runFor(5000)
  await expect(page.getByRole('region', { name: '渠道接入状态' })).toContainText('新渠道')
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await page.screenshot({ path: join(artifacts, 'probe-channel-setup-mobile.png') })
  if (await page.locator('.pm-maintenance details').getAttribute('open') === null) await page.locator('.pm-maintenance summary').click()
  await page.getByRole('button', { name: '同步全部令牌', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('令牌同步失败')
  await expect.poll(() => requests.some(request => request.pathname === '/api/upstream-channels/c/groups/sync')).toBe(true)
  await expect(page.locator('.endpoint-group')).toHaveCount(3)
  await expect(page.getByRole('region', { name: '渠道接入状态' })).toHaveCount(0)
  const newGroup = page.locator('.endpoint-group').filter({ hasText: 'https://c.example.test' })
  await newGroup.locator(':scope > summary').click()
  await expect(newGroup.getByRole('switch')).toBeEnabled()
  await expect(newGroup.getByRole('switch')).not.toBeChecked()
  // Stop by channel name in both tabs, including tokens awaiting model discovery.
  tokens.push({ ...token('catalog-pending', 'a', []), channelName: tokens[0].channelName })
  for (const item of tokens) item.probeEnabled = true
  await page.clock.runFor(5000)
  const histories = tokens.map(item => structuredClone(item.probeModels))
  await modelsTab.click()
  await page.getByLabel('模型类别', { exact: true }).selectOption('all')
  await search.fill('福利组')
  const stop = page.getByRole('button', { name: '批量停止（3）', exact: true })
  await expect(stop).toBeEnabled()
  rejectStop = true
  await stop.click()
  await expect(page.getByRole('alert').filter({ hasText: '停止状态保存失败' })).toBeVisible()
  assert.ok(tokens.every(item => item.probeEnabled))
  rejectStop = false
  await stop.click()
  await expect(page.getByRole('button', { name: '正在停止…', exact: true })).toBeDisabled()
  await expect.poll(() => stops.length).toBe(2)
  assert.deepEqual(stops[1].map(item => item.id).sort(), ['1', '2', 'catalog-pending'])
  assert.ok(stops[1].every(item => item.channelId === 'a'))
  await page.clock.runFor(5000)
  assert.equal(stops.length, 2)
  releaseStop()
  await expect(page.locator('.pr-batch-result')).toContainText('已停止 3 个令牌')
  await expect(page.getByRole('button', { name: '批量停止（0）', exact: true })).toBeDisabled()
  assert.ok(tokens.filter(item => item.channelId !== 'a').every(item => item.probeEnabled))
  assert.deepEqual(tokens.map(item => item.probeModels), histories)
  await page.reload()
  await search.fill('福利组')
  await expect(page.getByRole('button', { name: '批量停止（0）', exact: true })).toBeDisabled()
  await tokensTab.click()
  const tokenSearch = page.getByRole('searchbox', { name: '搜索令牌渠道、名称或 Endpoint' })
  await tokenSearch.fill(tokens[2].channelName)
  await expect(page.locator('#pm-tokens-panel .endpoint-group')).toHaveCount(1)
  await expect(page.getByRole('button', { name: '批量停止（1）', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '批量停止（1）', exact: true }).click()
  await expect.poll(() => stops.length).toBe(3)
  assert.deepEqual(stops[2], [{ channelId: 'b', id: String(tokens[2].id) }])
  releaseStop()
  await expect(page.locator('.pr-batch-result')).toContainText('已停止 1 个令牌')
  assert.ok(tokens.find(item => item.channelId === 'c').probeEnabled)
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await page.screenshot({ path: join(artifacts, 'probe-batch-stop-mobile.png') })
  await tokenSearch.fill('no-matching-channel')
  await expect(page.getByRole('button', { name: '批量停止（0）', exact: true })).toBeDisabled()
  await expect(page.getByText('没有匹配的令牌，请调整渠道名称或搜索条件。')).toBeVisible()
  // Fold each failing pair independently; restore it only after real success arrives in polling.
  const liveTime = await page.evaluate(() => Date.now())
  const failureHistory = Array.from({ length: 5 }, (_, index) => ({ at: new Date(liveTime - (5 - index) * minute).toISOString(), status: 'error', reason: 'timeout', error: '探测超时' }))
  const failing = token(1, 'a', ['claude-sonnet-4-6'])
  Object.assign(failing.probeModels[0], { status: 'error', reason: 'timeout', error: '探测超时', lastProbeAt: new Date(liveTime).toISOString(), history: failureHistory })
  const working = token(2, 'a', ['claude-sonnet-4-6'])
  working.probeModels[0].lastProbeAt = new Date(liveTime).toISOString()
  const excluded = token(3, 'b', ['claude-only-failed'])
  Object.assign(excluded.probeModels[0], { autoPaused: true, status: 'error', reason: 'model_unsupported', error: '上游不支持此模型', lastProbeAt: new Date(liveTime).toISOString(),
    history: [{ at: new Date(liveTime - minute).toISOString(), status: 'error', reason: 'model_unsupported' }] })
  tokens.splice(0, tokens.length, failing, working, excluded)
  channelSetup = []
  await modelsTab.click()
  await page.reload()
  const sharedModel = page.locator('.pr-model').filter({ has: page.getByRole('heading', { name: 'claude-sonnet-4-6', exact: true }) })
  const failingRow = sharedModel.getByRole('article', { name: /#1$/ })
  await expect(sharedModel).toHaveAttribute('open', '')
  await expect(sharedModel.locator('.pr-channel').first().locator('.pr-token-identity > span')).toHaveText('上游 a · 0.1×')
  await expect(sharedModel.locator('.pr-folded-lines')).not.toHaveAttribute('open', '')
  await expect(failingRow).not.toBeVisible()
  const archived = page.locator('.pr-folded-models')
  await expect(archived).not.toHaveAttribute('open', '')
  await expect(archived.locator('.pr-model')).toHaveCount(0, { timeout: 1000 })
  await archived.locator(':scope > summary').click()
  await expect(archived).toContainText('claude-only-failed')
  await sharedModel.locator('.pr-folded-lines > summary').click()
  await expect(failingRow).toBeVisible()
  await expect(failingRow.locator('.pr-issue-reason')).toContainText('探测超时')
  await page.clock.runFor(5000)
  await expect(sharedModel.locator('.pr-folded-lines')).toHaveAttribute('open', '')
  await failingRow.getByRole('button', { name: /^重新验证/ }).click()
  await expect(failingRow.getByRole('button', { name: /^重新验证/ })).toBeDisabled()
  await expect(sharedModel.locator('.pr-folded-lines .pr-model-paused')).toContainText('等待重新验证')
  await page.screenshot({ path: join(artifacts, 'probe-folded-mobile.png') })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.screenshot({ path: join(artifacts, 'probe-folded-desktop.png') })
  Object.assign(failing.probeModels[0], { revalidatePending: false, status: 'inconclusive' })
  failing.probeModels[0].history.push({ status: 'inconclusive', at: new Date(liveTime + 5000).toISOString() })
  await page.clock.runFor(5000)
  await expect(sharedModel.locator('.pr-folded-lines')).toContainText('上游 a · 0.1×')
  for (const model of [failing.probeModels[0], excluded.probeModels[0]]) {
    Object.assign(model, { revalidatePending: false, autoPaused: false, status: 'ok', reason: null, error: null, lastProbeAt: new Date(liveTime + 10000).toISOString() })
    model.history.push({ status: 'ok', at: new Date(liveTime + 10000).toISOString() })
  }
  await page.clock.runFor(5000)
  await expect(sharedModel.locator('.pr-folded-lines')).toHaveCount(0)
  await expect(failingRow).toBeVisible()
  await expect(failingRow.locator('.pr-current')).toContainText('当前可用')
  await expect(archived).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'claude-only-failed', exact: true })).toBeVisible()
  assert.equal(failing.probeModels[0].history.length, 7, 'Recovery retains all previous failures and uncertain results')
  // A shared model can have hundreds of upstreams. Paginate timelines,
  // while search and bulk actions must still include every matching token.
  const scaleTime = await page.evaluate(() => Date.now())
  tokens.splice(0, tokens.length, ...Array.from({ length: 120 }, (_, index) => {
    const item = token(index, `scale-${index}`, ['claude-scale'])
    item.probeModels[0].lastProbeAt = new Date(scaleTime).toISOString()
    return item
  }))
  await page.reload()
  await expect(page.locator('.pr-channel')).toHaveCount(5)
  await expect(page.getByRole('button', { name: '批量停止（120）', exact: true })).toBeEnabled()
  await page.getByRole('navigation', { name: '模型令牌线路分页' }).getByRole('button', { name: '下一页', exact: true }).click()
  await expect(page.locator('.pr-channel')).toHaveCount(5)
  await search.fill('上游 scale-119')
  await expect(page.locator('.pr-channel')).toHaveCount(1)
  await expect(page.locator('.pr-channel h5')).toHaveText('上游 scale-119')
  // Precise state filters and hints also work on mobile, including mixed failures.
  const stateTime = await page.evaluate(() => Date.now())
  const stateToken = (id, change = {}, modelChange = {}) => {
    const item = token(id, 'state', ['claude-states'], change)
    Object.assign(item.probeModels[0], { lastProbeAt: new Date(stateTime).toISOString(), ...modelChange })
    return item
  }
  tokens.splice(0, tokens.length,
    stateToken(1), stateToken(2, { probeEnabled: false }), stateToken(3, {}, { lastProbeAt: null }),
    stateToken(4, {}, { revalidatePending: true }), stateToken(5, {}, { lastProbeAt: new Date(stateTime - 3 * minute).toISOString() }),
    stateToken(6, {}, { status: 'inconclusive' }), stateToken(7, { modelsError: '模型列表同步失败', probeBlockReason: 'models' }),
    stateToken(8, { probeBlockReason: 'balance' }), stateToken(9, { probePaused: true }),
    stateToken(10, {}, { protocol: 'unsupported' }), stateToken(11, {}, { status: 'error' }))
  await page.reload()
  await expect(page.locator('.pr-model-availability')).toHaveText('有可用线路 1/11')
  await expect(page.locator('.pr-model-state-details')).toContainText('探测失败 1')
  await expect(page.locator('.pr-model-state-details')).toContainText('探测未启用 1')
  await page.setViewportSize({ width: 390, height: 844 })
  for (const [state, label, hint] of [
    ['disabled', '探测未启用', '关闭期间不会自动验证'], ['unprobed', '等待首次检测', '尚未取得首次调用结果'],
    ['revalidating', '等待重新验证', '等待下一次探测结果'], ['stale', '结果已过期', '最近结果已超过有效期'],
    ['models_error', '模型同步失败', '后台会自动重试'], ['balance_blocked', '余额不足 · 已暂停', '请充值后刷新渠道余额'],
    ['paused', '令牌待同步', '必要时重新授权'], ['unsupported', '暂不支持探测', '暂不支持此模型的接口类型'],
    ['inconclusive', '响应未确认', '未取得有效输出'],
  ]) {
    await page.getByLabel('最近探测状态', { exact: true }).selectOption(state)
    await expect(page.locator('.pr-model-availability')).toHaveText(`${label} 1`)
    await expect(page.locator('.pr-channel')).toHaveCount(1)
    await expect(page.locator('.pr-state-hint')).toContainText(hint)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  }
  await page.getByLabel('最近探测状态', { exact: true }).selectOption('all')
  await page.screenshot({ path: join(artifacts, 'probe-specific-states-mobile.png') })
  // Expected API failures are handled in the UI; Chromium also reports their HTTP status to the console.
  const unexpectedErrors = errors.filter(message => !/Failed to load resource: the server responded with a status of (400|503)/.test(message))
  assert.deepEqual(unexpectedErrors, [])
})
