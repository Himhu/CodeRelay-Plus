import { useEffect, useRef, useState } from 'react'
import { requestJSON } from './console-fetch.js'
import { Paginated } from './pagination.jsx'
import { ArrowsClockwise, X } from '@phosphor-icons/react'

const multiplier = value => value == null ? '—' : `${value}×`
const sources = { default: '分组默认', custom: '用户专属', account: '当前账户适用', automatic: '自动选择分组' }
const keyStatuses = { active: '已启用', inactive: '已停用', expired: '已过期', quota_exhausted: '额度耗尽', unknown: '状态未知' }

function APIKeyList({items, groups, provider}) {
  return <Paginated items={items} label="已创建令牌">{rows => <ul className="route-key-list">{rows.map(key => {
    const status = key.status === 'active' && key.expiresAt && Date.parse(key.expiresAt) <= Date.now() ? 'expired' : key.status
    const group = groups?.find(group => group.id === key.groupId)
    const groupName = group?.name || key.groupName || (key.groupId ? `分组 #${key.groupId}` : provider === 'NewAPI' ? '跟随账户分组' : '未绑定分组')
    return <li key={key.id}><div><b>{key.name}</b><span className="key-meta">#{key.id} · {groupName}</span>
      {key.groupId && groups && !group && <span className="key-meta">该分组不在当前可用线路列表中</span>}
      {key.lastUsedAt && <span className="key-meta">最近使用：{new Date(key.lastUsedAt).toLocaleString('zh-CN',{hour12:false})}</span>}
    </div><span className={`key-status ${status}`}>{keyStatuses[status]}</span></li>
  })}</ul>}</Paginated>
}

const rateText = value => value == null ? '自动' : `${value}×`
function WatchSection({ channel, busy, onChanged }) {
  const watch = channel.upstreamWatch || {}
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  async function toggle(event) {
    setPending(true); setError('')
    try {
      const payload = await requestJSON(`/api/upstream-channels/${channel.id}/watch`, { ignoreAnnouncements: event.target.checked })
      if (!Array.isArray(payload.channels)) throw new Error('渠道数据格式无效，已保留上次结果。')
      onChanged(payload.channels)
    } catch (err) { setError(err.message) }
    finally { setPending(false) }
  }
  return <section className="detail-section" aria-labelledby="upstream-watch-title">
    <div className="detail-section-head"><h3 id="upstream-watch-title">倍率、公告和订阅</h3></div>
    <p className="route-hint">跟随线路同步。首次只建立基线，之后的倍率变化和新公告才提醒。订阅额度不并入钱包余额。</p>
    {watch.updatedAt && <p className="route-hint">更新：{new Date(watch.updatedAt).toLocaleString('zh-CN', { hour12: false })}</p>}
    <h4>倍率变化</h4>
    {watch.rateChanges?.length ? <ul className="route-key-list">{watch.rateChanges.map(entry => <li key={entry.at}>
      <div><b>{new Date(entry.at).toLocaleString('zh-CN', { hour12: false })}</b>
        {entry.added?.length > 0 && <span className="key-meta">新增 {entry.added.map(item => `${item.name} ${rateText(item.rate)}`).join('、')}</span>}
        {entry.removed?.length > 0 && <span className="key-meta">删除 {entry.removed.map(item => `${item.name} ${rateText(item.rate)}`).join('、')}</span>}
        {entry.changed?.length > 0 && <span className="key-meta">变化 {entry.changed.map(item => `${item.name} ${rateText(item.from)}→${rateText(item.to)}${item.percent == null ? '' : `（${item.percent}%）`}`).join('、')}</span>}
      </div></li>)}</ul> : <p className="route-hint">还没有超过提醒阈值的倍率变化。</p>}
    <h4>上游公告</h4>
    <label className="auto-probe-option"><input type="checkbox" checked={watch.ignoreAnnouncements === true} disabled={busy || pending} onChange={toggle}/><span>不推送这个渠道的公告<small className="field-hint">仍然保存在这里，只是不再发 QQ。</small></span></label>
    {watch.announcementsError && <p className="site-error" role="alert">{watch.announcementsError}</p>}
    {watch.announcements?.length ? <ul className="route-key-list">{watch.announcements.map(item => <li key={item.id}><div><b>{item.title}</b>{item.at && <span className="key-meta">{item.at}</span>}<span className="key-meta">{item.content}</span></div></li>)}</ul> : <p className="route-hint">还没有公告。首次同步不会把旧公告当成新消息。</p>}
    {channel.provider === 'Sub2API' && <><h4>订阅用量</h4>
      {watch.subscriptionsError && <p className="site-error" role="alert">{watch.subscriptionsError}</p>}
      {watch.subscriptions?.length ? <ul className="route-key-list">{watch.subscriptions.map(item => <li key={item.id}><div><b>{item.groupName}</b><span className="key-meta">{item.status}{item.expiresInDays == null ? '' : ` · 剩余 ${item.expiresInDays} 天`}</span>
        {[['日', item.daily], ['周', item.weekly], ['月', item.monthly]].filter(([, value]) => value).map(([label, value]) => <span className="key-meta" key={label}>{label}剩余 {value.remainingPercent}%（${value.remaining} / ${value.limit}）</span>)}
      </div></li>)}</ul> : <p className="route-hint">没有读到订阅用量。钱包余额仍按原来的方式显示。</p>}</>}
    {error && <p className="site-error" role="alert">{error}</p>}
  </section>
}

