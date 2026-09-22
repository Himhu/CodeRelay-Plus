import { SyncError, isRecord, localHost, readJSON } from './upstream-client.js'
import { accountSite } from './channel-balance.js'

export const HEALTH_PROBE_PROMPT = 'Reply OK.'
export const HEALTH_PROBE_MAX_TOKENS = 8
export const HEALTH_PROBE_TIMEOUT_MS = 45000
const REASONING_PROBE_MAX_TOKENS = 32
const MAX_MODELS = 10000

// Classify bounded structured errors; never persist upstream text (it may echo keys).
function upstreamProbeError(payload, status, selected) {
  const detail = payload?.response?.error ?? payload?.error ?? payload
  const code = typeof detail?.code === 'string' ? detail.code.toLowerCase() : ''
  const message = typeof detail === 'string' ? detail : typeof detail?.message === 'string' ? detail.message : typeof detail?.detail === 'string' ? detail.detail : ''
  const type = typeof detail?.type === 'string' ? detail.type.toLowerCase() : ''
  const text = `${code} ${type} ${message}`.slice(0, 16384)
  let reason = 'upstream_error', retryProtocol = null, omitParameter = null, requireStream = false
  if (status === 401 || /invalid_api_key|authentication_error|invalid.{0,12}(?:api.?key|token)|无效.{0,5}(?:密钥|令牌)/i.test(text)) reason = 'authentication'
  else if (status === 402 || /insufficient_quota|insufficient.{0,10}(?:balance|credit)|余额不足|额度不足|配额不足/i.test(text)) reason = 'quota'
  else if (status === 403 || /permission|access.denied|(?:do not|don't) have access|not.authorized|not.allowed.to|无权|权限/i.test(text)) reason = 'permission'
  else if (status === 429 || /rate_limit|rate.limit.exceeded|限流|请求过于频繁/i.test(text)) reason = 'rate_limit'
  else if (status >= 500 || /overloaded|no.available.channel|无可用渠道|暂无可用|暂时不可用/i.test(text)) reason = 'upstream_unavailable'
  else if (['chat', 'responses'].includes(selected?.protocol) && /stream(?:ing)?["']?\s*(?:must be|must equal|is required to be|[:=])\s*true|only supports? stream(?:ing)?\b|仅支持流式/i.test(text)) {
    reason = 'request_incompatible'; requireStream = true
  } else if (/unsupported[ _](?:parameter|value)|not supported.{0,80}(?:endpoint|v1\/|api)|only.{0,40}(?:responses|chat.completions|messages)|(?:use|try|使用).{0,20}(?:\/v1\/responses|responses api)|不支持.{0,12}(?:参数|接口)|仅支持.{0,15}(?:接口|responses)/i.test(text)) {
    reason = 'request_incompatible'
    if (selected?.protocol === 'chat' && /(?:use|try|使用|only|仅支持).{0,30}(?:\/v1\/responses|responses(?: api| endpoint)?)/i.test(text)) retryProtocol = 'responses'
    // Only omit optional parameters explicitly rejected by the upstream. Output limits stay fixed.
    if (/temperature/i.test(text) && /unsupported|not supported|不支持/i.test(text)) omitParameter = 'temperature'
    if (/reasoning(?:_effort|\.effort| effort)|reasoning/i.test(text) && /unsupported|not supported|不支持/i.test(text)) omitParameter = 'reasoning'
  } else if (selected && [200, 400, 404, 422].includes(status) && (['model_not_found', 'model_not_supported', 'unsupported_model', 'model_not_exist'].includes(code || type)
    || /\bmodel\b.{0,120}(?:does not exist|doesn't exist|not found|not supported|is unsupported)\b|\bunsupported model\b|模型.{0,80}(?:不存在|不支持)|不支持.{0,30}模型/i.test(text))) reason = 'model_unsupported'
  else if (status === 400 || status === 422) reason = 'request_invalid'
  else if (status === 404) reason = 'not_found'
  const messages = {
    authentication: 'API 密钥未通过认证，请检查或重新同步令牌。', permission: '该令牌缺少接口或模型访问权限，请核对上游授权。',
    quota: '上游额度或余额不足。', rate_limit: '上游限流，后续按正常周期继续探测。',
    upstream_unavailable: '上游服务或可用渠道暂时异常，后续按正常周期继续探测。',
    request_incompatible: requireStream ? '上游要求流式请求，下个探测周期改用流式并验证完整响应。' : retryProtocol ? '上游要求 Responses 接口，下个探测周期改用该接口。' : omitParameter ? `上游不支持 ${omitParameter} 参数，下个探测周期移除该可选参数。` : '上游接口或参数不兼容，请核对模型的接口要求。',
    model_unsupported: '上游明确返回模型不存在或不支持，已暂停此令牌下该模型的自动探测。',
    request_invalid: '上游拒绝探测参数，尚不能确认模型是否受支持。', not_found: '上游未找到请求资源，尚不能确认是接口还是模型问题。',
    upstream_error: status >= 300 && status < 400 ? '上游返回重定向，未转发密钥。' : '上游返回错误，未确认模型可用。',
  }
  return Object.assign(new SyncError(messages[reason], status), { reason, retryProtocol, omitParameter, requireStream })
}

export function probeProtocol(id) {
  if (/embed/i.test(id)) return 'embeddings'
  if (/image|dall-e|flux|stable-diffusion|sora|video|veo|whisper|tts|audio|realtime|rerank|moderation|music/i.test(id)) return 'unsupported'
  if (/claude/i.test(id)) return 'messages'
  if (/codex/i.test(id)) return 'responses'
  return 'chat'
}

export function healthProbeRequest(model, protocol = probeProtocol(model)) {
  if (protocol === 'gemini') return { contents: [{ role: 'user', parts: [{ text: HEALTH_PROBE_PROMPT }] }], generationConfig: { maxOutputTokens: REASONING_PROBE_MAX_TOKENS, temperature: 0 } }
  if (protocol === 'embeddings') return { model, input: 'OK' }
  if (protocol === 'responses') return { model, input: HEALTH_PROBE_PROMPT, max_output_tokens: REASONING_PROBE_MAX_TOKENS, stream: false, store: false, reasoning: { effort: 'low' } }
  if (protocol === 'messages') return { model, max_tokens: HEALTH_PROBE_MAX_TOKENS, temperature: 0, messages: [{ role: 'user', content: HEALTH_PROBE_PROMPT }] }
  const request = { model, messages: [{ role: 'user', content: HEALTH_PROBE_PROMPT }], stream: false }
  if (protocol === 'chat' && /(?:^|[\/_-])(?:o\d|gpt-[5-9])/i.test(model)) return { ...request, max_completion_tokens: REASONING_PROBE_MAX_TOKENS, reasoning_effort: 'low' }
  return { ...request, max_tokens: HEALTH_PROBE_MAX_TOKENS, temperature: 0 }
}

function probeBase(channel) {
  const base = accountSite(channel).endpoint
  const url = new URL(base)
  if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || (url.protocol === 'http:' && localHost(url.hostname)))) {
    throw new SyncError('探针地址无效。', 400)
  }
  return `${base}/v1`
}

async function request(channel, token, path, body, signal, protocol, selected) {
  if (typeof token.key !== 'string' || !token.key || /[\s*•]/.test(token.key)) throw upstreamProbeError(null, 401, selected)
  const headers = { Accept: 'application/json', Authorization: `Bearer ${token.key}`, 'User-Agent': 'Signal-Monitor/0.1' }
  if (body) headers['Content-Type'] = 'application/json'
  if (protocol === 'messages') { headers['x-api-key'] = token.key; headers['anthropic-version'] = '2023-06-01' }
  if (protocol === 'gemini') { delete headers.Authorization; headers['x-goog-api-key'] = token.key }
  const base = protocol === 'gemini' ? probeBase(channel).replace(/\/v1$/, '').replace(/\/v1beta$/, '') + '/v1beta' : probeBase(channel)
  const response = await fetch(`${base}${path}`, { method: body ? 'POST' : 'GET', headers,
    body: body ? JSON.stringify(body) : undefined, redirect: 'manual', signal })
  if (!response.ok) {
    let payload
    try { payload = await readJSON(response.body, 16384) } catch { /* HTML, oversized or invalid bodies are not evidence of model support. */ }
    const error = upstreamProbeError(payload, response.status, selected)
    if (!selected) error.message += `（HTTP ${response.status}）`
    throw error
  }
  return response
}

export async function listProbeModels(channel, token, { signal, timeoutMs = 15000 } = {}) {
  const combined = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])])
  const native = channel.probePlatform === 'gemini'
  const models = new Map(), cursors = new Set()
  let cursor = '', expectedTotal
  // ponytail: cap the complete local snapshot at 10,000 models; reject, never silently truncate.
  do {
    const response = await request(channel, token, `/models${cursor ? `?${native ? 'pageToken' : 'after_id'}=${encodeURIComponent(cursor)}` : ''}`, null, combined, native ? 'gemini' : undefined)
    const payload = await readJSON(response.body, 2 * 1024 * 1024)
    const items = payload?.data ?? payload?.models
    if (!isRecord(payload) || payload.error || payload.success === false || !Array.isArray(items) || (payload.has_more != null && typeof payload.has_more !== 'boolean')) throw new SyncError('模型列表格式无效，已保留上次列表。', 502)
    if (payload.total != null) {
      if (!Number.isSafeInteger(payload.total) || payload.total < 0 || (expectedTotal != null && expectedTotal !== payload.total)) throw new SyncError('模型列表分页发生变化，请重新拉取。', 502)
      expectedTotal = payload.total
    }
    for (const item of items) {
      const id = typeof item === 'string' ? item : item?.id ?? (native ? item?.name?.replace(/^models\//, '') : undefined)
      if (typeof id !== 'string' || !id.trim() || id.length > 256 || /[\x00-\x1f\x7f]/.test(id)) throw new SyncError('上游返回无效的模型名称，未更新列表。', 502)
      models.set(id, { id, protocol: native && probeProtocol(id) !== 'unsupported' ? 'gemini' : probeProtocol(id) })
    }
    if (models.size > MAX_MODELS) throw new SyncError('模型超过单次读取上限（10,000 个），未更新列表。', 502)
    if (native ? !payload.nextPageToken : !payload.has_more) break
    cursor = native ? payload.nextPageToken : payload.last_id
    if (typeof cursor !== 'string' || !items.length || cursors.has(cursor) || !native && !models.has(cursor)) throw new SyncError('模型分页不完整，未更新列表。', 502)
    cursors.add(cursor)
  } while (true)
  if (expectedTotal != null && expectedTotal !== models.size) throw new SyncError('模型列表不完整，未更新列表。', 502)
  return [...models.values()]
}

function usageView(usage) {
  const number = value => Number.isSafeInteger(value) && value >= 0 ? value : null
  return { inputTokens: number(usage?.prompt_tokens ?? usage?.input_tokens), outputTokens: number(usage?.completion_tokens ?? usage?.output_tokens),
    reasoningTokens: number(usage?.completion_tokens_details?.reasoning_tokens ?? usage?.output_tokens_details?.reasoning_tokens) }
}

async function completionPayload(response, selected) {
  if (!response.headers.get('content-type')?.includes('text/event-stream')) return readJSON(response.body, 512 * 1024)
  // Gateways can stream even for stream:false. Decode all supported text
  // protocols and stop at their terminal event, not at an unrelated socket close.
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffer = '', size = 0, text = '', reasoning = '', finish = null, usage, reportedModel, refusal, message
  const parse = block => {
    const lines = block.split(/\r?\n/)
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    if (!data) return null
    if (data === '[DONE]') return { choices: [{ message: { content: text, reasoning_content: reasoning, refusal }, finish_reason: finish }], usage, model: reportedModel }
    const event = JSON.parse(data)
    const type = event.type ?? lines.find(line => line.startsWith('event:'))?.slice(6).trim()
    if (event.error || type === 'error' || type === 'response.failed') throw upstreamProbeError(event, response.status, selected)
    if (type === 'response.completed' || type === 'response.incomplete') return event.response
    if (type === 'message_start') { message = event.message; usage = event.message?.usage }
    if (type === 'content_block_start' && event.content_block?.type === 'text') text += event.content_block.text || ''
    if (type === 'content_block_delta') { text += event.delta?.text || ''; reasoning += event.delta?.thinking || '' }
    if (type === 'message_delta') { finish = event.delta?.stop_reason ?? finish; usage = { ...usage, ...event.usage } }
    if (type === 'message_stop') return { ...message, content: [{ type: 'text', text }, ...(reasoning ? [{ type: 'thinking' }] : [])], stop_reason: finish, usage }
    const choice = event.choices?.find(item => item.index === 0 || item.index == null)
    if (choice) {
      text += typeof choice.delta?.content === 'string' ? choice.delta.content : ''
      reasoning += choice.delta?.reasoning_content || ''
      refusal ||= choice.delta?.refusal
      finish = choice.finish_reason ?? finish
    }
    usage = event.usage ?? usage; reportedModel = event.model ?? reportedModel
    // finish_reason is a protocol terminal event, even if a proxy keeps the
    // socket open or omits the optional trailing [DONE] frame.
    if (selected.protocol === 'chat' && finish) return { choices: [{ message: { content: text, reasoning_content: reasoning, refusal }, finish_reason: finish }], usage, model: reportedModel }
    return null
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 512 * 1024) throw new SyncError('探针响应过大。', 502)
      buffer += decoder.decode(value, { stream: true })
      let separator
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, separator.index)
        buffer = buffer.slice(separator.index + separator[0].length)
        const completed = parse(block)
        if (completed) return completed
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) { const completed = parse(buffer); if (completed) return completed }
    // A chat finish_reason followed by EOF is also a valid terminal response.
    if (selected.protocol === 'chat' && finish) return { choices: [{ message: { content: text, reasoning_content: reasoning, refusal }, finish_reason: finish }], usage, model: reportedModel }
    throw Object.assign(new SyncError('流式响应中断，未收到完整结束标记，暂不能确认模型可用。', 502), { reason: 'incomplete_stream' })
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

export async function executeHealthProbe(channel, token, now = Date.now, model, options = {}) {
  return executeProbe(channel, token, now, model, options)
}

async function executeProbe(channel, token, now = Date.now, model, { signal, timeoutMs = HEALTH_PROBE_TIMEOUT_MS } = {}) {
  const selected = typeof model === 'string' ? { id: model, protocol: probeProtocol(model) } : model
  if (!selected?.id) return { status: 'inconclusive', reason: 'missing_model', error: '请先拉取模型列表。', latencyMs: null, usage: null }
  const protocol = selected.protocol
  if (protocol === 'unsupported') return { status: 'unsupported', error: '该模型需要专用探针，尚未验证。', latencyMs: null, usage: null }
  const paths = { gemini: `/models/${encodeURIComponent(selected.id)}:generateContent`, chat: '/chat/completions', messages: '/messages', responses: '/responses', embeddings: '/embeddings' }
  const started = performance.now(), combined = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])])
  let httpStatus = null
  try {
    if (!paths[protocol]) throw new SyncError('模型探针协议无效。', 400)
    const body = healthProbeRequest(selected.id, protocol)
    if (selected.requireStream && ['chat', 'responses'].includes(protocol)) body.stream = true
    if (selected.omitTemperature) delete body.temperature
    if (selected.omitReasoning) { delete body.reasoning; delete body.reasoning_effort }
    const response = await request(channel, token, paths[protocol], body, combined, protocol, selected)
    httpStatus = response.status
    const payload = await completionPayload(response, selected)
    if (!isRecord(payload) || payload.error || payload.success === false || payload.status === 'failed') throw upstreamProbeError(payload, response.status, selected)
    const choice = payload.choices?.[0]
    const blocks = protocol === 'gemini' ? payload.candidates?.[0]?.content?.parts?.map(item => item.text || '').join('') : protocol === 'messages' ? payload.content : protocol === 'responses'
      ? payload.output?.filter(item => item.type === 'message').flatMap(item => item.content || []) : choice?.message?.content
    const text = typeof blocks === 'string' ? blocks : Array.isArray(blocks)
      ? blocks.filter(item => ['text', 'output_text'].includes(item?.type) && typeof item.text === 'string').map(item => item.text).join('') : ''
    const vector = payload.data?.[0]?.embedding
    const valid = protocol === 'embeddings' ? Array.isArray(vector) && vector.length > 0 && vector.every(Number.isFinite) : typeof text === 'string' && text.trim().length > 0
    const usage = usageView(payload.usageMetadata ? { input_tokens: payload.usageMetadata.promptTokenCount, output_tokens: payload.usageMetadata.candidatesTokenCount, output_tokens_details: { reasoning_tokens: payload.usageMetadata.thoughtsTokenCount } } : payload.usage)
    const limit = body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens ?? body.generationConfig?.maxOutputTokens
    const finish = choice?.finish_reason ?? payload.stop_reason ?? payload.incomplete_details?.reason ?? payload.candidates?.[0]?.finishReason
    const refused = Boolean(choice?.message?.refusal) || finish === 'refusal' || finish === 'content_filter'
      || Array.isArray(blocks) && blocks.some(item => item?.type === 'refusal')
    const reportedLimit = ['length', 'max_tokens', 'max_output_tokens', 'MAX_TOKENS'].includes(finish)
    const usageAtLimit = limit != null && usage.outputTokens != null && usage.outputTokens >= limit
    const reportedComplete = ['stop', 'end_turn', 'stop_sequence', 'STOP'].includes(finish) || payload.status === 'completed'
    // Gateways may report reasoning-inclusive or inaccurate usage. An explicit
    // normal finish outranks the usage-only inference.
    const limited = reportedLimit || (usageAtLimit && !reportedComplete)
    const reasoning = usage.reasoningTokens > 0 || Boolean(choice?.message?.reasoning_content)
      || payload.content?.some?.(item => item.type === 'thinking') || payload.output?.some?.(item => item.type === 'reasoning')
    const reason = refused ? 'refused' : valid ? null : limited ? 'output_limit' : reasoning ? 'reasoning_only' : 'empty_output'
    const error = reason === 'refused' ? '上游拒绝生成探针内容，未确认模型可用。'
      : reason === 'output_limit' ? `响应未包含有效输出，已达到本次 ${limit} token 输出上限；未追加请求。`
        : reason === 'reasoning_only' ? '上游仅返回推理内容，没有最终文本；未追加请求。'
          : reason === 'empty_output' ? (protocol === 'embeddings' ? '上游响应未包含有效向量。' : '上游响应未包含可识别的非空文本。') : null
    const incompleteResponse = ['incomplete', 'in_progress', 'queued', 'cancelled'].includes(payload.status)
    const incomplete = limited || incompleteResponse
    const incompleteReason = limited ? 'output_limit' : 'incomplete_response'
    return { status: refused ? 'error' : incomplete ? 'inconclusive' : valid ? 'ok' : 'inconclusive', reason: refused ? 'refused' : incomplete ? incompleteReason : reason,
      latencyMs: Math.round(Math.max(0, performance.now() - started)), timeoutMs, httpStatus, usage, error: refused ? error : incomplete
        ? reportedLimit ? `上游返回输出上限结束标记（${limit} token），本轮输出未完整结束。`
          : incompleteResponse ? '上游将响应标记为未完成，本轮不能确认模型可用。'
            : text.length > 12000 ? '回答超过本次采集长度限制，本轮未计入分析。'
              : `上游报告用量达到 ${limit} token 输出上限，且缺少正常结束标记；无法确认本轮输出完整。`
        : error }
  } catch (error) {
    const compatibilityPending = error.reason === 'request_incompatible'
    return { status: signal?.aborted ? 'cancelled' : error.reason === 'incomplete_stream' || compatibilityPending ? 'inconclusive' : 'error', reason: combined.aborted ? 'timeout' : error.reason ?? 'connection_error',
      retryProtocol: error.retryProtocol ?? null, omitParameter: error.omitParameter ?? null, requireStream: selected.requireStream === true || error.requireStream === true,
      latencyMs: Math.round(Math.max(0, performance.now() - started)), timeoutMs, httpStatus: httpStatus ?? (error instanceof SyncError ? error.status : null), usage: null,
      error: signal?.aborted ? '探测已停止。' : combined.aborted ? `超过 ${timeoutMs / 1000} 秒仍未收到完整响应；本次超时，不代表模型不受支持，未追加请求。` : error instanceof SyncError ? error.message : '连接失败或响应格式无效，未重试。' }
  }
}
