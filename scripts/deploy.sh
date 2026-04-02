#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/discord-bot}"
APP_USER="${APP_USER:-discordbot}"
APP_GROUP="${APP_GROUP:-$APP_USER}"
SERVICE_NAME="${SERVICE_NAME:-discord-bot}"
BRANCH="${BRANCH:-main}"
REPO_URL="${REPO_URL:-}"
RECORDINGS_DIR="${RECORDINGS_DIR:-/var/lib/discord-bot/recordings}"
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

if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --user-group --create-home --home-dir "/home/$APP_USER" --shell /usr/sbin/nologin "$APP_USER"
fi

install -d -m 0755 "$APP_DIR"
install -d -o "$APP_USER" -g "$APP_GROUP" -m 0755 "$RECORDINGS_DIR"

if [ ! -d "$APP_DIR/.git" ]; then
  if [ -z "$REPO_URL" ]; then
    echo "APP_DIR does not contain a git checkout and REPO_URL was not provided." >&2
    exit 1
  fi
  rm -rf "$APP_DIR"
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi

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

if [ ! -f "$APP_DIR/.env" ]; then
  echo "Warning: $APP_DIR/.env does not exist yet." >&2
fi

systemctl restart "$SERVICE_NAME"
systemctl --no-pager --full status "$SERVICE_NAME" || true
