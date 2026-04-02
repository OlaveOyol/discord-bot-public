#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/discord-bot}"
APP_USER="${APP_USER:-discordbot}"
APP_GROUP="${APP_GROUP:-$APP_USER}"
SERVICE_NAME="${SERVICE_NAME:-discord-bot}"
BRANCH="${BRANCH:-main}"
REPO_URL="${REPO_URL:-}"
RECORDINGS_DIR="${RECORDINGS_DIR:-/var/lib/discord-bot/recordings}"
SHARED_DIR="${SHARED_DIR:-$APP_DIR/shared}"
LOCK_FILE="${LOCK_FILE:-/tmp/discord-bot-deploy.lock}"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "Another deployment is already running." >&2
  exit 1
fi

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_command git
require_command npm
require_command node
require_command systemctl

if ! command -v ffmpeg >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    apt-get install -y ffmpeg curl
  else
    echo "Missing ffmpeg and no apt-get is available to install it." >&2
    exit 1
  fi
fi

if ! command -v curl >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    apt-get install -y curl
  else
    echo "Missing curl and no apt-get is available to install it." >&2
    exit 1
  fi
fi

install_yt_dlp() {
  install -d -m 0755 /usr/local/bin
  curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
  chmod 0755 /usr/local/bin/yt-dlp
}

if ! command -v yt-dlp >/dev/null 2>&1; then
  install_yt_dlp
else
  install_yt_dlp
fi

if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --user-group --create-home --home-dir "/home/$APP_USER" --shell /usr/sbin/nologin "$APP_USER"
fi

install -d -m 0755 "$APP_DIR"
install -d -o "$APP_USER" -g "$APP_GROUP" -m 0755 "$RECORDINGS_DIR"
install -d -o "$APP_USER" -g "$APP_GROUP" -m 0755 "$SHARED_DIR"

if [ ! -d "$APP_DIR/.git" ]; then
  if [ -z "$REPO_URL" ]; then
    echo "APP_DIR does not contain a git checkout and REPO_URL was not provided." >&2
    exit 1
  fi
  rm -rf "$APP_DIR"
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi

git config --global --add safe.directory "$APP_DIR"
git -C "$APP_DIR" fetch --prune origin
git -C "$APP_DIR" checkout "$BRANCH"
git -C "$APP_DIR" reset --hard "origin/$BRANCH"

cd "$APP_DIR"
npm ci --omit=dev
npm run check

if [ -f "$APP_DIR/deploy/systemd/discord-bot.service" ]; then
  install -m 0644 "$APP_DIR/deploy/systemd/discord-bot.service" "/etc/systemd/system/${SERVICE_NAME}.service"
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null
fi

chown -R "$APP_USER:$APP_GROUP" "$APP_DIR"
chown -R "$APP_USER:$APP_GROUP" "$RECORDINGS_DIR"
chown -R "$APP_USER:$APP_GROUP" "$SHARED_DIR"

if [ -f "$APP_DIR/.env" ] && [ ! -f "$SHARED_DIR/.env" ]; then
  cp "$APP_DIR/.env" "$SHARED_DIR/.env"
  chown "$APP_USER:$APP_GROUP" "$SHARED_DIR/.env"
fi

if [ ! -f "$SHARED_DIR/.env" ]; then
  echo "Warning: $SHARED_DIR/.env does not exist yet." >&2
fi

build_id="$(git -C "$APP_DIR" rev-parse --short=12 HEAD)"
package_result="$(node "$APP_DIR/deploy/scripts/package-release.js" --build-id "$build_id" --output-dir "$APP_DIR/staging/artifacts")"
manifest_path="$(printf '%s' "$package_result" | node -e "const fs=require('node:fs'); const data=JSON.parse(fs.readFileSync(0,'utf8')); process.stdout.write(data.manifestPath);")"
supervisor_token=""
if [ -f "$SHARED_DIR/.env" ]; then
  supervisor_token="$(node -e "const fs=require('node:fs'); const file=process.argv[1]; const lines=fs.readFileSync(file,'utf8').split(/\r?\n/); for (const line of lines) { if (!line || line.trim().startsWith('#')) continue; const idx=line.indexOf('='); if (idx <= 0) continue; const key=line.slice(0, idx).trim(); if (key !== 'SUPERVISOR_TOKEN') continue; const value=line.slice(idx + 1).trim().replace(/^['\"]|['\"]$/g, ''); if (value) process.stdout.write(value); break; }" "$SHARED_DIR/.env")"
fi

ota_apply_args=(
  apply
  --manifest "$manifest_path"
  --app-dir "$APP_DIR"
  --service-name "$SERVICE_NAME"
  --app-user "$APP_USER"
  --app-group "$APP_GROUP"
  --legacy-env-path "$APP_DIR/.env"
)

if [ -n "$supervisor_token" ]; then
  ota_apply_args+=(--supervisor-token "$supervisor_token")
fi

node "$APP_DIR/deploy/scripts/ota-supervisor.js" \
  "${ota_apply_args[@]}"

systemctl --no-pager --full status "$SERVICE_NAME" || true
