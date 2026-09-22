import { Scroll, ChartLineUp, GearSix, GitBranch, ListChecks, PlugsConnected, Robot } from '@phosphor-icons/react'

export const navigation = [
  ['overview', '总览', '总览', ChartLineUp],
  ['secondary-channels', '调度站点', '调度', PlugsConnected],
  ['route-automation', '线路管理', '线路', GitBranch],
  ['probes', '探针监控', '探针', ListChecks],
  ['logs', '日志中心', '日志', Scroll],
  ['qq-bot', 'QQ 机器人', 'QQ', Robot],
  ['settings', '设置', '设置', GearSix],
]

export const routePages = ['route-bindings', 'route-accounts', 'route-discovery', 'route-automation']

export function routeHref(page, siteId, groupId) {
  const params = new URLSearchParams()
  if (siteId) params.set('site', siteId)
  if (groupId) params.set('group', groupId)
  return `#${page}${params.size ? `?${params}` : ''}`
}
