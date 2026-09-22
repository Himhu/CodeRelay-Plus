import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { HEALTH_PROBE_MAX_TOKENS, HEALTH_PROBE_PROMPT, HEALTH_PROBE_TIMEOUT_MS, healthProbeRequest, listProbeModels, executeHealthProbe } from './probe-request.js'

test('only explicit model rejection is classified as unsupported; errors never echo credentials', async t => {
  let scenario, calls = 0
  const upstream = createServer(async (req, res) => {
    for await (const chunk of req) { void chunk }
    calls++
    res.writeHead(scenario.status ?? 400, { 'Content-Type': scenario.sse ? 'text/event-stream' : 'application/json' })
    res.end(scenario.raw ?? (scenario.sse ? `data: ${JSON.stringify(scenario.payload)}\n\n` : JSON.stringify(scenario.payload)))
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening'); t.after(() => upstream.close())
  const channel = { endpoint: `http://127.0.0.1:${upstream.address().port}` }
  const cases = [
    { status: 404, payload: { error: { code: 'model_not_found', message: 'private-key model missing' } }, reason: 'model_unsupported' },
    { payload: { error: { type: 'model_not_found', message: 'Model "cheap" is not supported by any configured account in this group' } }, reason: 'model_unsupported' },
    { payload: { error: { message: 'The model cheap does not exist' } }, reason: 'model_unsupported' },
    { payload: { error: { message: '此模型不存在' } }, reason: 'model_unsupported' },
    { payload: { detail: "The 'cheap' model is not supported when using Codex with a ChatGPT account.", status: 'failed' }, status: 200, reason: 'model_unsupported' },
    { status: 200, payload: { error: { code: 'unsupported_model', message: 'private-key' } }, reason: 'model_unsupported' },
    { status: 200, sse: true, payload: { type: 'response.failed', response: { error: { code: 'model_not_found' } } }, reason: 'model_unsupported' },
    { status: 200, sse: true, payload: { type: 'error', code: 'unsupported_model' }, reason: 'model_unsupported' },
    { status: 401, payload: { error: { code: 'model_not_found' } }, reason: 'authentication' },
    { status: 403, payload: { error: { code: 'model_not_found' } }, reason: 'permission' },
    { status: 404, payload: { error: { code: 'model_not_found', message: 'The model does not exist or you do not have access to it.' } }, reason: 'permission' },
    { status: 429, payload: { error: { code: 'model_not_found' } }, reason: 'rate_limit' },
    { status: 429, payload: { error: { code: 'insufficient_quota' } }, reason: 'quota' },
    { status: 503, payload: { error: { code: 'model_not_found' } }, reason: 'upstream_unavailable' },
    { status: 400, payload: { error: { message: '当前分组该模型暂无可用渠道' } }, reason: 'upstream_unavailable' },
    { payload: { error: { message: 'Invalid request' } }, reason: 'request_invalid' },
    { status: 404, payload: { error: { message: 'Not Found' } }, reason: 'not_found' },
    { status: 404, raw: '<html>model not supported private-key</html>', reason: 'not_found' },
    { status: 400, raw: JSON.stringify({ error: { code: 'model_not_found', message: 'x'.repeat(17000) } }), reason: 'request_invalid' },
    { payload: { error: { message: 'Model is not supported by this OpenAI-compatible endpoint for composite groups' } }, reason: 'request_incompatible' },
    { payload: { error: { message: 'This model is not supported on the Chat Completions endpoint' } }, reason: 'request_incompatible' },
    { payload: { error: { message: 'Not supported in this endpoint. Please use /v1/responses' } }, reason: 'request_incompatible', retryProtocol: 'responses' },
    { payload: { error: { message: 'codex channel: only /v1/responses, /v1/responses/compact and /v1/alpha/search are supported' } }, reason: 'request_incompatible', retryProtocol: 'responses' },
    { payload: { error: { code: 'unsupported_parameter', message: 'temperature is not supported' } }, reason: 'request_incompatible', omitParameter: 'temperature' },
    { payload: { error: { code: 'unsupported_parameter', message: 'reasoning_effort is not supported' } }, reason: 'request_incompatible', omitParameter: 'reasoning' },
  ]
  for (scenario of cases) {
    const before = calls
    const result = await executeHealthProbe(channel, { key: 'private-key' }, Date.now, { id: 'cheap', protocol: 'chat' })
    assert.equal(result.status, scenario.reason === 'request_incompatible' ? 'inconclusive' : 'error', JSON.stringify(scenario))
    assert.equal(result.reason, scenario.reason, JSON.stringify(scenario))
    assert.equal(result.httpStatus, scenario.status ?? 400)
    assert.equal(result.retryProtocol, scenario.retryProtocol ?? null)
    assert.equal(result.omitParameter, scenario.omitParameter ?? null)
    assert.ok(!JSON.stringify(result).includes('private-key'))
    assert.equal(calls, before + 1, 'Classifying an error must not retry or run another paid request')
  }
  scenario = { payload: { error: { code: 'model_not_found' } } }
  await assert.rejects(listProbeModels(channel, { key: 'private-key' }), error => error.reason !== 'model_unsupported')
})

test('health probe request keeps prompt and completion bounded', () => {
  const request = healthProbeRequest('cheap-health-model')
  assert.equal(HEALTH_PROBE_PROMPT, 'Reply OK.')
  assert.equal(HEALTH_PROBE_MAX_TOKENS, 8)
  assert.equal(HEALTH_PROBE_TIMEOUT_MS, 45000)
  assert.deepEqual(request, { model: 'cheap-health-model', messages: [{ role: 'user', content: 'Reply OK.' }], max_tokens: 8, temperature: 0, stream: false })
  assert.equal(healthProbeRequest('claude-sonnet-4-6', 'messages').max_tokens, 8)
  assert.equal(healthProbeRequest('gpt-5.5').max_completion_tokens, 32)
  assert.equal(healthProbeRequest('openai/gpt-5.5').max_completion_tokens, 32)
  assert.equal(healthProbeRequest('vendor/o3-mini').max_tokens, undefined)
  assert.equal(healthProbeRequest('o3-mini').max_completion_tokens, 32)
  assert.equal(healthProbeRequest('gpt-5.3-codex', 'responses').max_output_tokens, 32)
  assert.deepEqual(healthProbeRequest('text-embedding-3-small', 'embeddings'), { model: 'text-embedding-3-small', input: 'OK' })
})

test('streamed Chat, Anthropic and Responses require terminal evidence and finish without waiting for socket close', async t => {
  let events, open = false, calls = 0
  const server = createServer(async (req, res) => {
    for await (const chunk of req) { void chunk }
    calls++
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const data = Buffer.from(events.map(event => typeof event === 'string' ? event : `data: ${JSON.stringify(event)}\r\n\r\n`).join(''))
    // Fragment framing and multi-byte text deliberately.
    for (let offset = 0; offset < data.length; offset += 7) res.write(data.subarray(offset, offset + 7))
    if (!open) res.end()
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const channel = { endpoint: `http://127.0.0.1:${server.address().port}` }, token = { key: 'secret' }
  const cases = [
    { protocol: 'chat', events: [{ choices: [{ index: 0, delta: { content: '正常' } }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, 'data: [DONE]\n\n'], open: true, status: 'ok' },
    { protocol: 'chat', events: [{ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] }], open: true, status: 'ok' },
    { protocol: 'chat', events: [{ choices: [{ delta: { content: 'partial' } }] }], status: 'inconclusive', reason: 'incomplete_stream' },
    { protocol: 'messages', events: [{ type: 'message_start', message: { usage: { input_tokens: 3 } } }, { type: 'content_block_delta', delta: { type: 'text_delta', text: 'OK' } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }, { type: 'message_stop' }], open: true, status: 'ok' },
    { protocol: 'messages', events: [{ type: 'content_block_delta', delta: { text: 'partial' } }], status: 'inconclusive', reason: 'incomplete_stream' },
    { protocol: 'responses', events: [{ type: 'response.output_text.delta', delta: 'OK' }, { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] } }], open: true, status: 'ok' },
    { protocol: 'chat', events: [{ choices: [{ delta: { content: 'partial' } }] }, { error: { code: 'insufficient_quota' } }], status: 'error', reason: 'quota' },
  ]
  for (const scenario of cases) {
    events = scenario.events; open = scenario.open
    let clock = 100000
    const result = await executeHealthProbe(channel, token, () => { clock -= 1000; return clock }, { id: 'test', protocol: scenario.protocol }, { timeoutMs: 2000 })
    assert.equal(result.status, scenario.status); assert.equal(result.reason, scenario.reason ?? null)
    assert.ok(result.latencyMs >= 0 && result.latencyMs < 2000, 'Monotonic elapsed time is independent of wall-clock jumps')
    assert.equal(result.httpStatus, 200)
  }
  assert.equal(calls, cases.length, 'Parsing never creates an extra paid request')
})

test('a normal response slower than the former 15-second cutoff still passes within the bounded timeout', { timeout: 20000 }, async t => {
  const server = createServer(async (req, res) => {
    for await (const chunk of req) { void chunk }
    setTimeout(() => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] })) }, 15100)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close() })
  const result = await executeHealthProbe({ endpoint: `http://127.0.0.1:${server.address().port}` }, { key: 'secret' }, Date.now, { id: 'normal-but-slow', protocol: 'chat' })
  assert.equal(result.status, 'ok'); assert.equal(result.timeoutMs, 45000); assert.ok(result.latencyMs >= 15000)
})

