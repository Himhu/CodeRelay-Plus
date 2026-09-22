#!/bin/sh
set -eu
archive=${1:?Provide the clean release archive}
release=/opt/signal-monitor/releases/$(date -u +%Y%m%d-%H%M%S)-fixes
previous=$(readlink /opt/signal-monitor/current)
backup=/var/backups/signal-monitor/$(date -u +%Y%m%d-%H%M%S)
new_started=0
audit_format=legacy
test ! -f "$previous/server/sqlite-store.js" || audit_format=sqlite
audit_time=$(date +%s)
test -n "$previous"
test ! -e "$release"
install -d -m 0755 "$release"
tar --warning=no-unknown-keyword -xzf "$archive" -C "$release"
chown -R root:root "$release"
chmod -R u=rwX,go=rX "$release"
for module in "$release"/server/*.js; do /usr/local/bin/node --check "$module"; done
/usr/local/bin/node --input-type=module - "$release/dist/version.json" <<'NODE'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
assert.match(JSON.parse(readFileSync(process.argv[2], 'utf8')).build, /^[a-f0-9-]{36}$/)
NODE
sh "$(dirname "$0")/publish-assets.sh"

inventory() {
  runuser -u signal-monitor -- /usr/local/bin/node --input-type=module - "$1" "$audit_format" "$audit_time" <<'NODE'
import { createChannelStore, createSecondarySiteStore, createConsoleSettingsStore } from '/opt/signal-monitor/current/server/site-store.js'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
const directory = '/var/lib/signal-monitor'
const stores = [createChannelStore(directory), createSecondarySiteStore(directory), createConsoleSettingsStore(directory)]
try {
  const databaseMode = process.argv[3] === 'sqlite'
  const [channels, sites, settings] = stores.map(store => store.load({ recent: databaseMode, now: Number(process.argv[4])*1000 }))
  const ids = items => items.map(item => item.id).sort()
  const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).filter(key => key !== 'probeHistorySummary').sort().map(key => [key, stable(value[key])])) : value
  const hash = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
  const result = { channels: channels.length, secondarySites: sites.length, identities: hash([ids(channels),ids(sites)]),
    bindings: hash(sites.map(site => [site.id,site.accountBindings])), storageKey: createHash('sha256').update(readFileSync(directory+'/storage.key')).digest('hex') }
  if (process.argv[2] === 'full') {
    if (databaseMode) {
      // Stream encrypted rows to verify future updates without loading millions
      // of historical objects into memory. The service is stopped on both sides.
      const db = new DatabaseSync(directory+'/monitor.sqlite', { readOnly:true })
      try {
        const digest = createHash('sha256')
        for (const row of db.prepare('SELECT scope,id,position,payload FROM records ORDER BY scope,id').iterate()) {
          digest.update(JSON.stringify([row.scope,row.id,row.position])); digest.update(row.payload)
        }
        let count = 0
        for (const row of db.prepare('SELECT channel_id,token_id,model_id,seq,at,status,payload FROM probe_history ORDER BY channel_id,token_id,model_id,seq').iterate()) {
          digest.update(JSON.stringify([row.channel_id,row.token_id,row.model_id,row.seq,row.at,row.status])); digest.update(row.payload); count++
        }
        let operationLogs = 0
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='operation_logs'").get()) {
          for (const row of db.prepare('SELECT seq,id,at,category,level,site_id,channel_id,search,payload FROM operation_logs ORDER BY seq').iterate()) {
            digest.update(JSON.stringify([row.seq,row.id,row.at,row.category,row.level,row.site_id,row.channel_id,row.search])); digest.update(row.payload); operationLogs++
          }
        }
        Object.assign(result, {data:digest.digest('hex'),history:count,operationLogs})
      } finally { db.close() }
    } else Object.assign(result, { data: hash([channels,sites,settings]),
      history: channels.flatMap(c => c.probeTokens ?? []).flatMap(t => t.probeModels ?? []).reduce((n,m) => n+(m.probeHistory?.length ?? 0),0) })
  }
  console.log(JSON.stringify(result))
} finally { for (const store of stores) store.close?.() }
NODE
}
rollback() {
  trap - EXIT
  systemctl stop signal-monitor || true
  if test ! -f "$previous/server/sqlite-store.js" && test -f /var/lib/signal-monitor/monitor.sqlite; then
    if test "$new_started" = 1; then
      # Refresh-token rotations may already have occurred. Never fall back to stale JSON.
      if ! runuser -u signal-monitor -- /usr/local/bin/node --input-type=module - "$release/server/site-store.js" <<'NODE'
import { pathToFileURL } from 'node:url'
const { exportLegacySnapshots } = await import(pathToFileURL(process.argv[2]).href)
exportLegacySnapshots('/var/lib/signal-monitor')
NODE
      then
        printf 'Rollback stopped: database export failed. Current database retained; service stopped to protect credentials.\n' >&2
        exit 1
      fi
    fi
    install -d -m 0700 "$backup/failed-database"
    for file in /var/lib/signal-monitor/monitor.sqlite*; do test ! -f "$file" || mv "$file" "$backup/failed-database/"; done
  fi
  ln -sfn "$previous" /opt/signal-monitor/current
  systemctl start signal-monitor
}
trap rollback EXIT
systemctl stop signal-monitor
install -d -m 0700 "$backup"
umask 077
tar -czf "$backup/data.tar.gz" -C / var/lib/signal-monitor etc/signal-monitor/auth.json
before=$(inventory full)
identity_before=$(inventory identity)
ln -sfn "$release" /opt/signal-monitor/current
test "$before" = "$(inventory full)"
new_started=1
systemctl start signal-monitor
curl -fsS --retry 12 --retry-connrefused --retry-delay 1 -H 'Host: 38.92.15.50' http://127.0.0.1:3000/api/auth/session
systemctl is-active signal-monitor nginx
test "$identity_before" = "$(inventory identity)"
trap - EXIT
printf '\nRelease: %s\nBackup: %s\nFull migration verified; existing accounts, history and storage key preserved.\n' "$release" "$backup/data.tar.gz"
