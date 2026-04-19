#!/usr/bin/env bash
# Signalfi deploy script
# Usage: ./deploy.sh [web|manifest|app|infra|stack|setup] ["commit message"]
#
#   web       — rebuild signalfi-web on the existing server
#   manifest  — sync infra configs, rebuild signalfi-manifest
#   app       — web + manifest
#   infra     — sync all infra configs + bring up the /root stack (traefik,
#               mosquitto, node-red, signalfi-manifest, signalfi-files, sftpgo)
#   setup     — first-time init on a NEW server (git clone + run setup.sh)
#   stack     — full rebuild on a new server (setup + infra + app)
#
# Environment (new-server targets):
#   REMOTE_TARGET       hostname of the new server
#   REMOTE_TARGET_PATH  checkout path on the new server (default /opt/signalfi_controller)
#
# Layout assumptions on the remote:
#   /opt/signalfi_controller/   ← git clone of this repo (app stack)
#   /root/docker-compose.yml    ← infra stack (copy of https_file_server/docker-compose.yml)
#   /root/config/               ← mosquitto.conf + pass.txt
#   /root/traefik-dynamic/      ← tls.yml
#   /root/certs/                ← signalfi-web fullchain + key
#   /root/acme.json             ← Let's Encrypt store (chmod 600)
#   /root/nginx-ota.conf        ← copy of https_file_server/nginx.conf
#   /root/sftpgo-init.json      ← copy of https_file_server/sftpgo/init-data.json
#   /opt/signalfi/              ← data tree (firmware, audio, reports, …)
#
# setup.sh on the remote is the source of truth for the layout above — deploy.sh
# just copies the current versions of tracked files into place before restarting.

set -euo pipefail

REMOTE_HOST="apis.symphonyinteractive.ca"
REMOTE_APP_PATH="/opt/signalfi_controller"
REMOTE_INFRA_PATH="/root"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Files that must be synced to the remote's /root/ before any infra restart.
# Every entry is: <local-source>|<remote-destination>|<mode>.  Listed in one
# place so adding a new infra config file is one line, not a scavenger hunt.
INFRA_FILES=(
    "https_file_server/docker-compose.yml|$REMOTE_INFRA_PATH/docker-compose.yml|644"
    "https_file_server/config/mosquitto.conf|$REMOTE_INFRA_PATH/config/mosquitto.conf|644"
    "https_file_server/traefik-dynamic/tls.yml|$REMOTE_INFRA_PATH/traefik-dynamic/tls.yml|644"
    "https_file_server/nginx.conf|$REMOTE_INFRA_PATH/nginx-ota.conf|644"
    "https_file_server/sftpgo/init-data.json|$REMOTE_INFRA_PATH/sftpgo-init.json|644"
    "https_file_server/certs/signalfi-web.fullchain.pem|$REMOTE_INFRA_PATH/certs/signalfi-web.fullchain.pem|644"
    "https_file_server/certs/signalfi-web.key|$REMOTE_INFRA_PATH/certs/signalfi-web.key|600"
)

