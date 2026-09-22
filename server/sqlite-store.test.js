import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:http'
import { createChannelStore, createSecondarySiteStore, createConsoleSettingsStore, encryptedStore, exportLegacySnapshots } from './site-store.js'
import { monitorAPI } from './monitor-api.js'

const now = Date.now()
const channel = (id = 'a', count = 1440) => ({ id, name: id, endpoint: 'https://example.test', provider: 'sub2api', token: 'private-access-secret', refreshToken: 'private-refresh-secret',
  probeTokens: [{ id: '1', key: 'private-api-secret', probeModels: [{ id: 'm', protocol: 'chat', nextProbeAt: new Date(now + 60000).toISOString(),
    probeHistory: Array.from({ length: count }, (_, index) => ({ at: new Date(now - (count - index) * 60000).toISOString(), status: index === 0 ? 'ok' : 'error', error: 'safe-error' })) }] }] })
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'signal-sqlite-test-'))
  const store = createChannelStore(directory)
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  return { directory, store }
}
const withoutSummary = records => JSON.parse(JSON.stringify(records, (name, value) => name === 'probeHistorySummary' ? undefined : value))

test('legacy migration verifies all records, preserves originals and secrets, resumes idempotently and bounds live history', t => {
  const { directory, store } = fixture(t)
  const original = [channel()]
  const legacy = encryptedStore(directory, 'upstream-channels.enc.json', '渠道', () => true)
  legacy.save(original)
  const backup = readFileSync(join(directory, 'upstream-channels.enc.json'))
  assert.deepEqual(withoutSummary(store.load()), original)
  assert.deepEqual(readFileSync(join(directory, 'upstream-channels.enc.json')), backup)
  const recent = store.load({ recent: true, now })
  const model = recent[0].probeTokens[0].probeModels[0]
  assert.ok(model.probeHistory.length <= 66)
  assert.equal(model.probeHistorySummary.failureCount, 1439)
  assert.equal(model.probeHistorySummary.lastSuccessAt, original[0].probeTokens[0].probeModels[0].probeHistory[0].at)
  model.probeHistory = [...model.probeHistory, { at: new Date(now).toISOString(), status: 'ok' }]
  store.saveChannels(recent); store.compact(recent[0], now)
  store.saveChannels(recent)
  const saved = store.load()[0].probeTokens[0].probeModels[0]
  assert.equal(saved.probeHistory.length, 1440)
  assert.equal(saved.probeHistory.at(-1).status, 'ok')
  assert.equal(saved.probeHistorySummary.failureCount, 0)
  assert.deepEqual(readFileSync(join(directory, 'upstream-channels.enc.json')), backup)
  for (const name of readdirSync(directory).filter(name => name.startsWith('monitor.sqlite'))) {
    assert.equal(statSync(join(directory,name)).mode & 0o777, 0o600)
    const bytes = readFileSync(join(directory,name))
    for (const secret of ['private-access-secret','private-refresh-secret','private-api-secret']) assert.ok(!bytes.includes(Buffer.from(secret)))
  }
  store.close()
  writeFileSync(join(directory, 'upstream-channels.enc.json'), 'legacy file no longer authoritative')
  assert.equal(store.load()[0].probeTokens[0].probeModels[0].probeHistory.length, 1440)
  store.close()
  rmSync(join(directory,'storage.key'))
  assert.throws(() => store.load(), /密钥缺失/)
})