test('health probe executes a bounded OpenAI-compatible request', async t => {
  let body, auth
  const server = createServer(async (req, res) => {
    auth = req.headers.authorization
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    body = JSON.parse(Buffer.concat(chunks))
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close())
  const { executeHealthProbe } = await import('./probe-request.js')
  const result = await executeHealthProbe({ endpoint: `http://127.0.0.1:${server.address().port}` }, { key: 'secret' }, Date.now, { id: 'cheap-health-model', protocol: 'chat' })
  assert.equal(result.status, 'ok'); assert.equal(auth, 'Bearer secret'); assert.equal(body.max_tokens, 8); assert.equal(body.messages[0].content, 'Reply OK.')
})

test('timeouts and missing credentials never classify a model as unsupported', async t => {
  let calls = 0
  const server = createServer(() => { calls++ })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const channel = { endpoint: `http://127.0.0.1:${server.address().port}` }
  const result = await executeHealthProbe(channel, { key: 'secret' }, Date.now, { id: 'cheap', protocol: 'chat' }, { timeoutMs: 100 })
  assert.equal(result.reason, 'timeout')
  assert.equal(result.httpStatus, null)
  assert.equal(calls, 1)
  const invalidKey = await executeHealthProbe(channel, { key: '' }, Date.now, { id: 'cheap', protocol: 'chat' })
  assert.equal(invalidKey.reason, 'authentication')
  assert.equal(calls, 1)
})

test('model discovery accepts OpenAI data and removes duplicates', async t => {
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'cheap' }, { id: 'cheap' }, 'fast'] })) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close())
  const result = await listProbeModels({ endpoint: `http://127.0.0.1:${server.address().port}` }, { key: 'secret' })
  assert.deepEqual(result, [{ id: 'cheap', protocol: 'chat' }, { id: 'fast', protocol: 'chat' }])
})

