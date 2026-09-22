import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { channelTableView } from '../src/channel-table-data.js'

const channels = Array.from({length:105}, (_, index) => {
  const n = index + 1
  return { id:String(n), name:`渠道${String(n).padStart(3,'0')}`, endpoint:`https://upstream-${n}.example.test`,
    provider:'newapi', createdAt:new Date(Date.UTC(2026,8,1,0,0,n)).toISOString(), status:n%2?'healthy':'down',
    auth:{status:'configured'}, balance:{status:'ok',amount:n*10,usdAmount:n,currency:'CNY',symbol:'¥'},
    probeSummary:{status:n%2?'healthy':'down',modelCount:1,modelNames:[n%2?'gpt-test':'claude-test'],enabledTokens:1,tokenCount:1,
      monitoredModels:1,counts:{ok:n%2,error:n%2?0:1},history:{rate:n===105?null:(n-1)*100/104,total:104,success:n-1,failed:105-n},
      lastProbeAt:new Date(Date.UTC(2026,8,1,0,0,n)).toISOString()} }
})

test('channel sorting uses the entire filtered list, actual USD amounts and nulls last in either direction', () => {
  const data = structuredClone(channels)
  data[0].balance = {status:'ok',amount:8,usdAmount:8,currency:'USD'}
  data[1].balance = {status:'error',amount:-50,usdAmount:-5,currency:'CNY'}
  data[2].balance = {status:'ok',amount:999999,currency:'QUOTA'}
  data[3].balance = {status:'ok',amount:-1,usdAmount:-0.1,currency:'CNY'}
  const view = query => channelTableView(data,new URLSearchParams(query))
  assert.equal(view('').rows[0].id,'105')
  assert.equal(view('sort=balance-asc').rows[0].id,'4')
  assert.equal(view('sort=balance-asc').rows[1].id,'5')
  assert.equal(view('sort=balance-desc').rows[0].id,'105')
  assert.deepEqual(view('sort=balance-asc&page=21').rows.slice(-2).map(c=>c.id),['2','3'])
  assert.deepEqual(view('sort=balance-desc&page=21').rows.slice(-2).map(c=>c.id),['2','3'])
  assert.equal(view('sort=rate-desc').rows[0].id,'104')
  assert.equal(view('sort=rate-asc').rows[0].id,'1','Zero success rate is data, not missing')
  assert.equal(view('sort=rate-asc&page=21').rows.at(-1).id,'105')
  assert.equal(view('sort=rate-desc&page=21').rows.at(-1).id,'105')
  assert.equal(view('sort=status-asc').rows[0].status,'down')
  assert.equal(view('q=upstream-83.example.test').rows[0].id,'83')
  assert.equal(view('q=' + encodeURIComponent('https://upstream-83.example.test/v1/chat/completions')).rows[0].id,'83')
  assert.equal(view('q=' + encodeURIComponent('https://www.upstream-83.example.test/api/v1')).total,1)
  data[82].endpoint = 'https://upstream-83.example.test/tenant-a'
  assert.equal(view('q=' + encodeURIComponent('https://upstream-83.example.test/tenant-a/v1/messages')).rows[0].id,'83')
  assert.equal(view('q=' + encodeURIComponent('https://upstream-83.example.test/tenant-b/v1')).total,0)
  const filtered = view('q=claude-test&status=down&page=2&sort=name-asc')
  assert.equal(filtered.total,52); assert.equal(filtered.rows[0].id,'12')
  assert.equal(filtered.counts.all,105); assert.equal(filtered.counts.healthy,53)
  assert.deepEqual(data.map(c=>c.id),channels.map(c=>c.id),'Sorting must not reorder the shared API snapshot')
})

test('channel paging clamps shrinking lists and rejects invalid URL preferences', () => {
  const view = query => channelTableView(channels,new URLSearchParams(query))
  assert.equal(view('page=21').rows.length,5)
  assert.equal(view('page=999').page,21)
  for (const page of ['-1','NaN','Infinity','2.5','9007199254740992']) assert.equal(view(`page=${page}`).page,1)
  assert.equal(view('size=50').pages,21)
  const invalid = view('size=-2&sort=nope&status=nope')
  assert.equal(invalid.pageSize,5); assert.equal(invalid.sort,'created-desc'); assert.equal(invalid.filter,'all')
  const empty = view('q=no-match&page=8')
  assert.equal(empty.page,1); assert.equal(empty.pages,1); assert.deepEqual(empty.rows,[])
  assert.equal(channelTableView(channels.slice(0,12),new URLSearchParams('page=21')).page,3)
})

