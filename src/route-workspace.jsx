import { ArrowsClockwise, GearSix, GitBranch } from '@phosphor-icons/react'
import { AccountRoutes, GroupRoutes } from './route-bindings.jsx'
import RouteAutomation from './route-automation.jsx'
import RouteDiscovery from './route-discovery.jsx'
import { routeHref } from './route-navigation.js'

const views = [
  ['route-automation', '自动调度'],
  ['route-bindings', '分组状态'],
]
const advancedViews = [
  ['route-accounts', '账号关联'],
  ['route-discovery', '智能选线'],
]

export default function RouteWorkspace({ sites, page, siteId, groupId, busy, onSync, onEdit, onUse, onChange }) {
  const site = siteId ? sites.find(item => item.id === siteId) : sites[0]
  return <div className="route-workspace">
    <div className="rw-context">
      <nav className="rw-tabs" aria-label="线路管理视图">{views.map(([id, name]) =>
        <a key={id} href={routeHref(id, site?.id, groupId)} aria-current={page === id ? 'page' : undefined}>{name}</a>)}</nav>
      <div className="rw-context-actions"><label><span className="sr-only">当前调度站点</span><select aria-label="当前调度站点" title={site?.endpoint} value={site?.id || ''} onChange={event => { window.location.hash = routeHref(page, event.target.value) }}>
        {!site && <option value="">{siteId ? '调度站点已不存在' : '选择调度站点'}</option>}
        {sites.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
        <a href="#secondary-channels" className="icon-button" aria-label="调度站点配置" title="调度站点配置"><GearSix size={18}/></a>
        {site && <button className="icon-button" title="同步调度站点配置" aria-label="同步调度站点配置" disabled={busy} onClick={() => onSync(site)}><ArrowsClockwise size={18} className={busy ? 'rw-spinning' : ''}/></button>}</div>
    </div>
    <details className="rw-advanced" key={page} open={advancedViews.some(([id]) => id === page)}><summary>高级维护{advancedViews.find(([id]) => id === page)?.[1] ? ` · ${advancedViews.find(([id]) => id === page)[1]}` : ''}</summary>
      <p>自动匹配无需手动关联；仅在排查旧账号或手动扫描线路时使用。</p>
      <nav aria-label="高级线路维护">{advancedViews.map(([id, name]) => <a key={id} href={routeHref(id, site?.id, groupId)} aria-current={page === id ? 'page' : undefined}>{name}</a>)}</nav>
    </details>
    {!site ? <div className="rw-empty"><GitBranch size={28}/><h2>{siteId ? '找不到此调度站点' : '暂无调度站点'}</h2><a href="#secondary-channels" className="outline-button">管理调度站点</a></div> : <>
      {site.error && <p className="site-error" role="alert">{site.error}</p>}
      {site.accountsError && <p className="site-error" role="alert">账号同步未完成：{site.accountsError}</p>}
      {page === 'route-automation' ? <RouteAutomation key={site.id} site={site} initialGroupId={groupId} onChange={onChange}/> : page === 'route-discovery' ? <RouteDiscovery key={site.id} site={site} initialGroupId={groupId} onUse={onUse}/>
        : page === 'route-accounts' ? <AccountRoutes key={site.id} site={site} initialGroupId={groupId} disabled={busy} onEdit={onEdit}/>
          : <GroupRoutes key={site.id} site={site} initialGroupId={groupId}/>}
    </>}
  </div>
}
