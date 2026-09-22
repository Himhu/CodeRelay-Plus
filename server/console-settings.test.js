import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { balanceNotices } from './console-settings.js'
import { channelBalanceView, newAPIBalance, saveBalance } from './channel-balance.js'
import { createConsoleSettingsStore } from './site-store.js'
import { monitorAPI } from './monitor-api.js'

test('notices use unrounded actual USD, preserve zero/debt and distinguish stale or unconvertible balances', () => {
  const now = Date.now()
  const channel = (id, amount, extra = {}) => ({ id, name: id, rechargeRate: 1,
    balance: { amount, currency: 'USD', status: 'ok', updatedAt: new Date(now).toISOString(), ...extra } })
  const converted = { id: 'CNY', name: '人民币站', rechargeRate: 10 }
  saveBalance(converted, newAPIBalance({ quota: 20000000 }, { quota_per_unit: 500000, quota_display_type: 'CNY', usd_exchange_rate: 7.2 }), now)
  assert.equal(channelBalanceView(converted).amount, 28.8)
  assert.equal(channelBalanceView(converted).usdAmount, 4)
  const custom = { id: 'custom', name: '积分站', rechargeRate: 2 }
  saveBalance(custom, newAPIBalance({ quota: 500000 }, { quota_per_unit: 500000, quota_display_type: 'CUSTOM', custom_currency_symbol: '积分', custom_currency_exchange_rate: 100 }), now)
  const channels = [channel('equal', 5), channel('above', 5.000001), channel('zero', 0), channel('debt', -0.01),
    { ...channel('recharge', 40), rechargeRate: 10 }, converted, custom,
    channel('old', 2, { updatedAt: new Date(now - 900001).toISOString() }),
    channel('failed', 3, { status: 'error' }), channel('unknown', null),
    channel('quota', 1, { currency: 'QUOTA' }), channel('legacy-cny', 2, { currency: 'CNY' })]
  const notices = balanceNotices(channels, 5, now)
  assert.deepEqual(new Set(notices.low.map(item => item.id)), new Set(['equal', 'zero', 'debt', 'recharge', 'CNY', 'custom', 'old', 'failed']))
  assert.deepEqual(notices.low.slice(0, 2).map(item => item.id), ['debt', 'zero'])
  assert.match(notices.low.find(item => item.id === 'old').problem, /15 分钟/)
  assert.match(notices.low.find(item => item.id === 'failed').problem, /未成功/)
  assert.deepEqual(notices.unavailable.map(item => item.id), ['unknown', 'quota', 'legacy-cny'])
  assert.deepEqual(balanceNotices(channels, 0, now).low.map(item => item.id), ['debt', 'zero'])
  converted.rechargeRate = 20
  assert.equal(channelBalanceView(converted).usdAmount, 2, 'Edits recompute from raw USD instead of dividing twice')
})

test('threshold APIs validate writes, persist across restart and retain the previous value on disk failure', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-settings-'))
  const disk = createConsoleSettingsStore(directory)
  let fail = false
  const store = { load: () => disk.load(), save: records => { if (fail) throw new Error('private-disk-path'); disk.save(records) } }
  const channel = { id: 'a', name: '上游 A', provider: 'newapi', endpoint: 'https://upstream.example.test', token: 'private-token',
    balance: { amount: 4, currency: 'USD', status: 'ok', updatedAt: new Date().toISOString() } }
  const createAPI = () => monitorAPI({ settingsStore: store, channelStore: { load: () => [channel] } })
  let api = createAPI()
  const server = createServer((req, res) => api(req, res, () => { res.writeHead(404); res.end() }))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }) })
  const base = `http://127.0.0.1:${server.address().port}`
  const get = async () => (await fetch(base + '/api/settings')).json()
  const post = async (value, origin = base) => {
    const response = await fetch(base + '/api/settings', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ lowBalanceThreshold: value }) })
    return { status: response.status, body: await response.json() }
  }
  assert.equal((await get()).settings.lowBalanceThreshold, 5)
  assert.equal((await get()).balanceNotices.low.length, 1)
  const notice = (await get()).balanceNotices.low[0]
  assert.equal(notice.endpoint, channel.endpoint)
  assert.equal(notice.provider, 'newapi')
  assert.equal(notice.needsAuthorization, false)
  assert.ok(!JSON.stringify(notice).includes('private-token'))
  for (const value of [-1, null, '5', true, 0.001, 0.000000001, 1000001]) assert.equal((await post(value)).status, 400)
  assert.equal((await post(2, 'https://foreign.example')).status, 403)
  assert.equal((await post(2.55)).status, 200)
  assert.equal((await get()).balanceNotices.low.length, 0)
  assert.equal(disk.load()[0].lowBalanceThreshold, 2.55)
  api = createAPI()
  assert.equal((await get()).settings.lowBalanceThreshold, 2.55)
  fail = true
  const failed = await post(10)
  assert.equal(failed.status, 500)
  assert.match(failed.body.error, /原阈值未改变/)
  assert.equal((await get()).settings.lowBalanceThreshold, 2.55)
  assert.equal(disk.load()[0].lowBalanceThreshold, 2.55)
  assert.ok(!JSON.stringify(await get()).includes('private'))
  fail = false
  assert.equal((await post(0)).status, 200)
  channel.balance.amount = 0
  assert.equal((await get()).balanceNotices.low.length, 1, 'Reads reflect the balance cache without querying upstreams')
})
