const MINUTE = 60000
const FAMILY_ORDER = ['Claude Code', 'Codex', 'Grok', 'Gemini', 'OpenAI', 'DeepSeek', 'Qwen', 'Kimi', 'Llama', 'Mistral', '其他模型']
const RATE_SOURCES = { default: '分组默认', custom: '用户专属', account: '当前账户适用' }
const validRate = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
export const formatProbeRate = value => `${Number(value.toPrecision(8))}×`

function tokenModelPricing(token, model) {
  const pricing = token.groupPricing
  const recharge = token.rechargeRate ?? 1
  const unknown = detail => ({ rates: [], lineRates: [], effectiveRates: [], detail, stale: false })

  if (pricing?.source === 'automatic') return unknown('自动选择分组，实际倍率随上游路由变化。')
  if (!validRate(pricing?.rate)) return unknown('尚未取得此令牌绑定分组的适用倍率。')
  if (!validRate(recharge) || recharge === 0) return unknown('充值倍率无效，暂无法折算。')
  if (model.protocol === 'unsupported') return unknown('该模型需要专用计费信息，暂无法确认实际倍率。')

  // Line rate (billing multiplier at the upstream)
  const lineRate = pricing.rate

  // Effective cost rate = line rate / recharge rate
  const effectiveCost = lineRate / recharge

  if (!validRate(effectiveCost)) return unknown('倍率超出可计算范围，暂无法折算。')

  const lineRates = [lineRate]
  const effectiveRates = [effectiveCost]

  let detail = `充值倍率 ${formatProbeRate(recharge)}（充 ¥1 = $${recharge}）\n`
  detail += `${RATE_SOURCES[pricing.source] || '分组适用'}线路倍率 ${formatProbeRate(lineRate)}\n`
  detail += `实际成本倍率 ${formatProbeRate(effectiveCost)}（= ${formatProbeRate(lineRate)} ÷ ${formatProbeRate(recharge)}）`

  if (pricing.peak) {
    const peakLineRate = lineRate * pricing.peak.factor
    const peakEffectiveCost = peakLineRate / recharge

    if (!validRate(pricing.peak.factor) || !validRate(peakLineRate) || !validRate(peakEffectiveCost)) {
      return unknown('高峰倍率无效，暂无法确认实际倍率。')
    }

    lineRates.push(peakLineRate)
    effectiveRates.push(peakEffectiveCost)

    detail += `\n高峰时段 ${pricing.peak.start}–${pricing.peak.end}：线路倍率 ${formatProbeRate(peakLineRate)}，实际成本 ${formatProbeRate(peakEffectiveCost)}`
    detail += `\n时段以上游站点时区为准`
  }

  const stale = pricing.status !== 'ok'
  if (stale) detail += '\n倍率同步未成功，当前为上次获取值'
  detail += '。模型基础定价以该上游为准。'

  return {
    rates: effectiveRates,  // Keep for backward compatibility
    lineRates,              // Line billing rates
    effectiveRates,         // Effective cost rates
    rechargeRate: recharge,
    detail,
    stale
  }
}

export function summarizeProbeRates(pricings) {
  const effectiveRates = pricings.flatMap(pricing => pricing.effectiveRates || pricing.rates || []).sort((a, b) => a - b)
  const lineRates = pricings.flatMap(pricing => pricing.lineRates || []).sort((a, b) => a - b)

  const minEffective = effectiveRates[0]
  const maxEffective = effectiveRates.at(-1)
  const minLine = lineRates[0]
  const maxLine = lineRates.at(-1)

  let display = ''

  // Show line rates if available
  if (lineRates.length > 0) {
    const lineDisplay = minLine === maxLine ? formatProbeRate(minLine) : `${formatProbeRate(minLine)}–${formatProbeRate(maxLine)}`
    display = `线路 ${lineDisplay}`
  }

  // Show effective cost rates
  if (effectiveRates.length > 0) {
    const effectiveDisplay = minEffective === maxEffective ? formatProbeRate(minEffective) : `${formatProbeRate(minEffective)}–${formatProbeRate(maxEffective)}`
    display += (display ? ' · ' : '') + `成本 ${effectiveDisplay}`
  }

  if (!display) display = '未获取'

  if (effectiveRates.length && pricings.some(pricing => !pricing.effectiveRates?.length && !pricing.rates?.length)) {
    display += ' · 部分未知'
  }

  if (pricings.some(pricing => pricing.stale)) {
    display += ' · 待更新'
  }

  return display
}

