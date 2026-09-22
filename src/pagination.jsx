import { useState } from 'react'
import { PAGE_SIZE, PAGE_SIZES, normalizePageSize, paginationRange } from './pagination-data.js'
import './pagination.css'

// Reset only for a changed search/filter/source, never for a polling snapshot.
export function usePagination(items, resetKey = '', initialPage = 1, initialPageSize = PAGE_SIZE) {
  const [state, setState] = useState({ key: resetKey, page: initialPage, pageSize: normalizePageSize(initialPageSize) })
  const current = state.key === resetKey ? state : { page: initialPage, pageSize: normalizePageSize(initialPageSize) }
  const range = paginationRange(items.length, current.page, current.pageSize)
  if (state.key !== resetKey || state.page !== range.page || state.pageSize !== range.pageSize) setState({ key: resetKey, page: range.page, pageSize: range.pageSize })
  return { ...range, rows: items.slice(range.start, range.start + range.pageSize),
    onPageChange: page => setState({ key: resetKey, page, pageSize: range.pageSize }),
    onPageSizeChange: pageSize => setState({ key: resetKey, page: 1, pageSize: normalizePageSize(pageSize) }) }
}

export function Pagination({ total, page, pageSize = PAGE_SIZE, onPageChange, onPageSizeChange, label = '列表', disabled = false }) {
  const range = paginationRange(total, page, pageSize)
  return <div className="list-pagination">
    <span className="list-page-info">共 {total} 条 · 第 {range.page} / {range.pages} 页</span>
    <div className="list-page-controls">
    <label className="list-page-size">每页
      <select aria-label={`${label}每页显示`} value={range.pageSize} disabled={disabled || !onPageSizeChange}
        onChange={event => onPageSizeChange?.(Number(event.target.value))}>
        {PAGE_SIZES.map(size => <option key={size} value={size}>{size} 条</option>)}
      </select>
    </label>
    <nav aria-label={`${label}分页`}>
      <button type="button" disabled={disabled || range.page <= 1} onClick={() => onPageChange(range.page - 1)}>上一页</button>
      {range.pageNumbers.flatMap((number, index) => [
        ...(index > 0 && number - range.pageNumbers[index - 1] > 1 ? [<span className="list-page-gap" aria-hidden="true" key={`gap-${number}`}>…</span>] : []),
        <button type="button" key={number} className="list-page-number"
        aria-label={`第 ${number} 页`} aria-current={number === range.page ? 'page' : undefined}
        disabled={disabled} onClick={() => onPageChange(number)}>{number}</button>])}
      <button type="button" disabled={disabled || range.page >= range.pages} onClick={() => onPageChange(range.page + 1)}>下一页</button>
    </nav>
    </div>
  </div>
}

// Render the controls outside tables/lists; nested lists each own their page.
export function Paginated({ items, resetKey, initialPage, label, always = false, children }) {
  const paging = usePagination(items, resetKey, initialPage)
  return <>{children(paging.rows)}{(always || paging.total > paging.pageSize) && <Pagination {...paging} label={label}/>}</>
}
