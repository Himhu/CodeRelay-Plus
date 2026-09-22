import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { monitorAPI } from './monitor-api.js'
import { createChannelStore } from './site-store.js'

test('Sub2API sessions use normal CAPTCHA validation, rotate durably, recover and respect revocation', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-auth-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const disk = createChannelStore(directory)
  let failSave = false, now = Date.now(), version = 0, logins = 0, refreshes = 0, checks = 0
  let loginFailure, profileFailure = '', refreshFailure = '', holdProfile, profileStarted, requireSaved = false
  const usedProofs = new Set()
  const store = { load: () => disk.load(), save: records => {
    if (failSave) throw new Error('private-storage-secret')
    disk.save(records)
  } }
  const tokens = () => ({ access_token: `access-secret-${version}`, refresh_token: `refresh-secret-${version}`, expires_in: 120 })
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
    assert.equal(req.headers['user-agent'], 'Signal-Monitor/0.1')
    if (req.url.startsWith('/api/v1/keys?')) return send(200, { code: 0, data: { items: [], total: 0, page: 1, page_size: 100 } })
    if (req.url === '/api/v1/groups/available') return send(200, { code: 0, data: [] })
    if (req.url === '/api/v1/groups/rates') return send(200, { code: 0, data: {} })
    if (req.url === '/api/v1/auth/login') {
      logins++
      assert.equal(req.method, 'POST')
      assert.equal(body.email, 'ordinary@example.test')
      assert.equal(body.password, 'password-secret')
      assert.equal(req.headers.authorization, undefined)
      if (loginFailure) return send(loginFailure.status, loginFailure.payload)
      if (!body.turnstile_token || usedProofs.has(body.turnstile_token)) return send(400, { code: 'CAPTCHA_INVALID', message: 'proof-secret' })
      usedProofs.add(body.turnstile_token)
      return send(200, { code: 0, data: { requires_2fa: true, temp_token: 'temporary-secret' } })
    }
    if (req.url === '/api/v1/auth/login/2fa') {
      assert.deepEqual(body, { temp_token: 'temporary-secret', totp_code: '123456' })
      version++
      return send(200, { code: 0, data: tokens() })
    }
    if (req.url === '/api/v1/auth/refresh') {
      refreshes++
      assert.equal(req.method, 'POST')
      assert.deepEqual(body, { refresh_token: `refresh-secret-${version}` })
      assert.equal(req.headers.authorization, undefined)
      if (refreshFailure) return send(refreshFailure === 'temporary' ? 503 : 401, { code: refreshFailure === 'temporary' ? 503 : 'REFRESH_TOKEN_EXPIRED' })
      version++
      return send(200, { code: 0, data: tokens() })
    }
    assert.equal(req.url, '/api/v1/auth/me')
    assert.equal(req.method, 'GET')
    assert.equal(body, null)
    checks++
    assert.equal(req.headers.authorization, `Bearer access-secret-${version}`)
    if (requireSaved) assert.equal(disk.load()[0].token, `access-secret-${version}`, 'New tokens must reach disk before profile lookup')
    if (holdProfile) { profileStarted(); await holdProfile }
    if (profileFailure === 'expired-once') { profileFailure = ''; return send(401, { code: 'ACCESS_TOKEN_EXPIRED' }) }
    if (profileFailure === 'revoked') return send(401, { code: 'TOKEN_REVOKED' })
    if (profileFailure === 'policy') return send(403, { error: { type: 'probe_blocked', message: 'private-upstream-secret' } })
    if (profileFailure === 'temporary') return send(503, { code: 503, message: 'private-upstream-secret' })
    if (profileFailure === 'malformed') return send(200, { code: 0, data: {} })
    return send(200, { code: 0, data: { id: 7, email: 'ordinary@example.test', role: 'user' } })
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  t.after(() => upstream.close())
  let middleware = monitorAPI({ channelStore: store, now: () => now })
  t.after(() => middleware.auth.stop())
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end() }))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  const list = async () => (await (await fetch(`${base}/api/upstream-channels`)).json()).channels
  const post = async (path, body, origin = base) => {
    const response = await fetch(base + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, ...await response.json() }
  }
  const input = { name: 'Authenticated Sub2API', provider: 'sub2api', endpoint: `http://127.0.0.1:${upstream.address().port}/api/v1/`,
    email: 'ordinary@example.test', password: 'password-secret', totpCode: '123456' }
  const add = body => post('/api/upstream-channels', body)
  for (const [status, payload, message] of [
    [403, { error: { type: 'probe_blocked', message: 'private-upstream-secret' } }, /禁止探针.*probe_blocked/],
    [403, { error: { type: 'forbidden', message: 'private-upstream-secret' } }, /上游登录失败/],
    [403, { error: { code: 'CAPTCHA_INVALID', message: 'private-upstream-secret' } }, /人机验证/],
    [401, { code: 401, message: 'private-upstream-secret' }, /邮箱、密码/],
    [404, { code: 404, message: 'private-upstream-secret' }, /用户登录接口/],
  ]) {
    loginFailure = { status, payload }
    const rejected = await add(input)
    assert.equal(rejected.status, status === 404 ? 502 : status)
    assert.match(rejected.error, message)
    assert.doesNotMatch(rejected.error, /分组|private-upstream-secret/)
    assert.deepEqual(await list(), [])
    assert.deepEqual(disk.load(), [])
  }
  loginFailure = null
  assert.match((await add(input)).error, /人机验证/)
  for (const turnstileToken of [{ bad: true }, 'x'.repeat(2049)]) assert.equal((await add({ ...input, turnstileToken })).status, 400)
  const added = await add({ ...input, turnstileToken: 'proof-secret-1' })
  assert.equal(added.status, 200)
  assert.equal(added.channels[0].auth.status, 'authorized')
  assert.equal(added.channels[0].auth.autoRefresh, true)
  const id = added.channels[0].id
  const checkPath = `/api/upstream-channels/${id}/auth/check`
  const check = () => post(checkPath, {})
  const reauthorize = proof => add({ ...input, id, turnstileToken: proof })
  assert.equal((await post(checkPath, {}, 'https://foreign.example')).status, 403)
  assert.equal((await reauthorize('proof-secret-1')).status, 502)
  assert.equal((await list()).length, 1)
  assert.equal(disk.load()[0].token, 'access-secret-1')
  for (const secret of ['password-secret', 'proof-secret', 'temporary-secret', '123456']) assert.ok(!JSON.stringify(disk.load()).includes(secret))
  assert.ok(!JSON.stringify(added).includes('access-secret'))
  requireSaved = true
  await middleware.auth.runDue()
  assert.equal(checks, 1)
  assert.equal(refreshes, 0)
  now += 70000
  await middleware.auth.runDue()
  assert.equal(refreshes, 1)
  assert.equal(checks, 2)
  assert.equal(disk.load()[0].token, 'access-secret-2')
  assert.ok(disk.load()[0].authRefreshedAt)
  profileFailure = 'expired-once'
  assert.equal((await check()).channels[0].auth.status, 'authorized')
  assert.equal(refreshes, 2)

  profileFailure = 'temporary'
  const temporary = await check()
  assert.equal(temporary.channels[0].auth.status, 'error')
  assert.equal(temporary.channels[0].needsAuthorization, false)
  const failedChecks = checks
  now += 29000
  await middleware.auth.runDue()
  assert.equal(checks, failedChecks, 'Transient failures must back off')
  now += 2000
  profileFailure = ''
  await middleware.auth.runDue()
  assert.equal((await list())[0].auth.status, 'authorized')
  profileFailure = 'malformed'
  assert.equal((await check()).channels[0].auth.status, 'error')
  profileFailure = ''

  profileFailure = 'policy'
  const savedSession = disk.load()[0]
  const policyFailure = (await check()).channels[0]
  assert.equal(policyFailure.auth.status, 'error')
  assert.equal(policyFailure.needsAuthorization, false)
  assert.match(policyFailure.auth.error, /禁止探针.*probe_blocked/)
  assert.equal(policyFailure.balance.status, 'error')
  assert.match(policyFailure.balance.error, /禁止探针.*probe_blocked/)
  assert.equal(disk.load()[0].token, savedSession.token)
  assert.equal(disk.load()[0].refreshToken, savedSession.refreshToken)
  assert.ok(!JSON.stringify(policyFailure).includes('private-upstream-secret'))
  profileFailure = ''

  let releaseProfile
  holdProfile = new Promise(resolve => { releaseProfile = resolve })
  const started = new Promise(resolve => { profileStarted = resolve })
  const checking = check()
  await started
  const queued = check()
  const edited = add({ ...input, id: (await list())[0].id, edit: true, password: '' })
  try {
    await middleware.auth.runDue()
  } finally { releaseProfile(); holdProfile = null }
  assert.equal((await checking).channels[0].auth.status, 'authorized')
  assert.equal((await queued).status, 200)
  assert.equal((await edited).status, 200)

  now += 70000
  failSave = true
  const oldRefreshes = refreshes
  const writeFailure = await check()
  assert.equal(writeFailure.channels[0].auth.status, 'storage-error')
  assert.equal(refreshes, oldRefreshes + 1)
  assert.notEqual(disk.load()[0].token, `access-secret-${version}`)
  const beforeBlockedCheck = checks
  assert.equal((await check()).channels[0].auth.status, 'storage-error')
  assert.equal(refreshes, oldRefreshes + 1)
  assert.equal(checks, beforeBlockedCheck, 'Unsaved rotation must pause network requests')
  failSave = false
  assert.equal((await check()).channels[0].auth.status, 'authorized')
  assert.equal(refreshes, oldRefreshes + 1, 'Recovery must persist the new token, not rotate again')
  assert.equal(disk.load()[0].token, `access-secret-${version}`)

  profileFailure = 'revoked'
  const beforeRevocation = refreshes
  const revoked = await check()
  assert.equal(revoked.channels[0].auth.status, 'expired')
  assert.equal(revoked.channels[0].needsAuthorization, true)
  assert.equal(disk.load()[0].refreshToken, undefined)
  assert.equal(refreshes, beforeRevocation, 'Do not try to renew a revoked session')
  now += 86400000
  await middleware.auth.runDue()
  assert.equal(refreshes, beforeRevocation)
  profileFailure = ''
  const reauthorized = await reauthorize('proof-secret-2')
  assert.equal(reauthorized.status, 200)
  assert.equal(reauthorized.channels.length, 1)
  assert.equal(reauthorized.channels[0].id, id)
  assert.equal(reauthorized.channels[0].auth.status, 'authorized')
  assert.equal((await add({ ...input, id, endpoint: 'https://different.example.test', turnstileToken: 'unused' })).status, 400)

  // Restart/start performs a check without any browser or password. When due,
  // the same official refresh flow runs from the saved token pair.
  await middleware.auth.stop()
  middleware = monitorAPI({ channelStore: store, now: () => now })
  const beforeRestartLogins = logins
  const beforeRestartRefreshes = refreshes
  const beforeRestartChecks = checks
  middleware.auth.start()
  await middleware.auth.runDue()
  assert.equal(logins, beforeRestartLogins)
  assert.equal(refreshes, beforeRestartRefreshes + 1)
  assert.equal(checks, beforeRestartChecks + 1)
  await middleware.auth.stop()
  refreshFailure = 'expired'
  now += 70000
  assert.equal((await check()).channels[0].auth.status, 'expired')
  assert.equal((await list())[0].needsAuthorization, true)
  for (const secret of ['password-secret', 'proof-secret', 'temporary-secret', 'refresh-secret', 'access-secret', 'private-']) {
    assert.ok(!JSON.stringify(await list()).includes(secret))
    assert.ok(!readFileSync(join(directory, 'monitor.sqlite'), 'utf8').includes(secret))
  }
})
