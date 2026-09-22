import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { monitorAPI } from './monitor-api.js'

test('unsupported pairs pause durably and manual revalidation preserves scheduling, guards and history', async t => {
  let now = 60000, omitModel = false, recovered = false, failSave = false, saved
  const calls = []
  const upstream = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: (omitModel ? ['temporary'] : ['missing', 'temporary']).map(id => ({ id })) }))
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const { model } = JSON.parse(Buffer.concat(chunks))
    calls.push(`${req.headers.authorization}/${model}`)
    if (model === 'temporary') { res.statusCode = 503; return res.end(JSON.stringify({ error: { message: 'Service temporarily unavailable' } })) }
    if (req.headers.authorization === 'Bearer first' && !recovered) { res.statusCode = 404; return res.end(JSON.stringify({ error: { code: 'model_not_found' } })) }
    res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }))
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening'); t.after(() => upstream.close())
  let channel = { id: 'channel', endpoint: `http://127.0.0.1:${upstream.address().port}`, balance: { status: 'ok', amount: 1 },
    probeTokens: ['first', 'second'].map((key, i) => ({ id: String(i + 1), key, status: 'active', probeEnabled: true })) }
  const store = { load: () => [channel], save: records => { if (failSave) throw Error('disk'); saved = structuredClone(records) } }
  let middleware = monitorAPI({ channelStore: store, now: () => now })
  await middleware.probes.runDue()
  let model = channel.probeTokens[0].probeModels[0]
  assert.equal(model.autoPaused, true)
  assert.equal(channel.probeTokens[1].probeModels[0].status, 'ok', 'Same model on a different token remains usable')
  const reserved = model.nextProbeAt
  now += 60000
  await middleware.probes.runDue()
  assert.equal(calls.filter(call => call === 'Bearer first/missing').length, 1)
  assert.equal(calls.filter(call => call.endsWith('/temporary')).length, 4, 'Transient failures continue every minute')
  await middleware.probes.stop()
  channel = saved[0]
  model = channel.probeTokens[0].probeModels[0]
  middleware = monitorAPI({ channelStore: store, now: () => now })
  t.after(() => middleware.probes.stop())
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end() }))
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  const post = (suffix, body) => fetch(`${base}/api/probe-tokens/channel/1/${suffix}`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  omitModel = true
  assert.equal((await post('models', {})).status, 200)
  model = channel.probeTokens[0].probeModels.find(item => item.id === 'missing')
  assert.equal(model.autoPaused, true, 'Discovery cannot discard a suspended model or its history')
  assert.equal(model.probeHistory.length, 1)
  assert.equal(model.nextProbeAt, reserved)
  await middleware.probes.runDue()
  assert.equal(calls.filter(call => call === 'Bearer first/missing').length, 1, 'Restart does not resume auto-paused pairs')
  const view = await fetch(`${base}/api/probe-tokens`).then(res => res.json())
  const publicModel = view.probeTokens[0].probeModels.find(item => item.id === 'missing')
  assert.equal(publicModel.nextProbeAt, null)
  assert.equal(publicModel.autoPaused, true)
  assert.equal(publicModel.history[0].reason, 'model_unsupported')
  assert.equal((await post('models/revalidate', { model: 'bad' })).status, 404)
  channel.balance.amount = 0
  assert.equal((await post('models/revalidate', { model: 'missing' })).status, 402)
  channel.balance.amount = 1
  channel.probeTokens[0].probeEnabled = false
  assert.equal((await post('models/revalidate', { model: 'missing' })).status, 409)
  channel.probeTokens[0].probeEnabled = true
  middleware.auth.busy.add(channel.id)
  assert.equal((await post('models/revalidate', { model: 'missing' })).status, 409)
  middleware.auth.busy.delete(channel.id)
  failSave = true
  assert.equal((await post('models/revalidate', { model: 'missing' })).status, 500)
  assert.equal(model.autoPaused, true)
  failSave = false
  // Revalidation must not pull a previously reserved request forward.
  model.nextProbeAt = new Date(now + 60000).toISOString()
  const before = calls.length
  assert.equal((await post('models/revalidate', { model: 'missing' })).status, 200)
  assert.equal(model.revalidatePending, true)
  assert.equal(model.autoPaused, false)
  assert.equal(model.status, 'unknown')
  assert.equal(calls.length, before, 'Revalidation only changes saved eligibility; it never calls the upstream directly')
  assert.equal((await post('models/revalidate', { model: 'missing' })).status, 200)
  await middleware.probes.runDue()
  assert.equal(calls.length, before)
  assert.equal((await post('models', {})).status, 200)
  assert.equal(channel.probeTokens[0].probeModels.find(item => item.id === 'missing').revalidatePending, true)
  recovered = true; now += 60000
  await middleware.probes.runDue()
  model = channel.probeTokens[0].probeModels.find(item => item.id === 'missing')
  assert.equal(model.status, 'ok')
  assert.equal(model.revalidatePending, false)
  assert.equal(model.probeHistory.length, 2)
  assert.equal(model.probeHistory[0].status, 'error')
  assert.equal(model.probeHistory[1].status, 'ok')
  assert.equal((await post('models/revalidate', { model: 'missing' })).status, 200)
  await middleware.probes.runDue()
  assert.equal(calls.filter(call => call === 'Bearer first/missing').length, 2, 'Repeated revalidation cannot bypass reservations')
  assert.equal((await post('models', {})).status, 200)
  assert.equal(channel.probeTokens[0].probeModels.find(item => item.id === 'missing').probeHistory.length, 2, 'Recovery does not discard the original rejection history')
  const temporary = channel.probeTokens[0].probeModels.find(item => item.id === 'temporary')
  const deadline = temporary.nextProbeAt
  const historyBeforeRetry = structuredClone(temporary.probeHistory)
  failSave = true
  assert.equal((await post('models/revalidate', { model: 'temporary' })).status, 500)
  assert.equal(temporary.status, 'error')
  assert.equal(temporary.revalidatePending, false)
  failSave = false
  const callsBeforeRetry = calls.length
  assert.equal((await post('models/revalidate', { model: 'temporary' })).status, 200)
  assert.equal(temporary.revalidatePending, true, 'Transient failures can be explicitly queued for revalidation')
  assert.equal(temporary.nextProbeAt, deadline)
  assert.deepEqual(temporary.probeHistory, historyBeforeRetry)
  assert.equal((await post('models/revalidate', { model: 'temporary' })).status, 200)
  await middleware.probes.runDue()
  assert.equal(calls.length, callsBeforeRetry, 'Revalidation must not trigger an extra paid request')
  now += 60000
  await middleware.probes.runDue()
  assert.equal(temporary.status, 'error')
  assert.equal(temporary.revalidatePending, false)
})

