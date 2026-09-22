import { createContext, useContext, useEffect, useState } from 'react'
import { ArrowRight, CircleNotch, Eye, EyeSlash, LockSimple, Pulse, SignOut, User, WarningCircle } from '@phosphor-icons/react'
import './console-session.css'
import { consoleFetch as fetch, updateRequired } from './console-fetch.js'
import { clearViewCache, prepareViewCache } from './view-cache.js'

const SessionContext = createContext(null)

async function authRequest(path, body) {
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), 15000)
  try {
    const response = await fetch(`/api/auth/${path}`, { method: body ? 'POST' : 'GET', signal: controller.signal,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined })
    const payload = await response.json().catch(() => null)
    if (!response.ok || typeof payload?.authenticated !== 'boolean') {
      throw new Error(payload?.error || '暂时无法连接登录服务，请稍后重试。')
    }
    return payload
  } catch (error) {
    if (controller.signal.aborted) throw new Error('连接服务器超时，请重新连接。')
    throw error
  } finally {
    clearTimeout(deadline)
  }
}

function LoginPage({ onLogin, checking, onRetry, connectionError }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [visible, setVisible] = useState(false)
  const [remember, setRemember] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(event) {
    event.preventDefault()
    if (busy) return
    setBusy(true); setError('')
    try {
      const session = await authRequest('login', { username: username.trim(), password, remember })
      setPassword(''); await onLogin(session)
    } catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }
  return <div className="login-page">
    <header className="login-header"><div className="login-brand"><span><Pulse size={20} weight="bold" /></span><b>signal</b><i />上游渠道监控</div><LockSimple size={18} aria-label="安全登录" /></header>
    <main className="login-main">
      <div className="login-content">
        <div className="login-title"><span>管理控制台</span><h1>登录 signal</h1></div>
        {checking ? <div className="login-checking" role="status"><CircleNotch size={22} className="login-spinner" />正在验证登录状态</div>
          : connectionError ? <div className="login-connection"><p role="alert">{connectionError}</p><button onClick={onRetry}>重新连接<ArrowRight size={18} /></button></div>
          : <form className="login-form" onSubmit={submit}>
            <label htmlFor="login-username">账号</label>
            <div className="login-input"><User size={18} /><input id="login-username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required maxLength={100} placeholder="输入管理员账号" value={username} onChange={event => setUsername(event.target.value)} disabled={busy} autoFocus /></div>
            <label htmlFor="login-password">密码</label>
            <div className="login-input"><LockSimple size={18} /><input id="login-password" name="password" type={visible ? 'text' : 'password'} autoComplete="current-password" required maxLength={1024} placeholder="输入登录密码" value={password} onChange={event => setPassword(event.target.value)} disabled={busy} /><button type="button" onClick={() => setVisible(value => !value)} aria-label={visible ? '隐藏密码' : '显示密码'} aria-pressed={visible} aria-controls="login-password" title={visible ? '隐藏密码' : '显示密码'}>{visible ? <EyeSlash size={19} /> : <Eye size={19} />}</button></div>
            <label className="login-remember"><input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} disabled={busy} />保持登录 7 天</label>
            <div className="login-feedback" aria-live="polite">{error && <p role="alert"><WarningCircle size={17} />{error}</p>}</div>
            <button className="login-submit" type="submit" disabled={busy}>{busy ? '登录中' : '登录'}{busy ? <CircleNotch size={19} className="login-spinner" /> : <ArrowRight size={19} weight="bold" />}</button>
          </form>}
      </div>
    </main>
    <footer className="login-footer"><span>signal</span><span>UPSTREAM CONTROL</span></footer>
  </div>
}

export function ConsoleAccount() {
  const session = useContext(SessionContext)
  if (!session) return <div className="console-identity"><div className="user-avatar">管</div><div><b>管理员</b><span>Administrator</span></div></div>
  return <div className="console-account">
    <div className="console-identity"><div className="user-avatar">管</div><div><b>{session.username}</b><span>管理员</span></div></div>
    <button className="console-signout" onClick={session.logout} disabled={session.loggingOut} aria-label="退出登录" title="退出登录"><SignOut size={19} /></button>
    {session.logoutError && <span className="console-logout-error" role="alert">{session.logoutError}</span>}
  </div>
}

function LoginSession({ children }) {
  const [session, setSession] = useState(null)
  const [checking, setChecking] = useState(true)
  const [connectionError, setConnectionError] = useState('')
  const [loggingOut, setLoggingOut] = useState(false)
  const [logoutError, setLogoutError] = useState('')
  async function acceptSession(current) {
    if (current.authenticated) await prepareViewCache(current.username)
    else await clearViewCache()
    setSession(current)
  }
  async function check() {
    setChecking(true); setConnectionError('')
    try { await acceptSession(await authRequest('session')) }
    catch (error) { setConnectionError(error.message) }
    finally { setChecking(false) }
  }
  useEffect(() => {
    void check()
    const expired = () => { void clearViewCache(); setSession({ authenticated: false }); setLogoutError('') }
    window.addEventListener('signal:session-expired', expired)
    return () => window.removeEventListener('signal:session-expired', expired)
  }, [])
  useEffect(() => {
    if (!session?.authenticated) return
    let stopped = false
    const refresh = async () => {
      if (document.hidden) return
      try {
        const current = await authRequest('session')
        if (!stopped && (!current.authenticated || current.username !== session.username)) await acceptSession(current)
      } catch { /* Keep the current view during a temporary network failure. */ }
    }
    const timer = setInterval(refresh, 60000)
    document.addEventListener('visibilitychange', refresh)
    return () => { stopped = true; clearInterval(timer); document.removeEventListener('visibilitychange', refresh) }
  }, [session?.authenticated, session?.username])
  async function logout() {
    setLoggingOut(true); setLogoutError('')
    try { await acceptSession(await authRequest('logout', {})) }
    catch (error) { setLogoutError(error.message) }
    finally { setLoggingOut(false) }
  }
  return session?.authenticated
    ? <SessionContext.Provider key={session.username} value={{ ...session, logout, loggingOut, logoutError }}>{children}</SessionContext.Provider>
    : <LoginPage onLogin={acceptSession} checking={checking} connectionError={connectionError} onRetry={check} />
}

function UpdateNotice() {
  const [updated, setUpdated] = useState(updateRequired)
  useEffect(() => {
    const show = () => setUpdated(true)
    if (updateRequired) show()
    window.addEventListener('signal:update-required', show)
    return () => window.removeEventListener('signal:update-required', show)
  }, [])
  return updated && <aside role="alert" className="console-update" aria-labelledby="console-update-title">
    <h2 id="console-update-title">页面已更新</h2>
    <p>请先复制保存尚未提交的内容，再刷新页面继续操作。</p>
    <button type="button" onClick={() => window.location.reload()}>刷新页面</button>
  </aside>
}

export default function SessionGate({ children }) {
  return <><UpdateNotice/>{import.meta.env.PROD ? <LoginSession>{children}</LoginSession> : <LocalSession>{children}</LocalSession>}</>
}

function LocalSession({ children }) {
  const [ready, setReady] = useState(false)
  useEffect(() => { let stopped = false; void prepareViewCache('local').then(() => { if (!stopped) setReady(true) }); return () => { stopped = true } }, [])
  return ready ? children : <div className="site-message" role="status">正在打开控制台…</div>
}
