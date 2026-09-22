import assert from 'node:assert/strict'
import test from 'node:test'
import { consoleFetch } from '../src/console-fetch.js'

test('reads recover from connection loss and gateway restarts with a bounded retry', async t => {
  const originalTimer = setTimeout
  t.mock.method(globalThis, 'setTimeout', fn => originalTimer(fn, 0))
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    if (calls === 1) throw new TypeError('Failed to fetch')
    return new Response('{}', { status: calls === 2 ? 502 : 200 })
  })
  assert.equal((await consoleFetch('/api/upstream-channels')).status, 200)
  assert.equal(calls, 3)
  calls = 0
  globalThis.fetch = async () => { calls++; return new Response('{}', { status: 503 }) }
  assert.equal((await consoleFetch(new Request('https://example.test/api'))).status, 503)
  assert.equal(calls, 3)
})

test('writes and business conflicts are never automatically retried', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new TypeError('Connection closed') })
  await assert.rejects(consoleFetch('/api/funding/pay', { method: 'POST', body: '{}' }), /Connection closed/)
  assert.equal(calls, 1)
  globalThis.fetch = async () => { calls++; return new Response('{}', { status: 409 }) }
  assert.equal((await consoleFetch('/api/test')).status, 409)
  assert.equal(calls, 2)
})

test('aborting a pending read cancels its retry', async t => {
  const controller = new AbortController()
  const waiting = Promise.withResolvers()
  let calls = 0
  const originalTimer = setTimeout
  t.mock.method(globalThis, 'setTimeout', (fn, ms) => { waiting.resolve(); return originalTimer(fn, ms) })
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new TypeError('Connection closed') })
  const read = consoleFetch('/api/test', { signal: controller.signal })
  const rejected = assert.rejects(read, error => error.name === 'AbortError')
  await waiting.promise
  controller.abort()
  await rejected
  assert.equal(calls, 1)
})

test('a read interrupted after headers is retried, but an interrupted write is never replayed', async t => {
  const originalTimer = setTimeout
  t.mock.method(globalThis, 'setTimeout', fn => originalTimer(fn, 0))
  const broken = () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"partial":'))
    controller.error(new TypeError('ERR_INCOMPLETE_CHUNKED_ENCODING'))
  } }), { headers: { 'Content-Type': 'application/json' } })
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => ++calls === 1 ? broken() : Response.json({ complete: true }))
  assert.deepEqual(await (await consoleFetch('/api/probe-tokens')).json(), { complete: true })
  assert.equal(calls, 2)
  calls = 0
  const response = await consoleFetch('/api/funding/pay', { method: 'POST', body: '{}' })
  await assert.rejects(response.json(), /INCOMPLETE_CHUNKED/)
  assert.equal(calls, 1)
})

test('a different server build blocks schema consumption and subsequent submissions without reloading forms', async t => {
  globalThis.__SIGNAL_BUILD__ = 'test-build-a'
  globalThis.window = new EventTarget()
  t.after(() => { delete globalThis.__SIGNAL_BUILD__; delete globalThis.window })
  const { consoleFetch: versionedFetch } = await import('../src/console-fetch.js?version-test')
  let calls = 0, notifications = 0
  window.addEventListener('signal:update-required', () => notifications++)
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    calls++
    assert.equal(new Headers(options.headers).get('X-Signal-Build'), 'test-build-a')
    return Response.json({ changedSchema: true }, { headers: { 'X-Signal-Build': calls === 1 ? 'test-build-a' : 'test-build-b' } })
  })
  assert.deepEqual(await (await versionedFetch('/api/secondary-sites')).json(), { changedSchema: true })
  await assert.rejects(versionedFetch('/api/secondary-sites'), /页面版本已更新/)
  await assert.rejects(versionedFetch('/api/funding/pay', { method: 'POST', body: '{}' }), /页面版本已更新/)
  assert.equal(calls, 2)
  assert.equal(notifications, 1)
})

test('shared JSON requests preserve server messages and do not replay incomplete mutations', async t => {
  const { requestJSON } = await import('../src/console-fetch.js')
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    calls++
    assert.equal(options.method, 'POST')
    assert.deepEqual(JSON.parse(options.body), { enabled: true })
    return new Response('<html>gateway</html>', { status: 502 })
  })
  await assert.rejects(requestJSON('/api/change', { enabled: true }), /先刷新确认处理结果/)
  assert.equal(calls, 1)
  globalThis.fetch = async () => Response.json({ error: '凭据需要更新' }, { status: 409 })
  await assert.rejects(requestJSON('/api/change', {}), /凭据需要更新/)
})
