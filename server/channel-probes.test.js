import assert from 'node:assert/strict'
import test from 'node:test'
import { channelProbeSummary } from './channel-probes.js'

const now = Date.parse('2026-09-18T00:10:30Z')
const end = Math.floor(now / 60000) * 60000
const at = value => new Date(value).toISOString()
const sample = (status, time = end - 60000) => ({ status, at: at(time) })
const model = (status = 'ok', changes = {}) => ({ id: 'gpt-5', protocol: 'chat', status, lastProbeAt: at(now - 1000), ...changes })
const token = (models = [model()], changes = {}) => ({ id: '1', key: 'private-key', status: 'active', probeEnabled: true, probeModels: models, ...changes })

test('overview keeps each token/model distinct and aggregates real observations over the same complete-hour window as probe records', () => {
  const start = end - 3600000
  const channel = { probeTokens: [
    token([model('ok', { probeHistory: [sample('ok', start), sample('error'), sample('error', start - 1), sample('ok', end), sample('ok', now + 60000)] })]),
    token([model('error', { lastProbeAt: at(now - 500), probeHistory: [sample('ok'), sample('ok'), sample('ok'), sample('inconclusive'), { status: 'ok', at: 'bad-date' }] })], { id: '2', probeStatus: 'ok' }),
    token([model('error', { probeHistory: [sample('error')] })], { id: '3', probeEnabled: false }),
  ] }
  const original = structuredClone(channel)
  const summary = channelProbeSummary(channel, now)
  assert.equal(summary.status, 'degraded')
  assert.equal(summary.modelCount, 1)
  assert.equal(summary.monitoredModels, 2)
  assert.equal(summary.counts.ok, 1)
  assert.equal(summary.counts.error, 1)
  assert.equal(summary.enabledTokens, 2)
  assert.equal(summary.history.success, 4)
  assert.equal(summary.history.failed, 2)
  assert.equal(summary.history.uncertain, 1)
  assert.equal(summary.history.total, 7)
  assert.equal(summary.history.rate, 4 / 6 * 100)
  assert.equal(summary.history.start, at(start))
  assert.equal(summary.history.end, at(end))
  assert.equal(summary.lastProbeAt, at(now - 500))
  assert.deepEqual(channel, original, 'Reading statistics must not mutate persisted probe data')
  assert.deepEqual(channelProbeSummary(JSON.parse(JSON.stringify(channel)), now), summary)
  assert.ok(!JSON.stringify(summary).includes('private-key'))
})

test('overview separates disabled, blocked, unknown and stale probes from confirmed successes and failures', () => {
  const status = (tokens, changes = {}, time = now) => channelProbeSummary({ probeTokens: tokens, ...changes }, time).status
  assert.equal(status([]), 'disabled')
  assert.equal(status([token([model()], { probeEnabled: false })]), 'disabled')
  assert.equal(status([token([model(), model('ok', { id: 'claude' })])]), 'healthy')
  assert.equal(status([token([model('error'), model('error', { id: 'claude' })])]), 'down')
  assert.equal(status([token([model(), model('inconclusive', { id: 'claude' })])]), 'degraded')
  assert.equal(status([token([model('inconclusive')])]), 'inconclusive')
  assert.equal(status([token([model('unknown', { lastProbeAt: null })])]), 'unknown')
  assert.equal(status([token([model('ok', { lastProbeAt: at(now + 1) })])]), 'unknown')
  assert.equal(status([token([model('ok', { lastProbeAt: at(now - 120000) })])]), 'healthy')
  assert.equal(status([token([model('ok', { lastProbeAt: at(now - 120001) })])]), 'stale')
  assert.equal(status([token([model('error', { lastProbeAt: at(now - 120001) })])]), 'stale')
  assert.equal(status([token([])]), 'unknown')
  assert.equal(status([token(), token([], { id: '2' })]), 'degraded')
  assert.equal(status([token([model('unsupported', { protocol: 'unsupported' })])]), 'unsupported')
  assert.equal(status([token([model(), model('unsupported', { id: 'image', protocol: 'unsupported' })])]), 'healthy')
  for (const changes of [{ key: '' }, { status: 'inactive' }, { expiresAt: at(now) }, { stale: true }]) {
    assert.equal(status([token([model()], changes)]), 'paused')
  }
  assert.equal(status([token()], { probeTokensUnavailable: true }), 'paused')
  assert.equal(status([token([model()], { modelsError: 'Failed' })]), 'healthy', 'Catalog errors do not override fresh successful probes')
  assert.equal(status([token([model('ok', { lastProbeAt: at(now - 120001) })], { modelsError: 'Failed' })]), 'stale')
  for (const amount of [0, -1]) assert.equal(status([token()], { balance: { status: 'ok', amount } }), 'paused')
  assert.equal(status([token()], { authStatus: 'expired', token: '' }), 'healthy', 'Account login state is not model connectivity')
  const noHistory = channelProbeSummary({ probeTokens: [token()] }, now)
  assert.equal(noHistory.history.total, 0)
  assert.equal(noHistory.history.rate, null)
  assert.equal(channelProbeSummary({}, now).lastProbeAt, null)
})

test('overview excludes auto-paused pairs from live health but retains their real failure history', () => {
  const paused = token([model('error', { autoPaused: true, probeHistory: [sample('error')] })])
  const summary = channelProbeSummary({ probeTokens: [paused, token()] }, now)
  assert.equal(summary.status, 'healthy')
  assert.equal(summary.monitoredModels, 1)
  assert.equal(summary.counts.excluded, 1)
  assert.equal(summary.history.failed, 1)
  assert.match(summary.detail, /明确拒绝或连续失败，已隔离/)
  assert.equal(channelProbeSummary({ probeTokens: [paused] }, now).status, 'paused')
  assert.equal(channelProbeSummary({ probeTokens: [token([model('ok', { revalidatePending: true })])] }, now).status, 'unknown')
})