test('explicit compatibility adjustments take effect next minute and survive model discovery', async t => {
  let now = 60000
  const calls = []
  const upstream = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'gpt-compatible' }, { id: 'cheap' }, { id: 'gpt-5-legacy' }, { id: 'gpt-stream' }] }))
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks)); calls.push({ path: req.url, body })
    if (body.model === 'gpt-compatible' && req.url !== '/v1/responses') {
      res.statusCode = 400; return res.end(JSON.stringify({ error: { message: 'Please use /v1/responses' } }))
    }
    if (body.model === 'cheap' && 'temperature' in body) {
      res.statusCode = 400; return res.end(JSON.stringify({ error: { code: 'unsupported_parameter', message: 'temperature is not supported' } }))
    }
    if (body.model === 'gpt-5-legacy' && 'reasoning_effort' in body) {
      res.statusCode = 400; return res.end(JSON.stringify({ error: { code: 'unsupported_parameter', message: 'reasoning_effort is not supported' } }))
    }
    if (body.model === 'gpt-stream') {
      if (!body.stream) { res.statusCode = 400; return res.end(JSON.stringify({ error: { message: 'stream must be true' } })) }
      res.setHeader('Content-Type', 'text/event-stream')
      return res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] })}\n\n`)
    }
    res.end(JSON.stringify(req.url === '/v1/responses' ? { output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] } : { choices: [{ message: { content: 'OK' } }] }))
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening'); t.after(() => upstream.close())
  const token = { id: '1', key: 'secret', status: 'active', probeEnabled: true }
  const channel = { id: 'channel', endpoint: `http://127.0.0.1:${upstream.address().port}`, probeTokens: [token] }
  let saved
  const middleware = monitorAPI({ channelStore: { load: () => [channel], save: records => { saved = structuredClone(records) } }, now: () => now })
  await middleware.probes.runDue()
  assert.equal(calls.length, 4)
  assert.equal(token.probeModels[0].protocolOverride, 'responses')
  assert.equal(token.probeModels[1].omitTemperature, true)
  assert.equal(token.probeModels[2].omitReasoning, true)
  assert.equal(token.probeModels[3].requireStream, true)
  assert.ok(token.probeModels.every(model => model.status === 'inconclusive' && !model.autoPaused), 'A known compatibility adjustment is pending validation, not a rejected model')
  assert.equal(token.probeModels[0].probeHistory[0].protocol, 'chat', 'History records the attempted protocol, before next-cycle adaptation')
  await middleware.probes.stop()
  const restoredToken = saved[0].probeTokens[0]
  restoredToken.modelsNextRefreshAt = new Date(now).toISOString()
  const restored = monitorAPI({ channelStore: { load: () => saved, save: () => {} }, now: () => now })
  t.after(() => restored.probes.stop())
  await restored.probes.runDue()
  assert.equal(calls.length, 4, 'Discovery and restart must not send an early retry')
  now += 60000
  await restored.probes.runDue()
  assert.equal(calls.length, 8)
  assert.equal(restoredToken.probeModels[0].protocol, 'responses')
  assert.ok(restoredToken.probeModels.every(model => model.status === 'ok'))
  const responses = calls.find(call => call.path === '/v1/responses').body
  assert.equal(responses.max_output_tokens, 32)
  assert.equal(responses.input, 'Reply OK.')
  const cheap = calls.findLast(call => call.body.model === 'cheap').body
  assert.equal(cheap.max_tokens, 8)
  assert.ok(!('temperature' in cheap))
  const legacy = calls.findLast(call => call.body.model === 'gpt-5-legacy').body
  assert.equal(legacy.max_completion_tokens, 32)
  assert.ok(!('reasoning_effort' in legacy))
})

