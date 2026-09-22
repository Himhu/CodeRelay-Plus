import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, request } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createQQBotStore } from './site-store.js'
import { monitorAPI } from './monitor-api.js'
import { applyQQInput, createQQBot, ed25519PublicKey, qqIncidents, signText, verifyQQSignature } from './qq-bot.js'

const secret = 'DG5g3B4j9X2KOErG'
const validationSecret = 'naOC0ocQE3shWLAfffVLB1rhYPG7'
const now = 1725442341000

test('QQ signatures match the published Ed25519 vectors', () => {
  assert.deepEqual([...ed25519PublicKey(validationSecret)], [215, 195, 98, 254, 120, 174, 248, 31, 242, 50, 135, 180, 147, 98, 139, 93, 176, 42, 60, 79, 227, 11, 33, 94, 77, 25, 96, 155, 93, 118, 103, 58])
  assert.equal(signText(secret, '1725442341Arq0D5A61EgUu4OxUvOp'), '87befc99c42c651b3aac0278e71ada338433ae26fcb24307bdc5ad38c1adc2d01bcfcadc0842edac85e85205028a1132afe09280305f13aa6909ffc2d652c706')
  const body = Buffer.from('{ "op": 0,"d": {}, "t": "GATEWAY_EVENT_NAME"}')
  const signature = signText(validationSecret, '1725442341' + body.toString())
  assert.equal(verifyQQSignature(validationSecret, '1725442341', body, signature, now), true)
  assert.equal(verifyQQSignature(validationSecret, '1725442000', body, signature, now), false)
  assert.equal(verifyQQSignature(validationSecret, '1725442341', body, 'ab'.repeat(64), now), false)
})

test('alerts cover low balance, a paused route and a fully failed probe, once each', async () => {
  const at = new Date(now).toISOString()
  const channel = { id: 'up', name: '上游 A', rechargeRate: 1, balance: { amount: 1.2, currency: 'USD', status: 'ok', updatedAt: at },
    probeTokens: [{ id: '1', probeEnabled: true, key: 'sk-test', status: 'active', probeModels: [
      { id: 'a', protocol: 'chat', status: 'error', lastProbeAt: at }, { id: 'b', protocol: 'chat', status: 'error', lastProbeAt: at }] }] }
  const sites = [{ id: 'site', name: '调度', accounts: [{ id: 7, name: '线路甲' }], automation: { accounts: {
    7: { pausedBySystem: true, pauseReason: 'error', reason: '暂停整条线路' },
    8: { pausedBySystem: true, pauseReason: 'standby', reason: '待命' },
  } } }]
  const found = qqIncidents({ channels: [channel], sites, threshold: 5, now })
  assert.deepEqual(found.map(item => item.key), ['balance:up', 'route:site:7', 'probe:up'])
  const calls = []
  const bot = createQQBot({ store: { load: () => [{ id: 'config', appId: '11111111', secret, enabled: true, groupOpenId: 'B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5', open: {} }], save(records) { this.saved = records } },
    now: () => now, incidents: () => found, fetch: async (url, init) => {
      calls.push(String(url))
      if (String(url).includes('/messages')) assert.equal(String(init.body).includes(secret), false)
      return { ok: true, status: 200, json: async () => (String(url).includes('getAppAccessToken') ? { access_token: 'qq-token', expires_in: '7200' } : { id: 'msg' }) }
    } })
  await bot.scan()
  await bot.scan()
  assert.deepEqual(calls, ['https://api.bot.qq.com/app/getAppAccessToken', 'https://api.bot.qq.com/v2/groups/B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5/messages', 'https://api.bot.qq.com/v2/groups/B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5/messages', 'https://api.bot.qq.com/v2/groups/B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5/messages'])
  assert.equal(JSON.stringify(bot.view()).includes(secret), false)
})

test('webhook validates the callback, stores one group and never returns the secret', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-qq-'))
  const store = createQQBotStore(directory)
  const api = monitorAPI({ publicOrigin: 'https://monitor.example', qqStore: store, now: () => now })
  const server = createServer((req, res) => api(req, res, () => { res.writeHead(404); res.end() }))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }) })
  const call = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers: { Host: 'monitor.example', ...headers } }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
  const headers = { Origin: 'https://monitor.example', 'Content-Type': 'application/json' }
  const saved = await call('/api/qq-bot', { method: 'POST', headers, body: JSON.stringify({ appId: '11111111', secret, enabled: true }) })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.qq.hasSecret, true)
  assert.equal(saved.body.qq.webhookUrl, 'https://monitor.example/api/qq/webhook')
  assert.equal(JSON.stringify(saved.body).includes(secret), false)
  assert.equal(store.load()[0].secret, secret)
  const plain = Buffer.from('{"d":{"plain_token":"Arq0D5A61EgUu4OxUvOp","event_ts":"1725442341"},"op":13}')
  const check = await call('/api/qq/webhook', { method: 'POST', headers: { ...headers, 'User-Agent': 'QQBot-Callback', 'X-Bot-Appid': '11111111' }, body: plain })
  assert.deepEqual(check.body, { plain_token: 'Arq0D5A61EgUu4OxUvOp', signature: signText(secret, '1725442341Arq0D5A61EgUu4OxUvOp') })
  const event = Buffer.from('{"op":0,"t":"GROUP_AT_MESSAGE_CREATE","d":{"group_openid":"B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5","content":"hi"}}')
  const ts = '1725442341'
  const signed = await call('/api/qq/webhook', { method: 'POST', headers: { ...headers, 'User-Agent': 'QQBot-Callback', 'X-Signature-Timestamp': ts, 'X-Signature-Ed25519': signText(secret, ts + event.toString()) }, body: event })
  assert.deepEqual(signed.body, { op: 12 })
  assert.equal((await call('/api/qq-bot')).body.qq.groupOpenId, 'B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5')
  const forged = await call('/api/qq/webhook', { method: 'POST', headers: { ...headers, 'User-Agent': 'QQBot-Callback', 'X-Signature-Timestamp': ts, 'X-Signature-Ed25519': 'a'.repeat(128) }, body: event })
  assert.equal(forged.status, 401)
  const changed = applyQQInput(store.load()[0], { appId: '22222222', secret: 'anothersecret', enabled: true })
  assert.equal(changed.groupOpenId, '')
  assert.equal(changed.secret, 'anothersecret')
})
