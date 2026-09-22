import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import test from 'node:test'
import { monitorAPI } from './monitor-api.js'

test('production proxy keeps host, remote address and write origin restrictions', async t => {
  const publicOrigin = 'https://192.0.2.10'
  const api = monitorAPI({ publicOrigin, channelStore: { load: () => [] } })
  const server = createServer((req, res) => api(req, res, () => { res.writeHead(404); res.end() }))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const request = (headers, method = 'GET') => new Promise((resolve, reject) => {
    const req = httpRequest(`${base}/api/upstream-channels`, {
      method, headers: { Host: '192.0.2.10', ...headers },
    }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, json: () => JSON.parse(body) }))
    })
    req.on('error', reject)
    req.end(method === 'POST' ? '{}' : undefined)
  })
  const clean = await request({})
  assert.equal(clean.status, 200)
  assert.deepEqual(await clean.json(), { channels: [] })
  assert.equal((await request({ Host: 'foreign.example', 'X-Forwarded-Host': '192.0.2.10' })).status, 403)
  assert.equal((await request({ Host: '127.0.0.1' })).status, 403)
  for (const Origin of [undefined, 'https://foreign.example', 'http://192.0.2.10']) {
    const headers = { 'Content-Type': 'application/json', ...(Origin ? { Origin } : {}) }
    assert.equal((await request(headers, 'POST')).status, 403)
  }
  assert.equal((await request({ Origin: publicOrigin, 'Content-Type': 'text/plain' }, 'POST')).status, 403)
  // A same-origin write reaches input validation without creating any data.
  assert.equal((await request({ Origin: publicOrigin, 'Content-Type': 'application/json' }, 'POST')).status, 400)
  let status
  await api({ url: '/api/upstream-channels', method: 'GET', headers: { host: '192.0.2.10' },
    socket: { remoteAddress: '198.51.100.2' } }, { writeHead(code) { status = code }, end() {} }, () => {})
  assert.equal(status, 403)
  for (const origin of ['http://192.0.2.10', 'https://192.0.2.10/', 'https://user:pass@192.0.2.10']) {
    assert.throws(() => monitorAPI({ publicOrigin: origin }))
  }
  const local = monitorAPI()
  await local({ url: '/api/secondary-sites', method: 'GET', headers: { host: '192.0.2.10' },
    socket: { remoteAddress: '127.0.0.1' } }, { writeHead(code) { status = code }, end() {} }, () => {})
  assert.equal(status, 403)
})