test('catalog failures keep known models probing but never invent models or bypass durable reservations', async t => {
  let status, calls = 0
  const upstream = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/v1/models') {
      res.statusCode = status
      return res.end(JSON.stringify(status === 200 ? { data: 'invalid' } : { error: { message: 'Catalog unavailable' } }))
    }
    for await (const chunk of req) { void chunk }
    calls++
    res.end(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }))
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening'); t.after(() => upstream.close())
  for (status of [403, 503, 200]) for (const cached of [true, false]) {
    let now = 60000, failSave = false
    const token = { id: '1', key: 'secret', status: 'active', probeEnabled: true,
      probeModels: cached ? [{ id: 'known', protocol: 'chat' }] : [] }
    const channel = { id: 'channel', endpoint: `http://127.0.0.1:${upstream.address().port}`, probeTokens: [token] }
    const api = monitorAPI({ now: () => now, channelStore: { load: () => [channel], save: () => { if (failSave) throw Error('disk unavailable') } } })
    const before = calls
    await api.probes.runDue()
    assert.ok(token.modelsError)
    assert.equal(calls - before, cached ? 1 : 0)
    if (cached) assert.equal(token.probeModels[0].status, 'ok')
    else assert.deepEqual(token.probeModels, [])
    now += 60000; failSave = true
    const reserved = calls
    await api.probes.runDue()
    assert.equal(calls, reserved, 'Storage failure stops paid requests even if cached models exist')
    await api.probes.stop()
  }
})

test('probe runner discovers models then verifies every model each minute, preserving deadlines on restart', async t => {
  let now = 60_000, calls = []
  const upstream = createServer(async (req, res) => {
    calls.push(req.url)
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'cheap-a' }, { id: 'cheap-b' }] }))
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks))
    assert.equal(body.max_tokens, 8)
    if (body.model === 'cheap-b') return res.end(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'length' }], usage: { completion_tokens: 8 } }))
    res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }))
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening'); t.after(() => upstream.close())
  const channel = { id: 'channel', name: 'Probe', provider: 'sub2api', endpoint: `http://127.0.0.1:${upstream.address().port}`,
    probeTokens: [{ id: '1', name: 'key', status: 'active', key: 'private-secret', probeEnabled: true }] }
  const token = channel.probeTokens[0]
  const saved = []
  const middleware = monitorAPI({ channelStore: { load: () => [channel], save: records => { saved.push(structuredClone(records)) } }, now: () => now })
  t.after(() => middleware.probes.stop())
  await middleware.probes.runDue()
  assert.deepEqual(calls, ['/v1/models', '/v1/chat/completions', '/v1/chat/completions'])
  assert.equal(token.probeModels[0].status, 'ok')
  assert.equal(token.probeModels[0].probeHistory.length, 1)
  assert.equal(token.probeModels[0].probeHistory[0].httpStatus, 200)
  assert.equal(token.probeModels[0].probeHistory[0].reason, null)
  assert.equal(token.probeModels[1].status, 'inconclusive')
  assert.ok(token.probeModels.every(model => model.nextProbeAt === new Date(now + 60000).toISOString()))
  await middleware.probes.runDue()
  assert.equal(calls.length, 3, 'Repeated ticks cannot duplicate a model probe')
  now += 59999
  await middleware.probes.runDue()
  assert.equal(calls.length, 3)
  now++
  await middleware.probes.runDue()
  assert.equal(calls.length, 5)
  assert.ok(token.probeModels.every(model => model.probeHistory.length === 2))
  assert.equal(token.probeModels[1].status, 'inconclusive')
  assert.equal(token.probeModels[1].reason, 'output_limit')
  assert.ok(saved.length >= 2)
  const restored = monitorAPI({ channelStore: { load: () => saved.at(-1), save: () => {} }, now: () => now })
  await restored.probes.runDue()
  assert.equal(calls.length, 5, 'Restart must honor each model reservation')
  const server = createServer((req, res) => restored(req, res, () => { res.writeHead(404); res.end() }))
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close())
  const payload = await fetch(`http://127.0.0.1:${server.address().port}/api/probe-tokens`).then(response => response.json())
  const model = payload.probeTokens[0].probeModels[1]
  assert.equal(model.reason, 'output_limit')
  assert.equal(model.history[0].reason, 'output_limit')
  assert.equal(model.history[0].httpStatus, 200)
  assert.equal(model.history[0].protocol, 'chat')
  assert.equal(model.history[0].completedAt, new Date(60000).toISOString())
  assert.equal(model.history[0].timeoutMs, 45000)
  assert.match(model.history[0].error, /8 token/)
  assert.equal(model.nextProbeAt, new Date(now + 60000).toISOString())
  assert.equal(payload.policy.scope, 'model')
  assert.equal(payload.policy.timeoutMs, 45000)
  assert.ok(!JSON.stringify(payload).includes('private-secret'))
  const readOverview = async () => (await fetch(`http://127.0.0.1:${server.address().port}/api/upstream-channels`).then(response => response.json())).channels[0].probeSummary
  const overview = await readOverview()
  assert.equal(overview.status, 'degraded')
  assert.equal(overview.counts.ok, 1)
  assert.equal(overview.counts.inconclusive, 1)
  assert.equal(overview.history.total, 2, 'Only completed minutes enter the overview statistics')
  assert.equal(overview.lastProbeAt, new Date(now).toISOString())
  assert.equal(calls.length, 5, 'Reading the overview never sends an additional probe')
  now += 1800000
  assert.equal((await readOverview()).status, 'stale', 'The API recalculates expiry without changing stored records')
  await restored.probes.runDue()
  assert.equal(calls.length, 8, 'A long pause runs one current probe per model, without replaying missed minutes')
})

