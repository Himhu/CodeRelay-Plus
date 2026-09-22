const build = typeof __SIGNAL_BUILD__ === 'string' ? __SIGNAL_BUILD__ : ''
export let updateRequired = false

// One JSON/error contract for ordinary reads and writes. consoleFetch retains
// its GET-only retry policy; payments and other mutations are never replayed.
export async function requestJSON(path, body, signal) {
  const response = await consoleFetch(path, { method: body == null ? 'GET' : 'POST', signal,
    headers: body == null ? undefined : { 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body) })
  const payload = await response.json().catch(error => {
    if (signal?.aborted) throw error
    throw new Error(`服务响应不完整（HTTP ${response.status}），${body == null ? '请稍后重试' : '请先刷新确认处理结果'}。`)
  })
  if (!response.ok) throw Object.assign(new Error(payload?.error || `请求失败（HTTP ${response.status}），请稍后重试。`), { code: payload?.code, status: response.status })
  return payload
}

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, ms)
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
}

export async function consoleFetch(input, options) {
  if (updateRequired) throw new Error('页面版本已更新，请刷新页面后继续。')
  const request = input instanceof Request ? input : null
  const method = (options?.method || request?.method || 'GET').toUpperCase()
  const signal = options?.signal ?? request?.signal
  if (build) {
    const headers = new Headers(options?.headers ?? request?.headers)
    headers.set('X-Signal-Build', build)
    options = { ...options, headers }
  }
  let response
  // Only reads can be replayed; a lost payment response must never trigger a new submission.
  for (let attempt = 0; ; attempt++) {
    try {
      response = await fetch(input, options)
      const serverBuild = response.headers.get('X-Signal-Build')
      if (build && serverBuild && serverBuild !== build) {
        updateRequired = true
        await response.body?.cancel().catch(() => {})
        window.dispatchEvent(new Event('signal:update-required'))
        throw new Error('页面版本已更新，请刷新页面后继续。')
      }
      // fetch() resolves at headers: a truncated JSON body can fail afterwards.
      // Finish successful GET bodies inside the retry boundary; never replay writes.
      if (method === 'GET' && response.ok && response.headers.get('Content-Type')?.includes('application/json')) {
        const body = await response.arrayBuffer()
        response = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
        response.headers.delete('Content-Encoding')
        response.headers.delete('Content-Length')
      }
    }
    catch (error) {
      if (method !== 'GET' || attempt >= 2 || signal?.aborted || error.name !== 'TypeError') throw error
      await pause(attempt ? 3000 : 1000, signal)
      continue
    }
    if (method !== 'GET' || attempt >= 2 || ![502, 503, 504].includes(response.status)) break
    await response.body?.cancel()
    await pause(attempt ? 3000 : 1000, signal)
  }
  if (response.status === 401) {
    const body = await response.clone().json().catch(() => null)
    if (body?.code === 'LOGIN_REQUIRED') window.dispatchEvent(new Event('signal:session-expired'))
  }
  return response
}