test('Anthropic models use messages payload and count valid text as usable', async t => {
  let body
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    body = JSON.parse(Buffer.concat(chunks))
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ content: [{ type: 'text', text: 'OK' }] }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close())
  const { executeHealthProbe } = await import('./probe-request.js')
  const result = await executeHealthProbe({ endpoint: `http://127.0.0.1:${server.address().port}` }, { key: 'secret' }, Date.now, { id: 'claude-3', protocol: 'messages' })
  assert.equal(result.status, 'ok'); assert.equal(body.max_tokens, 8); assert.equal(body.messages[0].content, 'Reply OK.')
})

test('empty, limited and refused responses retain distinct reasons without additional requests', async t => {
  let payload, stream = false, calls = 0
  const upstream = createServer(async (req, res) => {
    for await (const chunk of req) { void chunk }
    calls++
    res.writeHead(200, { 'Content-Type': stream ? 'text/event-stream' : 'application/json' })
    res.end(stream ? `data: ${JSON.stringify({ type: 'response.incomplete', response: payload })}\n\n` : JSON.stringify(payload))
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening'); t.after(() => upstream.close())
  const channel = { endpoint: `http://127.0.0.1:${upstream.address().port}` }, token = { key: 'secret' }
  const cases = [
    { protocol: 'messages', payload: { content: [], stop_reason: 'max_tokens', usage: { input_tokens: 12, output_tokens: 8 } }, reason: 'output_limit' },
    { protocol: 'chat', payload: { choices: [{ message: { content: '' }, finish_reason: 'length' }] }, reason: 'output_limit' },
    { protocol: 'chat', payload: { choices: [{ message: { content: '' } }], usage: { completion_tokens: 8 } }, reason: 'output_limit' },
    { protocol: 'messages', payload: { content: [{ type: 'thinking', thinking: 'private-reasoning' }] }, reason: 'reasoning_only' },
    { protocol: 'chat', payload: { choices: [{ message: { content: null, reasoning_content: 'private-reasoning' } }] }, reason: 'reasoning_only' },
    { protocol: 'responses', payload: { output: [{ type: 'reasoning', summary: [] }], usage: { output_tokens: 2, output_tokens_details: { reasoning_tokens: 2 } } }, reason: 'reasoning_only' },
    { protocol: 'chat', payload: { choices: [{ message: { content: '  ' }, finish_reason: 'stop' }] }, reason: 'empty_output' },
    { protocol: 'responses', payload: { output: [] }, reason: 'empty_output' },
    { protocol: 'embeddings', payload: { data: [{ embedding: [] }] }, reason: 'empty_output' },
    { protocol: 'chat', payload: { choices: [{ message: { content: '', refusal: 'private-refusal' } }] }, reason: 'refused', status: 'error' },
    { protocol: 'messages', payload: { content: [{ type: 'text', text: 'No' }], stop_reason: 'refusal' }, reason: 'refused', status: 'error' },
    { protocol: 'chat', payload: { choices: [{ message: { content: [{ type: 'text', text: 'OK' }] } }] }, reason: null, status: 'ok' },
    { protocol: 'messages', payload: { content: [{ type: 'text', text: 'O' }], stop_reason: 'max_tokens' }, reason: 'output_limit' },
    { protocol: 'responses', stream: true, payload: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }, reason: 'output_limit' },
    { protocol: 'responses', stream: true, payload: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] }, reason: 'output_limit' },
    { protocol: 'responses', payload: { status: 'in_progress', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] }, reason: 'incomplete_response' },
    { protocol: 'chat', payload: { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }], usage: { completion_tokens: 99 } }, reason: null, status: 'ok' },
  ]
  for (const scenario of cases) {
    payload = scenario.payload; stream = scenario.stream
    const before = calls
    const result = await executeHealthProbe(channel, token, Date.now, { id: 'test-model', protocol: scenario.protocol })
    assert.equal(result.status, scenario.status ?? 'inconclusive')
    assert.equal(result.reason, scenario.reason)
    assert.equal(result.httpStatus, 200)
    assert.equal(calls, before + 1, 'An inconclusive response must not cause paid retries')
    assert.ok(!JSON.stringify(result).includes('private-'))
    if (result.reason === 'output_limit') assert.match(result.error, /(?:8|32) token/)
  }
})