test('due models, tokens and channels start together; a slow request cannot serialize the others', { timeout: 5000 }, async t => {
  let now = 59000, releaseSlow, allStarted
  const held = new Promise(resolve => { releaseSlow = resolve })
  const started = new Promise(resolve => { allStarted = resolve })
  const requests = []
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks))
    requests.push(`${req.headers.authorization}/${body.model}`)
    if (requests.length === 4) allStarted()
    if (body.model === 'slow-model') await held
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }))
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const endpoint = `http://127.0.0.1:${upstream.address().port}`
  const model = (id, due = now) => ({ id, protocol: 'chat', nextProbeAt: new Date(due).toISOString(), status: 'unknown' })
  const token = (id, models) => ({ id, status: 'active', key: id, probeEnabled: true,
    modelsNextRefreshAt: new Date(now + 600000).toISOString(), probeModels: models })
  const channels = [
    { id: 'a', endpoint, probeTokens: [token('first', [model('slow-model'), model('fast-model'), model('later-model', 180000)]), token('same-channel', [model('fast-model')])] },
    { id: 'b', endpoint, probeTokens: [token('second', [model('fast-model')])] },
  ]
  const saved = []
  const middleware = monitorAPI({ channelStore: { load: () => channels, save: records => saved.push(structuredClone(records)) }, now: () => now })
  t.after(async () => { releaseSlow(); await middleware.probes.stop(); upstream.close() })
  const firstPass = middleware.probes.runDue()
  await started
  assert.equal(requests.length, 4, 'All due requests start before the slow model finishes')
  const overlap = middleware.probes.runDue()
  assert.ok(saved.flatMap(records => records.flatMap(channel => channel.probeTokens)).some(token =>
    token.probeModels.some(model => model.id === 'slow-model' && Date.parse(model.nextProbeAt) === 60000)))
  now = 61000
  releaseSlow()
  await Promise.all([firstPass, overlap])
  assert.equal(requests.length, 4, 'Overlapping ticks must not repeat in-flight models')
  const models = channels[0].probeTokens[0].probeModels
  assert.equal(models[0].lastProbeAt, new Date(61000).toISOString())
  assert.equal(models[0].probeHistory[0].at, new Date(59000).toISOString(), 'A response crossing the minute stays in its request minute')
  await middleware.probes.runDue()
  assert.equal(requests.length, 8)
  assert.equal(models[2].probeHistory, undefined, 'Each model has its own deadline')
  now = 119999
  await middleware.probes.runDue()
  assert.equal(requests.length, 8)
  assert.equal(models[0].probeHistory.length, 2)
  assert.equal(models[1].probeHistory.length, 2)
  now = 120001
  await middleware.probes.runDue()
  assert.equal(requests.length, 12)
  assert.equal(models[0].nextProbeAt, new Date(180000).toISOString(), 'Tick delays do not drift the next minute')
  now = 180000
  await middleware.probes.runDue()
  assert.equal(requests.length, 17)
  assert.equal(models[2].probeHistory.length, 1)
})

for (const batch of [false, true]) test(`${batch ? 'batch' : 'single'} disabling cancels all token models and re-enabling keeps their deadlines`, { timeout: 5000 }, async t => {
  let started, calls = 0
  const reading = new Promise(resolve => { started = resolve })
  const upstream = createServer(async (req, res) => {
    for await (const chunk of req) { void chunk }
    if (++calls === 2) started()
    // Both requests stay in flight until the token is disabled.
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const now = 60000
  const token = { id: '1', status: 'active', key: 'secret', probeEnabled: true,
    modelsNextRefreshAt: new Date(now + 600000).toISOString(), probeModels: ['a', 'b'].map(id => ({ id, protocol: 'chat', status: 'unknown' })) }
  const channel = { id: 'channel', endpoint: `http://127.0.0.1:${upstream.address().port}`, probeTokens: [token] }
  const middleware = monitorAPI({ channelStore: { load: () => [channel], save: () => {} }, now: () => now })
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end() }))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { await middleware.probes.stop(); upstream.closeAllConnections(); upstream.close(); server.close() })
  const base = `http://127.0.0.1:${server.address().port}`
  const toggle = enabled => fetch(`${base}/api/probe-tokens/channel/1`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) })
  const running = middleware.probes.runDue()
  await reading
  assert.equal((await (batch ? fetch(`${base}/api/probe-tokens/batch-disable`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tokens: [{ channelId: 'channel', id: '1' }] }) }) : toggle(false))).status, 200)
  await running
  assert.ok(token.probeModels.every(model => !model.probeHistory?.length))
  assert.equal((await toggle(true)).status, 200)
  await middleware.probes.runDue()
  assert.equal(calls, 2)
  assert.ok(token.probeModels.every(model => Date.parse(model.nextProbeAt) === now + 60000))
})

