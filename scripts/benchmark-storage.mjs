// Synthetic data only. Never starts the probe scheduler or contacts upstreams.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createChannelStore } from '../server/site-store.js'
import { monitorAPI } from '../server/monitor-api.js'
import { createServer } from 'node:http'

const directory=mkdtempSync(join(tmpdir(),'signal-storage-benchmark-')), store=createChannelStore(directory)
const count=120, now=Date.now(), started=performance.now()
try {
  for(let c=0;c<count;c++) store.saveChannels([{id:String(c),name:`Test ${c}`,endpoint:'https://example.test',provider:'sub2api',token:'test-secret',
    probeTokens:Array.from({length:2},(_,t)=>({id:String(t),key:'test-key',status:'active',probeEnabled:true,probeModels:Array.from({length:5},(_,m)=>({
      id:`model-${m}`,protocol:'chat',status:'ok',lastProbeAt:new Date(now-60000).toISOString(),
      probeHistory:Array.from({length:1440},(_,i)=>({at:new Date(now-(1440-i)*60000).toISOString(),status:i%5?'ok':'error',latencyMs:100,error:null,httpStatus:i%5?200:503}))
    }))}))}])
  const seedMs=performance.now()-started
  const loadStarted=performance.now(), channels=store.load({recent:true,now}), loadMs=performance.now()-loadStarted
  const models=channels.flatMap(c=>c.probeTokens.flatMap(t=>t.probeModels))
  const liveHistory=models.reduce((n,m)=>n+m.probeHistory.length,0)
  assert.ok(liveHistory<=models.length*66)
  const db=new DatabaseSync(join(directory,'monitor.sqlite'))
  const old=db.prepare('SELECT payload FROM probe_history WHERE channel_id=? AND token_id=? AND model_id=? AND seq=100').get('0','0','model-0').payload
  for(const model of models) model.nextProbeAt=new Date(now+60000).toISOString()
  const reserveStart=performance.now();store.saveChannels(channels);const reserveMs=performance.now()-reserveStart
  for(const model of models) model.probeHistory=[...model.probeHistory,{at:new Date(now).toISOString(),status:'ok',latencyMs:90,httpStatus:200,error:null}]
  const saveStart=performance.now();store.saveChannels(channels);for(const c of channels)store.compact(c,now);const saveMs=performance.now()-saveStart
  assert.deepEqual(db.prepare('SELECT payload FROM probe_history WHERE channel_id=? AND token_id=? AND model_id=? AND seq=100').get('0','0','model-0').payload,old,'Old history must not be re-encrypted or rewritten')
  assert.equal(db.prepare('SELECT count(*) AS n FROM probe_history').get().n,count*2*5*1440)
  db.close()
  const api=monitorAPI({channelStore:store,now:()=>now})
  const server=createServer((req,res)=>api(req,res,()=>res.end()))
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const url=`http://127.0.0.1:${server.address().port}/api/probe-tokens`, readStart=performance.now()
  const response=await fetch(url), bytes=(await response.text()).length, readMs=performance.now()-readStart
  const repeatStart=performance.now(), repeated=await fetch(url,{headers:{'If-None-Match':response.headers.get('etag')}}), repeatMs=performance.now()-repeatStart
  assert.equal(repeated.status,304)
  await new Promise(resolve=>server.close(resolve))
  global.gc?.()
  const metrics={channels:count,tokens:count*2,models:models.length,databaseHistory:count*2*5*1440,liveHistory,seedMs,loadMs,reserveMs,saveMs,readMs,repeatMs,responseBytes:bytes,databaseBytes:statSync(join(directory,'monitor.sqlite')).size,rssMB:process.memoryUsage().rss/1024/1024}
  console.log(JSON.stringify(metrics,null,2))
  assert.ok(reserveMs<1500&&saveMs<2000,'Incremental minute batch must stay below a small fraction of the minute')
} finally { store.close();rmSync(directory,{recursive:true,force:true}) }