test('native Gemini discovery and probes use header authentication, pagination and bounded output', async t => {
  const requests = []
  const remote = createServer(async (req, res) => {
    requests.push(req.url)
    assert.equal(req.headers['x-goog-api-key'], 'private-native-key')
    assert.equal(req.headers.authorization, undefined)
    res.setHeader('Content-Type', 'application/json')
    if (req.method === 'GET') return res.end(JSON.stringify(req.url.includes('pageToken=')
      ? { models: [{ name: 'models/gemini-2.5-pro' }] }
      : { models: [{ name: 'models/gemini-2.5-flash' }], nextPageToken: 'next-page' }))
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks))
    assert.equal(body.contents[0].parts[0].text, 'Reply OK.')
    assert.equal(body.generationConfig.maxOutputTokens, 32)
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1 } }))
  })
  remote.listen(0, '127.0.0.1'); await once(remote, 'listening'); t.after(() => remote.close())
  const channel = { endpoint: `http://127.0.0.1:${remote.address().port}`, probePlatform: 'gemini' }, token = { key: 'private-native-key' }
  const models = await listProbeModels(channel, token)
  assert.deepEqual(models.map(model => model.protocol), ['gemini', 'gemini'])
  const result = await executeHealthProbe(channel, token, Date.now, models[0])
  assert.equal(result.status, 'ok'); assert.equal(result.usage.outputTokens, 1)
  assert.deepEqual(requests, ['/v1beta/models', '/v1beta/models?pageToken=next-page', '/v1beta/models/gemini-2.5-flash:generateContent'])
})