test('failed multi-channel transaction leaves credentials, reservations and histories intact; retry and full deletion work', t => {
  const { directory, store } = fixture(t)
  const records = [channel('a', 2),channel('b', 2)]
  store.save(records)
  const before = store.load()
  const db = new DatabaseSync(join(directory,'monitor.sqlite'))
  t.after(() => db.close())
  db.exec("CREATE TRIGGER fail_write BEFORE UPDATE ON records WHEN NEW.id='b' BEGIN SELECT RAISE(ABORT,'test disk failure'); END")
  for (const record of records) {
    record.token = 'new-private-secret'
    const model = record.probeTokens[0].probeModels[0]
    model.nextProbeAt = new Date(now + 120000).toISOString()
    model.probeHistory.push({at:new Date(now).toISOString(),status:'ok'})
  }
  assert.throws(() => store.saveChannels(records), /test disk failure/)
  assert.deepEqual(store.load(), before)
  db.exec('DROP TRIGGER fail_write')
  store.saveChannels(records)
  assert.equal(store.load()[0].probeTokens[0].probeModels[0].probeHistory.length,3)
  const beforeOther = store.load()[1]
  records[0].name='changed'
  store.saveChannels([records[0]])
  assert.deepEqual(store.load()[1], beforeOther)
  store.save([records[0]])
  assert.equal(db.prepare("SELECT count(*) AS n FROM probe_history WHERE channel_id='b'").get().n,0)
  records[0].probeTokens=[];store.saveChannels([records[0]])
  assert.equal(db.prepare('SELECT count(*) AS n FROM probe_history').get().n,0)
})

test('corrupt legacy migration fails closed and can be retried; secondary sites and settings share encrypted DB', t => {
  const { directory, store } = fixture(t)
  const legacy = encryptedStore(directory, 'upstream-channels.enc.json', '渠道', () => true)
  legacy.save([channel('a',1)])
  const good = readFileSync(join(directory,'upstream-channels.enc.json'))
  writeFileSync(join(directory,'upstream-channels.enc.json'),'broken')
  assert.throws(() => store.load(), /已有数据未被覆盖/)
  writeFileSync(join(directory,'upstream-channels.enc.json'),good)
  assert.equal(store.load().length,1)
  const sites = createSecondarySiteStore(directory), settings = createConsoleSettingsStore(directory)
  t.after(() => {sites.close();settings.close()})
  sites.save([{id:'side',provider:'sub2api',groups:[],token:'private-admin-secret'}])
  settings.save([{lowBalanceThreshold:7.5}])
  assert.equal(sites.load()[0].token,'private-admin-secret')
  assert.equal(settings.load()[0].lowBalanceThreshold,7.5)
  assert.equal(store.load()[0].token,'private-access-secret')
})

test('probe polling returns bounded history and 304 until data changes', async t => {
  const { store } = fixture(t)
  store.save([channel()])
  const api=monitorAPI({channelStore:store,now:()=>now})
  const server=createServer((req,res)=>api(req,res,()=>res.end()))
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(()=>new Promise(resolve=>server.close(resolve)))
  const url=`http://127.0.0.1:${server.address().port}/api/probe-tokens`
  const first=await fetch(url), etag=first.headers.get('etag'), payload=await first.json()
  assert.ok(payload.probeTokens[0].probeModels[0].history.length<=66)
  assert.equal(payload.probeTokens[0].probeModels[0].historySummary.failureCount,1439)
  assert.ok(!JSON.stringify(payload).includes('private-'))
  const second=await fetch(url,{headers:{'If-None-Match':etag}})
  assert.equal(second.status,304)
  assert.equal(await second.text(),'')
  const compressed=await fetch(url,{headers:{'If-None-Match':`W/${etag}`}})
  assert.equal(compressed.status,304,'Compressed proxy ETags must also avoid downloading unchanged history')
})


test('downgrade export includes the latest rotated credentials, settings and complete histories', t => {
  const {directory,store}=fixture(t)
  store.save([channel('a',1440)])
  const current=store.load({recent:true,now})
  current[0].refreshToken='rotated-refresh-secret'
  current[0].probeTokens[0].probeModels[0].probeHistory.push({at:new Date(now).toISOString(),status:'ok'})
  store.saveChannels(current)
  const expected=store.load()
  exportLegacySnapshots(directory)
  const legacy=encryptedStore(directory,'upstream-channels.enc.json','渠道',()=>true)
  assert.deepEqual(legacy.load(),expected)
  assert.equal(legacy.load()[0].refreshToken,'rotated-refresh-secret')
  assert.equal(legacy.load()[0].probeTokens[0].probeModels[0].probeHistory.length,1440)
})
