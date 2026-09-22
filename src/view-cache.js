// Display snapshots only. Server storage remains authoritative; auth and payment
// responses, passwords and API keys never enter this cache.
const paths = new Set(['/api/upstream-channels', '/api/probe-tokens', '/api/secondary-sites', '/api/settings'])
const build = typeof __SIGNAL_BUILD__ === 'string' ? __SIGNAL_BUILD__ : 'development'
const memory = new Map(), timers = new Map(), writtenAt = new Map()
let owner = null, generation = 0, database
const maxAge = 24 * 60 * 60000

function validData(path, data) {
  if (!data || typeof data !== 'object') return false
  const field = { '/api/upstream-channels': 'channels', '/api/secondary-sites': 'sites', '/api/probe-tokens': 'probeTokens' }[path]
  if (field) return Array.isArray(data[field]) && data[field].every(item => item && typeof item === 'object' && item.id != null)
  return path === '/api/settings' && Number.isFinite(data.settings?.lowBalanceThreshold) && Array.isArray(data.balanceNotices?.low) && Array.isArray(data.balanceNotices?.unavailable)
}

const validRecord = record => record.owner === owner && record.build === build && paths.has(record.path)
  && Number.isFinite(record.savedAt) && record.savedAt <= Date.now() + 60000 && Date.now() - record.savedAt < maxAge && validData(record.path, record.data)

function openDatabase() {
  if (!database) database = new Promise(resolve => {
    try {
      const request = indexedDB.open('signal-display-cache', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('views', { keyPath: 'path' })
      request.onsuccess = () => resolve(request.result)
      request.onerror = request.onblocked = () => resolve(null)
    } catch { resolve(null) }
  })
  return database
}

async function transaction(mode, action) {
  const db = await openDatabase()
  if (!db) return null
  return new Promise(resolve => {
    try {
      const tx = db.transaction('views', mode)
      const request = action(tx.objectStore('views'))
      tx.oncomplete = () => resolve(request?.result)
      tx.onerror = tx.onabort = () => resolve(null)
    } catch { resolve(null) }
  })
}

export async function prepareViewCache(username) {
  if (owner === username) return
  resetMemory()
  owner = username
  const current = generation
  // A browser database must never hold the authenticated UI indefinitely.
  // Hydrate late snapshots in memory without overwriting newer network data.
  const restore = transaction('readwrite', store => {
    const request = store.getAll()
    request.onsuccess = () => {
      if (current === generation) for (const record of request.result) if (!validRecord(record)) store.delete(record.path)
    }
    return request
  }).then(records => {
    if (current !== generation || !Array.isArray(records)) return
    for (const record of records) {
      if (validRecord(record) && !memory.has(record.path)) memory.set(record.path, record)
    }
  }).catch(() => {})
  let deadline
  await Promise.race([restore, new Promise(resolve => { deadline = setTimeout(resolve, 2000) })])
  clearTimeout(deadline)
}

function resetMemory() {
  generation++
  memory.clear(); writtenAt.clear()
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
}

export function clearViewCache() {
  resetMemory(); owner = null
  void transaction('readwrite', store => store.clear())
}

export const viewCacheGeneration = () => generation
export function readViewCache(path) {
  const record = memory.get(path)
  return record && Date.now() - record.savedAt < maxAge ? record : null
}

export function writeViewCache(path, data, expectedGeneration) {
  if (!owner || expectedGeneration !== generation || !paths.has(path) || !validData(path, data)) return
  const record = { path, data, owner, build, savedAt: Date.now() }
  memory.set(path, record)
  // Probe history can be large. Keep the complete snapshot in memory and persist
  // at most once per 30 seconds, without changing the server's polling cadence.
  if (timers.has(path)) return
  const delay = Math.max(0, (writtenAt.get(path) || 0) + 30000 - Date.now())
  timers.set(path, setTimeout(() => {
    timers.delete(path)
    if (expectedGeneration !== generation) return
    writtenAt.set(path, Date.now())
    const latest = memory.get(path)
    void transaction('readwrite', store => {
      if (expectedGeneration === generation) return store.put(latest)
    })
  }, delay))
}

export const cachedDataLabel = savedAt => `上次数据 · ${new Date(savedAt).toLocaleString('zh-CN', { hour12: false })}`
