import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { monitorAPI } from './monitor-api.js'
import { createChannelStore, createSecondarySiteStore } from './site-store.js'

test('upstream configurations persist separately, protect credentials and survive failed saves', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-upstream-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  createChannelStore(directory).save([])
  writeFileSync(join(directory, 'main-sites.enc.json'), 'legacy-unread-snapshot')
  const mainSnapshot = readFileSync(join(directory, 'main-sites.enc.json'), 'utf8')
  const disk = createChannelStore(directory)
  let failSave = false
  const store = { load: () => disk.load(), save: records => {
    if (failSave) throw new Error('private-filesystem-detail')
    disk.save(records)
  } }
  let middleware = monitorAPI({ channelStore: store })
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end() }))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  const post = async (body, origin = base) => {
    const response = await fetch(`${base}/api/upstream-channels`, { method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, ...await response.json() }
  }
  const list = async () => (await (await fetch(`${base}/api/upstream-channels`)).json()).channels
  assert.deepEqual(await list(), [])
  const input = { name: ' Saved upstream ', provider: 'newapi', endpoint: 'https://gateway.example.test/api/v1/', token: ' Bearer upstream-token-secret ' }
  for (const invalid of [{ ...input, name: '' }, { ...input, provider: 'invalid' },
    { ...input, endpoint: 'http://external.example' }, { ...input, endpoint: 'https://user:password@example.test' },
    { ...input, endpoint: 'https://example.test/?token=secret' }, { ...input, token: 'invalid token' }]) {
    assert.equal((await post(invalid)).status, 400)
  }
  assert.equal((await post(input, 'https://foreign.example')).status, 403)
  assert.deepEqual(await list(), [])
  failSave = true
  const failed = await post(input)
  assert.equal(failed.status, 500)
  assert.ok(!JSON.stringify(failed).includes('private-filesystem-detail'))
  assert.deepEqual(await list(), [])
  assert.deepEqual(disk.load(), [])
  failSave = false
  const added = await post(input)
  assert.equal(added.status, 200)
  assert.equal(added.channels[0].name, 'Saved upstream')
  assert.equal(added.channels[0].endpoint, 'https://gateway.example.test/api/v1')
  assert.equal(added.channels[0].needsAuthorization, false)
  assert.equal(disk.load()[0].token, 'upstream-token-secret')
  assert.ok(!JSON.stringify(added).includes('upstream-token-secret'))
  assert.equal(statSync(join(directory, 'monitor.sqlite')).mode & 0o777, 0o600)

  let denyLogin = false
  const authPaths = []
  const upstream = createServer(async (req, res) => {
    authPaths.push(req.url)
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks))
    assert.equal(req.method, 'POST')
    assert.equal(req.headers.authorization, undefined)
    const send = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)) }
    if (denyLogin) return send(401, { code: 401, message: 'password-secret' })
    if (req.url === '/api/v1/auth/login') {
      assert.equal(body.email, 'ordinary@example.test')
      assert.equal(body.password, 'password-secret')
      return send(200, { code: 0, data: { requires_2fa: true, temp_token: 'temporary-secret' } })
    }
    assert.equal(req.url, '/api/v1/auth/login/2fa')
    assert.equal(body.temp_token, 'temporary-secret')
    assert.equal(body.totp_code, '123456')
    send(200, { code: 0, data: { access_token: 'user-access-secret', refresh_token: 'user-refresh-secret', expires_in: 3600 } })
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  t.after(() => upstream.close())
  const subInput = { name: 'Sub2API user', provider: 'sub2api', endpoint: `http://127.0.0.1:${upstream.address().port}/api/v1/`,
    email: 'ordinary@example.test', password: 'password-secret' }
  assert.equal((await post(subInput)).status, 400)
  assert.equal((await list()).length, 1)
  denyLogin = true
  const rejected = await post(subInput)
  assert.equal(rejected.status, 401)
  assert.ok(!JSON.stringify(rejected).includes('password-secret'))
  denyLogin = false
  const sub = await post({ ...subInput, totpCode: '123456' })
  assert.equal(sub.status, 200)
  assert.equal(sub.channels[1].needsAuthorization, false)
  assert.equal(disk.load()[1].token, 'user-access-secret')
  assert.equal(disk.load()[1].refreshToken, 'user-refresh-secret')
  for (const secret of ['password-secret', 'temporary-secret', '123456']) assert.ok(!JSON.stringify(disk.load()).includes(secret))
  assert.ok(authPaths.every(path => path.startsWith('/api/v1/auth/login')))
  await Promise.all([post({ name: 'Address only', provider: 'sub2api', endpoint: 'https://address.example.test' }),
    post({ name: 'Another channel', provider: 'newapi', endpoint: 'https://another.example.test', token: '' })])
  const beforeRestart = await list()
  assert.equal(beforeRestart.length, 4)
  assert.ok(beforeRestart.slice(2).every(channel => channel.needsAuthorization))
  middleware = monitorAPI({ channelStore: createChannelStore(directory) })
  assert.deepEqual(await list(), beforeRestart)
  for (const secret of ['upstream-token-secret', 'user-access-secret', 'user-refresh-secret', 'password-secret']) {
    assert.ok(!JSON.stringify(beforeRestart).includes(secret))
    assert.ok(!readFileSync(join(directory, 'monitor.sqlite'), 'utf8').includes(secret))
  }
  assert.equal(readFileSync(join(directory, 'main-sites.enc.json'), 'utf8'), mainSnapshot)
  assert.equal((await fetch(`${base}/api/main-sites`)).status, 404)
  const database = new DatabaseSync(join(directory, 'monitor.sqlite'))
  database.prepare("UPDATE records SET payload=? WHERE scope='channels'").run(Buffer.from('corrupted'))
  database.close()
  assert.throws(() => monitorAPI({ channelStore: createChannelStore(directory) }), /已有数据未被覆盖/)
  // The shared key must never be regenerated just because the second data file is new.
  const missingKeyDirectory = join(directory, 'missing-key')
  createSecondarySiteStore(missingKeyDirectory).save([{ id: 'keep', provider: 'sub2api', groups: [] }])
  rmSync(join(missingKeyDirectory, 'storage.key'))
  assert.throws(() => createChannelStore(missingKeyDirectory).save([]), /密钥缺失/)
  assert.equal(existsSync(join(missingKeyDirectory, 'storage.key')), false)
  assert.equal(existsSync(join(missingKeyDirectory, 'monitor.sqlite')), true)
})
