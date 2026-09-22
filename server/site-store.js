import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { sqliteStore } from './sqlite-store.js'
import { validBalanceThreshold } from './console-settings.js'

export const defaultDataDirectory = process.env.SIGNAL_DATA_DIR || join(homedir(), 'Library', 'Application Support', 'Signal Monitor')

export function createSecondarySiteStore(directory = defaultDataDirectory) {
  return databaseStore(directory, 'sites', 'secondary-sites.enc.json', '调度站点', site => site?.id && site.provider === 'sub2api' && Array.isArray(site.groups))
}

export function createChannelStore(directory = defaultDataDirectory) {
  return databaseStore(directory, 'channels', 'upstream-channels.enc.json', '上游渠道', channel => channel?.id &&
    typeof channel.name === 'string' && typeof channel.endpoint === 'string' && ['newapi', 'sub2api', 'direct'].includes(channel.provider))
}

export function createConsoleSettingsStore(directory = defaultDataDirectory) {
  return databaseStore(directory, 'settings', 'console-settings.enc.json', '设置', settings => validBalanceThreshold(settings?.lowBalanceThreshold))
}

// The site end users actually call (NewAPI main site). Kept in its own scope so
// gateway probe data and attribution never mix with upstream channel history.
export function createUserGatewayStore(directory = defaultDataDirectory) {
  return databaseStore(directory, 'user-gateways', 'user-gateways.enc.json', '用户网关主站',
    gateway => Boolean(gateway?.id) && typeof gateway.endpoint === 'string' && Array.isArray(gateway.keys))
}

function databaseStore(directory, scope, filename, label, validEntry) {
  const legacy = encryptedStore(directory, filename, label, validEntry)
  return sqliteStore(directory, { scope, legacy, key: legacy.key, validEntry })
}

// Legacy snapshots are read only during migration. Exported for migration tests.
export function encryptedStore(directory, filename, label, validEntry) {
  const file = join(directory, filename)
  const keyFile = join(directory, 'storage.key')
  const prepare = () => { mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700) }
  function key() {
    prepare()
    if (!existsSync(keyFile)) {
      if (readdirSync(directory).some(name => name.endsWith('.enc.json') || name === 'monitor.sqlite')) throw new Error('本地存储密钥缺失，请恢复 storage.key；已有数据未被覆盖。')
      writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: 'wx' })
    }
    chmodSync(keyFile, 0o600)
    const value = readFileSync(keyFile)
    if (value.length !== 32) throw new Error('本地存储密钥无效；已有数据未被覆盖。')
    return value
  }
  return {
    key,
    load() {
      if (!existsSync(file)) return []
      try {
        prepare()
        chmodSync(file, 0o600)
        const saved = JSON.parse(readFileSync(file, 'utf8'))
        if (saved.version !== 1) throw new Error('Unsupported version')
        const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(saved.iv, 'base64'))
        decipher.setAuthTag(Buffer.from(saved.tag, 'base64'))
        const records = JSON.parse(Buffer.concat([decipher.update(Buffer.from(saved.data, 'base64')), decipher.final()]).toString('utf8'))
        if (!Array.isArray(records) || records.some(record => !validEntry(record))) throw new Error('Invalid snapshot')
        return records
      } catch {
        throw new Error(`无法读取本地${label}存储，请检查 ${filename} 和 storage.key；已有数据未被覆盖。`)
      }
    },
    save(records) {
      prepare()
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key(), iv)
      const data = Buffer.concat([cipher.update(JSON.stringify(records), 'utf8'), cipher.final()])
      const temporary = `${file}.${randomUUID()}.tmp`
      try {
        writeFileSync(temporary, JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }), { mode: 0o600, flag: 'wx' })
        renameSync(temporary, file)
      } finally { rmSync(temporary, { force: true }) }
    },
  }
}

// Explicit downgrade/export only. Normal operation never rewrites these files.
export function exportLegacySnapshots(directory = defaultDataDirectory) {
  for (const [create, filename, label] of [
    [createChannelStore, 'upstream-channels.enc.json', '上游渠道'],
    [createSecondarySiteStore, 'secondary-sites.enc.json', '调度站点'],
    [createConsoleSettingsStore, 'console-settings.enc.json', '设置'],
  ]) {
    const store = create(directory)
    try { encryptedStore(directory, filename, label, () => true).save(store.load()) }
    finally { store.close() }
  }
}
