import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, request } from 'playwright'

const { url, username, password } = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const anonymous = await request.newContext({ baseURL: url })
let browser
try {
  assert.equal((await anonymous.get('/')).status(), 200)
  assert.equal((await anonymous.get('/api/auth/session')).status(), 200)
  for (const path of ['/api/secondary-sites', '/api/upstream-channels', '/api/probe-tokens']) {
    const response = await anonymous.get(path)
    assert.equal(response.status(), 401)
    assert.equal(response.headers()['www-authenticate'], undefined)
  }
  const redirect = await anonymous.get(url.replace('https:', 'http:'), { maxRedirects: 0 })
  assert.equal(redirect.status(), 301)
  assert.equal(redirect.headers().location, url + '/')
  assert.equal((await anonymous.post('/api/auth/login', { data: { username, password }, headers: { Origin: 'https://foreign.example' } })).status(), 403)
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH })
  for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    if (process.env.SIGNAL_VERIFY_VIEWPORT && process.env.SIGNAL_VERIFY_VIEWPORT !== name) continue
    const context = await browser.newContext({ viewport })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const loginHeading = () => page.getByRole('heading', { name: '登录 signal', exact: true })
    const login = async (remember = false) => {
      await page.getByLabel('账号', { exact: true }).fill(username)
      await page.getByLabel('密码', { exact: true }).fill(password)
      await page.getByRole('checkbox', { name: '保持登录 7 天' }).setChecked(remember)
      await page.getByRole('button', { name: '登录', exact: true }).click()
    }
    await page.goto(`${url}/#secondary-channels`)
    await loginHeading().waitFor()
    await page.getByLabel('账号', { exact: true }).waitFor()
    assert.equal(await page.locator('.app-shell').count(), 0)
    await page.screenshot({ path: join(tmpdir(), `signal-login-${name}.png`), fullPage: true })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await page.getByLabel('密码', { exact: true }).fill('incorrect-test-password')
    await page.getByRole('button', { name: '显示密码', exact: true }).click()
    assert.equal(await page.getByLabel('密码', { exact: true }).getAttribute('type'), 'text')
    await page.getByRole('button', { name: '隐藏密码', exact: true }).click()
    assert.equal(await page.getByLabel('密码', { exact: true }).getAttribute('type'), 'password')
    await page.getByLabel('账号', { exact: true }).fill(username)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: '账号或密码不正确。' }).waitFor()
    await login(true)
    await page.getByRole('heading', { level: 1, name: '调度站点', exact: true }).waitFor()
    const cookie = (await context.cookies()).find(item => item.name === '__Host-signal_session')
    assert.ok(cookie?.secure && cookie.httpOnly && cookie.sameSite === 'Lax')
    assert.ok(cookie.expires > Date.now() / 1000 + 6 * 86400)
    assert.ok(!JSON.stringify(await page.evaluate(() => ({ ...localStorage }))).includes(cookie.value))
    const session = await context.request.get(`${url}/api/auth/session`)
    const build = session.headers()['x-signal-build']
    assert.match(build, /^[a-f0-9-]{36}$/)
    const headers = { 'X-Signal-Build': build }
    const stale = await context.request.get(`${url}/api/upstream-channels`)
    assert.equal(stale.status(), 409)
    assert.equal((await stale.json()).code, 'CLIENT_OUTDATED')
    for (const [path, key] of [['/api/secondary-sites', 'sites'], ['/api/upstream-channels', 'channels'], ['/api/probe-tokens', 'probeTokens']]) {
      const response = await context.request.get(`${url}${path}`, { headers, timeout: 60000 })
      assert.equal(response.status(), 200)
      assert.ok(Array.isArray((await response.json())[key]))
    }
    assert.equal((await context.request.post(`${url}/api/upstream-channels`, { data: {}, headers: { ...headers, Origin: url } })).status(), 400)
    assert.equal((await context.request.post(`${url}/api/upstream-channels`, { data: {}, headers: { Origin: 'https://foreign.example' } })).status(), 403)
    for (const [hash, title] of [['overview', '总览'], ['secondary-channels', '调度站点'], ['probes', '探针监控']]) {
      await page.goto(`${url}/#${hash}`)
      await page.getByRole('heading', { level: 1, name: title, exact: true }).waitFor()
      await page.reload()
      await page.getByRole('heading', { level: 1, name: title, exact: true }).waitFor()
      assert.equal(new URL(page.url()).hash, `#${hash}`)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    }
    await page.getByRole('button', { name: '退出登录', exact: true }).click()
    await loginHeading().waitFor()
    assert.equal((await anonymous.get('/api/secondary-sites', { headers: { Cookie: `${cookie.name}=${cookie.value}` } })).status(), 401)
    await page.reload()
    await loginHeading().waitFor()
    await login(false)
    await page.getByRole('heading', { level: 1, name: '探针监控', exact: true }).waitFor()
    const shortCookie = (await context.cookies()).find(item => item.name === '__Host-signal_session')
    assert.equal(shortCookie.expires, -1)
    // Revoke this session from another request and confirm the next API read returns to login.
    await context.request.post(`${url}/api/auth/logout`, { data: {}, headers: { Origin: url } })
    await page.locator('.sidebar .nav-item').filter({ hasText: '总览' }).click()
    await loginHeading().waitFor()
    assert.equal(await page.locator('.app-shell').count(), 0)
    assert.deepEqual(errors, [])
    console.log(`${name}: login, errors, password visibility, navigation, persistent cookie, logout and expiry passed`)
    await context.close()
  }
  console.log('Trusted HTTPS, protected APIs, no Basic Auth prompt and same-origin checks passed')
} finally {
  await browser?.close()
  await anonymous.dispose()
}