test('overview paginates 100+ channels, retains URL preferences and page on polling, and fits mobile screens', async t => {
  const directory=mkdtempSync(join(tmpdir(),'signal-channel-table-'))
  const server=await createServer({root:fileURLToPath(new URL('../',import.meta.url)),configFile:false,plugins:[react()],cacheDir:join(directory,'.vite'),server:{host:'127.0.0.1',port:0}})
  await server.listen()
  const browser=await chromium.launch()
  t.after(async()=>{await browser.close();await server.close();rmSync(directory,{recursive:true,force:true})})
  const page=await browser.newPage({viewport:{width:1440,height:1000}}), errors=[],writes=[]
  let data=structuredClone(channels), reads=0
  await page.clock.install()
  page.on('pageerror',error=>errors.push(error.message))
  await page.route('**/api/**',route=>{
    if(route.request().method()!=='GET') writes.push(route.request().url())
    const path=new URL(route.request().url()).pathname
    if(path==='/api/settings') return route.fulfill({json:{settings:{lowBalanceThreshold:5},balanceNotices:{low:[],unavailable:[]}}})
    if(path==='/api/upstream-channels'){reads++;return route.fulfill({json:{channels:data}})}
    return route.fulfill({status:404,json:{error:'Unexpected request'}})
  })
  await page.goto(server.resolvedUrls.local[0])
  const panel=page.locator('.channels-panel'), rows=panel.locator('tbody tr'), pagination=panel.getByRole('navigation',{name:'渠道分页'})
  const first=()=>rows.first().locator('.channel-cell b')
  await expect(rows).toHaveCount(5);await expect(first()).toHaveText('渠道105')
  await expect(pagination.getByRole('button',{name:'上一页',exact:true})).toBeDisabled()
  await pagination.getByRole('button',{name:'下一页',exact:true}).click()
  await expect(first()).toHaveText('渠道100')
  await expect(pagination.getByRole('button',{name:'第 2 页',exact:true})).toHaveAttribute('aria-current','page')
  const priorReads=reads
  await page.clock.fastForward(30000)
  await expect.poll(()=>reads).toBeGreaterThan(priorReads)
  await expect(first()).toHaveText('渠道100')
  await page.reload()
  await expect(first()).toHaveText('渠道100')
  await panel.getByLabel('渠道排序',{exact:true}).selectOption('balance-asc')
  await expect(first()).toHaveText('渠道001')
  await panel.getByLabel('渠道排序',{exact:true}).selectOption('rate-desc')
  await expect(first()).toHaveText('渠道104')
  await pagination.getByRole('button',{name:'第 21 页',exact:true}).click()
  await expect(rows).toHaveCount(5)
  await expect(pagination.getByRole('button',{name:'下一页',exact:true})).toBeDisabled()
  await panel.getByPlaceholder('搜索渠道、模型或 URL').fill('claude-test')
  await expect(panel.getByRole('status')).toContainText('筛选后 52 / 共 105 个 · 第 1 / 11 页')
  await panel.getByRole('button',{name:/^正常 /}).click()
  await expect(panel.getByText('没有匹配的渠道，请调整状态筛选或搜索条件')).toBeVisible()
  await expect(pagination.getByRole('button',{name:'下一页',exact:true})).toBeDisabled()
  await panel.getByRole('button',{name:'清除筛选',exact:true}).click()
  await expect(rows).toHaveCount(5)
  await panel.getByLabel('渠道排序',{exact:true}).selectOption('name-asc')
  await pagination.getByRole('button',{name:'第 21 页',exact:true}).click()
  data=data.slice(0,12)
  await page.clock.fastForward(30000)
  await expect(rows).toHaveCount(2)
  await expect(panel.getByRole('status')).toContainText('第 3 / 3 页')
  await expect(first()).toHaveText('渠道011')
  await panel.getByRole('button',{name:'编辑 渠道011',exact:true}).click()
  await expect(page.getByRole('dialog',{name:'编辑上游渠道',exact:true})).toBeVisible()
  await page.keyboard.press('Escape')
  for(const width of [1440,390,320]){
    await page.setViewportSize({width,height:900})
    await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
    const select=panel.getByLabel('渠道排序',{exact:true})
    const box=await select.boundingBox()
    assert.ok(box&&box.x>=0&&box.x+box.width<=width)
    await panel.screenshot({path:join(tmpdir(),`signal-channel-table-${width}.png`)})
  }
  assert.deepEqual(errors,[]);assert.deepEqual(writes,[])
})
