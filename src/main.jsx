import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import '@fontsource-variable/manrope';
import SessionGate, { ConsoleAccount } from './console-session.jsx';
import { requestJSON } from './console-fetch.js';
import SecondarySites from './secondary-sites.jsx';
import { navigation, routePages } from './route-navigation.js';
import ChannelDetail from './channel-detail.jsx';
import ChannelFunding from './channel-funding.jsx';
import ProbeMonitor from './probe-monitor.jsx';
import LogCenter from './log-center.jsx';
import MobileNavigation from './mobile-navigation.jsx';
import { BalanceNotice, ConsoleSettings, useConsoleSettings } from './balance-notices.jsx';
import { cachedDataLabel, readViewCache, writeViewCache, viewCacheGeneration } from './view-cache.js';
import {probeResultLabel} from './probe-records-data.js';
import { channelFilters, channelSorts, channelTableView } from './channel-table-data.js';
import { Paginated, Pagination } from './pagination.jsx';
import '@fontsource/dm-mono';
import { Pulse, Check, CaretRight, Eye, EyeSlash, Key, Lightning, MagnifyingGlass, Pause, Play, PlugsConnected, Plus, Trash, X, PencilSimple } from '@phosphor-icons/react';import './styles.css';
import './mobile.css';
import './channel-table.css';
const probeProtocolLabels = {gemini:'Gemini 原生',chat:'Chat Completions',responses:'Responses',messages:'Anthropic Messages',embeddings:'Embeddings',unsupported:'暂不支持'}
const modelProtocolLabel = model => probeProtocolLabels[model.protocol] || '兼容协议'
function modelIdentity(id){
  const raw=String(id||'')
  const lower=raw.toLowerCase()
  let family='其他模型',name=raw
  if(/claude/.test(lower)){family=/code/.test(lower)?'Claude Code':'Claude';name=raw.replace(/^claude[-_]?/i,'').replace(/[-_]/g,' ')}
  else if(/codex/.test(lower)){family='Codex';name=raw.replace(/[-_]/g,' ')}
  else if(/grok/.test(lower)){family='Grok';name=raw.replace(/[-_]/g,' ')}
  else if(/gemini/.test(lower)){family='Gemini';name=raw.replace(/[-_]/g,' ')}
  else if(/deepseek/.test(lower)){family='DeepSeek';name=raw.replace(/[-_]/g,' ')}
  else if(/qwen/.test(lower)){family='Qwen';name=raw.replace(/[-_]/g,' ')}
  else if(/kimi|moonshot/.test(lower)){family='Kimi';name=raw.replace(/[-_]/g,' ')}
  else if(/llama/.test(lower)){family='Llama';name=raw.replace(/[-_]/g,' ')}
  else if(/mistral|mixtral/.test(lower)){family='Mistral';name=raw.replace(/[-_]/g,' ')}
  else if(/(^|[-_])(gpt|o[134](?:[-_]|$))/.test(lower)){family='OpenAI';name=raw.replace(/[-_]/g,' ')}
  name=name.replace(/\b(\d+)\s+(\d+)(?=\s|$)/g,'$1.$2').replace(/\s+/g,' ').trim()
  name=name.replace(/\b[a-z]/g,letter=>letter.toUpperCase())
  return {family,name,raw}
}

async function requestChannels(body, signal, path = '/api/upstream-channels') {
  const payload = await requestJSON(path, body, signal)
  if (!Array.isArray(payload.channels)) throw new Error('渠道数据格式无效，已保留上次结果。')
  return payload.channels.map(channel => ({ ...channel,
    provider: channel.provider === 'newapi' ? 'NewAPI' : 'Sub2API',
    accent: channel.provider === 'newapi' ? 'cyan' : 'violet',
    status: channel.probeSummary?.status || 'unknown' }))
}

function currentPage() {
  const raw = window.location.hash.slice(1).split('?')[0]
  const page = raw === 'alerts' ? 'logs' : raw === 'integrations' ? 'overview' : raw
  return ['overview', 'secondary-channels', ...routePages, 'probe-tokens', 'logs', 'probes', 'settings'].includes(page) ? page : 'overview'
}

