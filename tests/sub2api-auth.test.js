import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer as createHTTPServer } from 'node:http'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { chromium } from 'playwright'
import { createServer } from 'vite'

test('Sub2API login proofs, background renewal and reauthorization work in the browser', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-auth-browser-'))
  const previousDirectory = process.env.SIGNAL_DATA_DIR
  process.env.SIGNAL_DATA_DIR = directory
  let vite, browser, upstream, renewalTimeout
  t.after(async () => {
    clearTimeout(renewalTimeout)
    await browser?.close()
    await vite?.close()
    upstream?.close()
    if (previousDirectory === undefined) delete process.env.SIGNAL_DATA_DIR
    else process.env.SIGNAL_DATA_DIR = previousDirectory
    rmSync(directory, { recursive: true, force: true })
  })
  let version = 0, profileFailure = '', logins = 0, refreshes = 0, notifyRenewed
  const renewed = new Promise(resolve => { notifyRenewed = resolve })
  const proofs = new Set()
  const tokens = () => ({access_token:`browser-access-secret-${version}`,refresh_token:`browser-refresh-secret-${version}`,expires_in:20})
  upstream = createHTTPServer(async (req, res) => {
    const chunks=[]; for await (const chunk of req) chunks.push(chunk)
    const body=chunks.length?JSON.parse(Buffer.concat(chunks)):null
    const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data))}
    if(req.url==='/api/v1/auth/login') {
      logins++
      assert.equal(body.password,'browser-password-secret')
      if(!body.turnstile_token?.startsWith('valid-proof-') || proofs.has(body.turnstile_token)) return send(400,{code:'CAPTCHA_INVALID'})
      proofs.add(body.turnstile_token)
      return send(200,{code:0,data:{requires_2fa:true,temp_token:'browser-temporary-secret'}})
    }
    if(req.url==='/api/v1/auth/login/2fa') {
      assert.deepEqual(body,{temp_token:'browser-temporary-secret',totp_code:'123456'})
      version++
      return send(200,{code:0,data:tokens()})
    }
    if(req.url==='/api/v1/auth/refresh') {
      assert.deepEqual(body,{refresh_token:`browser-refresh-secret-${version}`})
      refreshes++;version++
      send(200,{code:0,data:tokens()})
      notifyRenewed()
      return
    }
    if(req.url==='/api/v1/groups/available') {
      assert.equal(req.headers.authorization,`Bearer browser-access-secret-${version}`)
      return send(200,{code:0,data:[{id:1,name:'用户可用线路',platform:'openai',rate_multiplier:2,
        subscription_type:'subscription',peak_rate_enabled:true,peak_start:'18:00',peak_end:'22:00',peak_rate_multiplier:1.5}]})
    }
    if(req.url==='/api/v1/groups/rates') return send(200,{code:0,data:{1:0}})
    if(req.url.startsWith('/api/v1/keys?')) return send(200,{code:0,data:{page:1,page_size:100,total:2,items:[
      {id:31,name:'已有启用令牌',group_id:1,status:'active',key:'private-api-secret'},
      {id:32,name:'已有停用令牌',group_id:1,status:'inactive',key:'private-disabled-secret'},
    ]}})
    if(req.url==='/v1/models') {
      assert.equal(req.method,'GET')
      assert.equal(req.headers.authorization,'Bearer private-api-secret')
      return send(200,{object:'list',data:[{id:'gpt-5'}]})
    }
    if(req.url==='/api/v1/announcements'||req.url==='/api/v1/subscriptions/progress') return send(200,{code:0,data:[]})
    assert.equal(req.url,'/api/v1/auth/me')
    assert.equal(req.headers.authorization,`Bearer browser-access-secret-${version}`)
    if(profileFailure==='revoked') return send(401,{code:'TOKEN_REVOKED'})
    if(profileFailure==='temporary') return send(503,{code:503})
    send(200,{code:0,data:{id:7,email:'ordinary@example.test',role:'user',balance:23.456789}})
  })
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening')
  vite=await createServer({root:fileURLToPath(new URL('../',import.meta.url)),cacheDir:join(directory,'node_modules','.vite'),
    server:{host:'127.0.0.1',port:5175,strictPort:true}})
  await vite.listen()
  const base=vite.resolvedUrls.local[0]
  browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH})
  let page=await browser.newPage({viewport:{width:1440,height:1000}})
  const errors=[]; page.on('pageerror',error=>errors.push(error.message))
  await page.goto(base)
  await page.getByRole('button',{name:'添加渠道',exact:true}).click()
  let dialog=page.getByRole('dialog',{name:'添加上游渠道',exact:true})
  assert.equal(await dialog.getByRole('checkbox', { name: /^自动探测新令牌/ }).isChecked(), true)
  // This test covers authorization only; keep its mock upstream free of paid probe calls.
  await dialog.getByRole('checkbox', { name: /^自动探测新令牌/ }).uncheck()
  await dialog.getByText('Sub2API',{exact:true}).click()
  await dialog.locator('[name="channel-name"]').fill('Sub2API 授权验证')
  await dialog.locator('[name="endpoint"]').fill(`http://127.0.0.1:${upstream.address().port}/v1`)
  await dialog.locator('[name="sub2api-email"]').fill('ordinary@example.test')
  await dialog.locator('[name="sub2api-password"]').fill('browser-password-secret')
  await dialog.locator('[name="totp-code"]').fill('123456')
  await dialog.locator('[name="turnstile-token"]').fill('rejected-proof-secret')
  await dialog.getByRole('button',{name:'保存配置',exact:true}).click()
  await dialog.getByRole('alert').waitFor()
  assert.equal(await dialog.locator('[name="turnstile-token"]').inputValue(),'')
  assert.equal(await dialog.locator('[name="sub2api-password"]').inputValue(),'browser-password-secret')
  await dialog.locator('[name="turnstile-token"]').fill('valid-proof-one')
  await dialog.getByRole('button',{name:'显示人机验证凭证（按需填写）',exact:true}).click()
  assert.equal(await dialog.locator('[name="turnstile-token"]').getAttribute('type'),'text')
  await dialog.getByRole('button',{name:'保存配置',exact:true}).click()
  await dialog.waitFor({state:'detached'})
  await page.getByText('已登录',{exact:true}).waitFor()
  await page.getByText('自动续期已开启',{exact:true}).waitFor()
  await page.getByText('未启用',{exact:true}).waitFor()
  await page.getByRole('button',{name:'刷新余额 Sub2API 授权验证',exact:true}).click()
  await page.getByLabel('Sub2API 授权验证 账户余额',{exact:true}).getByText('$23.46',{exact:false}).waitFor()
  const beforeBackgroundLogins=logins
  await page.close()
  await Promise.race([renewed,new Promise((_,reject)=>{renewalTimeout=setTimeout(()=>reject(new Error('Background refresh did not run')),22000)})])
  clearTimeout(renewalTimeout)
  assert.equal(logins,beforeBackgroundLogins)
  assert.equal(refreshes,1)
  page=await browser.newPage({viewport:{width:1440,height:1000}})
  page.on('pageerror',error=>errors.push(error.message))
  await page.goto(base)
  await page.getByText('已登录',{exact:true}).waitFor()
  let listed=await page.request.get(base+'api/upstream-channels').then(response=>response.json())
  assert.ok(listed.channels[0].auth.refreshedAt)
  assert.ok(!JSON.stringify(listed).includes('secret'))
  for (const name of ['monitor.sqlite', 'monitor.sqlite-wal']) if (existsSync(join(directory, name))) {
    assert.ok(!readFileSync(join(directory, name)).includes(Buffer.from('browser-access-secret')))
  }
  profileFailure='revoked'
  await page.getByRole('button',{name:'检查授权 Sub2API 授权验证',exact:true}).click()
  await page.getByText('需要重新授权',{exact:true}).waitFor()
  const beforeReauth=listed.channels[0].id
  await page.getByRole('button',{name:'重新授权 Sub2API 授权验证',exact:true}).click()
  dialog=page.getByRole('dialog',{name:'上游重新授权',exact:true})
  await dialog.waitFor()
  assert.equal(await dialog.locator('[name="sub2api-email"]').inputValue(),'ordinary@example.test')
  assert.equal(await dialog.locator('[name="sub2api-password"]').inputValue(),'')
  assert.equal(await dialog.locator('[name="turnstile-token"]').inputValue(),'')
  assert.ok(await dialog.locator('[name="endpoint"]').getAttribute('readonly')!==null)
  await page.setViewportSize({width:390,height:844})
  await page.screenshot({path:'/tmp/sub2api-auth-mobile.png',fullPage:true})
  const bounds=await dialog.boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=390)
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth))
  profileFailure=''
  await dialog.locator('[name="sub2api-password"]').fill('browser-password-secret')
  await dialog.locator('[name="totp-code"]').fill('123456')
  await dialog.locator('[name="turnstile-token"]').fill('valid-proof-two')
  await dialog.getByRole('button',{name:'保存配置',exact:true}).click()
  await dialog.waitFor({state:'detached'})
  await page.setViewportSize({width:1440,height:1000})
  await page.getByText('已登录',{exact:true}).waitFor()
  listed=await page.request.get(base+'api/upstream-channels').then(response=>response.json())
  assert.equal(listed.channels.length,1)
  assert.equal(listed.channels[0].id,beforeReauth)
  await page.getByRole('button',{name:'刷新余额 Sub2API 授权验证',exact:true}).click()
  await page.getByLabel('Sub2API 授权验证 账户余额',{exact:true}).getByText('$23.46',{exact:false}).waitFor()
  profileFailure='temporary'
  await page.getByRole('button',{name:'检查授权 Sub2API 授权验证',exact:true}).click()
  await page.getByText('暂时无法确认',{exact:true}).waitFor()
  await page.getByLabel('Sub2API 授权验证 账户余额',{exact:true}).getByText('查询失败 · 上次结果',{exact:true}).waitFor()
  assert.equal(await page.getByText('需要重新授权',{exact:true}).count(),0)
  profileFailure=''
  await page.getByRole('button',{name:'检查授权 Sub2API 授权验证',exact:true}).click()
  await page.getByText('已登录',{exact:true}).waitFor()
  await page.getByRole('button',{name:'查看 Sub2API 授权验证 的线路倍率',exact:true}).click()
  const detail=page.getByRole('dialog',{name:'Sub2API 授权验证',exact:true})
  await detail.getByRole('heading',{name:'用户可用线路',exact:true}).waitFor()
  assert.equal(await detail.locator('.route-group-rate strong').innerText(),'0×')
  assert.match(await detail.locator('.route-rate-details').innerText(),/默认倍率\s*2×/)
  assert.match(await detail.locator('.route-rate-details').innerText(),/用户专属倍率\s*0×/)
  assert.match(await detail.locator('.route-peak').innerText(),/18:00–22:00.*1.5/)
  await detail.getByText('已创建 2 个令牌',{exact:true}).waitFor()
  assert.equal(await detail.locator('.route-groups .route-key-list').count(),0)
  await detail.locator('.created-keys summary').click()
  await detail.locator('.created-keys').getByText('已有启用令牌',{exact:true}).waitFor()
  await detail.locator('.created-keys').getByText('已有停用令牌',{exact:true}).waitFor()
  await detail.locator('.created-keys').getByText('已停用',{exact:true}).waitFor()
  await detail.locator('.unkeyed-routes summary').click()
  await detail.getByText('当前没有未创建令牌的可用线路。',{exact:true}).waitFor()
  await page.setViewportSize({width:390,height:844})
  assert.ok(await page.locator('.detail-drawer').evaluate(el=>el.scrollWidth<=el.clientWidth))
  await detail.getByRole('button',{name:'关闭渠道详情',exact:true}).click()
  await page.setViewportSize({width:1440,height:1000})
  await page.screenshot({path:'/tmp/sub2api-auth-desktop.png',fullPage:true})
  await page.reload()
  await page.getByText('已登录',{exact:true}).waitFor()
  assert.deepEqual(errors,[])
})
