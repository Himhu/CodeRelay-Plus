// The UI displays 60 complete minutes. Keep a margin and a short failure tail.
export function recentProbeHistory(history, now = Date.now()) {
  const start = Math.floor(now / 60000) * 60000 - 65 * 60000
  return history.filter((item, index) => index >= history.length - 8 || Date.parse(item.at) >= start)
}

export function summarizeProbeHistory(history, previous) {
  const result = { failureCount: 0, consecutiveFailures: 0, unresolvedExclusion: false, lastSuccessAt: null, ...previous }
  for (const item of history) {
    if (item.status === 'ok') {
      result.failureCount = result.consecutiveFailures = 0
      result.unresolvedExclusion = false
      result.lastSuccessAt = item.completedAt ?? item.at
    } else {
      result.consecutiveFailures = item.status === 'error' ? result.consecutiveFailures + 1 : 0
      result.failureCount = Math.max(result.failureCount, result.consecutiveFailures)
      result.unresolvedExclusion ||= item.reason === 'model_unsupported'
    }
  }
  return result
}
