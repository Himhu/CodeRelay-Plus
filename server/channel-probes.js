import { usableAPIKey } from './user-api-keys.js'

// Calculate current token pass rate (snapshot of last check, not historical)
function currentTokenPassRate(tokens) {
  const checked = tokens.filter(t => t.lastStatus !== 'unknown')
  if (checked.length === 0) return null
  const passed = checked.filter(t => t.lastStatus === 'ok').length
  return passed / checked.length
}

// Calculate historical success rate within a time window
function historicalSuccessRate(history, windowMinutes = 60, now = Date.now()) {
  const windowStart = now - windowMinutes * 60 * 1000
  const windowRecords = history.filter(h => h.time >= windowStart && h.time < now)

  if (windowRecords.length === 0) return null

  const successes = windowRecords.filter(r => r.status === 'ok').length
  const failures = windowRecords.filter(r => r.status === 'error').length
  const total = successes + failures

  if (total === 0) return null

  return {
    rate: successes / total,
    successCount: successes,
    failureCount: failures,
    totalCount: total,
    coverage: windowRecords.length / windowMinutes // How many minutes have data
  }
}

// Read the existing model snapshots/history; overview requests never run probes.
export function channelProbeSummary(channel, now = Date.now(), intervalSec = 60, probeCosts = () => new Map()) {
  const tokens = channel.probeTokens ?? []
  // Calculate for complete minutes only
  const currentMinuteStart = Math.floor(now / 60000) * 60000
  const end = currentMinuteStart - 60000  // Last complete minute
  const start = end - 59 * 60000  // 60 complete minutes total
  const counts = { ok: 0, error: 0, inconclusive: 0, unknown: 0, stale: 0, paused: 0, unsupported: 0, excluded: 0 }
  const history = { success: 0, failed: 0, uncertain: 0, total: 0, rate: null,
    start: new Date(start).toISOString(), end: new Date(end).toISOString() }
  const modelNames = new Set()
  let enabledTokens = 0, monitoredModels = 0, awaitingModels = 0, pausedTokens = 0, lastProbeTime = null
  let costBlockedModels = 0
  const balanceBlocked = channel.balance?.status === 'ok' && Number.isFinite(channel.balance.amount) && channel.balance.amount <= 0
  const rememberTime = value => {
    const time = Date.parse(value)
    if (Number.isFinite(time) && time <= now && (lastProbeTime === null || time > lastProbeTime)) lastProbeTime = time
  }
  for (const token of tokens) {
    const enabled = token.probeEnabled === true
    const paused = !token.key || !usableAPIKey(token, now) || token.stale || channel.probeTokensUnavailable || balanceBlocked
    if (enabled) { enabledTokens++; if (paused) pausedTokens++ }
    const models = token.probeModels ?? []
    const costBlocks = enabled ? probeCosts(token) : new Map()
    if (enabled && !models.length) awaitingModels++
    rememberTime(token.lastProbeAt)
    for (const model of models) {
      modelNames.add(model.id)
      rememberTime(model.lastProbeAt)
      if (enabled) {
        if (costBlocks.has(model.id)) { counts.paused++; monitoredModels++; costBlockedModels++ }
        else if (model.autoPaused) counts.excluded++
        else if (model.protocol === 'unsupported') counts.unsupported++
        else {
          monitoredModels++
          const time = Date.parse(model.lastProbeAt)
          const state = paused ? 'paused' : model.revalidatePending || !Number.isFinite(time) || time > now ? 'unknown'
            : now - time > 2 * intervalSec * 1000 ? 'stale'
              : ['ok', 'error', 'inconclusive'].includes(model.status) ? model.status : 'unknown'
          counts[state]++
        }
      }
      // Retain past observations even when a token has since been disabled.
      // Only include records in complete minute window
      for (const item of Array.isArray(model.probeHistory) ? model.probeHistory.slice(-1440) : []) {
        const time = Date.parse(item?.at)
        if (!Number.isFinite(time) || time < start || time > end) continue
        if (item.status === 'ok') history.success++
        else if (item.status === 'error') history.failed++
        else if (item.status === 'inconclusive') history.uncertain++
        else continue
        rememberTime(item.at)
      }
    }
  }
  history.total = history.success + history.failed + history.uncertain
  const confirmed = history.success + history.failed
  // Calculate historical success rate (only confirmed results)
  if (confirmed) {
    history.rate = history.success / confirmed * 100
    // Add coverage metric: how many minutes out of 60 have data
    const windowMinutes = 60
    const minutesWithData = new Set()
    for (const token of tokens) {
      for (const model of token.probeModels || []) {
        for (const item of Array.isArray(model.probeHistory) ? model.probeHistory : []) {
          const time = Date.parse(item?.at)
          if (Number.isFinite(time) && time >= start && time <= end) {
            minutesWithData.add(Math.floor((time - start) / 60000))
          }
        }
      }
    }
    history.coverage = minutesWithData.size / windowMinutes
    history.coverageMinutes = minutesWithData.size
  }
  let status = 'unknown'
  if (!enabledTokens) status = 'disabled'
  else if (pausedTokens === enabledTokens) status = 'paused'
  else if (monitoredModels && !awaitingModels && counts.paused === monitoredModels) status = 'paused'
  else if (!monitoredModels && !awaitingModels) status = counts.excluded ? 'paused' : 'unsupported'
  else if (monitoredModels && !awaitingModels && counts.ok === monitoredModels) status = 'healthy'
  else if (monitoredModels && !awaitingModels && counts.error === monitoredModels) status = 'down'
  else if (counts.ok || counts.error) status = 'degraded'
  else if (monitoredModels && !awaitingModels && counts.stale === monitoredModels) status = 'stale'
  else if (monitoredModels && !awaitingModels && counts.inconclusive === monitoredModels) status = 'inconclusive'
  const details = [`${enabledTokens}/${tokens.length} 个令牌已启用，按令牌分别统计 ${monitoredModels} 个受监测模型`,
    `通过 ${counts.ok}、失败 ${counts.error}、无有效内容 ${counts.inconclusive}、待探测 ${counts.unknown}、过期 ${counts.stale}、暂停 ${counts.paused}`]
  if (awaitingModels) details.push(`${awaitingModels} 个已启用令牌等待获取模型`)
  if (counts.unsupported) details.push(`${counts.unsupported} 个模型暂不支持探测，不计入正常/失败判断`)
  if (counts.excluded) details.push(`${counts.excluded} 个令牌与模型组合被明确拒绝或连续失败，已隔离，可在探针页面查看原因并重新验证`)
  if (enabledTokens && balanceBlocked) details.push('上游余额不足，探测已暂停')
  if (costBlockedModels) details.push(`${costBlockedModels} 个模型的折算成本高于调度分组倍率，已暂停探测，倍率恢复后自动继续`)
  return { status, tokenCount: tokens.length, enabledTokens, modelCount: modelNames.size,
    modelNames: [...modelNames], monitoredModels, awaitingModels, costBlockedModels, counts, history,
    lastProbeAt: lastProbeTime === null ? null : new Date(lastProbeTime).toISOString(), detail: details.join('；') + '。' }
}
