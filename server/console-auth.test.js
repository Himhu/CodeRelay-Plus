import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createConsoleAuth, passwordRecord } from './console-auth.js'

test('console login protects APIs, persists and revokes secure sessions, limits retries and checks origins', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-console-auth-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const credentialFile = join(directory, 'auth.json')
  const password = 'test-password-not-a-real-secret'
  writeFileSync(credentialFile, JSON.stringify(await passwordRecord('admin', password)))
  let time = Date.now()
  const config = { publicOrigin: 'https://192.0.2.10', directory, credentialFile, now: () => time }
  let auth = createConsoleAuth(config)
  const server = createServer((req, res) => auth(req, res, () => { res.writeHead(200); res.end('{"protected":true}') }))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  function request(path, { body, cookie, headers = {}, method = body ? 'POST' : 'GET' } = {}) {
    return new Promise((resolve, reject) => {
      const req = httpRequest(`http://127.0.0.1:${server.address().port}${path}`, {
        method, headers: { Host: '192.0.2.10', Origin: config.publicOrigin,
          'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
      }, res => {
        let data = ''
        res.on('data', chunk => { data += chunk })
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) }))
      })
      req.on('error', reject)
      req.end(body ? JSON.stringify(body) : undefined)
    })
  }
  const login = body => request('/api/auth/login', { body: { username: 'admin', password, ...body } })
  const denied = await request('/api/probe-tokens')
  assert.equal(denied.status, 401)
  assert.equal(denied.headers['www-authenticate'], undefined)
  assert.equal(denied.body.code, 'LOGIN_REQUIRED')
  assert.equal((await request('/api/auth/session')).body.authenticated, false)
  assert.equal((await request('/api/auth/session', { headers: { Host: 'foreign.example' } })).status, 403)
  assert.equal((await request('/api/auth/login', { body: { username: 'admin', password }, headers: { Origin: 'https://foreign.example' } })).status, 403)
  assert.equal((await request('/api/auth/login', { body: { username: 'admin', password }, headers: { 'Content-Type': 'text/plain' } })).status, 403)
  assert.equal((await login({ remember: 'yes' })).status, 400)
  assert.equal((await login({ password: 'incorrect' })).status, 401)
  const signed = await login({ remember: true })
  assert.equal(signed.status, 200)
  const rawCookie = signed.headers['set-cookie'][0]
  assert.match(rawCookie, /^__Host-signal_session=/)
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=604800']) assert.ok(rawCookie.includes(flag))
  const cookie = rawCookie.split(';')[0]
  const rawToken = cookie.split('=')[1]
  const saved = readFileSync(join(directory, 'console-sessions.json'), 'utf8')
  assert.ok(!saved.includes(rawToken) && !saved.includes(password))
  assert.equal(statSync(join(directory, 'console-sessions.json')).mode & 0o777, 0o600)
  assert.equal((await request('/api/secondary-sites', { cookie })).status, 200)
  assert.equal((await request('/api/secondary-sites', { cookie: cookie + 'tampered' })).status, 401)
  auth = createConsoleAuth({ ...config, build: 'release-b' })
  assert.equal((await request('/api/auth/session', { cookie })).headers['x-signal-build'], 'release-b')
  for (const headers of [{}, { 'X-Signal-Build': 'release-a' }]) {
    const stale = await request('/api/secondary-sites', { cookie, headers })
    assert.equal(stale.status, 409)
    assert.equal(stale.body.code, 'CLIENT_OUTDATED')
    const write = await request('/api/upstream-channels/test/funding/pay', { cookie, headers, body: {} })
    assert.equal(write.status, 409)
    assert.equal(write.body.protected, undefined, 'Old pages cannot reach business writes')
  }
  assert.equal((await request('/api/secondary-sites', { cookie, headers: { 'X-Signal-Build': 'release-b' } })).status, 200)
  assert.equal((await request('/api/secondary-sites', { headers: { 'X-Signal-Build': 'release-b' } })).status, 401)
  auth = createConsoleAuth(config)
  assert.equal((await request('/api/auth/session', { cookie })).body.username, 'admin')
  assert.equal((await request('/api/auth/logout', { cookie, body: {}, headers: { Origin: 'https://foreign.example' } })).status, 403)
  const logout = await request('/api/auth/logout', { cookie, body: {} })
  assert.equal(logout.status, 200)
  assert.match(logout.headers['set-cookie'][0], /Max-Age=0/)
  assert.equal((await request('/api/secondary-sites', { cookie })).status, 401)
  auth = createConsoleAuth(config)
  assert.equal((await request('/api/secondary-sites', { cookie })).status, 401)
  const short = await login({ remember: false })
  const shortCookie = short.headers['set-cookie'][0]
  assert.ok(!shortCookie.includes('Max-Age'))
  time += 12 * 60 * 60 * 1000 + 1
  assert.equal((await request('/api/secondary-sites', { cookie: shortCookie.split(';')[0] })).status, 401)
  for (let i = 0; i < 8; i++) assert.equal((await login({ password: 'incorrect' })).status, 401)
  const limited = await login({})
  assert.equal(limited.status, 429)
  assert.ok(Number(limited.headers['retry-after']) > 0)
  time += 10 * 60 * 1000 + 1
  const last = await login({ remember: true })
  assert.equal(last.status, 200)
  writeFileSync(credentialFile, JSON.stringify(await passwordRecord('admin', 'different-test-password')))
  auth = createConsoleAuth(config)
  assert.equal((await request('/api/secondary-sites', { cookie: last.headers['set-cookie'][0].split(';')[0] })).status, 401)
})
