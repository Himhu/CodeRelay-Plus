import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = mkdtempSync(join(tmpdir(), 'signal-release-'))
const release = join(temporary, 'app')
mkdirSync(join(release, 'server'), { recursive: true })

// Build against a fresh data directory; Vite's API plugin must not load local accounts.
execFileSync('npm', ['run', 'build', '--', '--outDir', join(release, 'dist')], {
  cwd: project, stdio: 'inherit', env: { ...process.env, SIGNAL_DATA_DIR: join(temporary, 'empty-data') },
})
const modules = [
  'production.js', 'console-auth.js', 'monitor-api.js', 'secondary-sites.js', 'route-bindings.js', 'route-automation.js', 'route-discovery.js', 'site-store.js', 'upstream-client.js',
  'sub2api-auth.js', 'channel-balance.js', 'channel-funding.js', 'channel-probes.js', 'user-groups.js', 'user-api-keys.js', 'user-gateway.js',
  'probe-request.js', 'console-settings.js', 'sqlite-store.js', 'probe-history.js', 'route-name.js', 'operation-logs.js',
]
for (const name of modules) cpSync(join(project, 'server', name), join(release, 'server', name))
writeFileSync(join(release, 'package.json'), JSON.stringify({ name: 'upstream-signal-console', private: true, type: 'module' }) + '\n')
const archive = join(temporary, 'signal-monitor.tar.gz')
execFileSync('tar', ['-czf', archive, '-C', release, 'dist', 'server', 'package.json'], {
  env: { ...process.env, COPYFILE_DISABLE: '1' },
})
console.log(`Release archive: ${archive}`)
