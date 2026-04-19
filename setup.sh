#!/usr/bin/env bash
# Signalfi server setup — idempotent first-time init + drift repair.
#
# Run on the REMOTE server, from the checked-out signalfi-web repo
# (expected at /opt/signalfi_controller).  Safe to re-run; existing data,
# volumes, and the Let's Encrypt acme.json are preserved.
#
# What it does:
#   1. Creates the /opt/signalfi data tree (firmware / audio / general /
#      manifests / tokens / reports / configs).
#   2. Creates /root/config/ and copies mosquitto.conf + any traefik-dynamic
#      files from the repo into place.
#   3. Syncs the infra compose file: https_file_server/docker-compose.yml →
#      /root/docker-compose.yml.
#   4. Ensures /root/acme.json exists with 600 perms (Traefik/Let's Encrypt).
#   5. Ensures the root_default Docker network exists (shared by app stack
#      and infra stack).
#   6. Creates /root/config/pass.txt from MQTT_USERS in .env if absent.
#   7. Copies nginx-ota.conf + sftpgo-init.json into place for bind mounts.
#
# Usage:
#   cd /opt/signalfi_controller && sudo ./setup.sh
#
# Environment (either exported or in /opt/signalfi_controller/.env):
#   MQTT_USERS  — "user1 'password1'  user2 'password2'  …"  (only read
#                 if /root/config/pass.txt doesn't already exist)

set -euo pipefail

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "$0")" && pwd)}"
INFRA_DIR="/root"
DATA_ROOT="/opt/signalfi"
NETWORK_NAME="root_default"

log() { printf '==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "setup.sh must run as root"
[[ -d "$REPO_DIR/https_file_server" ]] || die "Repo not found at $REPO_DIR (expected a signalfi-web checkout)"
command -v docker >/dev/null || die "docker not installed"

# Load .env if present so MQTT_USERS etc. are available.
if [[ -f "$REPO_DIR/.env" ]]; then
    set -a; source "$REPO_DIR/.env"; set +a
fi

# ── 1. Data tree ──────────────────────────────────────────────────────────────
log "Creating $DATA_ROOT data tree"
install -d -m 755 \
    "$DATA_ROOT/files/firmware" \
    "$DATA_ROOT/files/audio" \
    "$DATA_ROOT/files/general" \
    "$DATA_ROOT/manifests/models" \
    "$DATA_ROOT/manifests/devices" \
    "$DATA_ROOT/tokens" \
    "$DATA_ROOT/reports" \
    "$DATA_ROOT/configs/models" \
    "$DATA_ROOT/configs/devices"

# ── 2. Infra config files ─────────────────────────────────────────────────────
log "Syncing infra configs into $INFRA_DIR"
install -d -m 755 "$INFRA_DIR/config"
install -d -m 755 "$INFRA_DIR/traefik-dynamic"
install -d -m 755 "$INFRA_DIR/certs"

install -m 644 "$REPO_DIR/https_file_server/config/mosquitto.conf" "$INFRA_DIR/config/mosquitto.conf"
install -m 644 "$REPO_DIR/https_file_server/traefik-dynamic/tls.yml" "$INFRA_DIR/traefik-dynamic/tls.yml"
install -m 644 "$REPO_DIR/https_file_server/nginx.conf"             "$INFRA_DIR/nginx-ota.conf"
install -m 644 "$REPO_DIR/https_file_server/sftpgo/init-data.json"  "$INFRA_DIR/sftpgo-init.json"
install -m 644 "$REPO_DIR/https_file_server/certs/signalfi-web.fullchain.pem" "$INFRA_DIR/certs/signalfi-web.fullchain.pem"
install -m 600 "$REPO_DIR/https_file_server/certs/signalfi-web.key"           "$INFRA_DIR/certs/signalfi-web.key"

# ── 3. Infra compose ──────────────────────────────────────────────────────────
log "Installing /root/docker-compose.yml from repo"
install -m 644 "$REPO_DIR/https_file_server/docker-compose.yml" "$INFRA_DIR/docker-compose.yml"

# ── 4. Let's Encrypt store ────────────────────────────────────────────────────
if [[ ! -f "$INFRA_DIR/acme.json" ]]; then
    log "Creating $INFRA_DIR/acme.json for Traefik ACME"
    touch "$INFRA_DIR/acme.json"
fi
chmod 600 "$INFRA_DIR/acme.json"

# ── 5. Docker network ─────────────────────────────────────────────────────────
if ! docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
    log "Creating Docker network $NETWORK_NAME"
    docker network create "$NETWORK_NAME"
else
    log "Docker network $NETWORK_NAME already exists"
fi

# ── 6. Mosquitto password file ────────────────────────────────────────────────
if [[ -f "$INFRA_DIR/config/pass.txt" ]]; then
    log "Mosquitto pass.txt already present — leaving alone"
elif [[ -z "${MQTT_USERS:-}" ]]; then
    log "WARN: /root/config/pass.txt missing and MQTT_USERS unset in .env — broker will refuse clients until pass.txt is generated"
else
    log "Generating /root/config/pass.txt from MQTT_USERS"
    first=1
    # shellcheck disable=SC2086
    set -- $MQTT_USERS
    while [[ $# -ge 2 ]]; do
        user="$1"; pass="$2"; shift 2
        if [[ $first -eq 1 ]]; then
            docker run --rm -v "$INFRA_DIR/config:/mosquitto/config" eclipse-mosquitto:2 \
                mosquitto_passwd -b -c /mosquitto/config/pass.txt "$user" "$pass"
            first=0
        else
            docker run --rm -v "$INFRA_DIR/config:/mosquitto/config" eclipse-mosquitto:2 \
                mosquitto_passwd -b /mosquitto/config/pass.txt "$user" "$pass"
        fi
        log "  added mosquitto user: $user"
    done
fi

log "setup.sh complete."
echo ""
echo "Next:"
echo "  cd $INFRA_DIR          && docker compose up -d --build   # infra stack"
echo "  cd $REPO_DIR           && docker compose up -d --build   # app stack (signalfi-web)"
