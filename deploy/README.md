# Production Deployment

This installation runs at https://38.92.15.50 with an application login page.
The API and probe scheduler run as `signal-monitor` on `127.0.0.1:3000`, using
Node.js 24 LTS. nginx serves the compiled frontend and proxies API requests. The
Node service protects every data API with a server-side session. Set-Cookie uses
Secure, HttpOnly and SameSite=Lax. `SIGNAL_PUBLIC_ORIGIN` must exactly match the
HTTPS origin. nginx replaces X-Real-IP for login attempt limits.

## Files

- `/opt/signal-monitor/current`: symlink to the deployed release.
- `/opt/signal-monitor/static/assets`: shared hashed frontend assets, retained for existing browser tabs.
- `/var/lib/signal-monitor`: server-created encrypted data, mode 0700.
- `/var/lib/signal-monitor/monitor.sqlite`: SQLite business data and incremental probe history; preserve its `storage.key`.
- `/var/backups/signal-monitor/<timestamp>/data.tar.gz`: server-side pre-deployment backup.
- `/etc/signal-monitor/auth.json`: scrypt-hashed website password, root-owned,
  mode 0640 and group `signal-monitor`.
- `/var/lib/signal-monitor/console-sessions.json`: hashed session identifiers;
  ordinary sessions expire in 12 hours, remembered sessions in seven days.
- `/root/signal-monitor-access.json`: initial website login, readable only by root.
- `/etc/letsencrypt/live/38.92.15.50`: trusted short-lived IP certificate.

The installation starts with no upstreams, subsidiary sites, API keys, probe history,
or local storage key. The application generates `storage.key` on its first save.
Back up the entire data directory, including that key, with the service stopped.
Run only one API process against the data directory.

## Build an Update

From the project directory:

```sh
node deploy/build-release.mjs
```

This builds into a temporary directory with a fresh `SIGNAL_DATA_DIR`. The archive
contains only `dist/`, the explicit runtime module list and minimal package
metadata. It excludes local account data, environment files, tests, reference
repositories and dependencies. The runtime backend uses only Node.js modules.

Extract the archive into a new directory under `/opt/signal-monitor/releases/`,
owned by root and readable by nginx and the service user. Before switching releases,
run `sh deploy/publish-assets.sh` on the server (copy this script with the release).
It publishes assets from all retained releases and verifies existing filenames
have identical contents. nginx serves `/assets/` from this shared directory and
returns 404 for missing files, never the application's HTML fallback. Keep these
assets across deployments so older open tabs can still load their styles/scripts.
Stop `signal-monitor`,
point `current` at the new release, and restart it. Do not replace or copy any
files into `/var/lib/signal-monitor` during a code update. Keep the previous
release. A downgrade to pre-SQLite code requires exporting the current database
with `exportLegacySnapshots()` first; never resume from a stale legacy JSON file.

For this existing installation, copy `deploy/activate-release.sh` and
`deploy/publish-assets.sh` to the same directory on the server, then run:

```sh
sh activate-release.sh /tmp/signal-monitor.tar.gz
```

The script publishes assets, stops the service, takes a server-side backup, and
verifies the complete migrated data and history before restarting. If startup
fails, it exports any newly rotated credentials before a pre-SQLite rollback.
See [storage and migration details](../docs/storage-scaling.zh-CN.md).

Each build includes `dist/version.json`; deploy it together with the frontend and
backend. Production responses include `X-Signal-Build`. Authenticated data requests
must send the same value (obtain it from `/api/auth/session` when using a script).
An older browser receives `409 CLIENT_OUTDATED` before reading incompatible data
or submitting changes. The frontend shows a refresh notice while keeping unsaved
forms visible; it does not reload automatically. Tabs opened before this version
check was introduced need one manual reload.

The nginx `/api/` location compresses JSON responses with gzip to reduce probe
history transfer size. When updating nginx configuration, back up the site file,
run `nginx -t`, then reload nginx. Application deployment does not install nginx
configuration automatically.

## Operations

```sh
systemctl status signal-monitor nginx signal-certbot-renew.timer
systemctl restart signal-monitor
journalctl -u signal-monitor -n 100 --no-pager
nginx -t
systemctl reload nginx
```

The Let's Encrypt IP certificate is valid for approximately six days. Certbot is
installed at `/opt/certbot/bin/certbot`. `signal-certbot-renew.timer` checks hourly;
renewal uses the webroot at `/var/www/letsencrypt` and reloads nginx after success.
Keep public port 80 open for ACME validation; application HTTP requests redirect
to HTTPS. Only ports 80, 443 and SSH need public access.

```sh
/opt/certbot/bin/certbot renew --dry-run
systemctl list-timers signal-certbot-renew.timer
```

Generate password records with `passwordRecord()` in `server/console-auth.js`,
replace `/etc/signal-monitor/auth.json` and restart `signal-monitor`. A changed
password invalidates existing sessions. `/root/signal-monitor-access.json`
records only the initial password. Sessions survive normal service restarts.

Verify from the local project with a credentials JSON
file containing `url`, `username` and `password` outside the project directory:

```sh
node deploy/verify-production.mjs /path/to/access.json
```

This verifies trusted TLS, login, access protection, logout, rejected invalid
writes and desktop/mobile rendering without creating channels or sending probes.
The frontend development server remains loopback-only and does not require login;
the production build always checks the session before mounting the console.