test('model scheduling honors persistence, balances, disabled tokens and unsupported models', async t => {
  let now = 60000, failSave = true
  const requests = []
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    requests.push(JSON.parse(Buffer.concat(chunks)).model)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }))
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening'); t.after(() => upstream.close())
  const token = { id: '1', key: 'secret', status: 'active', probeEnabled: true,
    modelsNextRefreshAt: new Date(now + 600000).toISOString(), probeModels: [
      { id: 'a', protocol: 'chat' }, { id: 'b', protocol: 'chat' }, { id: 'video', protocol: 'unsupported' },
    ] }
  const channel = { id: 'channel', endpoint: `http://127.0.0.1:${upstream.address().port}`,
    balance: { status: 'ok', amount: 1 }, probeTokens: [token] }
  const middleware = monitorAPI({ channelStore: { load: () => [channel], save: () => { if (failSave) throw new Error('disk') } }, now: () => now })
  t.after(() => middleware.probes.stop())
  await middleware.probes.runDue()
  assert.deepEqual(requests, [], 'No request may run until model deadlines are saved')
  failSave = false; now += 60000
  channel.balance.amount = 0
  await middleware.probes.runDue()
  assert.deepEqual(requests, [], 'An empty balance pauses all models')
  channel.balance.amount = 1; token.probeEnabled = false
  await middleware.probes.runDue()
  assert.deepEqual(requests, [], 'Disabled tokens cannot run any model')
  token.probeEnabled = true
  await middleware.probes.runDue()
  assert.deepEqual(requests.sort(), ['a', 'b'])
  assert.equal(token.probeModels[2].nextProbeAt, undefined)
})

test('models refresh automatically without paid probes, retry after failure and survive restart', async t => {
  let now = 1_000, fail = true, calls = 0
  const upstream = createServer((req, res) => {
    calls++
    assert.equal(req.method, 'GET', 'Automatic discovery must never invoke a paid model')
    assert.equal(req.url, '/v1/models')
    res.writeHead(fail ? 503 : 200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(fail ? { error: 'private-secret' } : { data: [{ id: 'cheap-a' }, { id: 'cheap-b' }] }))
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening'); t.after(() => upstream.close())
  const history = [{ at: new Date(0).toISOString(), status: 'ok', latencyMs: 20 }]
  let channels = ['newapi', 'sub2api'].map(provider => ({ id: provider, provider,
    endpoint: `http://127.0.0.1:${upstream.address().port}`,
    balance: { status: 'ok', amount: provider === 'sub2api' ? 0 : 5 },
    probeTokens: [{ id: '1', status: 'active', key: 'private-secret', probeEnabled: provider === 'sub2api',
      probeModels: [{ id: 'cheap-a', protocol: 'chat', status: 'ok', probeHistory: history }], probeStatus: 'ok' }],
  }))
  let saved
  const store = { load: () => channels, save: records => { saved = structuredClone(records) } }
  let middleware = monitorAPI({ channelStore: store, now: () => now })
  t.after(() => middleware.probes.stop())
  middleware.auth.busy.add('newapi')
  await middleware.probes.runDue()
  assert.equal(calls, 1, 'Discovery respects account synchronization locks')
  middleware.auth.busy.delete('newapi')
  await middleware.probes.runDue()
  assert.equal(calls, 2)
  for (const channel of channels) {
    const token = channel.probeTokens[0]
    assert.match(token.modelsError, /HTTP 503/)
    assert.ok(!token.modelsError.includes('private-secret'))
    assert.deepEqual(token.probeModels[0].probeHistory, history)
    assert.equal(token.probeStatus, 'ok', 'A list error is not a failed paid probe')
    assert.equal(token.nextProbeAt, undefined)
  }
  await middleware.probes.stop()
  channels = structuredClone(saved)
  middleware = monitorAPI({ channelStore: store, now: () => now })
  now += 59999
  await middleware.probes.runDue()
  assert.equal(calls, 2, 'Retry spacing persists across restart')
  fail = false
  now++
  await middleware.probes.runDue()
  assert.equal(calls, 4)
  for (const channel of channels) {
    const token = channel.probeTokens[0]
    assert.equal(token.modelsError, null)
    assert.equal(token.modelsUpdatedAt, new Date(now).toISOString())
    assert.equal(token.probeModels.length, 2)
    assert.equal(token.probeModels[0].status, 'ok')
    assert.deepEqual(token.probeModels[0].probeHistory, history)
    assert.equal(token.probeModels[1].status, 'unknown')
    assert.equal(token.probeEnabled, channel.provider === 'sub2api')
    assert.equal(token.nextProbeAt, undefined)
  }
  now += 599999
  await middleware.probes.runDue()
  assert.equal(calls, 4)
  now++
  await middleware.probes.runDue()
  assert.equal(calls, 6, 'Successful model lists refresh every ten minutes')
  const fresh = { id: '2', status: 'active', key: 'new-private-secret', probeEnabled: false }
  channels[0].probeTokens.push(fresh,
    { id: 'stale', status: 'active', key: 'stale-secret', stale: true },
    { id: 'expired', status: 'active', key: 'expired-secret', expiresAt: new Date(now - 1).toISOString() })
  await middleware.probes.runDue()
  assert.equal(calls, 7, 'New tokens are discovered on the next pass; stale or expired keys are skipped')
  assert.equal(fresh.probeModels.length, 2)
  assert.equal(fresh.probeEnabled, false)
})

test('probe start is rejected when the confirmed channel balance is empty', async t => {
  const channel = { id: 'empty-balance', name: 'Empty', provider: 'sub2api', endpoint: 'https://upstream.example.test',
    balance: { status: 'ok', amount: 0 }, probeTokens: [{ id: '1', name: 'key', status: 'active', key: 'private-secret' }] }
  const middleware = monitorAPI({ channelStore: { load: () => [channel], save: () => {} } })
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end() }))
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  const response = await fetch(`${base}/api/probe-tokens/${channel.id}/1`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) })
  assert.equal(response.status, 402)
  assert.match((await response.json()).error, /上游余额不足/)
  assert.equal(channel.probeTokens[0].probeEnabled, undefined)
})

