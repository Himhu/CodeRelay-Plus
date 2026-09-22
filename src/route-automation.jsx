import { useState } from 'react'
import { requestJSON } from './console-fetch.js'
import { Paginated } from './pagination.jsx'
import './route-automation.css'

const labels = { ready: '待推送', standby: '等待重新验证', switching: '等待重新验证', discovering: '识别模型', verifying: '等待验证', healthy: '正常调度', observing: '短暂异常观察', cooldown: '已隔离', recovering: '恢复验证', waiting: '等待探针', error: '接入失败', shadow: '影子模式', frozen: '紧急冻结', approval: '待审批', foreign: '非本站账号', hold: '人工暂停' }
const rate = value => Number.isFinite(value) ? `${Number(value.toPrecision(8))}×` : '未确认'
const time = at => at ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : '尚未运行'
const activeStates = new Set(['healthy', 'observing', 'ready'])
const attention = route => ['error', 'foreign', 'approval', 'frozen', 'shadow', 'hold'].includes(route.state) || (!route.groupId && route.groups?.length > 1 && route.enabled !== false)

export default function RouteAutomation({ site, initialGroupId, onChange }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [query, setQuery] = useState('')
  const state = site.automation ?? { enabled: false, accounts: [] }
  const [filter, setFilter] = useState(() => (state.routes ?? []).some(route => activeStates.has(route.state)) ? 'active' : 'all')
  async function save(values) {
    if (busy) return
    setBusy(true); setError('')
    try { onChange((await requestJSON(`/api/secondary-sites/${site.id}/automation`, values)).site) }
    catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }
  const all = (state.routes ?? []).filter(route => !initialGroupId || String(route.groupId) === initialGroupId)
  const filters = [
    ['active', '参与调度', all.filter(route => activeStates.has(route.state))],
    ['attention', '需处理', all.filter(attention)],
    ['waiting', '暂停与等待', all.filter(route => !activeStates.has(route.state) && !attention(route))],
    ['all', '全部', all],
  ]
  const routes = filters.find(([id]) => id === filter)[2].filter(route => `${route.upstreamName} ${route.tokenName} ${route.groupName} ${route.endpoint} ${route.family || ''} ${route.targetGroupName || ''}`.toLowerCase().includes(query.trim().toLowerCase()))
  return <section className="route-automation" aria-label="自动调度">
    <div className="ra-heading"><div><h2>自动调度</h2><p>自动接入 → 探测验证 → 全部达标线路调度 → 异常恢复</p></div>
      <button type="button" role="switch" aria-checked={state.enabled} aria-label="启用自动推送" className={`outline-button ${state.enabled ? 'ra-enabled' : ''}`} disabled={busy} onClick={() => save({ enabled: !state.enabled })}>{busy ? '保存中…' : state.enabled ? '自动推送已开启' : '开启自动推送'}</button></div>
    <div className="ra-summary"><span>{(state.accounts ?? []).filter(item => item.managed).length} 条自动管理</span><span>{all.filter(attention).length} 条需处理</span><span>最近核对：{time(state.lastRunAt)}</span><a href={`#logs?site=${encodeURIComponent(site.id)}`}>运行日志</a></div>
    {!state.enabled && <p className="site-session-note">自动推送已关闭。开启后，后台自动推送所有倍率达标且验证正常的线路，已关联线路统一自动管理。</p>}
    {(error || state.error) && <p className="site-error" role="alert">{error || state.error}</p>}
    <div className="ra-gates" role="group" aria-label="调度闸门">
      <button type="button" aria-pressed={state.shadow === true} title="只计算调度结果，不写入调度站" disabled={busy} onClick={() => save({ shadow: state.shadow !== true })}>影子模式</button>
      <button type="button" aria-pressed={state.freeze === true} title="立刻停止自动写入" disabled={busy} onClick={() => save({ freeze: state.freeze !== true })}>紧急冻结</button>
      <button type="button" aria-pressed={state.approve === true} title="每轮写入前需要手动批准" disabled={busy} onClick={() => save({ approve: state.approve !== true })}>写入审批</button>
      <button type="button" aria-pressed={state.ownedOnly === true} title="不修改不是本站创建的调度账号" disabled={busy} onClick={() => save({ ownedOnly: state.ownedOnly !== true })}>只改本站账号</button>
      <label className="ra-rank">排序<select aria-label="调度排序" value={state.rank || 'keep'} disabled={busy} onChange={event => save({ rank: event.target.value })}><option value="keep">保持优先级</option><option value="price">价格优先</option><option value="speed">速度优先</option></select>{state.rank === 'speed' && <span className="ra-priority">101 最快</span>}{state.rank === 'price' && <span className="ra-priority">101 最低价</span>}</label>
      {state.approve === true && <button type="button" className="ra-approve" disabled={busy} onClick={() => save({ approveOnce: true })}>批准下一轮写入</button>}
    </div>
    <div className="ra-tools"><div className="ra-filters" role="group" aria-label="调度线路筛选">{filters.map(([id, title, rows]) => <button type="button" key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>{title}<span>{rows.length}</span></button>)}</div>
      <label className="rw-search"><span className="sr-only">搜索线路</span><input type="search" aria-label="搜索线路" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索上游、模型系列或分组"/></label></div>
    {initialGroupId && <a className="text-button" href={`#route-automation?site=${encodeURIComponent(site.id)}`}>查看全部分组</a>}
    <Paginated items={routes} resetKey={JSON.stringify([site.id, query, filter, initialGroupId])} label="自动调度线路" always>{rows => <div className="table-scroll"><table className="group-rates-table mobile-list-table ra-table"><thead><tr><th>上游 / 模型系列</th><th>目标调度分组</th><th>推送状态</th><th>模型与详情</th></tr></thead><tbody>{rows.map(route => <tr key={route.id}>
      <td><b>{route.tokenName}</b>{route.family && <span className="ra-family">{route.family}</span>}<span className="group-description">令牌 #{route.tokenId}{route.accountId ? ` · 调度账号 #${route.accountId}` : ''}</span></td>
      <td data-label="目标分组">{route.groupId ? <b>{route.groups.find(group => group.id === route.groupId)?.name || route.targetGroupName || `#${route.groupId}`}</b> : route.groups.length > 1 ? <select aria-label={`目标分组 ${route.upstreamName} ${route.tokenId} ${route.platform}${route.family ? ` ${route.family}` : ''}`} value="" disabled={busy || Boolean(route.accountId)} onChange={event => save({ routeId: route.id, groupId: Number(event.target.value) })}>
        <option value="" disabled>选择目标分组</option>{route.groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select> : <span>{route.groups[0]?.name || '未匹配分组'}</span>}
        <span className="group-description">上游成本 {rate(route.cost)} · 调度分组 {rate(route.targetRate)}</span>
        {!!route.groupId && !route.accountId && route.groups.length > 1 && <details><summary>更换目标</summary><select aria-label={`更换目标分组 ${route.upstreamName} ${route.tokenId}`} value={route.groupId} disabled={busy} onChange={event => save({ routeId: route.id, groupId: Number(event.target.value) })}>{route.groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></details>}</td>
      <td data-label="推送状态"><span className={`rb-status ${route.state === 'healthy' ? 'ok' : 'review'}`}>{labels[route.state] || '等待推送'}</span>{attention(route) && <span className="group-description">{route.reason}</span>}{route.accountId && <button type="button" className="text-button" disabled={busy} onClick={() => save({ routeId: route.id, hold: route.hold !== true })}>{route.hold ? '恢复自动' : '人工暂停'}</button>}</td>
      <td data-label="模型"><details><summary>{route.modelCount != null && `共 ${route.modelCount} · `}可用 {route.availableModels.length} · 异常 {route.excludedModels.length}{route.retainedModels?.length ? ` · 观察 ${route.retainedModels.length}` : ''}</summary>
        <p>{route.reason}</p><p className="group-description">{route.endpoint}<br/>{route.groupName || '未分组'} · {route.accountPlatform || route.platform}</p>
        <Paginated items={route.availableModels} label="可用模型">{models => <p>可用：{models.join('、') || '暂无'}</p>}</Paginated><Paginated items={route.excludedModels} label="异常模型">{models => <p>异常：{models.join('、') || '暂无'}</p>}</Paginated>
        {!!route.retainedModels?.length && <Paginated items={route.retainedModels} label="观察期模型">{models => <p>观察期保留：{models.join('、')}（上次成功仍在两分钟内）</p>}</Paginated>}
        <a href={route.channelId ? `#probes?channel=${encodeURIComponent(route.channelId)}` : '#probes'}>查看探测记录</a></details></td>
    </tr>)}</tbody></table>{!routes.length && <p className="inline-empty">{all.length ? '当前筛选没有线路，可切换“全部”查看。' : '等待上游自动接入；可先在总览添加渠道。'}</p>}</div>}</Paginated>
    <details className="ra-rules"><summary>自动处理规则</summary><p className="ra-policy">上游开启自动接入后，后台同步已有令牌，获取模型并探测。上游没有令牌的分组不会自动创建。实际成本不高于调度分组、且模型探测正常的线路全部参与调度。同一个模型可由多条线路同时承接，不再设置主用或备用。影子模式、紧急冻结和写入审批默认关闭；开启后才会拦住调度站写入。价格优先和速度优先从优先级 101 起排序，数字越小越先被调度，速度相差不到 50ms 时不互换。只改本站账号开启后，不会修改不是本站创建的调度账号。人工暂停不会被探测结果自动解开。</p><p className="ra-policy">正常模型每分钟探测；已隔离模型每 5 分钟复测。短暂异常保留最近成功起两分钟的观察期；余额恢复、倍率恢复或连续验证通过后，后台自动恢复符合条件的线路。已关联线路的调度开关由系统维护，停用账号需重新验证后恢复。关闭探针后，对应线路自动退出调度。</p><p className="ra-policy">目标分组不唯一、凭据失效、写入结果未确认等情况仍需处理，原因在对应线路详情和日志中显示。</p></details>
  </section>
}
