import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { isRecord, readJSON, SyncError } from './upstream-client.js'

const deriveKey = promisify(scrypt)
const cookieName = '__Host-signal_session'
const digest = value => createHash('sha256').update(value).digest('hex')
const sessionAge = 12 * 60 * 60 * 1000
const rememberedAge = 7 * 24 * 60 * 60 * 1000
const failureWindow = 10 * 60 * 1000
const scryptOptions = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

export async function passwordRecord(username, password) {
  if (typeof username !== 'string' || !username.trim() || username.length > 100 ||
      typeof password !== 'string' || password.length < 12 || password.length > 1024) {
    throw new Error('Use a username and a password between 12 and 1024 characters.')
  }
  const salt = randomBytes(32).toString('hex')
  const hash = (await deriveKey(password, salt, 64, scryptOptions)).toString('hex')
  return { username: username.trim(), salt, hash }
}

export function createConsoleAuth({ publicOrigin, directory, credentialFile, build = '', now = Date.now }) {
  const origin = new URL(publicOrigin)
  if (origin.protocol !== 'https:' || origin.origin !== publicOrigin) throw new Error('An HTTPS public origin is required.')
  const credentials = JSON.parse(readFileSync(credentialFile, 'utf8'))
  if (typeof credentials.username !== 'string' || !credentials.username || credentials.username.length > 100 ||
      !/^[a-f0-9]{64}$/.test(credentials.salt) || !/^[a-f0-9]{128}$/.test(credentials.hash)) {
    throw new Error('Invalid console authentication configuration.')
  }
  const credentialId = digest(JSON.stringify(credentials))
  const file = join(directory, 'console-sessions.json')
  let sessions = new Map()
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    if (saved.version !== 1 || !Array.isArray(saved.sessions) || saved.sessions.length > 100 ||
        saved.sessions.some(item => !Array.isArray(item) || !/^[a-f0-9]{64}$/.test(item[0]) || !Number.isFinite(item[1]))) {
      throw new Error('Invalid console session store.')
    }
    if (saved.credentialId === credentialId) sessions = new Map(saved.sessions.filter(([, expiry]) => expiry > now()))
  }
  const failures = new Map()
  const pending = new Set()
  function persist(next) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
    const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, credentialId, sessions: [...next] }), { mode: 0o600, flag: 'wx' })
      renameSync(temporary, file)
      sessions = next
    } finally { rmSync(temporary, { force: true }) }
  }
  const liveSessions = () => new Map([...sessions].filter(([, expiry]) => expiry > now()))
  const cookie = (value, age) => `${cookieName}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax${age == null ? '' : `; Max-Age=${age}`}`

  return async (req, res, next) => {
    if (build) res.setHeader('X-Signal-Build', build)
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    try {
      if (req.headers.host !== origin.host || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) {
        return send(403, { error: '请求来源无效。' })
      }
      if (req.method !== 'GET' && (req.headers.origin !== publicOrigin ||
          !req.headers['content-type']?.startsWith('application/json'))) {
        return send(403, { error: '请求来源无效。' })
      }
      const token = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1)
      const id = token && /^[A-Za-z0-9_-]{43}$/.test(token) ? digest(token) : null
      const authenticated = id && (sessions.get(id) ?? 0) > now()
      const path = req.url?.split('?')[0]
      if (path === '/api/auth/session' && req.method === 'GET') {
        return send(200, { authenticated: Boolean(authenticated), ...(authenticated ? { username: credentials.username } : {}) })
      }
      if (path === '/api/auth/login' && req.method === 'POST') {
        // nginx replaces this header with the actual client IP; direct access is loopback-only.
        const client = req.headers['x-real-ip'] || req.socket.remoteAddress
        for (const [key, entry] of failures) if (entry.until <= now()) failures.delete(key)
        const failed = failures.get(client)
        if ((failed?.count ?? 0) >= 8 || pending.has(client) || pending.size >= 4 || failures.size >= 1024) {
          res.setHeader('Retry-After', String(Math.max(1, Math.ceil(((failed?.until ?? now() + 10000) - now()) / 1000))))
          return send(429, { error: '登录尝试过于频繁，请稍后重试。' })
        }
        pending.add(client)
        try {
          let input
          try { input = await readJSON(req, 8192) }
          catch (error) { throw new SyncError('登录信息格式无效。', error.status === 413 ? 413 : 400) }
          if (!isRecord(input) || typeof input.username !== 'string' || !input.username.trim() || input.username.length > 100 ||
              typeof input.password !== 'string' || !input.password || input.password.length > 1024 ||
              (input.remember !== undefined && typeof input.remember !== 'boolean')) {
            return send(400, { error: '请输入有效的账号和密码。' })
          }
          const actual = await deriveKey(input.password, credentials.salt, 64, scryptOptions)
          if (!timingSafeEqual(actual, Buffer.from(credentials.hash, 'hex')) || input.username.trim() !== credentials.username) {
            failures.set(client, { count: (failed?.count ?? 0) + 1, until: failed?.until ?? now() + failureWindow })
            return send(401, { error: '账号或密码不正确。' })
          }
          const age = input.remember ? rememberedAge : sessionAge
          const value = randomBytes(32).toString('base64url')
          const updated = liveSessions()
          if (id) updated.delete(id)
          while (updated.size >= 100) updated.delete(updated.keys().next().value)
          updated.set(digest(value), now() + age)
          persist(updated)
          failures.delete(client)
          res.setHeader('Set-Cookie', cookie(value, input.remember ? age / 1000 : null))
          return send(200, { authenticated: true, username: credentials.username })
        } finally { pending.delete(client) }
      }
      if (path === '/api/auth/logout' && req.method === 'POST') {
        const updated = liveSessions()
        if (id) updated.delete(id)
        if (authenticated) persist(updated)
        res.setHeader('Set-Cookie', cookie('', 0))
        return send(200, { authenticated: false })
      }
      if (!authenticated) return send(401, { code: 'LOGIN_REQUIRED', error: '登录已过期，请重新登录。' })
      // Reject stale browser schemas before returning data or applying a mutation.
      if (build && req.headers['x-signal-build'] !== build) {
        return send(409, { code: 'CLIENT_OUTDATED', error: '页面版本已更新，请刷新页面后继续。未提交的内容请先复制保存。' })
      }
      return next()
    } catch (error) {
      send(error instanceof SyncError ? error.status : 503, { error: error instanceof SyncError ? error.message : '登录服务暂时不可用，请稍后重试。' })
    }
  }
}
