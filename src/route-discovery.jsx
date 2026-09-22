import { useEffect, useRef, useState } from 'react'
import { CaretDown, CaretDoubleDown, CaretDoubleUp, CaretRight, CheckCircle, Info, Link, MagnifyingGlass, WarningCircle, X } from '@phosphor-icons/react'
import { requestJSON as request } from './console-fetch.js'
import { Paginated } from './pagination.jsx'
import { routeHref } from './route-navigation.js'

const statusNames = { eligible: '符合条件', 'cost-too-high': '倍率高于分组', 'unknown-price': '成本待确认', unmatched: '不匹配', unavailable: '暂不可用' }
const tokenNames = { existing: '已复用', missing: '未创建', unusable: '不可用', error: '待处理' }
const rate = value => !Number.isFinite(value) ? '未确认' : `${Number(value.toPrecision(8))}×`
const criteriaKey = config => JSON.stringify([Number(config.groupId), config.targetRate ?? null])
const rowKey = row => JSON.stringify([row.upstreamId, row.groupId])

function CandidateDetail({ row, accounts, disabled, onClose, onUse }) {
  const dialog = useRef(null)
  const [accountId, setAccountId] = useState(row.accountSuggestions.length === 1 ? String(row.accountSuggestions[0].id) : '')
  const [modelSearch, setModelSearch] = useState('')
  useEffect(() => { const element = dialog.current; element.showModal(); return () => element.close() }, [])
  const usable = row.tokenId && row.models.some(model => model.protocol !== 'unsupported') && row.status === 'eligible'
  const models = row.models.filter(model => model.id.toLowerCase().includes(modelSearch.trim().toLowerCase()))
  return <dialog ref={dialog} className="rd-detail" aria-labelledby="rd-detail-title" onCancel={event => { event.preventDefault(); onClose() }}>
    <div className="rd-detail-head"><div><span>{row.upstreamName} · #{row.groupId}</span><h2 id="rd-detail-title">{row.groupName}</h2></div>
      <button className="icon-button" type="button" title="关闭详情" aria-label="关闭详情" onClick={onClose}><X size={20}/></button></div>
    <div className="rd-detail-body">
      <div className={`rd-verdict ${row.status === 'eligible' ? 'ok' : 'review'}`}>
        {row.status === 'eligible' ? <CheckCircle size={21}/> : <WarningCircle size={21}/>}
        <div><b>{statusNames[row.status]}</b><p>{row.reason}</p></div></div>
      <section><h3>倍率比较</h3><dl className="rd-calculation">
        <div><dt>上游适用倍率{row.rateSource === 'custom' ? '（用户专属）' : ''}</dt><dd>{rate(row.rawRate)}</dd></div>
        <div><dt>充值倍率</dt><dd>{rate(row.rechargeRate)}</dd></div>
        <div><dt>高峰因子</dt><dd>{rate(row.peakFactor)}</dd></div>
        <div className="rd-calculation-total"><dt>折算成本倍率</dt><dd>{rate(row.costRate)}</dd></div>
        <div><dt>调度站分组倍率</dt><dd>{rate(row.targetRate)}</dd></div>
      </dl>
        {row.pricingNote && <p className="rd-caution"><Info size={15}/>{row.pricingNote}</p>}
        <p className="rd-price-note">折算倍率不高于调度站分组倍率，且探测验证正常的线路全部参与调度。</p></section>
      <section><h3>令牌与模型 <span>{row.models.length} 个模型</span></h3>
        <div className="rd-token-info"><span>{tokenNames[row.tokenState]}</span><b>{row.tokenName || '暂无可用令牌'}</b></div>
        {row.tokenError && <p className="site-error" role="alert">{row.tokenError}</p>}
        {row.models.length ? <details className="rd-models"><summary>支持模型 <CaretDown size={14}/></summary>
          <input type="search" aria-label="搜索支持模型" placeholder="搜索模型" value={modelSearch} onChange={event => setModelSearch(event.target.value)}/>
          <Paginated items={models} resetKey={modelSearch} label="支持模型">{rows => <ul>{rows.map(model => <li key={model.id}><b>{model.id}</b><span>{model.protocol}</span></li>)}</ul>}</Paginated>{!models.length && <p className="rd-price-note">没有匹配模型</p>}
        </details> : <p className="rd-price-note">{row.tokenId ? '上游尚未返回支持模型。' : '令牌就绪后获取模型目录。'}</p>}
      </section>
      <section><h3>关联调度站点账号</h3>
        {usable ? <label className="rd-account-label">调度站点账号<select aria-label="关联调度站点账号" value={accountId} disabled={disabled} onChange={event => setAccountId(event.target.value)}>
          <option value="">选择调度站点账号</option>{accounts.map(account => <option key={account.id} value={account.id}>{row.accountSuggestions.some(item => item.id === account.id) ? '推荐 · ' : ''}{account.name} #{account.id}</option>)}</select></label>
          : <p className="rd-price-note">{row.status !== 'eligible' ? '此线路尚未满足筛选条件。' : '等待令牌和模型目录就绪。'}</p>}
        {usable && !accounts.length && <p className="rd-price-note">目标分组暂无调度站点账号。</p>}
      </section>
    </div>
    <div className="rd-detail-footer"><button type="button" className="outline-button" onClick={onClose}>关闭</button>
      <button type="button" className="probe-button" disabled={disabled || !usable || !accountId || !accounts.some(account => String(account.id) === accountId)} onClick={() => {
        onClose(); onUse(row, accounts.find(account => String(account.id) === accountId))
      }}><Link size={16}/>填入关联</button></div>
  </dialog>
}

export default function RouteDiscovery({ site, initialGroupId, onUse }) {
  const [groupId, setGroupId] = useState(initialGroupId || String(site.groups.find(group => group.status === 'active')?.id || site.groups[0]?.id || ''))
  const [job, setJob] = useState(null)
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [expanded, setExpanded] = useState({})
  const [selected, setSelected] = useState(null)
  const [notice, setNotice] = useState('')
  const path = `/api/secondary-sites/${site.id}/discovery`
  const running = starting || job?.status === 'running'
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setSelected(null)
    request(path, null, controller.signal).then(data => {
      if (controller.signal.aborted) return
      setJob(data.job); setError('')
      if (data.job && (!initialGroupId || data.job.config.groupId === Number(initialGroupId) || data.job.status === 'running')) {
        setGroupId(String(data.job.config.groupId))
        setNotice(data.job.status === 'running' && initialGroupId && data.job.config.groupId !== Number(initialGroupId) ? '此调度站点已有识别任务运行中，正在显示该任务。' : '')
      } else {
        const group = initialGroupId ? site.groups.find(group => String(group.id) === initialGroupId) : site.groups.find(group => group.status === 'active') || site.groups[0]
        setGroupId(String(group?.id || ''))
        setNotice(initialGroupId && !group ? '目标分组已不存在，请重新选择。' : '')
      }
    }).catch(err => { if (!controller.signal.aborted) setError(err.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [path, reload, initialGroupId])
  useEffect(() => {
    if (job?.status !== 'running') return
    const controller = new AbortController()
    let timer
    async function poll() {
      try { const data = await request(path, null, controller.signal); if (!controller.signal.aborted) { setJob(data.job); setError('') } }
      catch (err) { if (!controller.signal.aborted) setError(err.message) }
      if (!controller.signal.aborted) timer = setTimeout(poll, 2000)
    }
    timer = setTimeout(poll, 1000)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [path, job?.id, job?.status])
  async function start() {
    if (running) return
    setStarting(true); setError(''); setSelected(null); setNotice('')
    try { setJob((await request(path, { groupId: Number(groupId) })).job); setExpanded({}); setSettingsOpen(false) }
    catch (err) { setError(err.message) }
    finally { setStarting(false) }
  }
  const targetRate = site.groups.find(group => group.id === Number(groupId))?.rate ?? null
  const activeJob = job && criteriaKey(job.config) === criteriaKey({ groupId, targetRate }) ? job : null
  const accounts = site.accounts.filter(account => account.groupIds.includes(Number(groupId)))
  const allRows = activeJob?.rows ?? []
  const eligibleCount = allRows.filter(row => row.status === 'eligible').length
  const issueRows = allRows.filter(row => row.tokenError || ['unknown-price', 'unavailable'].includes(row.status))
  const selectedRow = allRows.find(row => rowKey(row) === selected)
  const visibleUpstreams = (activeJob?.upstreams ?? []).map(upstream => ({
    ...upstream, rows: allRows.filter(row => row.upstreamId === upstream.upstreamId &&
      [row.groupName, row.upstreamName, ...row.keywords].join(' ').toLowerCase().includes(search.trim().toLowerCase()) &&
      (filter === 'all' || (filter === 'eligible' ? row.status === 'eligible' : issueRows.includes(row)))),
  })).filter(upstream => upstream.rows.length || upstream.error || upstream.status === 'running' || (!search && filter === 'all'))
  const pagingKey = JSON.stringify([site.id, job?.id, groupId, search, filter])
  const allExpanded = visibleUpstreams.length > 0 && visibleUpstreams.every(upstream => expanded[upstream.upstreamId])
  return <section className="rd-page" aria-label="智能选线">
    <h2 className="sr-only">智能选线</h2><p className="site-session-note">这是手动扫描工具。已开启自动接入和自动调度的线路由后台持续处理，无需在此重复选线。</p>
    <fieldset className="rd-controls" disabled={loading || running}>
      <label>目标调度站点分组<select aria-label="目标调度站点分组" value={groupId} onChange={event => { window.location.hash = routeHref('route-discovery', site.id, event.target.value) }}>
        {!groupId && <option value="">选择分组</option>}{site.groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
      <button type="button" className="probe-button rd-start" disabled={!groupId} onClick={start}><MagnifyingGlass size={16}/>{running ? '识别中…' : '开始选线'}</button>
      <details className="rd-settings" open={settingsOpen} onToggle={event => setSettingsOpen(event.currentTarget.open)}>
        <summary><CaretRight size={14}/><span>选线设置</span><small>调度站分组倍率 {rate(targetRate)} · 只读取已有令牌</small></summary>
        <div className="rd-settings-body"><div className="rd-settings-fields">
          <span>调度站分组倍率 <b>{rate(targetRate)}</b></span>
          <p className="rd-price-note">仅识别线路和已有令牌；缺少令牌时，请在上游站点创建后同步。</p></div>
      <div className="rd-notes">
        <p>折算成本倍率 = 上游适用倍率 × 高峰因子 ÷ 充值倍率。不高于目标调度站分组倍率即可接入，相等也允许；探测验证正常后全部参与调度。</p>
        <p>分组倍率直接从调度站读取，无需填写百分比或参考售价。只使用上游已有令牌；新同步的令牌是否自动探测跟随渠道的“自动探测新令牌”设置。</p>
      </div></div></details>
    </fieldset>
    {loading && <p className="site-message" role="status">正在读取识别配置…</p>}
    {notice && <p className="rd-caution" role="status"><Info size={16}/>{notice}</p>}
    {error && <div className="site-error" role="alert">{error}<button disabled={running} onClick={() => setReload(value => value + 1)}>重新读取</button></div>}
    {job && !activeJob && !loading && <p className="rd-caution" role="status"><Info size={16}/>筛选条件已变更，请重新识别以更新结果。</p>}
    {!job && !loading && !error && <div className="rw-empty"><h3>{site.groups.length ? '暂无识别结果' : '调度站点暂无分组'}</h3></div>}
    {activeJob && <>
      <div className="rd-progress" role="status" title={activeJob.finishedAt && new Date(activeJob.finishedAt).toLocaleString('zh-CN', { hour12: false })}>
        <span>{activeJob.status === 'running' ? '正在识别' : activeJob.status === 'complete' ? '识别完成' : activeJob.status === 'error' ? '识别失败' : '部分结果需处理'} · 上游 {activeJob.completed} / {activeJob.total}</span>
        <span>已找到 {activeJob.reused ?? 0} 个可用的已有令牌</span></div>
      <Paginated items={activeJob.errors} resetKey={job?.id} label="识别错误">{errors => errors.map((message, index) => <p key={index} className="site-error" role="alert">{message}</p>)}</Paginated>
      <div className="rd-results-toolbar">
        <label className="rw-search"><MagnifyingGlass size={17}/><input type="search" aria-label="搜索上游线路" placeholder="搜索上游或线路" value={search} onChange={event => setSearch(event.target.value)}/></label>
        <div className="rd-result-tabs" role="group" aria-label="线路结果筛选">{[['all', '全部', allRows.length], ['eligible', '符合条件', eligibleCount], ['issues', '待处理', issueRows.length]].map(([id, label, count]) =>
        <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}<span>{count}</span></button>)}</div>
        <button className="icon-button" title={allExpanded ? '收起全部上游' : '展开全部上游'} aria-label={allExpanded ? '收起全部上游' : '展开全部上游'} onClick={() => setExpanded(allExpanded ? {} : Object.fromEntries(visibleUpstreams.map(item => [item.upstreamId, true])))}>{allExpanded ? <CaretDoubleUp size={18}/> : <CaretDoubleDown size={18}/>}</button></div>
      <Paginated items={visibleUpstreams} resetKey={pagingKey} label="选线上游" always>{upstreams => <div className="rd-upstreams">{upstreams.map(upstream => {
        const eligible = allRows.filter(row => row.upstreamId === upstream.upstreamId && row.status === 'eligible').length
        return <div className="rd-upstream" key={upstream.upstreamId}>
          <button type="button" className="rd-upstream-heading" aria-label={`展开上游 ${upstream.name}`} aria-expanded={expanded[upstream.upstreamId] === true} aria-controls={`routes-${upstream.upstreamId}`} onClick={() => setExpanded(current => ({ ...current, [upstream.upstreamId]: !current[upstream.upstreamId] }))}>
            <CaretRight size={16} className={expanded[upstream.upstreamId] ? 'rd-caret-open' : ''}/><b>{upstream.name}</b>
            <span>{upstream.status === 'running' ? '同步中' : upstream.status === 'error' ? '同步失败' : `${upstream.routes} 条线路 · ${eligible} 条符合`}</span>
          </button>
          {upstream.error && <p className="site-error" role="alert">{upstream.error}</p>}
          <div id={`routes-${upstream.upstreamId}`} hidden={!expanded[upstream.upstreamId]}>
            {upstream.rows.length ? <Paginated items={upstream.rows} resetKey={pagingKey} label={`${upstream.name} 线路`}>{rows => <div className="table-scroll"><table className="rd-table mobile-list-table"><thead><tr><th>上游线路</th><th>判定</th><th>成本倍率</th><th>调度分组倍率</th><th>令牌</th><th><span className="sr-only">详情</span></th></tr></thead>
              <tbody>{rows.map(row => <tr key={rowKey(row)}>
                <td><button type="button" className="rd-route-name" title={row.groupName} onClick={() => setSelected(rowKey(row))}>{row.groupName}</button></td>
                <td data-label="判定"><span className={`rd-status ${row.status}`} title={row.reason}>{statusNames[row.status]}</span></td>
                <td data-label="成本倍率">{rate(row.costRate)}</td><td data-label="调度分组倍率">{rate(row.targetRate)}</td>
                <td data-label="令牌"><span className={row.tokenError ? 'rb-status review' : 'rd-token-state'}>{row.tokenError ? '待处理' : tokenNames[row.tokenState]}</span></td>
                <td><button type="button" className="icon-button" title="查看线路详情" aria-label={`查看 ${row.upstreamName} ${row.groupName} 详情`} onClick={() => setSelected(rowKey(row))}><CaretRight size={19}/></button></td>
              </tr>)}</tbody></table></div>}</Paginated> : <p className="rw-empty">{upstream.status === 'running' ? '正在读取线路…' : '当前没有匹配线路'}</p>}
          </div>
        </div>
      })}</div>}</Paginated>
      {!visibleUpstreams.length && <p className="rw-empty">没有匹配的上游线路</p>}
    </>}
    {selectedRow && <CandidateDetail key={rowKey(selectedRow)} row={selectedRow} accounts={accounts} disabled={running} onClose={() => setSelected(null)} onUse={onUse}/>}
  </section>
}
