export class SyncError extends Error {
  constructor(message, status = 400) { super(message); this.status = status }
}

export const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
export const textValue = value => typeof value === 'string' ? value.trim() : ''
export const localHost = host => ['localhost', '127.0.0.1', '[::1]'].includes(host)

export async function readJSON(stream, limit) {
  const chunks = []
  let length = 0
  for await (const chunk of stream) {
    length += chunk.length
    if (length > limit) throw new SyncError('请求或响应内容过大。', 413)
    chunks.push(Buffer.from(chunk))
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new SyncError('未收到有效 JSON，请检查上游站点地址及接口版本。', 502) }
}

export async function upstream(site, path, body, method = body ? 'POST' : 'GET') {
  const headers = { Accept: 'application/json', 'User-Agent': 'Signal-Monitor/0.1' }
  const adminRequest = site.provider === 'sub2api' && site.authMode === 'admin-api-key'
  if (adminRequest && !path.startsWith('/api/v1/admin/')) throw new SyncError('管理员密钥只能用于 Sub2API 管理接口。', 400)
  if (site.token) {
    if (adminRequest) headers['x-api-key'] = site.token
    else headers.Authorization = `Bearer ${site.token}`
  }
  if (site.provider === 'newapi' && site.userId) headers['New-Api-User'] = site.userId
  if (body) headers['Content-Type'] = 'application/json'
  let response
  try {
    response = await fetch(`${site.endpoint}${path}`, { method, headers,
      body: body ? JSON.stringify(body) : undefined, redirect: 'manual', signal: AbortSignal.timeout(15000) })
  } catch { throw new SyncError('无法连接上游站点，请检查地址、网络和证书后重试。', 502) }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel()
    throw new SyncError('上游站点返回重定向，请填写最终站点地址。', 502)
  }
  const payload = await readJSON(response.body, 2 * 1024 * 1024)
  if (!response.ok || payload?.success === false || (payload?.code != null && payload.code !== 0)) {
    const reason = [payload?.reason, payload?.code, payload?.message, payload?.type,
      payload?.error?.reason, payload?.error?.code, payload?.error?.message, payload?.error?.type].map(textValue).join(' ')
    const policyBlocked = [payload?.code, payload?.type, payload?.error?.code, payload?.error?.type]
      .some(value => textValue(value).toLowerCase() === 'probe_blocked')
    const loginRequest = path === '/api/v1/auth/login' || path === '/api/v1/auth/login/2fa'
    const refreshRequest = path === '/api/v1/auth/refresh'
    const accountRequest = path === '/api/user/self' || path === '/api/v1/auth/me'
    const keysRequest = /^\/api\/v1\/keys(?:[/?]|$)/.test(path) || /^\/api\/token\//.test(path)
    const keyCreation = method === 'POST' && ['/api/v1/keys', '/api/token/'].includes(path)
    const keyDeletion = method === 'DELETE' && (/^\/api\/v1\/keys\/\d+$/.test(path) || /^\/api\/token\/\d+$/.test(path))
    const announcementRequest = path === '/api/v1/announcements' || path === '/api/notice'
    const subscriptionRequest = path === '/api/v1/subscriptions/progress'
    const watchRequest = announcementRequest || subscriptionRequest
    const operation = adminRequest ? '调度站点管理数据同步' : keyDeletion ? 'API 令牌删除' : keyCreation ? 'API 令牌创建' : loginRequest ? '上游登录' : refreshRequest ? '登录续期'
      : watchRequest ? (subscriptionRequest ? '订阅用量' : '上游公告')
      : `${keysRequest ? 'API 密钥' : accountRequest ? '账户信息' : '分组'}同步`
    let message = `${operation}失败（HTTP ${response.status}），请检查凭据和接口权限。`
    if (policyBlocked) message = '上游站点禁止探针、监控和测试流量（probe_blocked），请联系站点管理员确认是否允许监控接入。'
    else if (adminRequest && [401, 403].includes(response.status)) message = '调度站点拒绝管理员访问，请检查 Sub2API Admin API Key 是否有效及管理接口权限。'
    else if (adminRequest && response.status === 404) message = '调度站点不支持所需的 Sub2API 管理接口，请检查站点地址及版本。'
    else if (/captcha|turnstile/i.test(reason)) message = '上游的人机验证未通过，请填写正常验证取得的有效凭证；已使用或过期的凭证需要重新获取。'
    else if (/totp|2fa/i.test(reason)) message = '两步验证码无效或已过期，请重新输入。'
    else if (/backend.mode|backend mode/i.test(reason)) message = '上游站点已关闭普通用户自助访问，无法读取分组倍率。'
    else if (response.status === 401) message = loginRequest ? '上游登录失败，请检查邮箱、密码及账号状态。' : '上游站点登录或令牌已失效，请重新授权。'
    else if (response.status === 404 && keyDeletion) message = '上游未找到该令牌，可能已被删除。'
    else if (response.status === 404) message = watchRequest ? (subscriptionRequest ? '上游没有订阅用量接口。' : '上游没有公告接口。') : loginRequest ? '上游不支持用户登录接口，请检查地址及版本。' : refreshRequest ? '上游不支持登录续期接口，请重新授权。' : keysRequest ? '上游不支持用户 API 密钥列表接口，请检查地址及版本。' : accountRequest ? '上游不支持账户信息接口，请检查地址及版本。' : '上游站点不支持所需的分组接口，请检查地址及版本。'
    else if (path === '/api/user/self' && /New-Api-User|user.?id|用户.?ID|用户标识/i.test(reason)) message = '请核对系统访问令牌及其所属用户 ID，在重新授权中补充或更正用户 ID。'
    else if (response.status === 429) message = '上游站点请求过于频繁，请稍后重试。'
    // Do not relay upstream error text: it can contain credentials or HTML.
    const error = new SyncError(message, response.status === 403 ? 403 : response.status === 401 ? 401 : response.status === 404 && watchRequest ? 404 : 502)
    error.policyBlocked = policyBlocked
    // Only an explicit rejection establishes that a creation did not succeed.
    error.upstreamRejected = response.status < 500 && (response.status >= 400 || payload?.success === false || (payload?.code != null && payload.code !== 0))
    error.authInvalidated = /TOKEN_REVOKED|USER_INACTIVE|USER_NOT_FOUND|SESSION_REVOKED|SESSION_BINDING|REFRESH_TOKEN_(?:INVALID|EXPIRED|REUSED)/i.test(reason)
    throw error
  }
  const valid = site.provider === 'newapi' ? payload?.success === true : payload?.code === 0
  const emptyTokenWrite = site.provider === 'newapi' && ((method === 'POST' && path === '/api/token/') || (method === 'DELETE' && /^\/api\/token\/\d+$/.test(path)))
  if (!valid || (method !== 'PUT' && !emptyTokenWrite && !Object.hasOwn(payload, 'data'))) throw new SyncError('上游接口响应格式不符。', 502)
  return payload.data
}