test('batch enable deduplicates targets, checks each token and rolls back on storage failure', async t => {
  const now = 1000, reservation = new Date(now + 60000).toISOString()
  const key = id => ({ id, name: `Key ${id}`, status: 'active', key: 'private-secret', probeEnabled: false })
  const channels = [
    { id: 'good', name: 'Good', provider: 'newapi', balance: { status: 'ok', amount: 1 },
      probeTokens: [key('1'), { ...key('2'), nextProbeAt: reservation }, { ...key('3'), stale: true },
        { ...key('4'), probeEnabled: true, nextProbeAt: reservation }, key('5'), { ...key('6'), expiresAt: new Date(0).toISOString() },
        { ...key('7'), key: '' }] },
    { id: 'empty', name: 'Empty', provider: 'sub2api', balance: { status: 'ok', amount: 0 }, probeTokens: [key('1')] },
    { id: 'busy', name: 'Busy', provider: 'sub2api', probeTokens: [key('1')] },
  ]
  let saved, saves = 0, failSave = false
  const middleware = monitorAPI({ channelStore: { load: () => channels, save: records => {
    if (failSave) throw new Error('private-disk-secret')
    saved = structuredClone(records); saves++
  } }, now: () => now })
  middleware.auth.busy.add('busy')
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end() }))
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  const send = (tokens, origin = base) => fetch(`${base}/api/probe-tokens/batch-enable`, { method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ tokens }) })
  const targets = [
    ...['1', '2', '2', '3', '4', '6', '7'].map(id => ({ channelId: 'good', id })),
    { channelId: 'empty', id: '1' }, { channelId: 'busy', id: '1' }, { channelId: 'missing', id: '1' },
  ]
  assert.equal((await send(targets, 'https://foreign.example')).status, 403)
  assert.equal((await send([{ channelId: 'good', id: '1' }, null])).status, 400)
  assert.equal(saves, 0)
  const response = await send(targets)
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.batch.enabled, 2)
  assert.equal(payload.batch.alreadyEnabled, 1)
  assert.equal(payload.batch.failures.length, 6)
  assert.match(payload.batch.failures.find(item => item.channelId === 'empty').error, /上游余额不足/)
  assert.ok(!JSON.stringify(payload).includes('secret'))
  assert.equal(saves, 1, 'A batch saves once, regardless of the number of models or tokens')
  assert.equal(saved[0].probeTokens[0].probeEnabled, true)
  assert.equal(saved[0].probeTokens[0].nextProbeAt, new Date(now).toISOString())
  assert.equal(saved[0].probeTokens[1].nextProbeAt, reservation, 'Batch enable preserves paid probe reservations')
  assert.equal(saved[0].probeTokens[3].nextProbeAt, reservation)
  assert.equal(saved[0].probeTokens[4].probeEnabled, false, 'Unselected tokens stay disabled')
  const replay = await send(targets).then(response => response.json())
  assert.equal(replay.batch.enabled, 0)
  assert.equal(replay.batch.alreadyEnabled, 3)
  assert.equal(saves, 1, 'Repeating the batch does not reset the schedule')

  channels[0].probeTokens[0].probeEnabled = false
  failSave = true
  const before = structuredClone(channels)
  const failed = await send([{ channelId: 'good', id: '1' }, { channelId: 'good', id: '5' }])
  assert.equal(failed.status, 500)
  assert.ok(!JSON.stringify(await failed.json()).includes('secret'))
  assert.deepEqual(JSON.parse(JSON.stringify(channels)), JSON.parse(JSON.stringify(before)), 'An unsaved batch enables no token')
})