function subscribeToPage(onChange) {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

const channelProbeLabels = { healthy: '正常', degraded: '部分异常', down: '全部失败', unknown: '待探测', disabled: '未启用', stale: '数据过期', paused: '已暂停', unsupported: '暂不支持', inconclusive: '待确认' }
function Dot({status}){return <span className={`status-dot ${status}`}/>};function Label({status}){return <span className={`status-label ${status}`}><Dot status={status}/>{channelProbeLabels[status] || '待探测'}</span>}
function Sidebar({active,setActive}) {
  active=active==='probe-tokens'?'probes':routePages.includes(active)?'route-automation':active
  return <><MobileNavigation active={active}/><aside className="sidebar">
    <div className="brand"><div className="brand-mark"><Pulse weight="bold"/></div><div><strong>signal</strong><small>UPSTREAM CONTROL</small></div></div>
    <nav className="nav-group" aria-label="主导航">{navigation.map(([id,label,,Icon])=><button className={`nav-item ${active===id?'active':''}`} key={id} aria-label={label} aria-current={active===id?'page':undefined} title={label} onClick={()=>setActive(id)}><Icon size={19} weight={active===id?'fill':'regular'}/><span>{label}</span></button>)}</nav>
    <div className="sidebar-bottom"><p className="sidebar-workflow">接入上游 → 自动探测 → 稳定线路推送</p><a href="#logs">查看运行日志</a></div>
  </aside></>
}
function Topbar({active,onProbe}){let titles={overview:['总览','实时掌握所有上游渠道的运行状态'],'secondary-channels':['调度站点','Sub2API 分组与账号'],'route-bindings':['线路管理','调度站点分组 → 账号 → 上游令牌'],'route-accounts':['线路管理','调度站点账号 → 上游令牌'],'route-discovery':['线路管理','上游线路 · 倍率比较'],'route-automation':['线路管理','自动探测、异常隔离与恢复'],'probe-tokens':['探针监控','模型状态与令牌管理'],logs:['日志中心','调度操作、同步结果与模型探测记录'],probes:['探针监控','模型状态与令牌管理'],settings:['设置','监控策略与通知偏好'],integrations:['集成','连接你的上游站点']};let[t,sub]=titles[active]||titles.overview;return <header className="topbar"><div><div className="crumb"><span>CONTROL ROOM</span><CaretRight size={12}/><b>{t.toUpperCase()}</b></div><h1>{t}</h1><p>{sub}</p></div><div className="top-actions"><ConsoleAccount/>{active==='overview'&&<button className="probe-button" onClick={onProbe}><Lightning weight="fill" size={16}/>查看探针</button>}</div></header>}
const authLabels = { missing: '未授权', configured: '令牌已保存', unchecked: '待验证', checking: '验证中',
  refreshing: '续期中', authorized: '已登录', expired: '需要重新授权', error: '暂时无法确认', 'storage-error': '授权保存失败' }

function ChannelAuth({channel,onCheck,onAuthorize,busy}) {
  const auth = channel.auth || {status:'missing'}
  const pending = busy || ['checking','refreshing'].includes(auth.status)
  return <div className="channel-auth">
    <span className={`auth-badge ${auth.status}`}>{authLabels[auth.status] || '待验证'}</span>
    {channel.needsAuthorization && <button className="text-button" disabled={pending} onClick={()=>onAuthorize(channel)}>登录授权</button>}
    {auth.error && <span className="auth-error">{auth.error}</span>}
    <details className="channel-maintenance"><summary>授权详情</summary>
      {channel.provider === 'Sub2API' && <>
        <span className="auth-meta">{auth.autoRefresh ? '自动续期已开启' : '未开启自动续期'}</span>
        {auth.checkedAt && <span className="auth-meta">最近验证：{new Date(auth.checkedAt).toLocaleString('zh-CN',{hour12:false})}</span>}
        {auth.expiresAt && <span className="auth-meta">当前授权到期：{new Date(auth.expiresAt).toLocaleString('zh-CN',{hour12:false})}</span>}
        <button disabled={pending || channel.needsAuthorization} aria-label={`检查授权 ${channel.name}`} onClick={()=>onCheck(channel)}>检查授权</button>
      </>}
      <button disabled={pending} aria-label={`重新授权 ${channel.name}`} onClick={()=>onAuthorize(channel)}>重新授权</button>
    </details>
  </div>
}

function ChannelBalance({channel,onCheck,busy}) {
  const balance = channel.balance || {status:channel.needsAuthorization?'missing':'unchecked',amount:null}
  const checking = busy || balance.status === 'checking' || ['checking','refreshing'].includes(channel.auth?.status)
  const hasAmount = typeof balance.amount === 'number' && Number.isFinite(balance.amount)
  const rechargeRate = Number.isFinite(channel.rechargeRate) && channel.rechargeRate > 0 ? channel.rechargeRate : 1
  const hasRawAmount = typeof balance.rawAmount === 'number' && Number.isFinite(balance.rawAmount) && rechargeRate !== 1
  const raw = balance.currency === 'QUOTA'
  const stale = hasAmount && balance.status !== 'ok'
  const labels = {missing:'授权后查询',unchecked:'等待查询',checking:'正在查询…',error:'查询失败',unauthorized:'余额查询未授权','storage-error':'保存失败'}
  return <div className="channel-balance" aria-label={`${channel.name} 账户余额`}>
    <strong className={hasAmount&&balance.amount<=0?'balance-low':''}>{hasAmount
      ? <>{raw?'':balance.symbol}{balance.amount.toLocaleString('zh-CN',{minimumFractionDigits:raw && rechargeRate === 1?0:2,maximumFractionDigits:raw && rechargeRate === 1?0:raw?8:2})}<small>{raw?'额度':balance.currency==='CUSTOM'?'站点货币':balance.currency}</small></> : '—'}</strong>
    {(checking || balance.status !== 'ok') && <span className="balance-meta">{checking?'正在查询…':labels[balance.status] || '等待查询'}{stale?' · 上次结果':''}</span>}
    <details className="channel-maintenance"><summary>余额明细 · {rechargeRate}×</summary>
    {balance.updatedAt && <span className="balance-meta">更新：{new Date(balance.updatedAt).toLocaleString('zh-CN',{hour12:false})}</span>}
    <span className="balance-meta">下次刷新：{checking ? '正在刷新…' : balance.nextCheckAt
      ? <time dateTime={balance.nextCheckAt} title="预计查询时间，后台调度或上游响应可能略有延迟。">{new Date(balance.nextCheckAt).toLocaleString('zh-CN',{hour12:false})}</time>
      : channel.needsAuthorization || balance.status === 'unauthorized' ? '授权后恢复'
      : balance.status === 'storage-error' ? '等待存储恢复' : '等待调度'}</span>
    {balance.notice && <span className="balance-meta">{balance.notice}</span>}
    <span className="balance-meta">充值倍率：{rechargeRate}×</span>
    {hasRawAmount && <span className="balance-meta">上游原始余额：{balance.rawCurrency === 'QUOTA' ? balance.rawAmount.toLocaleString('zh-CN') : `${balance.symbol || ''}${balance.rawAmount.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})} ${balance.rawCurrency || ''}`}</span>}
    </details>
    {balance.error && <span className="balance-error">{balance.error}</span>}
    <button type="button" disabled={checking||channel.needsAuthorization} aria-label={`刷新余额 ${channel.name}`} onClick={()=>onCheck(channel)}>刷新余额</button>
    <ChannelFunding channel={channel} disabled={checking||channel.needsAuthorization} onChanged={()=>onCheck(channel)}/>
  </div>
}

function Table({data,view,onInspect,onToggle,onAdd,onEdit,onCheckAuth,onCheckBalance,onAuthorize,authBusy=[],title='上游渠道状态',description,addLabel='添加渠道'}) {
  const panel = useRef(null)
  const { filter, query, sort, pageSize, counts, total, pages, page, start, rows } = useMemo(() => channelTableView(data, new URLSearchParams(view)), [data, view])
  function changeView(values, resetPage = true) {
    const next = new URLSearchParams(view)
    if (resetPage) next.delete('page')
    for (const [key, value] of Object.entries(values)) value == null || value === '' ? next.delete(key) : next.set(key, String(value))
    window.history.replaceState(null, '', `#overview${next.size ? `?${next}` : ''}`)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  }
  function goToPage(next) {
    changeView({page:next},false)
    panel.current?.scrollIntoView({block:'start'})
  }
  useEffect(() => {
    if (Number(new URLSearchParams(view).get('page')) > pages) changeView({ page }, false)
  }, [view, page, pages])
  return <section className="panel channels-panel" ref={panel}>
    <div className="panel-header table-head"><div><h2>{title}</h2><p>{description || `${data.length} 个连接 · 自动探测间隔 60 秒`}</p></div><button className="outline-button" onClick={onAdd}><Plus size={16}/> {addLabel}</button></div>
    <div className="table-toolbar"><div className="filter-tabs">{channelFilters.map(([id,label]) =>
      <button className={filter===id?'active':''} aria-pressed={filter===id} onClick={()=>changeView({status:id==='all'?null:id})} key={id}>{label} <em>{counts[id]}</em></button>)}</div>
      {(filter !== 'all' || query) && <button type="button" className="channel-reset" onClick={()=>changeView({status:null,q:null})}>清除筛选</button>}
    </div>
    <div className="channel-list-controls">
      <label className="search-field"><MagnifyingGlass size={16}/><input type="search" aria-label="搜索渠道、模型或地址" placeholder="搜索渠道或模型" value={query} onChange={event=>changeView({q:event.target.value})}/></label>
      <label>排序<select aria-label="渠道排序" value={sort} onChange={event=>changeView({sort:event.target.value})}>{channelSorts.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>

    </div>
    <div className="channel-list-meta"><span role="status">{total ? `第 ${start+1}–${start+rows.length} 个` : '0 个匹配渠道'} · 筛选后 {total} / 共 {data.length} 个 · 第 {page} / {pages} 页</span>
      <details><summary>统计与排序说明</summary><p className="channel-probe-note">状态按已启用令牌的模型探测汇总，超过 2 分钟的结果标记为过期。成功率和次数统计最近 60 个完整分钟。余额按充值倍率折算后的美元金额排序，未确认或无法换算的金额排在最后；没有成功率或探测时间的渠道也排在最后。</p></details></div>
    <div className="table-scroll"><table className="channel-table mobile-list-table"><thead><tr><th>渠道</th><th>探测状态</th><th>登录授权</th><th>账户余额</th><th title="成功 ÷（成功 + 失败）；响应无有效内容的记录单独统计。">探测成功率</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>
      {rows.length ? rows.map(channel => {
        const summary = channel.probeSummary, history = summary?.history
        return <tr key={channel.id}>
          <td><div className="channel-cell"><div className={`provider-icon ${channel.accent}`}>{channel.provider==='NewAPI'?'N':'S'}</div><div><b>{channel.name}</b><span className="channel-onboarding">{channel.autoProbeNewTokens ? "自动接入" : "手动接入"}</span><span>{channel.provider}{summary && <> <i>·</i> {summary.modelCount} 个模型</>}</span></div></div></td>
          <td data-label="探测状态"><div className="channel-probe-state" title={summary?.detail}><Label status={channel.status}/>{summary && <small>{summary.enabledTokens}/{summary.tokenCount} 个令牌已启用</small>}{summary?.monitoredModels > 0 && <small>通过 {summary.counts.ok} · 失败 {summary.counts.error}</small>}</div></td>
          <td data-label="登录授权"><ChannelAuth channel={channel} onCheck={onCheckAuth} onAuthorize={onAuthorize} busy={authBusy.includes(channel.id)}/></td>
          <td data-label="账户余额"><ChannelBalance channel={channel} onCheck={onCheckBalance} busy={authBusy.includes(channel.id)}/></td>
          <td data-label="探测成功率"><div className="channel-probe-state"><strong>{history?.rate == null ? '—' : `${history.rate.toFixed(2)}%`}</strong>{history && <small>成功 {history.success.toLocaleString('zh-CN')} · 失败 {history.failed.toLocaleString('zh-CN')}</small>}{history?.uncertain > 0 && <small>无有效内容 {history.uncertain.toLocaleString('zh-CN')} 条</small>}<details className="channel-maintenance"><summary>探测明细</summary><small>探测次数：{history ? history.total.toLocaleString('zh-CN') : '—'}</small><span className="last-seen">{summary?.lastProbeAt ? <time dateTime={summary.lastProbeAt}>{new Date(summary.lastProbeAt).toLocaleString('zh-CN',{hour12:false})}</time> : '尚未探测'}</span></details></div></td>

          <td><div className="row-actions"><button aria-label={`编辑 ${channel.name}`} onClick={()=>onEdit(channel)}><PencilSimple size={16}/></button><button aria-label={`查看 ${channel.name} 的探针`} onClick={()=>onToggle(channel.id)}><Pulse size={16}/></button><button aria-label={`查看 ${channel.name} 的线路倍率`} onClick={()=>onInspect(channel)}><CaretRight size={16}/></button></div></td>
        </tr>
      }) : <tr><td colSpan="6"><div className="table-empty"><PlugsConnected size={20}/><span>{data.length ? '没有匹配的渠道，请调整状态筛选或搜索条件' : '还没有渠道，点击“添加渠道”开始配置'}</span></div></td></tr>}
    </tbody></table></div>
    <Pagination total={total} page={page} pageSize={pageSize} onPageChange={goToPage} onPageSizeChange={nextSize => changeView({ pageSize: nextSize, page: 1 }, false)} label="渠道"/>
  </section>
}
function SecretField({name,value,onChange,placeholder,label,hint,required=false}){
  const [visible,setVisible]=useState(false)
  return <div className="secret-field"><label htmlFor={name}>{label}</label><div className="secret-input"><input id={name} name={name} required={required} type={visible?'text':'password'} value={value} onChange={onChange} placeholder={placeholder}/><button type="button" aria-label={`${visible?'隐藏':'显示'}${label}`} aria-pressed={visible} aria-controls={name} onClick={()=>setVisible(v=>!v)}>{visible?<EyeSlash size={15}/>:<Eye size={15}/>}</button></div>{hint&&<small className="field-hint">{hint}</small>}</div>
}

function AddModal({onClose,onSave,initial={}}){
  const dialog=useRef(null)
  useEffect(()=>{
    const element=dialog.current,previous=document.activeElement
    element.showModal()
    return ()=>{element.close();previous?.focus({preventScroll:true})}
  },[])
  const [name,setName]=useState(initial.name || ''),[endpoint,setEndpoint]=useState(initial.endpoint || ''),[provider,setProvider]=useState(initial.provider || 'newapi')
  const [token,setToken]=useState(''),[email,setEmail]=useState(initial.email || ''),[password,setPassword]=useState(''),[userId,setUserId]=useState(initial.userId || ''),[totpCode,setTotpCode]=useState('')
  const [saving,setSaving]=useState(false),[error,setError]=useState('')
  const [turnstileToken,setTurnstileToken]=useState('')
  const [rechargeRate,setRechargeRate]=useState(String(initial.rechargeRate ?? 1))
  const [autoProbeNewTokens,setAutoProbeNewTokens]=useState(initial.id?initial.autoProbeNewTokens===true:true)
  async function submit(event){
    event.preventDefault()
    if(saving)return
    setSaving(true);setError('')
    try{await onSave({name:name.trim(),endpoint:endpoint.trim(),provider,token,email,password,userId,totpCode,turnstileToken,rechargeRate:Number(rechargeRate),autoProbeNewTokens})}
    catch(err){setError(err.message || '保存失败，请重试。')}
    finally{setSaving(false);setTurnstileToken('')}
  }
  return <dialog ref={dialog} className="modal-backdrop" aria-labelledby="add-modal-title" onCancel={event=>{event.preventDefault();if(!saving)onClose()}} onClick={()=>{if(!saving)onClose()}}><form className="add-modal" onSubmit={submit} onClick={e=>e.stopPropagation()}>
    <div className="modal-head"><div><span className="eyebrow">{initial.edit?'EDIT CONNECTION':'NEW CONNECTION'}</span><h2 id="add-modal-title">{initial.edit?'编辑上游渠道':initial.id?'上游重新授权':'添加上游渠道'}</h2></div><button type="button" className="icon-button" aria-label="关闭" disabled={saving} onClick={onClose}><X size={18}/></button></div>
    <fieldset className="connection-fields" disabled={saving}>
    <fieldset className="provider-field"><legend>上游类型</legend><div className="provider-options">{[['newapi','NewAPI','系统访问令牌','N'],['sub2api','Sub2API','普通用户身份','S']].map(([id,title,subtitle,mark])=><label key={id} className={provider===id?'selected':''}><input type="radio" name="provider" value={id} disabled={Boolean(initial.id)} checked={provider===id} onChange={()=>{setProvider(id);setError('')}}/><span className={`provider-option-mark ${id==='sub2api'?'sub':''}`}>{mark}</span><span><b>{title}</b><small>{subtitle}</small></span></label>)}</div></fieldset>
    <label>渠道名称<input name="channel-name" required maxLength={100} autoFocus value={name} onChange={e=>setName(e.target.value)} placeholder="输入渠道名称"/></label>
    <label>Endpoint URL<input name="endpoint" required type="url" readOnly={Boolean(initial.id)} value={endpoint} onChange={e=>setEndpoint(e.target.value)} placeholder="https://api.example.com/v1"/></label>
    {<label>充值倍率<input name="recharge-rate" required type="number" min="0.000001" max="1000000" step="any" value={rechargeRate} onChange={e=>setRechargeRate(e.target.value)} placeholder="例如 1.2"/><small className="field-hint">充值 1 元对应上游账户 {rechargeRate || '—'} 元，实际余额按上游余额 ÷ 充值倍率计算。默认 1。</small></label>}
    {provider==='newapi'?<><SecretField label="系统访问令牌" name="access-token" required={Boolean(initial.id&&!initial.edit)} value={token} onChange={e=>setToken(e.target.value)} placeholder={initial.edit?'留空以保留当前令牌':"粘贴 NewAPI 系统访问令牌"} hint={initial.edit?'如需更换令牌再填写；留空不会改变现有授权。':'用于读取令牌所属账户的余额，请填写系统访问令牌；模型调用 API Key 不适用。'}/><label>令牌所属用户 ID（可选）<input name="newapi-user-id" inputMode="numeric" pattern="[1-9][0-9]*" value={userId} onChange={e=>setUserId(e.target.value)} placeholder={"部分版本必填，可在上游个人设置中查看用户 ID"}/></label></>:<><label>用户邮箱<input name="sub2api-email" required={Boolean(initial.id&&!initial.edit)} type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="sub2API 登录邮箱"/></label><SecretField label="用户密码" name="sub2api-password" required={Boolean(initial.id&&!initial.edit)} value={password} onChange={e=>setPassword(e.target.value)} placeholder={initial.edit?'留空以保留当前授权':'sub2API 登录密码'} hint={initial.edit?'需要改密码时填写新密码；留空只保存名称或充值倍率。':"填写邮箱和密码后以普通用户身份登录，仅保存授权令牌，不保存密码；也可先留空保存渠道地址。"}/><label>两步验证码（已启用时填写）<input name="totp-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]{6}" value={totpCode} onChange={e=>setTotpCode(e.target.value)} placeholder="当前六位验证码"/></label><SecretField label="人机验证凭证（按需填写）" name="turnstile-token" value={turnstileToken} onChange={e=>setTurnstileToken(e.target.value)} placeholder="正常验证后取得的 turnstile_token" hint={<>获取方式：在上游登录页面正常完成人机验证后、提交登录前，打开浏览器控制台，执行 <code>window.turnstile?.getResponse?.()</code>，将非空结果粘贴到这里。<br/>仅用于本次登录，由上游校验；提交后清空，不保存。启用两步验证时，请一并填写当前六位验证码。</>}/></>}
    <label className="auto-probe-option"><input type="checkbox" checked={autoProbeNewTokens} onChange={e=>setAutoProbeNewTokens(e.target.checked)}/><span>自动探测新令牌<small className="field-hint">自动同步上游已有令牌并探测，不会创建上游令牌；稳定线路自动推送到已开启调度的站点。手动停用的令牌保持关闭。</small></span></label>
    </fieldset>
    {error&&<p className="site-error" role="alert">{error}</p>}
    <div className="modal-actions"><button type="button" className="cancel-button" disabled={saving} onClick={onClose}>取消</button><button className="probe-button" type="submit" disabled={saving}><Plus size={15}/>{saving?'正在保存…':initial.edit?'保存修改':'保存配置'}</button></div>
  </form></dialog>
}
function CreateTokenDialog({controls,onClose}) {
  const dialog=useRef(null)
  const [channels,setChannels]=useState([])
  const [channelId,setChannelId]=useState(controls.channelId||'')
  const [name,setName]=useState('')
  const [groupId,setGroupId]=useState('')
  const [error,setError]=useState('')
  const [loading,setLoading]=useState(true)
  useEffect(()=>{const element=dialog.current;element.showModal();return()=>element.close()},[])
  useEffect(()=>{
    const controller=new AbortController()
    requestJSON('/api/upstream-channels',null,controller.signal).then(payload=>{
      if(controller.signal.aborted)return
      const list=(payload.channels??[]).filter(channel=>!channel.needsAuthorization&&['newapi','sub2api'].includes(channel.provider))
      setChannels(list)
      setChannelId(current=>current&&list.some(channel=>channel.id===current)?current:list[0]?.id||'')
    }).catch(err=>{if(!controller.signal.aborted)setError(err.message)}).finally(()=>{if(!controller.signal.aborted)setLoading(false)})
    return()=>controller.abort()
  },[])
  const channel=channels.find(item=>item.id===channelId)
  const groups=channel?.userGroups?.groups??[]
  async function submit(event){
    event.preventDefault()
    if(await controls.createToken({channelId,name:name.trim(),groupId}))onClose()
  }
  const failure=controls.actionError?.key==='create-token'?controls.actionError.message:error
  return <dialog ref={dialog} className="modal-backdrop" aria-labelledby="create-token-title" onCancel={event=>{event.preventDefault();if(controls.busy!=='create-token')onClose()}} onClick={()=>{if(controls.busy!=='create-token')onClose()}}>
    <form className="add-modal" onSubmit={submit} onClick={event=>event.stopPropagation()}>
      <div className="modal-head"><div><h2 id="create-token-title">创建上游令牌</h2></div><button type="button" className="icon-button" aria-label="关闭" disabled={controls.busy==='create-token'} onClick={onClose}><X size={16}/></button></div>
      {loading?<p className="site-message">正在读取可创建令牌的渠道…</p>:channels.length?<><label>渠道<select value={channelId} disabled={Boolean(controls.channelId&&channels.some(item=>item.id===controls.channelId))||controls.busy==='create-token'} onChange={event=>{setChannelId(event.target.value);setGroupId('')}}>{channels.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>令牌名称<input required maxLength={50} value={name} onChange={event=>setName(event.target.value)} placeholder="例如 探针-默认分组"/></label>
        <label>绑定分组<select value={groupId} disabled={controls.busy==='create-token'} onChange={event=>setGroupId(event.target.value)}><option value="">跟随账户分组</option>{groups.map(group=><option key={group.id} value={group.id}>{group.name}{group.rate==null?'':` · ${group.rate}×`}</option>)}</select><small className="field-hint">留空则不指定分组。创建后自动同步到探针列表，页面不显示令牌明文。</small></label></>
        :<p className="site-message">没有已授权的上游渠道。请先在总览完成授权。</p>}
      {failure&&<p className="site-error" role="alert">{failure}</p>}
      <div className="modal-actions"><button type="button" className="cancel-button" disabled={controls.busy==='create-token'} onClick={onClose}>取消</button><button className="probe-button" type="submit" disabled={loading||!channels.length||controls.busy==='create-token'}><Plus size={15}/>{controls.busy==='create-token'?'正在创建…':'创建令牌'}</button></div>
    </form>
  </dialog>
}
function ProbeTokenRow({token,controls,TokenToggle}) {
  return <tr key={`${token.channelId}-${token.id}`}>
    <td><b>{token.name}</b><span className="key-meta">令牌 #{token.id}</span>{token.upstreamTokenName && <span className="key-meta">上游令牌名：{token.upstreamTokenName}</span>}</td>
    <td data-label="渠道">{token.channelName}</td>
    <td data-label="平台">{token.provider==='direct'?'调度站点直连':token.provider}</td>
    <td data-label="绑定分组">{token.groupName||token.groupId||'跟随账户'}</td>
    <td data-label="支持模型">
      <details className="probe-models">
        <summary>{token.probeModels?.length?`${token.probeModels.length} 个模型`:token.probePaused?'暂不可获取':token.modelsError?'获取失败，等待重试':token.modelsUpdatedAt?'暂无支持模型':'等待自动获取'}</summary>
        {token.modelsError&&<small className="probe-model-error">{token.modelsError}{token.probeModels?.length>0?' 已保留模型列表；已启用的探测会继续验证已有模型。':''}</small>}
        {token.modelsUpdatedAt&&<small className="key-meta">更新：{new Date(token.modelsUpdatedAt).toLocaleString('zh-CN',{hour12:false})}</small>}
        <small className="key-meta">{token.probePaused?'令牌待同步':token.modelsNextRefreshAt?`${token.modelsError?'自动重试':'下次更新'}：${new Date(token.modelsNextRefreshAt).toLocaleString('zh-CN',{hour12:false})}`:'等待自动获取'}</small>
        <Paginated items={token.probeModels||[]} label={`${token.name} 支持模型`}>{models => <ul>{models.map(model=><li key={model.id}>
          <span title={`${model.id}${model.error?` · ${model.error}`:''}`}><b><i className="model-family">{modelIdentity(model.id).family}</i>{modelIdentity(model.id).name}</b><small>{modelProtocolLabel(model)}{model.lastProbeAt ? ` · ${new Date(model.lastProbeAt).toLocaleString('zh-CN',{hour12:false})}` : ''}</small></span>
          <span title={model.costBlockReason || undefined} className={`key-status ${model.costBlocked?'inactive':model.status==='ok'?'active':model.status==='error'?'expired':model.status==='unsupported'?'inactive':''}`}>
            {model.costBlocked?'成本过高 · 暂停':model.status==='ok'?'可用':probeResultLabel(model)}{!model.costBlocked&&model.latencyMs!=null?` · ${model.latencyMs} ms`:''}
          </span>
          {model.costBlocked && <small className="key-meta">{model.costBlockReason}</small>}
          {model.autoPaused && <button type="button" className="pr-refresh" disabled={Boolean(controls.busy)||!token.probeEnabled||token.probePaused||model.costBlocked}
            title={token.probeEnabled?'在下个正常探测周期重新验证，保留历史记录':'请先启用此令牌的探测'}
            aria-label={`重新验证 ${token.name} 的 ${model.id}`} onClick={()=>controls.revalidate(token,model)}>重新验证</button>}
        </li>)}</ul>}</Paginated>
      </details>
    </td>
    <td data-label="探测开关">
      <TokenToggle token={token} controls={controls}/>
    </td>
    <td data-label="最近结果">
      {token.probeStatus==='ok'?<><span className="key-status active">正常</span>{token.probeLatencyMs != null && <small>{token.probeLatencyMs} ms</small>}</>:token.probeStatus==='error'?<span className="key-status expired">失败</span>:token.probeStatus==='inconclusive'?<span className="key-status" title={token.probeError}>{probeResultLabel({status:token.probeStatus,reason:token.probeModels?.find(model=>model.id===token.lastProbeModel)?.reason})}</span>:'—'}
      {token.lastProbeAt&&<small>{new Date(token.lastProbeAt).toLocaleString('zh-CN',{hour12:false})}</small>}
    </td>
    <td data-label="最近同步">{token.updatedAt?new Date(token.updatedAt).toLocaleString('zh-CN',{hour12:false}):'—'}</td>
    <td data-label="操作">{['newapi','sub2api'].includes(token.provider)&&<button type="button" className="pr-refresh pr-stop" disabled={Boolean(controls.busy)} aria-label={`删除令牌 ${token.name} #${token.id}`} title="在上游删除该令牌。已关联调度线路时会拒绝。" onClick={()=>{if(window.confirm(`删除上游令牌「${token.name}」？已关联调度线路的令牌会拒绝删除。`))void controls.removeToken(token)}}><Trash size={14}/>删除</button>}</td>
  </tr>
}

function ProbeTokenGroup({group,controls,TokenToggle,search}) {
  const providers = [...new Set(group.tokens.map(token=>token.provider))].join(' · ')
  const channels = [...new Set(group.tokens.map(token=>token.channelName))]
  return <details className="endpoint-group">
        <summary>
          <span className="endpoint-group-main"><b className="mono">{group.endpoint}</b><small>{providers} · {channels.slice(0,3).join('、')}{channels.length>3?` 等 ${channels.length} 个渠道`:''}</small></span>
          <span className="endpoint-group-count">{group.tokens.length} 个令牌</span>
        </summary>
        <Paginated items={group.tokens} resetKey={search} label={`${group.endpoint} 令牌`}>{tokens => <div className="endpoint-group-table"><table className="token-table mobile-list-table"><thead><tr><th>令牌</th><th>渠道</th><th>Provider</th><th>绑定分组</th><th>支持模型 / 可用性</th><th>探测</th><th>最近结果</th><th>最近同步</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>{tokens.map(token=><ProbeTokenRow key={`${token.channelId}-${token.id}`} token={token} controls={controls} TokenToggle={TokenToggle}/>)}</tbody></table></div>}</Paginated>
  </details>
}

function ProbeTokens({controls,TokenToggle}){
  const {tokens,policy,loading,busy,disableBatch,enableBatch}=controls
  const [query,setQuery]=useState('')
  const [creating,setCreating]=useState(false)
  const search=query.trim().toLowerCase()
  const visible=useMemo(()=>tokens.filter(token=>`${token.channelName} ${token.name} #${token.id} ${token.groupName||''} ${token.endpoint}`.toLowerCase().includes(search)),[tokens,search])
  const groupedTokens=useMemo(()=>{const groups=new Map();for(const token of visible){const endpoint=token.endpoint||'未提供 Endpoint';if(!groups.has(endpoint))groups.set(endpoint,{endpoint,tokens:[]});groups.get(endpoint).tokens.push(token)}return [...groups.values()]},[visible])
  const stopTokens=visible.filter(token=>token.probeEnabled)
  const startTokens=visible.filter(token=>!token.probeEnabled&&!token.probePaused)
  return <div className="probe-tokens-page"><div className="panel-header table-head"><div><h2>上游令牌</h2><p>{visible.length} / {tokens.length} 个令牌 · {groupedTokens.length} 个 Endpoint · 每个模型每 {policy.intervalSec} 秒探测</p></div></div>
    <div className="pr-toolbar pm-token-toolbar"><label className="pr-search"><MagnifyingGlass size={16}/><input type="search" aria-label="搜索令牌渠道、名称或 Endpoint" placeholder="输入渠道名称筛选令牌" value={query} onChange={event=>setQuery(event.target.value)}/></label>
      <button type="button" className="probe-button" disabled={loading||Boolean(busy)} onClick={()=>setCreating(true)}><Plus size={15}/>创建令牌</button>
      <button type="button" className="pr-refresh" disabled={loading||Boolean(busy)||!startTokens.length} onClick={()=>void enableBatch(startTokens)}><Play size={15}/>{busy==='batch-enable'?'正在启用…':`批量启用检测（${startTokens.length}）`}</button>
      <button type="button" className="pr-refresh pr-stop" disabled={loading||Boolean(busy)||!stopTokens.length}
        title={`停止当前${search?'搜索结果':'列表'}中 ${stopTokens.length} 个令牌的全部模型探测，保留历史记录。`}
        onClick={()=>void disableBatch(stopTokens)}><Pause size={15}/>{busy==='batch-disable'?'正在停止…':`批量停止（${stopTokens.length}）`}</button></div>
    {creating&&<CreateTokenDialog controls={controls} onClose={()=>setCreating(false)}/>}
    {loading?<p className="site-message" role="status">正在读取探针令牌…</p>:groupedTokens.length?<Paginated items={groupedTokens} resetKey={search} label="Endpoint" always>{groups => <div className="probe-endpoint-list">{groups.map(group=><ProbeTokenGroup key={group.endpoint} group={group} controls={controls} TokenToggle={TokenToggle} search={search}/>)}</div>}</Paginated>:<div className="table-scroll"><div className="table-empty"><Key size={20}/><span>{tokens.length?'没有匹配的令牌，请调整渠道名称或搜索条件。':'暂无可用探针令牌。自动接入将持续同步；可在上方查看接入进度。'}</span></div></div>}</div>
}
function App(){
  const consoleSettings = useConsoleSettings()
  const location = useSyncExternalStore(subscribeToPage, () => window.location.hash)
  const active = currentPage()
  const pageParams = new URLSearchParams(location.split('?')[1] || '')
  const setActive = page => { window.location.hash = page }
  const [cached] = useState(() => readViewCache('/api/upstream-channels'))
  const cacheGeneration = useRef(viewCacheGeneration())
  const [cachedAt, setCachedAt] = useState(cached?.savedAt ?? null)
  const [channelsLoading, setChannelsLoading] = useState(!cached)
  const [channelsError, setChannelsError] = useState('')
  const [channelReload, setChannelReload] = useState(0)
  const [data, setData] = useState(cached?.data.channels ?? [])
  const [authBusy, setAuthBusy] = useState([])
  const [detailError, setDetailError] = useState(null)
  const channelRevision = useRef(0)
  function acceptChannels(channels) {
    setData(channels); setCachedAt(null)
    writeViewCache('/api/upstream-channels', { channels }, cacheGeneration.current)
  }
  useEffect(() => {
    if (active !== 'overview') return
    const controller = new AbortController()
    let reading = false
    setChannelsError('')
    async function loadChannels() {
      if (reading) return
      reading = true
      const revision = channelRevision.current
      try {
        const channels = await requestChannels(null, controller.signal)
        if (!controller.signal.aborted && revision === channelRevision.current) { acceptChannels(channels); setChannelsError('') }
      } catch(error) { if (!controller.signal.aborted && revision === channelRevision.current) setChannelsError(error.message) }
      finally { reading = false; if (!controller.signal.aborted) setChannelsLoading(false) }
    }
    void loadChannels()
    const timer = setInterval(loadChannels, 30000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [active, channelReload])
  async function saveChannel(values) {
    channelRevision.current++
    try {
      const channels = await requestChannels({...values,id:addOpen?.id,edit:Boolean(addOpen?.edit)})
      acceptChannels(channels)
      setAddOpen(null)
      if (active !== 'overview') setActive('overview')
      setChannelsError('')
      notify(values.autoProbeNewTokens ? '渠道已保存，后台将自动同步令牌并接入探测' : '渠道配置已保存')
      consoleSettings.refresh()
    } finally { channelRevision.current++ }
  }
  async function checkAccount(channel, kind = 'auth') {
    channelRevision.current++
    if (kind === 'groups') setDetailError(null)
    setAuthBusy(current=>[...current,channel.id])
    try {
      acceptChannels(await requestChannels({},null,`/api/upstream-channels/${channel.id}/${kind}/${kind==='groups'?'sync':'check'}`))
      setChannelsError('')
      consoleSettings.refresh()
    } catch(error) { if(kind==='groups') setDetailError({id:channel.id,message:error.message}); else setChannelsError(error.message) }
    finally { channelRevision.current++; setAuthBusy(current=>current.filter(id=>id!==channel.id)) }
  }
  function inspect(channel) {
    setSelected(channel.id)
    setDetailError(null)
  }
  let[selected,setSelected]=useState(null),[addOpen,setAddOpen]=useState(null),[toast,setToast]=useState('');let notify=m=>{setToast(m);setTimeout(()=>setToast(''),2200)};let probe=()=>setActive('probes');let toggle=channelId=>setActive(`probes?${new URLSearchParams({channel:channelId})}`);return <div className="app-shell"><Sidebar active={active} setActive={setActive}/><main className="main"><Topbar active={active} onProbe={probe}/><BalanceNotice state={consoleSettings} onFundingChanged={()=>setChannelReload(value=>value+1)}/>{['probe-tokens','probes'].includes(active)?<ProbeMonitor key={pageParams.get('channel')||'all'} channelId={pageParams.get('channel')} channelName={data.find(channel=>channel.id===pageParams.get('channel'))?.name} onClearChannel={()=>setActive(active)} tokenTab={active==='probe-tokens'} onTabChange={tokens=>setActive(`${tokens?'probe-tokens':'probes'}${pageParams.get('channel')?`?${new URLSearchParams({channel:pageParams.get('channel')})}`:''}`)} TokensView={ProbeTokens} identifyModel={modelIdentity} protocolLabel={modelProtocolLabel}/>:active==='overview'?<><div className="page-actions"><span className="refresh-status"><span className="refresh-dot"/>渠道与探针汇总每 30 秒刷新</span></div>{cachedAt && <p className="cached-data-note">{cachedDataLabel(cachedAt)}</p>}{channelsLoading ? <p className="site-message" role="status">正在读取上游渠道…</p>
      : <>{channelsError && <div className="site-error" role="alert">{channelsError}<button onClick={()=>setChannelReload(value=>value+1)}>重试</button></div>}
      {(!channelsError || data.length>0) && <><Table data={data} view={location.split('?')[1] || ''} description={`${data.length} 个已保存渠道 · 余额与授权状态每 30 秒刷新显示`} onInspect={inspect} onToggle={toggle} onAdd={()=>setAddOpen({})} onEdit={channel=>setAddOpen({...channel,edit:true,provider:channel.provider==='Sub2API'?'sub2api':'newapi'})} authBusy={authBusy} onCheckAuth={checkAccount} onCheckBalance={channel=>checkAccount(channel,'balance')} onAuthorize={channel=>setAddOpen({...channel,provider:channel.provider==='Sub2API'?'sub2api':'newapi'})}/><p className="site-session-note">账户余额约每 5 分钟自动查询，也可手动刷新；关闭浏览器后，本地服务继续查询并为 Sub2API 自动续期。余额仅代表账户钱包，不含订阅套餐额度；查询失败会保留并标记上次结果。</p></>}</>}</>:active==='logs'?<LogCenter siteId={pageParams.get('site')||''} channelId={pageParams.get('channel')||''}/>:active==='settings'?<ConsoleSettings state={consoleSettings}/>:active==='secondary-channels'||routePages.includes(active)?<SecondarySites SecretField={SecretField} page={active} siteId={pageParams.get('site')} groupId={pageParams.get('group')}/>:null}</main>{selected&&data.some(channel=>channel.id===selected)&&<ChannelDetail key={selected} channel={data.find(channel=>channel.id===selected)} onClose={()=>setSelected(null)} onRefresh={()=>checkAccount(data.find(channel=>channel.id===selected),'groups')} busy={authBusy.includes(selected)} error={detailError?.id===selected?detailError.message:''}/>} {addOpen&&<AddModal key={addOpen.id||'new'} initial={addOpen} onClose={()=>setAddOpen(null)} onSave={saveChannel}/>} {toast&&<div className="toast"><Check size={16} weight="bold"/>{toast}</div>} </div>
}

import {createRoot} from 'react-dom/client';
createRoot(document.getElementById('root')).render(<SessionGate><App/></SessionGate>);
