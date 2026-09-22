import { createServer } from 'node:http'
import { isAbsolute } from 'node:path'
import { readFileSync } from 'node:fs'
import { monitorAPI } from './monitor-api.js'
import { createChannelStore, createSecondarySiteStore, createConsoleSettingsStore, createUserGatewayStore, createQQBotStore } from './site-store.js'
import { createConsoleAuth } from './console-auth.js'

const publicOrigin = process.env.SIGNAL_PUBLIC_ORIGIN
const directory = process.env.SIGNAL_DATA_DIR
const port = Number(process.env.PORT || 3000)
const { build } = JSON.parse(readFileSync(new URL('../dist/version.json', import.meta.url), 'utf8'))
if (typeof build !== 'string' || !/^[a-f0-9-]{36}$/.test(build)) throw new Error('Missing or invalid console build version.')
if (!publicOrigin || !directory || !isAbsolute(directory)) {
  throw new Error('Set SIGNAL_PUBLIC_ORIGIN and an absolute SIGNAL_DATA_DIR for production.')
}
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.')

const api = monitorAPI({ publicOrigin, channelStore: createChannelStore(directory), secondaryStore: createSecondarySiteStore(directory), settingsStore: createConsoleSettingsStore(directory), gatewayStore: createUserGatewayStore(directory), qqStore: createQQBotStore(directory) })
const authenticate = createConsoleAuth({ publicOrigin, directory, build, credentialFile: process.env.SIGNAL_AUTH_FILE || '/etc/signal-monitor/auth.json' })
const server = createServer((req, res) => {
  const path = req.url?.split('?')[0]
  const respond = () => api(req, res, () => {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ error: 'Not found' }))
  })
  // QQ callbacks have no console session or Origin. The handler checks the signature.
  if (path === '/api/qq/webhook') return void respond()
  void authenticate(req, res, respond)
})
server.requestTimeout = 30000
server.headersTimeout = 15000
server.once('error', error => {
  console.error(`API listener failed: ${error.code || 'unknown'}`)
  process.exit(1)
})
server.listen(port, '127.0.0.1', () => {
  api.logs.record({ category: 'system', level: 'info', action: '服务启动', message: 'API、探测与自动调度服务已启动' })
  api.auth.start()
  api.probes.start()
  api.routing.start()
  console.log(`Signal Monitor API listening on 127.0.0.1:${port}`)
})

let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  const deadline = setTimeout(() => process.exit(1), 30000)
  deadline.unref()
  await Promise.all([
    new Promise(resolve => server.close(resolve)),
    api.routing.stop(), api.discovery.stop(), api.probes.stop(), api.auth.stop(),
  ])
  api.logs.record({ category: 'system', level: 'info', action: '服务停止', message: '后台任务已结束，服务正常停止' })
  api.closeStores()
  clearTimeout(deadline)
}
process.on('SIGTERM', () => { void stop() })
process.on('SIGINT', () => { void stop() })
