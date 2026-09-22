import { Paginated } from './pagination.jsx'
import { useEffect, useRef, useState } from 'react'
import { Wallet, Warning } from '@phosphor-icons/react'
import { requestJSON } from './console-fetch.js'
import { FundingDialog } from './channel-funding.jsx'
import './balance-notices.css'
import { cachedDataLabel, readViewCache, writeViewCache, viewCacheGeneration } from './view-cache.js'

const dollars = value => new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)

async function requestSettings(body, signal) {
  const payload = await requestJSON('/api/settings', body, signal)
  if (typeof payload.settings?.lowBalanceThreshold !== 'number' || !Array.isArray(payload.balanceNotices?.low) || !Array.isArray(payload.balanceNotices?.unavailable)) {
    throw new Error(payload.error || '余额公告与设置读取失败，请重试。')
  }
  return payload
}

export function useConsoleSettings() {
  const [cached] = useState(() => readViewCache('/api/settings'))
  const cacheGeneration = useRef(viewCacheGeneration())
  const [cachedAt, setCachedAt] = useState(cached?.savedAt ?? null)
  const [data, setData] = useState(cached?.data ?? null), [error, setError] = useState(''), [reload, setReload] = useState(0)
  const revision = useRef(0)
  function accept(payload) {
    setData(payload); setCachedAt(null)
    writeViewCache('/api/settings', payload, cacheGeneration.current)
  }
  useEffect(() => {
    const controller = new AbortController()
    let reading = false
    async function read() {
      if (reading) return
      reading = true
      const current = revision.current
      try {
        const payload = await requestSettings(null, controller.signal)
        if (!controller.signal.aborted && current === revision.current) { accept(payload); setError('') }
      } catch (err) {
        if (!controller.signal.aborted && current === revision.current) setError(err.message)
      } finally { reading = false }
    }
    void read()
    const timer = setInterval(read, 30000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [reload])
  async function save(settings) {
    revision.current++
    try {
      const payload = await requestSettings(settings)
      accept(payload); setError('')
    } finally { revision.current++ }
  }
  return { data, cachedAt, error, save, refresh: () => setReload(value => value + 1) }
}

export function BalanceNotice({ state, onFundingChanged }) {
  const [fundingChannel, setFundingChannel] = useState(null)
  const low = state.data?.balanceNotices.low ?? [], unavailable = state.data?.balanceNotices.unavailable ?? []
  const showNotice = low.length > 0 || unavailable.length > 0 || Boolean(state.error)
  const threshold = state.data?.settings.lowBalanceThreshold
  return <>{showNotice && <section className="balance-notice" aria-label="上游余额公告">
    <div className="balance-notice-bar">
      <strong className="balance-notice-label"><Warning size={17}/>{low.length ? `低余额 ${low.length} 站` : '余额待确认'}</strong>
      {low.length > 0 && <div className="balance-notice-window"><div className="balance-notice-copy">
        {low.map(item => <span key={item.id}><b>{item.name}</b><strong>{dollars(item.amount)}</strong>{item.problem && <em>上次余额 · 待复核</em>}</span>)}
      </div></div>}
      {!low.length && <span className="balance-notice-pending">{unavailable.length ? `${unavailable.length} 个站点的余额暂不能确认` : '公告暂时无法更新'}</span>}
      <a href="#settings">设置阈值</a>
    </div>
    {state.error && <p className="balance-notice-error">公告更新失败{state.data ? '，以下为上次结果' : ''}。<button onClick={state.refresh}>重试</button></p>}
    {state.cachedAt && <p className="cached-data-note">{cachedDataLabel(state.cachedAt)}</p>}
    {(low.length > 0 || unavailable.length > 0) && <details>
      <summary>查看全部{unavailable.length > 0 ? ` · ${unavailable.length} 站余额待确认` : ''}<span>提醒阈值 ≤ {dollars(threshold)}</span></summary>
      <p className="balance-notice-caption">点击站点旁的“充值 / 兑换”读取上游充值方式或兑换码购买地址。按充值倍率折算后的美元余额判断；列表每 30 秒更新，上游余额约每 5 分钟查询。</p>
      <Paginated items={[...low, ...unavailable]} label="余额提醒">{items => <ul>{items.map(item => <li key={item.id}>
        <b>{item.name}</b><strong>{item.amount == null ? '余额未知' : dollars(item.amount)}</strong>
        <span>{item.problem ? `${item.problem}${item.amount == null ? '' : '，显示上次余额'}` : '余额不足，请及时补充'}{item.updatedAt && <> · 更新于 <time dateTime={item.updatedAt}>{new Date(item.updatedAt).toLocaleString('zh-CN', { hour12: false })}</time></>}</span>
        <div className="balance-notice-actions">{item.needsAuthorization
          ? <a href="#overview" aria-label={`前往总览授权 ${item.name}`}>授权后充值</a>
          : <button type="button" aria-label={`充值兑换 ${item.name}`} onClick={() => setFundingChannel({ ...item, provider: { newapi: 'NewAPI', sub2api: 'Sub2API' }[item.provider] || item.provider })}><Wallet size={16}/>充值 / 兑换</button>}
        </div>
      </li>)}</ul>}</Paginated>
    </details>}
  </section>}
    {fundingChannel && <FundingDialog channel={fundingChannel} onClose={() => setFundingChannel(null)} onChanged={() => { state.refresh(); onFundingChanged?.() }}/>}
  </>
}

export function ConsoleSettings({ state }) {
  return <section className="panel console-settings" aria-labelledby="balance-settings-title">
    <div className="panel-header"><div><h2 id="balance-settings-title">余额公告</h2><p>上游余额偏低时，在页面顶部显示提醒。</p></div></div>
    {state.cachedAt && <p className="cached-data-note">{cachedDataLabel(state.cachedAt)}</p>}
    {!state.data ? <p className="site-message">{state.error || '正在读取设置…'}{state.error && <button onClick={state.refresh}>重试</button>}</p> : <BalanceSettingsForm settings={state.data.settings} onSave={state.save}/>}
  </section>
}

function numberField(settings, key, fallback) {
  const value = settings[key]
  return typeof value === 'number' ? String(value) : String(fallback)
}

function BalanceSettingsForm({ settings, onSave }) {
  const initial = () => ({
    threshold: String(settings.lowBalanceThreshold),
    rate: numberField(settings, 'rateChangeMinPercent', 1),
    daily: numberField(settings, 'subscriptionDailyRemainingPercent', 20),
    weekly: numberField(settings, 'subscriptionWeeklyRemainingPercent', 20),
    monthly: numberField(settings, 'subscriptionMonthlyRemainingPercent', 20),
    expiry: numberField(settings, 'subscriptionExpiryDays', 3),
  })
  const [fields, setFields] = useState(initial)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false)
  useEffect(() => { if (!dirty) setFields(initial()) }, [settings, dirty])
  const change = key => event => { setFields(current => ({ ...current, [key]: event.target.value })); setDirty(true); setSaved(false) }
  async function submit(event) {
    event.preventDefault()
    if (busy) return
    setBusy(true); setError(''); setSaved(false)
    try {
      await onSave({ lowBalanceThreshold: Number(fields.threshold), rateChangeMinPercent: Number(fields.rate),
        subscriptionDailyRemainingPercent: Number(fields.daily), subscriptionWeeklyRemainingPercent: Number(fields.weekly),
        subscriptionMonthlyRemainingPercent: Number(fields.monthly), subscriptionExpiryDays: Number(fields.expiry) })
      setSaved(true); setDirty(false)
    }
    catch (err) { setError(err.message) }
    finally { setBusy(false) }
  }
  return <form onSubmit={submit} className="balance-settings-form">
    <label htmlFor="low-balance-threshold">最低余额阈值 <span>USD</span></label>
    <div className="balance-threshold-input"><span>$</span><input id="low-balance-threshold" type="number" inputMode="decimal" min="0" max="1000000" step="0.01" required disabled={busy} value={fields.threshold} aria-describedby="balance-threshold-help" onChange={change('threshold')}/></div>
    <p id="balance-threshold-help">实际余额不高于此金额时提醒。设置为 0，仅提醒余额为零或欠费的站点。这个阈值不暂停调度。</p>
    <label htmlFor="rate-change-percent">倍率变化提醒 <span>%</span></label>
    <div className="balance-threshold-input"><input id="rate-change-percent" type="number" inputMode="numeric" min="0" max="100" step="1" required disabled={busy} value={fields.rate} onChange={change('rate')}/></div>
    <p>同一轮扫描里，分组新增、删除，以及达到该百分比的倍率变化，合并成一条 QQ。小于该百分比的波动只更新基线，不提醒。首次同步不发历史变化。</p>
    <label htmlFor="subscription-daily">订阅日剩余 <span>%</span></label>
    <div className="balance-threshold-input"><input id="subscription-daily" type="number" inputMode="numeric" min="0" max="100" step="1" required disabled={busy} value={fields.daily} onChange={change('daily')}/></div>
    <label htmlFor="subscription-weekly">订阅周剩余 <span>%</span></label>
    <div className="balance-threshold-input"><input id="subscription-weekly" type="number" inputMode="numeric" min="0" max="100" step="1" required disabled={busy} value={fields.weekly} onChange={change('weekly')}/></div>
    <label htmlFor="subscription-monthly">订阅月剩余 <span>%</span></label>
    <div className="balance-threshold-input"><input id="subscription-monthly" type="number" inputMode="numeric" min="0" max="100" step="1" required disabled={busy} value={fields.monthly} onChange={change('monthly')}/></div>
    <label htmlFor="subscription-expiry">订阅到期提醒 <span>天</span></label>
    <div className="balance-threshold-input"><input id="subscription-expiry" type="number" inputMode="numeric" min="0" max="365" step="1" required disabled={busy} value={fields.expiry} onChange={change('expiry')}/></div>
    <p>只针对 Sub2API 订阅额度，不并入钱包余额，也不因此暂停调度。剩余百分比不高于对应阈值，或到期天数不高于这里的天数时，QQ 各发一条。</p>
    <div className="balance-settings-actions"><button type="submit" className="probe-button" disabled={busy}>{busy ? '保存中…' : '保存设置'}</button><span>保存在服务器，重启后仍然生效。</span></div>
    {error && <p className="site-error" role="alert">{error}</p>}{saved && <p className="balance-settings-saved" role="status">设置已保存，余额公告已更新。</p>}
  </form>
}
