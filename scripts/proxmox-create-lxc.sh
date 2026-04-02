#!/usr/bin/env bash
set -euo pipefail

START_CTID="${START_CTID:-192}"
START_IP="${START_IP:-192.168.68.15}"
CIDR="${CIDR:-24}"
BRIDGE="${BRIDGE:-vmbr0}"
HOSTNAME_PREFIX="${HOSTNAME_PREFIX:-discord-bot}"
PVE_TEMPLATE_STORAGE="${PVE_TEMPLATE_STORAGE:-local}"
PVE_ROOTFS_STORAGE="${PVE_ROOTFS_STORAGE:-local-lvm}"
ROOTFS_SIZE_GB="${ROOTFS_SIZE_GB:-120}"
CORES="${CORES:-2}"
MEMORY_MB="${MEMORY_MB:-1024}"
SWAP_MB="${SWAP_MB:-512}"
UNPRIVILEGED="${UNPRIVILEGED:-1}"
SEARCH_LIMIT="${SEARCH_LIMIT:-64}"
DNS_SERVER="${DNS_SERVER:-1.1.1.1}"
GATEWAY="${GATEWAY:-}"
TEMPLATE_PATTERN="${TEMPLATE_PATTERN:-debian-12-standard}"
SSH_LOGIN_USER="${SSH_LOGIN_USER:-deploy}"
SSH_PUBLIC_KEY="${SSH_PUBLIC_KEY:-}"
SSH_PUBLIC_KEY_FILE="${SSH_PUBLIC_KEY_FILE:-}"
REPO_URL="${REPO_URL:-}"
BRANCH="${BRANCH:-main}"
NODE_MAJOR="${NODE_MAJOR:-24}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_command pct
require_command pveam
require_command awk
require_command sed

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this script as root on the Proxmox host." >&2
  exit 1
fi

if [ -n "$SSH_PUBLIC_KEY_FILE" ] && [ -z "$SSH_PUBLIC_KEY" ]; then
  SSH_PUBLIC_KEY="$(tr -d '\r' < "$SSH_PUBLIC_KEY_FILE")"
fi

if [ -z "$GATEWAY" ]; then
  GATEWAY="$(ip route | awk '/default/ { print $3; exit }')"
fi

ip_to_int() {
  local a b c d
  IFS=. read -r a b c d <<<"$1"
  echo $((((a << 24) | (b << 16) | (c << 8) | d)))
}

int_to_ip() {
  local value="$1"
  echo "$(((value >> 24) & 255)).$(((value >> 16) & 255)).$(((value >> 8) & 255)).$((value & 255))"
}

next_ctid() {
  local current="$START_CTID"
  local used
  used="$(pct list 2>/dev/null | awk 'NR>1 { print $1 }')"
  while grep -qx "$current" <<<"$used"; do
    current=$((current + 1))
  done
  echo "$current"
}

collect_used_ips() {
  pct config "$1" 2>/dev/null | sed -n 's/^net[0-9]: .*ip=\([^,\/]*\).*/\1/p'
}

next_ip() {
  local current used candidate
  current="$(ip_to_int "$START_IP")"
  used="$(
    pct list 2>/dev/null \
      | awk 'NR>1 { print $1 }' \
      | while read -r ctid; do
          collect_used_ips "$ctid"
        done \
      | sort -u
  )"

  for _ in $(seq 1 "$SEARCH_LIMIT"); do
    candidate="$(int_to_ip "$current")"
    if ! grep -qx "$candidate" <<<"$used"; then
      echo "$candidate"
      return
    fi
    current=$((current + 1))
  done

  echo "No free IP found within SEARCH_LIMIT=$SEARCH_LIMIT starting at $START_IP" >&2
  exit 1
}

find_template() {
  local existing available name
  existing="$(pveam list "$PVE_TEMPLATE_STORAGE" 2>/dev/null | awk -v pattern="$TEMPLATE_PATTERN" '$2 ~ pattern { print $2 }' | tail -n 1)"
  if [ -n "$existing" ]; then
    echo "${PVE_TEMPLATE_STORAGE}:vztmpl/${existing}"
    return
  fi

  pveam update >/dev/null
  available="$(pveam available --section system 2>/dev/null | awk -v pattern="$TEMPLATE_PATTERN" '$2 ~ pattern { print $2 }' | tail -n 1)"
  if [ -z "$available" ]; then
    echo "Could not find a container template matching $TEMPLATE_PATTERN" >&2
    exit 1
  fi

  pveam download "$PVE_TEMPLATE_STORAGE" "$available" >/dev/null
  echo "${PVE_TEMPLATE_STORAGE}:vztmpl/${available}"
}