log() { printf '==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

ssh_run() {
    local host="${REMOTE_TARGET_HOST:-$REMOTE_HOST}"
    ssh "root@$host" "$@"
}

commit_and_push() {
    git add -A
    if git diff --cached --quiet; then
        log "Nothing to commit."
    else
        local msg="${1:-}"
        [[ -z "$msg" ]] && read -r -p "Commit message: " msg
        [[ -z "$msg" ]] && die "Commit message required."
        log "Committing: $msg"
        git commit -m "$msg"
    fi
    log "Pushing to origin/master..."
    git push origin master
}

# Rsync every tracked infra-config file to its remote destination, creating
# parent dirs and setting file mode.  Idempotent.
sync_infra_files() {
    local host="${REMOTE_TARGET_HOST:-$REMOTE_HOST}"
    log "Syncing infra configs to root@$host"
    # Pre-create every destination dir in a single SSH round-trip
    local mkdir_cmd=""
    for entry in "${INFRA_FILES[@]}"; do
        IFS='|' read -r src dest mode <<<"$entry"
        mkdir_cmd+="mkdir -p '$(dirname "$dest")'; "
    done
    ssh "root@$host" "$mkdir_cmd"
    for entry in "${INFRA_FILES[@]}"; do
        IFS='|' read -r src dest mode <<<"$entry"
        local local_path="$SCRIPT_DIR/$src"
        [[ -f "$local_path" ]] || die "Missing $local_path — nothing to sync to $dest"
        scp -q "$local_path" "root@$host:$dest"
        ssh "root@$host" "chmod $mode '$dest'"
    done
    log "Infra configs synced."
}

# ── Existing-server targets ──────────────────────────────────────────────────

deploy_web() {
    log "Updating signalfi-web (app stack)"
    commit_and_push "${COMMIT_MSG:-}"
    ssh_run "cd $REMOTE_APP_PATH && git pull && \
        docker compose up -d --build --no-deps --force-recreate signalfi-web"
    log "signalfi-web deployed."
}

deploy_manifest() {
    log "Updating signalfi-manifest (infra stack)"
    commit_and_push "${COMMIT_MSG:-}"
    sync_infra_files
    ssh_run "cd $REMOTE_APP_PATH && git pull && \
        cd $REMOTE_INFRA_PATH && docker compose up -d --build --no-deps --force-recreate signalfi-manifest"
    log "signalfi-manifest deployed."
}

deploy_app() {
    log "Updating app services (web + manifest)"
    commit_and_push "${COMMIT_MSG:-}"
    sync_infra_files
    ssh_run "
      cd $REMOTE_APP_PATH && git pull &&
      docker compose up -d --build --no-deps --force-recreate signalfi-web &&
      cd $REMOTE_INFRA_PATH && docker compose up -d --build --no-deps --force-recreate signalfi-manifest
    "
    log "App services deployed."
}

deploy_infra() {
    log "Applying infra config changes (Traefik / Mosquitto / manifest / nginx)"
    commit_and_push "${COMMIT_MSG:-}"
    sync_infra_files
    # Bring up the /root stack.  --build rebuilds anything with a local build
    # context; the other services just pick up config changes via mount.
    ssh_run "cd $REMOTE_INFRA_PATH && docker compose up -d --build"
    log "Infra stack reloaded."
}

# ── New-server targets ───────────────────────────────────────────────────────

require_new_server_env() {
    [[ -n "${REMOTE_TARGET:-}" ]] || die "Set REMOTE_TARGET=hostname before this target."
    REMOTE_TARGET_HOST="$REMOTE_TARGET"
    REMOTE_TARGET_PATH="${REMOTE_TARGET_PATH:-/opt/signalfi_controller}"
}

deploy_setup() {
    require_new_server_env
    local repo_url
    repo_url=$(git remote get-url origin)

    log "First-time setup on $REMOTE_TARGET_HOST (clone → $REMOTE_TARGET_PATH)"
    commit_and_push "${COMMIT_MSG:-}"

    # Clone (or fast-forward) the repo, then run setup.sh.
    ssh "root@$REMOTE_TARGET_HOST" "
      if [[ -d '$REMOTE_TARGET_PATH/.git' ]]; then
          cd '$REMOTE_TARGET_PATH' && git pull
      else
          git clone '$repo_url' '$REMOTE_TARGET_PATH'
      fi
    "

    # If the caller has a local .env, scp it over — setup.sh needs MQTT_USERS
    # to populate Mosquitto's pass.txt on first run.
    if [[ -f "$SCRIPT_DIR/.env" ]]; then
        scp -q "$SCRIPT_DIR/.env" "root@$REMOTE_TARGET_HOST:$REMOTE_TARGET_PATH/.env"
        log "Copied local .env → remote."
    else
        log "WARN: no local .env — copy one to $REMOTE_TARGET_PATH/.env before running setup.sh, or broker users won't be created."
    fi

    ssh "root@$REMOTE_TARGET_HOST" "cd '$REMOTE_TARGET_PATH' && ./setup.sh"
    log "Setup complete on $REMOTE_TARGET_HOST."
}

deploy_stack() {
    # Full fresh-server deploy: setup (dirs, network, acme, configs) →
    # infra sync + up → app up.
    require_new_server_env

    deploy_setup

    log "Syncing infra configs → $REMOTE_TARGET_HOST"
    sync_infra_files
    ssh "root@$REMOTE_TARGET_HOST" "cd $REMOTE_INFRA_PATH && docker compose up -d --build"

    log "Bringing up app stack on $REMOTE_TARGET_HOST"
    ssh "root@$REMOTE_TARGET_HOST" "cd $REMOTE_TARGET_PATH && docker compose up -d --build"

    log "Stack deployed on $REMOTE_TARGET_HOST."
}

# ── Entry point ──────────────────────────────────────────────────────────────

TARGET="${1:-}"
COMMIT_MSG="${2:-}"

if [[ -z "$TARGET" ]]; then
    cat <<MENU
Signalfi Deploy
───────────────────────────────────────
Existing server ($REMOTE_HOST):
  1) Update signalfi-web
  2) Update signalfi-manifest
  3) Update both app services
  4) Apply infra config changes (Traefik / Mosquitto / nginx / sftpgo)

New server deployment (set REMOTE_TARGET=hostname first):
  5) First-time setup only (clone + setup.sh)
  6) Full stack deploy (setup + infra + app)
MENU
    read -r -p "Choice [1-6]: " choice
    case "$choice" in
        1) TARGET="web" ;;
        2) TARGET="manifest" ;;
        3) TARGET="app" ;;
        4) TARGET="infra" ;;
        5) TARGET="setup" ;;
        6) TARGET="stack" ;;
        *) echo "Cancelled." && exit 0 ;;
    esac
fi

case "$TARGET" in
    web)      deploy_web ;;
    manifest) deploy_manifest ;;
    app)      deploy_app ;;
    infra)    deploy_infra ;;
    setup)    deploy_setup ;;
    stack)    deploy_stack ;;
    *) die "Unknown target: $TARGET.  Use: web | manifest | app | infra | setup | stack" ;;
esac

log "Done."
