import { PAGE_SIZE, normalizePageSize, paginationRange } from './pagination-data.js'

export const channelFilters = [['all', '全部'], ['healthy', '正常'], ['degraded', '部分异常'], ['down', '全部失败'], ['disabled', '未启用'], ['pending', '待确认']]
export const channelSorts = [
  ['created-desc', '最近添加'], ['created-asc', '最早添加'],
  ['name-asc', '名称 A → Z'], ['name-desc', '名称 Z → A'],
  ['balance-asc', '余额从低到高'], ['balance-desc', '余额从高到低'],
  ['rate-desc', '成功率从高到低'], ['rate-asc', '成功率从低到高'],
  ['status-asc', '异常优先'], ['probed-desc', '最近探测'],
]
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
const statusOrder = ['down', 'paused', 'degraded', 'stale', 'inconclusive', 'unknown', 'healthy', 'disabled', 'unsupported']
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null
const date = value => finite(Date.parse(value))
const matchesStatus = (channel, selected) => selected === 'all' || channel.status === selected ||
  selected === 'pending' && !['healthy', 'degraded', 'down', 'disabled'].includes(channel.status)
const values = {
  created: channel => date(channel.createdAt),
  name: channel => channel.name || '',
  balance: channel => channel.balance?.status === 'ok'
    ? finite(channel.balance.usdAmount) ?? (channel.balance.currency === 'USD' ? finite(channel.balance.amount) : null) : null,
  rate: channel => finite(channel.probeSummary?.history?.rate),
  status: channel => statusOrder.indexOf(channel.status) < 0 ? 5 : statusOrder.indexOf(channel.status),
  probed: channel => date(channel.probeSummary?.lastProbeAt),
}

export function channelTableView(data, params) {
  const filter = channelFilters.some(([id]) => id === params.get('status')) ? params.get('status') : 'all'
  const query = params.get('q') || ''
  const sort = channelSorts.some(([id]) => id === params.get('sort')) ? params.get('sort') : 'created-desc'
  const pageSize = normalizePageSize(params.get('pageSize'), PAGE_SIZE)
  const requestedPage = Number(params.get('page'))
  const [field, direction] = sort.split('-'), readValue = values[field]
  const counts = Object.fromEntries(channelFilters.map(([id]) => [id, data.filter(channel => matchesStatus(channel, id)).length]))
  // Filter and sort the full summary snapshot before slicing; never sort only a page.
  const list = data.filter(channel => matchesStatus(channel, filter) &&
    `${channel.name} ${channel.provider} ${channel.endpoint || ''} ${(channel.probeSummary?.modelNames || []).join(' ')}`.toLowerCase().includes(query.trim().toLowerCase()))
  list.sort((a, b) => {
    const left = readValue(a), right = readValue(b)
    if (left == null || right == null) return left == null && right == null ? 0 : left == null ? 1 : -1
    const compared = field === 'name' ? collator.compare(left, right) : left - right
    return (direction === 'desc' ? -compared : compared) || String(a.id).localeCompare(String(b.id))
  })
  const { total, pages, page, start, pageNumbers } = paginationRange(list.length, requestedPage, pageSize)
  return { filter, query, sort, pageSize, counts, total, pages, page, start, pageNumbers, rows: list.slice(start, start + pageSize) }
}