test('batch stop persists only selected tokens, preserves histories and reservations, and rolls back failed writes', async t => {
  const reservation = new Date(120000).toISOString()
  const key = id => ({ id, name: `Key ${id}`, key: 'private-secret', status: 'active', probeEnabled: true, nextProbeAt: reservation,
    probeModels: [{ id: 'model', protocol: 'chat', nextProbeAt: reservation, probeHistory: [{ at: new Date(0).toISOString(), status: 'ok' }] }] })
  const channels = [
    { id: 'a', name: 'Target', provider: 'sub2api', balance: { status: 'ok', amount: 0 }, probeTokensUnavailable: true,
      probeTokens: [key('1'), { ...key('2'), stale: true }, { ...key('3'), probeModels: [] }, { ...key('4'), probeEnabled: false }] },
    { id: 'b', name: 'Other', provider: 'newapi', probeTokens: [key('1')] },
  ]
  let saved, saves = 0, failSave = false
  const middleware = monitorAPI({ channelStore: { load: () => channels, save: records => {
    if (failSave) throw Error('private-disk-secret')
    saved = structuredClone(records); saves++
  } }, now: () => 60000 })
  middleware.auth.busy.add('a')
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end() }))
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  const send = (tokens, origin = base) => fetch(`${base}/api/probe-tokens/batch-disable`, { method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ tokens }) })
  const targets = ['1', '1', '2', '3', '4'].map(id => ({ channelId: 'a', id }))
  const before = structuredClone(channels)
  assert.equal((await send(targets, 'https://foreign.example')).status, 403)
  assert.equal((await send([...targets, null])).status, 400)
  assert.equal((await send([])).status, 400)
  assert.equal(saves, 0)
  failSave = true
  const failed = await send(targets)
  assert.equal(failed.status, 500)
  assert.ok(!JSON.stringify(await failed.json()).includes('secret'))
  assert.deepEqual(channels, before)
  failSave = false
  const result = await send([...targets, { channelId: 'a', id: 'missing' }]).then(response => response.json())
  assert.equal(result.batch.disabled, 3)
  assert.equal(result.batch.alreadyDisabled, 1)
  assert.equal(result.batch.failures.length, 1)
  assert.ok(!JSON.stringify(result).includes('secret'))
  assert.equal(saves, 1)
  assert.ok(saved[0].probeTokens.every(token => token.probeEnabled === false))
  assert.deepEqual(saved[1], before[1], 'Same token ID in another channel remains enabled')
  for (let index = 0; index < saved[0].probeTokens.length; index++) {
    assert.deepEqual(saved[0].probeTokens[index].probeModels, before[0].probeTokens[index].probeModels)
    assert.equal(saved[0].probeTokens[index].nextProbeAt, reservation)
  }
  const replay = await send(targets).then(response => response.json())
  assert.equal(replay.batch.disabled, 0)
  assert.equal(replay.batch.alreadyDisabled, 4)
  assert.equal(saves, 1)
  const restored = monitorAPI({ channelStore: { load: () => structuredClone(saved), save: () => {} }, now: () => 60000 })
  const restarted = createServer((req, res) => restored(req, res, () => { res.writeHead(404); res.end() }))
  restarted.listen(0, '127.0.0.1'); await once(restarted, 'listening'); t.after(() => restarted.close())
  const payload = await fetch(`http://127.0.0.1:${restarted.address().port}/api/probe-tokens`).then(response => response.json())
  assert.ok(payload.probeTokens.filter(token => token.channelId === 'a').every(token => !token.probeEnabled))
  assert.ok(payload.probeTokens.find(token => token.channelId === 'b').probeEnabled)
})

test('concurrent token reservations and results share durable writes while the API remains responsive', async t => {
  const now = 60000, saved = []
  let calls = 0, ticked = false
  const upstream = createServer(async (req, res) => {
    for await (const chunk of req) { void chunk }
    calls++
    assert.equal(saved.length, 1, 'One shared reservation is durable before any upstream request')
    assert.ok(saved[0].every(channel => channel.probeTokens.every(token => token.probeModels[0].nextProbeAt === new Date(now + 60000).toISOString())))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }))
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const channels = Array.from({ length: 3 }, (_, c) => ({ id: String(c), endpoint: `http://127.0.0.1:${upstream.address().port}`,
    probeTokens: Array.from({ length: 6 }, (_, i) => ({ id: String(i), key: 'test-key', status: 'active', probeEnabled: true,
      modelsNextRefreshAt: new Date(now + 600000).toISOString(), probeModels: [{ id: 'model', protocol: 'chat' }] })) }))
  const api = monitorAPI({ now: () => now, channelStore: { load: () => channels, save: records => saved.push(structuredClone(records)) } })
  t.after(async () => { await api.probes.stop(); upstream.close() })
  setTimeout(() => { ticked = true }, 0)
  await api.probes.runDue()
  assert.equal(ticked, true, 'Batch persistence yields to incoming requests')
  assert.equal(calls, 18)
  assert.equal(saved.length, 2, '18 simultaneous tokens require two writes, not 36')
  assert.ok(saved[1].every(channel => channel.probeTokens.every(token => token.probeModels[0].probeHistory.length === 1)))
})

