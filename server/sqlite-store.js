import { DatabaseSync } from 'node:sqlite'
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto'
import { chmodSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { join } from 'node:path'
import { recentProbeHistory, summarizeProbeHistory } from './probe-history.js'

// One service owns the in-memory business state. SQLite transactions protect
// durable reservations, credentials and history; WAL permits backup/readers.
export function sqliteStore(directory, { scope, legacy, key, validEntry }) {
  let db, secret, revision = 0
  const documents = new Map(), histories = new Map()
  const encode = text => {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', secret, iv)
    const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), data])
  }
  const decode = value => {
    const data = Buffer.from(value), cipher = createDecipheriv('aes-256-gcm', secret, data.subarray(0, 12))
    cipher.setAuthTag(data.subarray(12, 28))
    return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8')
  }
  const idOf = (record, index) => String(record.id ?? index)
  const identity = (channel, token, model) => JSON.stringify([String(channel), String(token), String(model)])
  let selectHistory, recentHistory, upsert, insertHistory, pruneHistory, deleteHistory
  function open() {
    if (db) return
    secret = key()
    const file = join(directory, 'monitor.sqlite')
    try {
      db = new DatabaseSync(file)
      chmodSync(file, 0o600)
      db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;')
      db.exec(`CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value BLOB NOT NULL);
        CREATE TABLE IF NOT EXISTS records (scope TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, payload BLOB NOT NULL, PRIMARY KEY(scope,id));
        CREATE TABLE IF NOT EXISTS probe_history (
          scope TEXT NOT NULL DEFAULT 'channels', channel_id TEXT NOT NULL, token_id TEXT NOT NULL, model_id TEXT NOT NULL,
          seq INTEGER NOT NULL, at INTEGER, status TEXT, payload BLOB NOT NULL,
          PRIMARY KEY(channel_id,token_id,model_id,seq),
          FOREIGN KEY(scope,channel_id) REFERENCES records(scope,id) ON DELETE CASCADE);
        CREATE INDEX IF NOT EXISTS probe_history_time ON probe_history(channel_id,token_id,model_id,at);
        CREATE INDEX IF NOT EXISTS probe_history_global_time ON probe_history(at DESC);
        CREATE TABLE IF NOT EXISTS operation_logs (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, at INTEGER NOT NULL,
          category TEXT NOT NULL, level TEXT NOT NULL, site_id TEXT NOT NULL, channel_id TEXT NOT NULL,
          search TEXT NOT NULL, payload BLOB NOT NULL);
        CREATE INDEX IF NOT EXISTS operation_logs_time ON operation_logs(at DESC,seq DESC);
        CREATE INDEX IF NOT EXISTS operation_logs_site ON operation_logs(site_id,at DESC);
        CREATE INDEX IF NOT EXISTS operation_logs_channel ON operation_logs(channel_id,at DESC);
        CREATE INDEX IF NOT EXISTS operation_logs_category ON operation_logs(category,at DESC);`)
      const check = db.prepare('SELECT value FROM metadata WHERE name=?').get('encryption')
      if (check && decode(check.value) !== 'signal-monitor-v1') throw new Error('Invalid encryption key')
      if (!check) db.prepare('INSERT INTO metadata VALUES (?,?)').run('encryption', encode('signal-monitor-v1'))
      selectHistory = db.prepare('SELECT seq,payload FROM probe_history WHERE channel_id=? AND token_id=? AND model_id=? ORDER BY seq')
      recentHistory = db.prepare(`SELECT seq,payload FROM probe_history WHERE channel_id=? AND token_id=? AND model_id=? AND at>=?
        UNION SELECT seq,payload FROM (SELECT seq,payload FROM probe_history WHERE channel_id=? AND token_id=? AND model_id=? ORDER BY seq DESC LIMIT 8)
        ORDER BY seq`)
      upsert = db.prepare('INSERT INTO records VALUES (?,?,?,?) ON CONFLICT(scope,id) DO UPDATE SET position=excluded.position,payload=excluded.payload')
      insertHistory = db.prepare('INSERT INTO probe_history(channel_id,token_id,model_id,seq,at,status,payload) VALUES (?,?,?,?,?,?,?)')
      pruneHistory = db.prepare('DELETE FROM probe_history WHERE channel_id=? AND token_id=? AND model_id=? AND seq<=?')
      deleteHistory = db.prepare('DELETE FROM probe_history WHERE channel_id=? AND token_id=? AND model_id=?')
      if (!db.prepare('SELECT 1 FROM metadata WHERE name=?').get(`migrated:${scope}`)) {
        const records = legacy.load()
        transaction(() => {
          write(records, true, true)
          // Verify decrypted content, not only row counts, before accepting migration.
          const restored = read(false)
          const canonical = value => JSON.stringify(value, (name, item) => name === 'probeHistorySummary' ? undefined : item)
          if (!isDeepStrictEqual(JSON.parse(canonical(restored)), JSON.parse(canonical(records)))) throw new Error('Migration verification failed')
          const digest = createHash('sha256').update(canonical(records)).digest('hex')
          db.prepare('INSERT INTO metadata VALUES (?,?)').run(`migrated:${scope}`, Buffer.from(JSON.stringify({ records: records.length, digest })))
        })
      }
    } catch (error) {
      db?.close(); db = null
      documents.clear(); histories.clear()
      throw new Error('无法读取本地数据库，请检查 monitor.sqlite、旧 JSON 和 storage.key；已有数据未被覆盖。', { cause: error })
    }
  }
  function transaction(operation) {
    db.exec('BEGIN IMMEDIATE')
    try { const result = operation(); db.exec('COMMIT'); return result }
    catch (error) { db.exec('ROLLBACK'); documents.clear(); histories.clear(); throw error }
  }
  function read(recent, now = Date.now()) {
    const records = db.prepare('SELECT id,payload FROM records WHERE scope=? ORDER BY position,rowid').all(scope).map(row => {
      const record = JSON.parse(decode(row.payload))
      if (!validEntry(record)) throw new Error('Invalid stored record')
      documents.set(row.id, decode(row.payload))
      if (scope === 'channels') for (const token of record.probeTokens ?? []) for (const model of token.probeModels ?? []) {
        const args = [row.id, String(token.id), String(model.id)]
        const rows = recent ? recentHistory.all(...args, Math.floor(now / 60000) * 60000 - 65 * 60000, ...args) : selectHistory.all(...args)
        const history = rows.map(item => JSON.parse(decode(item.payload)))
        // Preserve missing histories in pristine model configurations.
        if (history.length || model.probeHistorySummary) model.probeHistory = history
        histories.set(identity(...args), { history: model.probeHistory, seq: rows.at(-1)?.seq ?? 0,
          last: history.at(-1), signature: history.length ? JSON.stringify(history.at(-1)) : null })
      }
      return record
    })
    return records
  }
  function write(records, replace, migrating = false) {
    if (!Array.isArray(records) || records.some(record => !validEntry(record))) throw new Error('Invalid records')
    const ids = new Set(), afterCommit = []
    for (const [position, record] of records.entries()) {
      const id = idOf(record, position)
      if (ids.has(id)) throw new Error('Duplicate record')
      ids.add(id)
      const priorPayload = documents.get(id) ?? (() => {
        const row = db.prepare('SELECT payload FROM records WHERE scope=? AND id=?').get(scope,id)
        return row ? decode(row.payload) : null
      })()
      const historyWrites = [], summaries = new Map()
      const priorRecord = priorPayload ? JSON.parse(priorPayload) : null
      const priorModels = new Map((priorRecord?.probeTokens ?? []).flatMap(token =>
        (token.probeModels ?? []).map(model => [identity(id,token.id,model.id), model])))
      if (scope === 'channels') for (const token of record.probeTokens ?? []) for (const model of token.probeModels ?? []) {
        const args = [id, String(token.id), String(model.id)], cacheKey = identity(...args)
        const history = model.probeHistory
        let previous = histories.get(cacheKey)
        if (!previous) {
          const last = db.prepare('SELECT seq,payload FROM probe_history WHERE channel_id=? AND token_id=? AND model_id=? ORDER BY seq DESC LIMIT 1').get(...args)
          previous = { seq: last?.seq ?? 0, signature: last ? decode(last.payload) : null }
        }
        if (history === previous.history && history?.at(-1) === previous.last) continue
        let anchor = -1
        if (previous.seq && history?.length) {
          anchor = history.lastIndexOf(previous.last)
          if (anchor < 0) anchor = history.findLastIndex(item => JSON.stringify(item) === previous.signature)
        }
        // Snapshot replacement is supported; normal probe saves append after the
        // last committed item, even when memory only holds a recent window.
        const reset = previous.seq && anchor < 0
        const additions = (history ?? []).slice(anchor + 1)
        if (Array.isArray(history)) {
          const summary = summarizeProbeHistory(additions, reset ? undefined : priorModels.get(cacheKey)?.probeHistorySummary)
          summaries.set(model, summary)
          afterCommit.push(() => { model.probeHistorySummary = summary })
        }
        let seq = reset ? 0 : previous.seq
        historyWrites.push(() => {
          if (reset) deleteHistory.run(...args)
          for (const item of additions) insertHistory.run(...args, ++seq, Number.isFinite(Date.parse(item.at)) ? Date.parse(item.at) : null, item.status ?? null, encode(JSON.stringify(item)))
          if (!migrating && seq > 1440) pruneHistory.run(...args, seq - 1440)
        })
        afterCommit.push(() => histories.set(cacheKey, { history, seq, last: history?.at(-1), signature: history?.length ? JSON.stringify(history.at(-1)) : null }))
      }
      const payload = JSON.stringify(record, (name, value) => name === 'probeHistory' && Array.isArray(value) ? undefined : summaries.has(value) ? { ...value, probeHistorySummary: summaries.get(value) } : value)
      if (priorPayload !== payload) {
        // Preserve the original insertion order for partial updates.
        const order = replace ? position : db.prepare('SELECT position FROM records WHERE scope=? AND id=?').get(scope,id)?.position
          ?? db.prepare('SELECT coalesce(max(position),-1)+1 AS position FROM records WHERE scope=?').get(scope).position
        upsert.run(scope, id, order, encode(payload))
        afterCommit.push(() => documents.set(id, payload))
      }
      for (const apply of historyWrites) apply()
      if (scope === 'channels') {
        const live = new Set((record.probeTokens ?? []).flatMap(token => (token.probeModels ?? []).map(model => identity(id,token.id,model.id))))
        for (const token of priorRecord?.probeTokens ?? []) for (const model of token.probeModels ?? []) {
          if (!live.has(identity(id,token.id,model.id))) {
            deleteHistory.run(id,String(token.id),String(model.id))
            afterCommit.push(() => histories.delete(identity(id,token.id,model.id)))
          }
        }
      }
    }
    if (replace) for (const row of db.prepare('SELECT id FROM records WHERE scope=?').all(scope)) if (!ids.has(row.id)) {
      db.prepare('DELETE FROM records WHERE scope=? AND id=?').run(scope,row.id)
      afterCommit.push(() => { documents.delete(row.id); for (const entry of histories.keys()) if (JSON.parse(entry)[0] === row.id) histories.delete(entry) })
    }
    return () => { for (const apply of afterCommit) apply() }
  }
  function save(records, replace) {
    open()
    const commit = transaction(() => write(records, replace))
    commit()
    revision++
  }
  return {
    get revision() { return revision },
    load(options = {}) {
      open()
      try { return read(options.recent === true, options.now) }
      catch (error) { throw new Error('无法读取本地数据库；已有数据未被覆盖。', { cause: error }) }
    },
    save: records => save(records, true),
    saveChannels: records => save(records, false),
    compact(channel, now) {
      for (const token of channel.probeTokens ?? []) for (const model of token.probeModels ?? []) {
        if (!Array.isArray(model.probeHistory)) continue
        model.probeHistorySummary ??= summarizeProbeHistory(model.probeHistory)
        model.probeHistory = recentProbeHistory(model.probeHistory, now)
        const cached = histories.get(identity(channel.id,token.id,model.id))
        if (cached) cached.history = model.probeHistory
      }
    },
    appendLog(entry) {
      open()
      db.prepare(`INSERT OR IGNORE INTO operation_logs(id,at,category,level,site_id,channel_id,search,payload)
        VALUES (?,?,?,?,?,?,?,?)`).run(entry.id, Date.parse(entry.at), entry.category, entry.level,
          entry.siteId || '', entry.channelId || '',
          [entry.action, entry.message, entry.siteName, entry.channelName, entry.tokenId, entry.accountId, entry.accountName, entry.model, JSON.stringify(entry.details || {})].filter(Boolean).join(' ').toLowerCase(),
          encode(JSON.stringify(entry)))
    },
    queryLogs({ kind, from, until, category, level, siteId, channelId, q, page, pageSize, channelIds }) {
      open()
      const probe = kind === 'probes', table = probe ? 'probe_history' : 'operation_logs'
      const clauses = ['at >= ?', 'at <= ?'], values = [from, until]
      const add = (sql, ...args) => { clauses.push(sql); values.push(...args) }
      if (channelId) add('channel_id = ?', channelId)
      if (channelIds) {
        if (!channelIds.length) return { items: [], total: 0 }
        add(`channel_id IN (${channelIds.map(() => '?').join(',')})`, ...channelIds)
      }
      if (!probe && siteId) add('site_id = ?', siteId)
      if (!probe && category) add('category = ?', category)
      if (level) add(probe ? level === 'success' ? "status = 'ok'" : level === 'error' ? "status = 'error'" : "coalesce(status,'unknown') NOT IN ('ok','error')" : 'level = ?', ...(!probe ? [level] : []))
      if (q) add(probe ? 'instr(lower(model_id), ?) > 0 OR instr(lower(token_id), ?) > 0' : 'instr(search, ?) > 0', ...Array(probe ? 2 : 1).fill(q.toLowerCase()))
      const where = clauses.map(clause => `(${clause})`).join(' AND ')
      const total = db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get(...values).n
      const rows = db.prepare(`SELECT ${probe ? 'channel_id,token_id,model_id,seq,' : ''}payload FROM ${table}
        WHERE ${where} ORDER BY at DESC,${probe ? 'channel_id,token_id,model_id,seq DESC' : 'seq DESC'} LIMIT ? OFFSET ?`)
        .all(...values, pageSize, (page - 1) * pageSize)
      return { total, items: rows.map(row => probe ? { ...JSON.parse(decode(row.payload)), channelId: row.channel_id,
        tokenId: row.token_id, model: row.model_id, id: JSON.stringify([row.channel_id,row.token_id,row.model_id,row.seq]) } : JSON.parse(decode(row.payload))) }
    },
    close() { db?.close(); db = null; documents.clear(); histories.clear() },
  }
}
