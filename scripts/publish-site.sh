#!/usr/bin/env bash
# Build the release from this clone and publish it to the folder the web server serves.
#
#   /opt/commonplace/scripts/publish-site.sh /var/www/commonplace
#
# Run it again after `git pull` to publish a new release (for example after a change to
# moderation/hidden.json: each release carries the list as it was at its commit).
set -euo pipefail
DIR="${1:?Usage: publish-site.sh /var/www/commonplace}"
cd "$(dirname "$0")/.."
git pull --ff-only 2>/dev/null || true
mem=$(awk '/MemTotal|SwapTotal/ {s+=$2} END {print int(s/1024)}' /proc/meminfo 2>/dev/null || echo 4096)
if [ "$mem" -lt 1800 ]; then
  echo "This server has ${mem} MB of memory+swap; the build needs ~2 GB. Add swap first:"
  echo "  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile"
  exit 1
fi
npm ci --no-audit --no-fund --loglevel=error
npm run release:ipfs            # builds ./out and prints its IPFS CID
NEW="$DIR.new.$$"; rm -rf "$NEW"; mkdir -p "$(dirname "$DIR")"
cp -a out "$NEW"
# Earlier releases' scripts stay too (their names are unique per build): a browser showing a cached
# page from an earlier release still finds the scripts that page asks for
[ -d "$DIR/_next/static" ] && cp -an "$DIR/_next/static/." "$NEW/_next/static/" 2>/dev/null || true
chmod -R a+rX "$NEW"
[ -d "$DIR" ] && rm -rf "$DIR.previous" && mv "$DIR" "$DIR.previous"
mv "$NEW" "$DIR"
echo "Published to $DIR (previous version kept in $DIR.previous)."