export default function ChannelDetail({ channel, onClose, onRefresh, busy, error, onChannels }) {
  const dialog = useRef(null)
  const snapshot = channel.userGroups || {}
  const groups = snapshot.groups
  const loading = busy || snapshot.status === 'loading'
  const failure = error || snapshot.error
  const keySnapshot = channel.apiKeys || {}
  const keys = keySnapshot.items
  const keysKnown = Array.isArray(keys)
  const keysStale = keySnapshot.status !== 'ok'
  const unkeyedGroups = keysKnown && groups ? groups.filter(group => !keys.some(key => key.groupId === group.id)) : []
  const unkeyedStale = keysStale || snapshot.status !== 'ok'
  useEffect(() => {
    const element = dialog.current
    element.showModal()
    return () => element.close()
  }, [])

  return <dialog ref={dialog} className="drawer-backdrop" aria-labelledby="channel-detail-title" onClick={onClose} onCancel={event => { event.preventDefault(); onClose() }}>
    <aside className="detail-drawer" onClick={event => event.stopPropagation()}>
      <div className="drawer-head"><div><span className="eyebrow">CHANNEL DETAIL</span><h2 id="channel-detail-title">{channel.name}</h2><span className="group-description">{channel.provider} · 账户可用线路</span></div>
        <button type="button" className="icon-button" aria-label="关闭渠道详情" onClick={onClose}><X size={19}/></button></div>
      <div className="drawer-body">
        <div className="detail-grid"><div><span>上游类型</span><b>{channel.provider}</b></div><div><span>渠道 ID</span><b>{channel.id}</b></div>
          <div className="detail-endpoint"><span>站点地址</span><b className="mono">{channel.endpoint}</b></div></div>
        <section className="detail-section" aria-labelledby="route-groups-title" aria-busy={loading}>
          <div className="detail-section-head"><h3 id="route-groups-title">可用线路与倍率{groups && <span className="route-count">{groups.length}</span>}</h3>
            <button type="button" className="outline-button" disabled={loading || channel.needsAuthorization} onClick={onRefresh}><ArrowsClockwise size={15}/>{loading?'正在同步…':'刷新线路'}</button></div>
          <p className="route-hint">展示当前账户可选择的线路分组及适用基础倍率。</p>
          {snapshot.updatedAt && <p className="route-hint">更新：{new Date(snapshot.updatedAt).toLocaleString('zh-CN',{hour12:false})}</p>}
          <div className="route-key-summary">
            <p>API 密钥：{keysKnown ? `已创建 ${keys.length} 个令牌${keysStale?'（上次结果）':''}` : loading?'正在查询…':'尚未取得列表'}</p>
            {keySnapshot.updatedAt && <span className="key-meta">令牌查询：{new Date(keySnapshot.updatedAt).toLocaleString('zh-CN',{hour12:false})}</span>}
            {keySnapshot.error && <p className="key-error" role="alert">{keySnapshot.error}{keysKnown?' 当前展示上次查询结果。':' 暂时无法判断哪些线路已创建令牌。'}</p>}
            {keysKnown && <details className="created-keys"><summary>已创建令牌（{keys.length}）{keysStale?' · 上次结果':''}</summary>
              {keys.length > 0 ? <APIKeyList items={keys} groups={groups} provider={channel.provider}/>
                : <p className="route-hint">{keysStale?'上次查询未发现已创建令牌。':'该账户尚未创建令牌。'}</p>}
            </details>}
            {keysKnown && groups && <details className="unkeyed-routes"><summary>{unkeyedStale?'上次未发现令牌的线路':'未创建令牌的线路'}（{unkeyedGroups.length}）</summary>
              {unkeyedGroups.length > 0 ? <Paginated items={unkeyedGroups} label="未创建令牌的线路">{rows => <ul className="route-key-list">{rows.map(group => <li key={group.id}>
                <div><b>{group.name}</b>{group.platform && <span className="key-meta">{group.platform}</span>}</div>
                <span className="key-status">{group.source==='automatic'?'自动':multiplier(group.rate)}</span>
              </li>)}</ul>}</Paginated> : <p className="route-hint">{unkeyedStale?'上次结果中没有未创建令牌的线路。':'当前没有未创建令牌的可用线路。'}</p>}
            </details>}
          </div>
          {failure && <p className="site-error" role="alert">{failure}{groups && ' 下方保留上次成功同步的结果。'}</p>}
          {loading && <p className="route-hint" role="status">正在读取上游线路及账户倍率…</p>}
          {!loading && !failure && !groups && <p className="route-empty">{channel.needsAuthorization?'请先在总览中完成登录授权，再查看可用线路。':'点击“刷新线路”读取可用分组。'}</p>}
          {groups?.length === 0 && !loading && <p className="route-empty">该账户当前没有可用线路分组。</p>}
          {groups?.length > 0 && <Paginated items={groups} label="可用线路分组">{rows => <ul className="route-groups" aria-label="可用线路分组">{rows.map(group => {
            const linkedKeys = keys?.filter(key => key.groupId === group.id) || []
            return <li key={group.id}>
            <div className="route-group-heading"><div><h4>{group.name}</h4>{group.platform && <span className="group-description">{group.platform}</span>}</div>
              <div className="route-group-rate"><strong>{group.source==='automatic'?'自动':multiplier(group.rate)}</strong><span>{sources[group.source]}</span></div></div>
            {group.description && <p className="route-hint">{group.description}</p>}
            {channel.provider === 'Sub2API' && <dl className="route-rate-details"><div><dt>默认倍率</dt><dd>{multiplier(group.defaultRate)}</dd></div><div><dt>用户专属倍率</dt><dd>{group.userRate == null?'未设置':multiplier(group.userRate)}</dd></div></dl>}
            {group.source === 'automatic' && <p className="route-hint">按实际选中的分组计费。</p>}
            {group.peak && <p className="route-peak">高峰规则：{group.peak.start}–{group.peak.end}，基础倍率 × {group.peak.factor}（上游时区）。</p>}
            <div className="route-key-state"><span className={linkedKeys.length?'key-created':''}>{keysKnown
              ? linkedKeys.length ? `已创建 ${linkedKeys.length} 个令牌${keysStale?'（上次结果）':''}` : keysStale?'上次未发现令牌':'未创建令牌'
              : loading?'正在查询令牌…':'令牌状态未知'}</span></div>
          </li>})}</ul>}</Paginated>}
          <WatchSection channel={channel} busy={busy} onChanged={onChannels}/>
          <p className="route-hint route-footnote">{channel.provider==='Sub2API'
            ? '用户专属倍率优先于默认倍率；高峰因子另行叠加，图片、视频等独立计费以上游规则为准。'
            : '倍率由上游按当前账户返回，已包含适用的特殊倍率；自动分组没有固定倍率。'}</p>
        </section>
      </div>
    </aside>
  </dialog>
}
