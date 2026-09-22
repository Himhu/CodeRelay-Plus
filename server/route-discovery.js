import { randomUUID } from 'node:crypto'
import { SyncError, isRecord, textValue } from './upstream-client.js'
import { usableAPIKey } from './user-api-keys.js'
import { probeRouteName } from './route-name.js'
import { effectiveRouteCost } from './user-groups.js'

const finiteRate = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
// Division roundoff (for example 0.3 / 3) must not turn equal rates into a discount.
export const isLowerRouteCost = (cost, target) => finiteRate(cost) && finiteRate(target) && target > 0 &&
  target - cost > Number.EPSILON * Math.max(cost, target) * 4
export const isWithinRouteRate = (cost, target) => finiteRate(cost) && finiteRate(target) && !isLowerRouteCost(target, cost)
const fresh = (at, now) => Number.isFinite(Date.parse(at)) && Date.parse(at) <= now && now - Date.parse(at) <= 300000
const FAMILY_PATTERNS = [
  ['Claude Code', /claude|anthropic|kiro|bedrock|ccmax|(?:^|[^a-z])cc(?:[^a-z]|$)/i],
  ['Codex', /codex|gpt|openai|chatgpt/i], ['Grok', /grok|x[.-]?ai/i], ['Gemini', /gemini|google/i],
  ['DeepSeek', /deepseek|深度求索/i], ['Qwen', /qwen|通义|千问/i], ['Kimi', /kimi|moonshot|月之暗面/i],
  ['Llama', /llama/i], ['Mistral', /mistral/i], ['GLM', /glm|zhipu|智谱/i],
  ['MiniMax', /minimax|海螺/i], ['MiMo', /mimo/i], ['混元', /hunyuan|混元|(?:^|[\s/])hy[34](?:[-\s]|$)/i],
]
export const routeFamilies = value => FAMILY_PATTERNS.filter(([, pattern]) => pattern.test(value || '')).map(([name]) => name)
const nameKey = value => textValue(value).toLowerCase().replace(/[\s\-_()[\]【】（）]/g, '')
export function routeTier(name, families) {
  if (families.includes('Claude Code')) {
    if (/kiro|bedrock/i.test(name)) return 'Kiro'
    if (/cursor/i.test(name)) return 'Cursor'
    if (/反重力|antigravity/i.test(name)) return 'Antigravity'
    if (/max[\s_-]?c(?:[^a-z]|$)/i.test(name)) return 'Max-C'
    if (/max/i.test(name)) return 'Max'
  }
  if (families.includes('Codex')) {
    if (/pro/i.test(name)) return 'Pro'
    if (/sale|特惠|福利/i.test(name)) return 'Sale'
    if (/plus/i.test(name)) return 'Plus'
  }
  if (families.includes('Grok')) {
    if (/heavy/i.test(name)) return 'Heavy'
    if (/free|免费/i.test(name)) return 'Free'
  }
  return null
}
const independentBilling = name => /image|生图|绘图|视频|video|语音|audio|tts|realtime|按次|按张/i.test(name || '')

