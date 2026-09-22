#!/bin/sh
set -eu

# Keep hashed assets available to browser tabs opened before a release switch.
install -d -m 0755 /opt/signal-monitor/static/assets
for release in /opt/signal-monitor/releases/*; do
  for asset in "$release"/dist/assets/*; do
    test -f "$asset" || continue
    target=/opt/signal-monitor/static/assets/$(basename "$asset")
    if test -f "$target"; then
      cmp -s "$asset" "$target" || { printf 'Asset content mismatch: %s\n' "$target" >&2; exit 1; }
    else
      install -m 0644 "$asset" "$target"
    fi
  done
done