CTID="$(next_ctid)"
IP_ADDRESS="$(next_ip)"
TEMPLATE="$(find_template)"
HOSTNAME="${HOSTNAME_PREFIX}-${CTID}"

echo "Creating LXC ${CTID} with IP ${IP_ADDRESS}/${CIDR}"

pct create "$CTID" "$TEMPLATE" \
  --arch amd64 \
  --hostname "$HOSTNAME" \
  --cores "$CORES" \
  --memory "$MEMORY_MB" \
  --swap "$SWAP_MB" \
  --rootfs "${PVE_ROOTFS_STORAGE}:${ROOTFS_SIZE_GB}" \
  --unprivileged "$UNPRIVILEGED" \
  --features nesting=1 \
  --net0 "name=eth0,bridge=${BRIDGE},ip=${IP_ADDRESS}/${CIDR},gw=${GATEWAY},type=veth" \
  --nameserver "$DNS_SERVER" \
  --onboot 1

pct start "$CTID"

echo "Bootstrapping container packages"
pct exec "$CTID" -- bash -lc "apt-get update && apt-get install -y ca-certificates curl gnupg ffmpeg git openssh-server sudo"
pct exec "$CTID" -- bash -lc "mkdir -p /etc/apt/keyrings && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg"
pct exec "$CTID" -- bash -lc "echo 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main' > /etc/apt/sources.list.d/nodesource.list"
pct exec "$CTID" -- bash -lc "apt-get update && apt-get install -y nodejs"

pct exec "$CTID" -- bash -lc "id -u ${SSH_LOGIN_USER} >/dev/null 2>&1 || useradd -m -s /bin/bash ${SSH_LOGIN_USER}"
pct exec "$CTID" -- bash -lc "usermod -aG sudo ${SSH_LOGIN_USER}"
pct exec "$CTID" -- bash -lc "printf '%s\n' '${SSH_LOGIN_USER} ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/90-${SSH_LOGIN_USER} && chmod 440 /etc/sudoers.d/90-${SSH_LOGIN_USER}"
pct exec "$CTID" -- bash -lc "mkdir -p /opt/discord-bot /var/lib/discord-bot/recordings"

if [ -n "$SSH_PUBLIC_KEY" ]; then
  pct exec "$CTID" -- bash -lc "install -d -m 700 -o ${SSH_LOGIN_USER} -g ${SSH_LOGIN_USER} /home/${SSH_LOGIN_USER}/.ssh"
  pct exec "$CTID" -- bash -lc "printf '%s\n' '$SSH_PUBLIC_KEY' > /home/${SSH_LOGIN_USER}/.ssh/authorized_keys"
  pct exec "$CTID" -- bash -lc "chown ${SSH_LOGIN_USER}:${SSH_LOGIN_USER} /home/${SSH_LOGIN_USER}/.ssh/authorized_keys && chmod 600 /home/${SSH_LOGIN_USER}/.ssh/authorized_keys"
fi

if [ -n "$REPO_URL" ]; then
  pct exec "$CTID" -- bash -lc "if [ ! -d /opt/discord-bot/.git ]; then git clone --branch '${BRANCH}' '${REPO_URL}' /opt/discord-bot; fi"
fi

cat <<EOF

Container created.

CTID: ${CTID}
IP: ${IP_ADDRESS}
Hostname: ${HOSTNAME}
SSH user: ${SSH_LOGIN_USER}

Next steps:
1. Copy your .env to /opt/discord-bot/.env inside the container.
2. If the repo was not cloned, clone it into /opt/discord-bot.
3. Run: sudo APP_DIR=/opt/discord-bot SERVICE_NAME=discord-bot BRANCH=${BRANCH} /opt/discord-bot/scripts/deploy.sh
4. Point your reverse proxy at http://${IP_ADDRESS}:8765

EOF