export function analyzeUpstreamRoutes({ site, groupId, channels, now = Date.now() }) {
  const target = site.groups.find(group => group.id === groupId)
  const targetFamilies = routeFamilies(target?.name)
  if (!targetFamilies.length) targetFamilies.push(...routeFamilies(target?.platform))
  const targetRate = finiteRate(target?.rate) ? target.rate : null
  const priceError = finiteRate(targetRate) ? null : '调度站分组倍率未确认，暂不能判断线路是否符合条件。'
  const targetTier = routeTier(target?.name || '', targetFamilies)
  const targetTiers = targetTier ? [targetTier] : []
  return [...channels.values()].filter(channel => !channel.routingSource).flatMap(channel => (channel.userGroups?.groups ?? []).map(group => {
    const namedFamilies = routeFamilies(group.name)
    const inferredFamilies = namedFamilies.length ? namedFamilies : routeFamilies(group.platform)
    if (!inferredFamilies.length) inferredFamilies.push(...routeFamilies(channel.name))
    const matches = inferredFamilies.filter(family => targetFamilies.includes(family))
    const exactName = nameKey(group.name).length >= 2 && nameKey(group.name) === nameKey(target?.name)
    const keywords = matches.length ? matches : exactName ? ['线路名称相同'] : []
    const tier = routeTier(group.name, inferredFamilies)
    const recharge = channel.rechargeRate ?? 1
    const peakFactor = group.peak ? Math.max(1, group.peak.factor) : 1
    const costRate = effectiveRouteCost(channel, group)
    const keys = (channel.apiKeys?.items ?? []).filter(token => String(token.groupId) === String(group.id))
    const token = (channel.probeTokens ?? []).find(token => String(token.groupId) === String(group.id) && usableAPIKey(token, now) && !token.stale && token.key)
    let status = 'eligible', reason = '名称 / 平台匹配，折算倍率不高于调度站分组倍率；探测验证通过后全部参与调度。'
    if (!target || target.status !== 'active') { status = 'unavailable'; reason = '目标调度站点分组未启用或已移除。' }
    else if (channel.userGroups?.status !== 'ok' || !fresh(channel.userGroups?.updatedAt, now) || channel.apiKeys?.status !== 'ok' || !fresh(channel.apiKeys?.updatedAt, now)) {
      status = 'unavailable'; reason = '线路或令牌列表未完整同步，暂不能判断是否符合条件。'
    } else if (!channel.token || channel.balance?.status !== 'ok' || channel.balance.amount <= 0 || (group.status && group.status !== 'active')) {
      status = 'unavailable'; reason = '上游授权、余额或线路状态暂不满足使用条件。'
    } else if (/拉闸|下架|已停|维护|不可用/.test(group.name)) { status = 'unavailable'; reason = '线路名称含停用或维护提示，需人工核对。' }
    else if (!keywords.length || (targetTiers.length && !targetTiers.includes(tier))) { status = 'unmatched'; reason = targetTiers.length && keywords.length
      ? `目标为 ${targetTiers.join(' / ')}，该线路${tier ? `识别为 ${tier}` : '未说明对应等级'}，需人工确认。` : '未识别到与调度站点分组一致的名称关键词或平台。' }
    else if (priceError || !finiteRate(costRate) || independentBilling(group.name) || independentBilling(target?.name) ||
      group.source === 'automatic' || group.subscriptionType !== 'standard') {
      status = 'unknown-price'; reason = priceError || '自动分组、订阅/独立计费或倍率信息不完整，需确认实际成本。'
    } else if (!isWithinRouteRate(costRate, targetRate)) { status = 'cost-too-high'; reason = '折算倍率高于调度站分组倍率，不参与探测和推送。' }
    let hostname = ''
    try { hostname = new URL(channel.endpoint).hostname.replace(/^www\./, '') } catch { /* Invalid endpoints cannot provide a matching hint. */ }
    const accounts = (site.accounts ?? []).filter(account => account.groupIds.includes(groupId) &&
      [channel.name, group.name, hostname].some(name => nameKey(name).length >= 2 && nameKey(account.name).includes(nameKey(name))))
    return { upstreamId: channel.id, upstreamName: channel.name, endpoint: channel.endpoint, provider: channel.provider,
      groupId: String(group.id), groupName: group.name, platform: group.platform, subscriptionType: group.subscriptionType,
      keywords: tier && keywords.length ? [...keywords, tier] : keywords, status, reason, rawRate: group.rate, rechargeRate: recharge, peakFactor, costRate,
      targetRate,
      pricingNote: group.longContextPricing ? '按普通上下文估算；长上下文的额外阶梯价格需另行核算。' : null,
      rateSource: group.source, tokenCount: keys.length, tokenId: token?.id ?? null, tokenName: token ? probeRouteName(channel, token) : null,
      models: (token?.probeModels ?? []).map(model => ({ id: model.id, protocol: model.protocol })),
      accountSuggestions: accounts.map(account => ({ id: account.id, name: account.name })),
      tokenState: keys.length ? token ? 'existing' : 'unusable' : 'missing', tokenError: null }
  }))
}

