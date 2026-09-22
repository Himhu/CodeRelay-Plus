import assert from 'node:assert/strict'
import test from 'node:test'
import { probeRouteName } from './route-name.js'

test('route names use the exact group effective rate, fold recharge and retain original metadata', () => {
  const channel = { name: '杂鱼', rechargeRate: 10, userGroups: { status: 'ok', groups: [
    { id: 'other', name: 'claude-kiro', rate: 99 }, { id: 'g', rate: 0.6, source: 'custom' },
  ] } }, token = { id: '3012', name: '123', groupId: 'g', groupName: 'claude-kiro' }
  assert.equal(probeRouteName(channel, token), '杂鱼 · 0.06×')
  assert.equal(token.name, '123')
  assert.equal(token.id, '3012')
  assert.equal(probeRouteName(channel, { id: 42, groupId: 7 }), '杂鱼 · 倍率未知')
  assert.equal(probeRouteName(channel, { id: 42 }), '杂鱼 · 倍率未知')
  channel.userGroups.groups[1].peak = { factor: 2 }
  assert.equal(probeRouteName(channel, token), '杂鱼 · 0.06×–0.12×')
  channel.userGroups.groups[1].rate = 0
  assert.equal(probeRouteName(channel, token), '杂鱼 · 0×')
  channel.rechargeRate = 0
  assert.equal(probeRouteName(channel, token), '杂鱼 · 倍率未知')
  const longName = probeRouteName({ name: '长名称😀'.repeat(30) }, token)
  assert.ok(Buffer.byteLength(longName) <= 100)
  assert.ok(longName.isWellFormed())
  assert.match(longName, /^长名称.+ · 倍率未知$/u)
})
