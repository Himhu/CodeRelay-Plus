import { useEffect, useState } from 'react'
import { requestJSON } from './console-fetch.js'
import './balance-notices.css'
import './qq-bot.css'

export default function QQBot() {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [appId, setAppId] = useState('')
  const [secret, setSecret] = useState('')
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    requestJSON('/api/qq-bot', null, controller.signal).then(payload => {
      if (typeof payload.qq?.appId !== 'string' || typeof payload.qq.enabled !== 'boolean') throw new Error('QQ 机器人配置格式无效。')
      setData(payload.qq); setAppId(payload.qq.appId); setEnabled(payload.qq.enabled)
    }).catch(err => { if (!controller.signal.aborted) setError(err.message) })
    return () => controller.abort()
  }, [])
  async function save(event) {
    event.preventDefault()
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      const payload = await requestJSON('/api/qq-bot', { appId, secret, enabled })
      setData(payload.qq); setAppId(payload.qq.appId); setEnabled(payload.qq.enabled); setSecret(''); setNotice('已保存。AppSecret 只留在服务器上。')
    } catch (err) { setError(err.message) }
    finally { setBusy(false) }
  }
  async function test() {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      const payload = await requestJSON('/api/qq-bot/test', {})
      setData(payload.qq); setNotice('测试消息已发送。')
    } catch (err) { setError(err.message) }
    finally { setBusy(false) }
  }
  async function copy() {
    const url = data?.webhookUrl
    if (!url) return
    try { await navigator.clipboard.writeText(url); setNotice('回调地址已复制。') }
    catch { setError('复制失败，请手动选择地址。') }
  }
  return <section className="panel console-settings qq-bot" aria-labelledby="qq-bot-title">
    <div className="panel-header"><div><h2 id="qq-bot-title">QQ 机器人</h2><p>只把告警发到一个 QQ 群，不在群里回话。</p></div></div>
    {!data ? <p className="site-message">{error || '正在读取 QQ 机器人配置…'}{error && <button onClick={() => window.location.reload()}>重试</button>}</p> : <form onSubmit={save} className="balance-settings-form">
      <label htmlFor="qq-app-id">AppID</label>
      <input id="qq-app-id" value={appId} inputMode="numeric" autoComplete="off" disabled={busy} onChange={event => setAppId(event.target.value)}/>
      <label htmlFor="qq-app-secret">AppSecret <span>{data.hasSecret ? '已保存，留空则不修改' : '只保存，不回显'}</span></label>
      <input id="qq-app-secret" type="password" value={secret} autoComplete="new-password" disabled={busy} onChange={event => setSecret(event.target.value)}/>
      <label className="qq-check"><input type="checkbox" checked={enabled} disabled={busy} onChange={event => setEnabled(event.target.checked)}/>启用告警</label>
      <p>回调地址填到 QQ 开放平台。把机器人拉进群，或在群里 @ 它一次，用来记下群。只发纯文本：余额不高于设置页阈值、倍率变化、上游公告、订阅余量或到期、整条线路被暂停、同一上游的受监测模型全部失败。</p>
      <div className="qq-url"><input aria-label="QQ 回调地址" readOnly value={data.webhookUrl || '部署到公网 HTTPS 后显示回调地址'}/><button type="button" className="outline-button" onClick={copy} disabled={!data.webhookUrl}>复制</button></div>
      <p role="status">{data.groupOpenId ? `告警群已记下：${data.groupOpenId}` : '还没有告警群。'}{data.lastSentAt ? ` 最近发送：${new Date(data.lastSentAt).toLocaleString('zh-CN', { hour12: false })}` : ''}</p>
      {data.lastError && <p className="site-error" role="alert">{data.lastError}</p>}
      <div className="balance-settings-actions">
        <button type="submit" className="probe-button" disabled={busy}>{busy ? '处理中…' : '保存'}</button>
        <button type="button" className="outline-button" disabled={busy || !data.hasSecret || !data.groupOpenId || !data.enabled} onClick={test}>发送测试</button>
      </div>
      {error && <p className="site-error" role="alert">{error}</p>}{notice && <p className="balance-settings-saved" role="status">{notice}</p>}
    </form>}
  </section>
}