export function buildProbeFamilyGroups(groups, identifyModel) {
  const families = new Map()
  for (const group of groups) {
    const identity = identifyModel(group.id)
    const family = identity.family === 'Claude' ? 'Claude Code' : identity.family
    if (!families.has(family)) families.set(family, { family, models: [] })
    families.get(family).models.push(group)
  }
  return [...families.values()].sort((a, b) => FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family))
    .map(category => ({ ...category, models: category.models.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true })) }))
}

export const probeStatusLabels = {
  ok: '探测通过', error: '探测失败', inconclusive: '响应未确认',
  unknown: '待探测', empty: '无记录', unsupported: '暂不支持',
  stale: '结果已过期', disabled: '探测已关闭', paused: '探测已暂停', excluded: '模型已隔离',
  partial_error: '部分失败', partial_inconclusive: '部分响应未确认', partial_unknown: '部分待探测',
  partial_stale: '部分结果已过期', partial_disabled: '部分已关闭', partial_paused: '部分已暂停', partial_unsupported: '部分暂不支持',
}

const reasonLabels = { output_limit: '输出达到上限', reasoning_only: '仅返回推理内容', empty_output: '响应无有效内容', refused: '上游拒绝生成', missing_model: '待获取模型',
  model_unsupported: '上游不支持此模型', authentication: '密钥认证失败', permission: '访问权限不足', quota: '上游额度不足', rate_limit: '上游限流',
  upstream_unavailable: '上游暂不可用', request_incompatible: '接口或参数不兼容', request_invalid: '请求参数被拒绝', not_found: '接口或模型未找到', timeout: '探测超时', connection_error: '连接或响应异常', incomplete_stream: '流式响应未完整结束', incomplete_response: '响应未完整结束' }
export const probeResultLabel = result => result.autoPaused ? probeStatusLabels.excluded : result.revalidatePending ? '等待重新验证'
  : (['inconclusive', 'error'].includes(result.status) && reasonLabels[result.reason]) || probeStatusLabels[result.status] || '待探测'

// Aggregate multiple probe results in the same minute without bias.
// Mixed results (success + failure) should be reported as 'partial_error' not just 'ok'.
const combinedStatus = statuses => {
  const distinct = new Set(statuses)
  if (distinct.size <= 1) return statuses[0] ?? 'empty'

  // If we have both success and failure, it's a mixed/partial state
  const hasSuccess = distinct.has('ok')
  const hasFailure = distinct.has('error')

  if (hasSuccess && hasFailure) return 'partial_error'

  const priority = ['error', 'inconclusive', 'unknown', 'stale', 'paused', 'disabled', 'unsupported']
  return `partial_${priority.find(status => distinct.has(status)) ?? 'unknown'}`
}

// Summarize probe results across timeline cells
// success/failed/uncertain are actual probe counts, not 0/1 per minute
export function summarizeProbeCells(cells) {
  const entries = cells.flatMap(cell => cell.entries)
  const success = entries.filter(entry => entry.status === 'ok').length
  const failed = entries.filter(entry => entry.status === 'error').length
  const uncertain = entries.filter(entry => ['inconclusive', 'unknown'].includes(entry.status)).length
  const tested = success + failed

  // Coverage: how many minutes (out of 60) have at least one confirmed result
  const minutesWithConfirmedResults = cells.filter(cell =>
    cell.entries.some(entry => ['ok', 'error'].includes(entry.status))
  ).length

  return {
    successProbes: success,     // Renamed from 'success' to clarify it's probe count
    failedProbes: failed,       // Renamed from 'failed'
    uncertainProbes: uncertain, // Renamed from 'uncertain'
    totalProbes: entries.length,
    coverageMinutes: minutesWithConfirmedResults,
    coverageRate: minutesWithConfirmedResults / 60, // 0-1 fraction
    successRate: tested ? success / tested : null,
    successRatePercent: tested ? `${Number((success / tested * 100).toFixed(1))}%` : '—',
  }
}