test('probe API exposes current blockers without changing switches or historical results', async t => {
  const now = Date.parse('2026-09-19T08:00:00Z')
  const channels = ['ready', 'empty', 'models', 'stale', 'expired', 'missing-key'].map(id => ({ id, name: id,
    provider: 'sub2api', endpoint: 'https://example.test', balance: { status: 'ok', amount: id === 'empty' ? 0 : 1 },
    probeTokens: [{ id: '1', name: 'test', key: id === 'missing-key' ? null : 'private-secret', status: 'active', probeEnabled: true,
      expiresAt: new Date(now + (id === 'expired' ? -60000 : 60000)).toISOString(), stale: id === 'stale',
      modelsError: id === 'models' ? '同步失败' : null,
      probeModels: [{ id: 'model', status: 'ok', lastProbeAt: new Date(now - 1000).toISOString(),
        probeHistory: [{ status: 'ok', at: new Date(now - 60000).toISOString() }] }] }] }))
  const before = structuredClone(channels)
  const api = monitorAPI({ channelStore: { load: () => channels, save: () => assert.fail('Read must not write') }, now: () => now })
  const server = createServer((req, res) => api(req, res, () => res.end()))
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close())
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/probe-tokens`)
  assert.equal(response.status, 200)
  const { probeTokens } = await response.json()
  assert.deepEqual(probeTokens.map(token => token.probeBlockReason), [null, 'balance', null, 'credentials', 'credentials', 'credentials'])
  assert.equal(probeTokens[0].probePaused, false, 'Expiry uses the same clock as the scheduler')
  assert.equal(probeTokens.at(-1).probePaused, true)
  assert.ok(probeTokens.every(token => token.probeEnabled && token.probeModels[0].status === 'ok'))
  assert.ok(!JSON.stringify(probeTokens).includes('private-secret'))
  assert.deepEqual(channels, before)
})

test('managed models recover automatically after exclusion and retry immediately after a positive balance refresh', async t => {
  let clock = 60000, recovered = false, paid = 0
  const remote = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'cheap' }] }))
    paid++
    if (!recovered) { res.statusCode = 404; return res.end(JSON.stringify({ error: { code: 'model_not_found' } })) }
    res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }))
  })
  remote.listen(0, '127.0.0.1'); await once(remote, 'listening'); t.after(() => remote.close())
  const channel = { id: 'direct', provider: 'direct', name: '调度直连', endpoint: `http://127.0.0.1:${remote.address().port}`,
    probeTokens: [{ id: '1', status: 'active', key: 'test-key', probeEnabled: true, autoRecoverModels: true }] }
  let saved
  const api = monitorAPI({ channelStore: { load: () => [channel], save: value => { saved = structuredClone(value) } },
    secondaryStore: { load: () => [{ id: 'site', groups: [], accounts: [{ id: 1 }], automation: { direction: 'push', enabled: false, routes: {}, accounts: {}, events: [] } }] }, now: () => clock })
  t.after(() => api.probes.stop())
  await api.probes.runDue()
  const model = channel.probeTokens[0].probeModels[0]
  assert.equal(model.autoPaused, true)
  clock += 60000; await api.probes.runDue(); assert.equal(paid, 1)
  clock += 240000; recovered = true; await api.probes.runDue()
  assert.equal(paid, 2); assert.equal(model.autoPaused, false); assert.equal(model.successStreak, 1)
  clock += 60000; await api.probes.runDue(); assert.equal(model.successStreak, 2)
  recovered = false; clock += 60000; await api.probes.runDue()
  assert.equal(model.autoPaused, true)
  channel.balance = { status: 'ok', amount: 0 }; const before = paid
  clock += 60000; await api.probes.runDue(); assert.equal(paid, before)
  recovered = true; channel.balance = { status: 'ok', amount: 10, updatedAt: new Date(clock).toISOString() }
  await api.probes.runDue(); assert.equal(paid, before + 1); assert.equal(model.autoPaused, false)
  assert.equal(saved[0].probeTokens[0].probeModels[0].successStreak, 1)
})

test('imported probes sharing a balance source run without starvation and obey balance changes', async t => {
  let clock = 60000, paid = 0
  const remote = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'cheap' }] }))
    paid++; res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }))
  })
  remote.listen(0, '127.0.0.1'); await once(remote, 'listening'); t.after(() => remote.close())
  const source = { id: 'source', balance: { status: 'ok', amount: 1 }, probeTokens: [] }
  const token = { id: '1', status: 'active', key: 'test-key', probeEnabled: true }
  const direct = { id: 'direct', provider: 'direct', endpoint: `http://127.0.0.1:${remote.address().port}`,
    balanceSourceId: source.id, probeTokens: [token] }
  const api = monitorAPI({ channelStore: { load: () => [source, direct], save() {} },
    secondaryStore: { load: () => [{ id: 'site', groups: [], accounts: [{ id: 1 }], automation: { direction: 'push', enabled: false, routes: {}, accounts: {}, events: [] } }] }, now: () => clock })
  t.after(() => api.probes.stop())
  await api.probes.runDue()
  assert.equal(paid, 1, 'Earlier source channels cannot starve their dependent probes')
  clock += 60000; source.balance = { status: 'checking', amount: 1 }
  await api.probes.runDue(); assert.equal(paid, 1)
  source.balance = { status: 'ok', amount: 0 }
  await api.probes.runDue(); assert.equal(paid, 1)
  source.balance = { status: 'ok', amount: 2 }
  await api.probes.runDue(); assert.equal(paid, 2)
  assert.equal(token.probeModels[0].successStreak, 2)
})