export function createRouteDiscovery({ channels, auth, refreshModels, now = Date.now, logs }) {
  const jobs = new Map(), tasks = new Set()
  let stopping = false
  function validate(site, input) {
    if (!isRecord(input) || !Number.isSafeInteger(input.groupId) || !site.groups.some(group => group.id === input.groupId)) {
      throw new SyncError('请选择调度站点分组。')
    }
    if (input.createMissing != null && input.createMissing !== false) throw new SyncError('已取消创建上游令牌，请在上游创建后同步。', 400)
    return { groupId: input.groupId, targetRate: site.groups.find(group => group.id === input.groupId).rate ?? null }
  }
  function start(site, input, synchronizeSite, finished) {
    if (stopping || jobs.get(site.id)?.status === 'running') throw new SyncError('线路识别正在进行，请稍后重试。', 409)
    const config = validate(site, input)
    const job = { id: randomUUID(), status: 'running', config, startedAt: new Date(now()).toISOString(), finishedAt: null,
      total: [...channels.values()].filter(channel => !channel.routingSource).length, completed: 0, upstreams: [], rows: [], errors: [], reused: 0 }
    jobs.set(site.id, job)
    const context = { category: 'discovery', siteId: site.id, siteName: site.name }
    logs?.record({ ...context, actor: 'user', action: '开始识别上游线路', message: `扫描 ${job.total} 个上游站点`, details: { groupId: config.groupId } })
    const task = Promise.resolve().then(async () => {
      try {
        const current = await synchronizeSite()
        if (current.error || current.accountsError) throw new SyncError('调度站点配置同步失败，本次识别已停止。', 502)
        config.targetRate = current.groups.find(group => group.id === config.groupId)?.rate ?? null
        await Promise.allSettled([...channels.values()].filter(channel => !channel.routingSource).map(async ({ id }) => {
          const upstreamStatus = { upstreamId: id, name: channels.get(id).name, status: 'running', routes: 0, error: null }
          job.upstreams.push(upstreamStatus)
          try {
            if (stopping) throw new SyncError('服务正在停止，本次识别已中止。', 503)
            await auth.withAccount(id, async (channel, verify, synchronize) => {
              if (stopping) throw new SyncError('服务正在停止，本次识别已中止。', 503)
              await synchronize()
              if (channel.userGroups?.status !== 'ok' || channel.apiKeys?.status !== 'ok') throw new SyncError(channel.userGroups?.error || channel.apiKeys?.error || '线路目录未完整同步。', 502)
              upstreamStatus.routes = channel.userGroups.groups.length
              const analyze = () => analyzeUpstreamRoutes({ site: current, ...config, channels: new Map([[id, channel]]), now: now() })
              const selectedTokens = analyze().filter(row => row.status === 'eligible' && row.tokenId)
              job.reused += selectedTokens.length
              for (const row of selectedTokens) {
                if (stopping) break
                const token = channel.probeTokens.find(token => token.id === row.tokenId)
                if (token && (!token.probeModels?.length || !fresh(token.modelsUpdatedAt, now()))) {
                  try { await refreshModels(channel, token) } catch { /* Existing helper stores the sanitized error. */ }
                }
              }
              const rows = analyze().map(row => ({ ...row, tokenError: (row.status !== 'eligible' ? null
                  : row.tokenId ? channel.probeTokens.find(token => token.id === row.tokenId)?.modelsError ?? null
                    : row.tokenCount ? channel.probeTokensError ?? null : null) }))
              job.rows.push(...rows)
              upstreamStatus.status = rows.some(row => row.tokenError) || channel.userGroups?.status !== 'ok' || channel.apiKeys?.status !== 'ok' ? 'partial' : 'complete'
            })
          } catch (error) {
            upstreamStatus.status = 'error'; upstreamStatus.error = error instanceof SyncError ? error.message : '上游线路同步失败。'
          } finally { job.completed++ }
        }))
        job.status = stopping || job.upstreams.some(item => item.status !== 'complete') || job.errors.length ? 'partial' : 'complete'
      } catch (error) { job.status = 'error'; job.errors.push(error instanceof SyncError ? error.message : '线路识别未完成，请重试。') }
      finally {
        job.finishedAt = new Date(now()).toISOString()
        for (const item of job.upstreams.filter(item => item.error)) logs?.record({ ...context, channelId: item.upstreamId, channelName: item.name,
          level: 'error', action: '上游线路识别失败', message: item.error })
        logs?.record({ ...context, level: job.status === 'complete' ? 'success' : job.status === 'partial' ? 'warning' : 'error', action: '线路识别结束',
          message: job.errors.join('；') || `已处理 ${job.completed}/${job.total} 个站点，找到 ${job.reused} 个可用的已有令牌`,
          details: { status: job.status, count: job.total, failed: job.upstreams.filter(item => item.status !== 'complete').length } })
        finished(); tasks.delete(task)
      }
    })
    tasks.add(task)
    return job
  }
  return { start, view: id => jobs.get(id) ?? null,
    async stop() { stopping = true; await Promise.allSettled([...tasks]) } }
}