// Current line state is separate from the outcome of an old probe in the timeline.
export const probeCurrentStates = {
  ok: { label: '当前可用' },
  error: { label: '探测失败' },
  excluded: { label: '模型已隔离' },
  balance_blocked: { label: '余额不足 · 已暂停', hint: '请充值后刷新渠道余额，余额恢复后继续探测。' },
  cost_blocked: { label: '成本过高 · 已暂停', hint: '折算成本高于对应调度分组倍率，后台更新倍率后自动重新判断。' },
  models_error: { label: '模型同步失败', hint: '模型列表未同步成功，后台会自动重试；持续失败请检查上游接口和令牌权限。' },
  paused: { label: '令牌待同步', hint: '令牌无效或同步状态异常，请同步渠道令牌，必要时重新授权。' },
  disabled: { label: '探测未启用', hint: '请在令牌详情或令牌管理中开启探测，关闭期间不会自动验证。' },
  stale: { label: '结果已过期', hint: '最近结果已超过有效期，等待新的检测结果；持续过期请检查上游连接和调度服务。' },
  inconclusive: { label: '响应未确认', hint: '请求已返回，但未取得有效输出，尚不能确认模型可用。' },
  revalidating: { label: '等待重新验证', hint: '已提交重新验证，等待下一次探测结果。' },
  unprobed: { label: '等待首次检测', hint: '已启用探测，尚未取得首次调用结果；上游返回模型名称不代表调用一定成功。' },
  unsupported: { label: '暂不支持探测', hint: '探测器暂不支持此模型的接口类型，尚未验证上游是否可用。' },
  invalid_time: { label: '检测时间异常', hint: '检测时间无效或晚于当前时间，请检查设备时间并等待新的结果。' },
  unknown: { label: '结果状态未识别', hint: '已有检测记录，但结果状态无法识别，等待新的检测结果。' },
}

export function summarizeProbeAvailability(records) {
  const counts = {}
  for (const record of records) {
    const state = Object.hasOwn(probeCurrentStates, record.currentStatus) ? record.currentStatus : 'unknown'
    counts[state] = (counts[state] ?? 0) + 1
  }
  const available = counts.ok ?? 0
  const failed = (counts.error ?? 0) + (counts.excluded ?? 0)
  const entries = Object.entries(probeCurrentStates).filter(([state]) => counts[state])
  const breakdown = entries.map(([state, info]) => `${info.label} ${counts[state]}`).join(' · ')
  const allFailed = records.length > 0 && failed === records.length
  return {
    status: available ? 'ok' : allFailed ? 'error' : entries.length === 1 ? entries[0][0] : 'inconclusive',
    label: available ? `有可用线路 ${available}/${records.length}` : allFailed ? '暂无可用线路'
      : entries.length === 1 ? `${entries[0][1].label} ${records.length}` : records.length ? '尚无确认可用线路' : '暂无线路',
    breakdown: entries.length > 1 || allFailed ? breakdown : '',
    detail: `当前筛选范围按令牌统计：${breakdown || '暂无线路'}。仅已启用且未过期的成功结果计为可用。`,
  }
}

export function probeRecordSection(record) {
  if (record.currentStatus === 'ok') return 'available'
  if (record.currentStatus === 'cost_blocked') return 'other'
  if (record.autoPaused || record.unresolvedExclusion) return 'excluded'
  if (record.failureCount >= 5) return 'abnormal'
  return 'other'
}

