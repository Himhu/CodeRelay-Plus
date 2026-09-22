export const PAGE_SIZE = 5
export const PAGE_SIZES = [5, 10, 20, 50, 100]

export function normalizePageSize(value, fallback = PAGE_SIZE) {
  const size = Number(value)
  return PAGE_SIZES.includes(size) ? size : fallback
}

export function paginationRange(total, requestedPage = 1, pageSize = PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const page = Math.min(pages, Math.max(1, Number.isSafeInteger(requestedPage) ? requestedPage : 1))
  const start = (page - 1) * pageSize
  const pageNumbers = pages <= 5
    ? Array.from({ length: pages }, (_, index) => index + 1)
    : [...new Set([1, ...Array.from({ length: 3 }, (_, index) => Math.max(2, Math.min(page - 1, pages - 3)) + index), pages])]
  return { total, pageSize, pages, page, start, pageNumbers }
}