// Build timeline showing the last 60 complete minutes (not including current incomplete minute)
export function buildProbeTimeline(records, now) {
  // Use the last complete minute as the end boundary
  const currentMinuteStart = Math.floor(now / MINUTE) * MINUTE
  const end = currentMinuteStart - MINUTE  // Last complete minute
  const start = end - 59 * MINUTE  // 60 complete minutes total

  const cells = Array.from({ length: 60 }, (_, index) => ({ time: start + index * MINUTE, entries: [] }))

  for (const record of records) {
    for (const item of record.history || []) {
      const time = Date.parse(item.at)
      // Only include records within the complete minute window
      if (!Number.isFinite(time) || time < start || time > end) continue

      const status = ['ok', 'error', 'inconclusive', 'unsupported'].includes(item.status) ? item.status : 'unknown'
      const cellIndex = Math.floor((time - start) / MINUTE)

      // Safety check to prevent out-of-bounds access
      if (cellIndex >= 0 && cellIndex < cells.length) {
        cells[cellIndex].entries.push({
          time, status, tokenId: record.tokenId, tokenName: record.tokenName,
          reason: item.reason ?? null, error: item.error ?? null, httpStatus: item.httpStatus ?? null,
          completedAt: item.completedAt ?? null, protocol: item.protocol ?? null, timeoutMs: item.timeoutMs ?? null,
          latencyMs: typeof item.latencyMs === 'number' && Number.isFinite(item.latencyMs) && item.latencyMs >= 0 ? item.latencyMs : null,
        })
      }
    }
  }

  return cells.map(cell => {
    const latencies = cell.entries.map(entry => entry.latencyMs).filter(value => value !== null)

    // Calculate P95 latency
    let p95Latency = null
    if (latencies.length > 0) {
      const sorted = [...latencies].sort((a, b) => a - b)
      const p95Index = Math.ceil(sorted.length * 0.95) - 1
      p95Latency = sorted[Math.max(0, p95Index)]
    }

    return {
      ...cell,
      status: combinedStatus(cell.entries.map(entry => entry.status)),
      latencyMs: latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : null,
      p95Latency,
      success: cell.entries.filter(entry => entry.status === 'ok').length,
      failed: cell.entries.filter(entry => entry.status === 'error').length,
      uncertain: cell.entries.filter(entry => ['inconclusive', 'unknown'].includes(entry.status)).length,
      totalProbes: cell.entries.length,  // Track actual probe count
    }
  })
}

export function buildProbeModelGroups(tokens, now, intervalSec = 60, withTimelines = true) {
  const groups = new Map()
  for (const token of tokens) {
    const models = token.probeModels || []
    // Each model runs every interval; allow one missed tick before marking its result old.
    const freshness = 2 * intervalSec * 1000
    for (const model of models) {
      if (!groups.has(model.id)) groups.set(model.id, { id: model.id, channels: new Map() })
      const group = groups.get(model.id)
      if (!group.channels.has(token.channelId)) group.channels.set(token.channelId, {
        id: token.channelId, name: token.channelName, endpoint: token.endpoint,
        provider: token.provider, records: [],
      })
      const time = Date.parse(model.lastProbeAt)
      const currentStatus = token.probeEnabled && model.costBlocked ? 'cost_blocked' : model.autoPaused ? 'excluded' : model.protocol === 'unsupported' ? 'unsupported'
        : !token.probeEnabled ? 'disabled' : token.probeBlockReason === 'balance' ? 'balance_blocked'
          : token.probePaused || token.probeBlockReason === 'credentials' ? 'paused'
            : token.probeBlockReason === 'models' ? 'models_error'
              : model.revalidatePending ? 'revalidating' : !model.lastProbeAt ? 'unprobed'
                : !Number.isFinite(time) || time > now ? 'invalid_time' : now - time > freshness ? 'stale'
                  : ['ok', 'error', 'inconclusive'].includes(model.status) ? model.status : 'unknown'
      let failureCount = 0, consecutive = 0, unresolvedExclusion = false
      const history = model.history || []
      // Keep unresolved failures folded through retries; only a successful probe restores the row.
      if (!model.historySummary && model.status !== 'ok') for (let index = history.length - 1; index >= 0 && history[index].status !== 'ok'; index--) {
        consecutive = history[index].status === 'error' ? consecutive + 1 : 0
        failureCount = Math.max(failureCount, consecutive)
        unresolvedExclusion ||= history[index].reason === 'model_unsupported'
      }
      if (model.historySummary) {
        failureCount = model.historySummary.failureCount
        unresolvedExclusion = model.historySummary.unresolvedExclusion
      }
      group.channels.get(token.channelId).records.push({
        ...model, currentStatus, failureCount, unresolvedExclusion, tokenId: token.id, tokenName: token.name, token, pricing: tokenModelPricing(token, model),
        groupName: token.groupName || (token.groupId ? `分组 #${token.groupId}` : '跟随账户分组'),
      })
    }
  }
  return [...groups.values()].map(group => {
    const channels = [...group.channels.values()].map(channel => {
      const records = !withTimelines ? channel.records : channel.records.map(record => {
        const cells = buildProbeTimeline([record], now)
        return { ...record, cells, summary: summarizeProbeCells(cells) }
      })
      return { ...channel, records }
    })
    return { ...group, channels }
  })
}
