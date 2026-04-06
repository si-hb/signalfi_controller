#!/usr/bin/env bash
# Signalfi deploy script
# Usage: ./deploy.sh [web|manifest|app|stack|setup] ["commit message"]
#
# web / manifest / app  — update app services on the EXISTING server
#                         (never touches traefik, nodered, or infra compose)
# stack                 — full rebuild on a NEW server using docker-compose.yml
# setup                 — first-time init on a NEW server (git clone + dirs + mosquitto)

set -euo pipefail

REMOTE_HOST="apis.symphonyinteractive.ca"
REMOTE_APP_PATH="/opt/signalfi_controller"    # git clone on existing server

ssh_run() { ssh "$REMOTE_HOST" "$@"; }

commit_and_push() {
    git add -A
    if git diff --cached --quiet; then
        echo "==> Nothing to commit."
    else
        local msg="${1:-}"
        [[ -z "$msg" ]] && read -r -p "Commit message: " msg
        [[ -z "$msg" ]] && { echo "Abort: commit message required." >&2; exit 1; }
        echo "==> Committing: $msg"
        git commit -m "$msg"
    fi
    echo "==> Pushing to origin/master..."
    git push origin master
}

deploy_web() {
    echo ""
    echo "==> Updating signalfi-web..."
    commit_and_push "${COMMIT_MSG:-}"
    ssh_run "cd $REMOTE_APP_PATH && git pull && \
      docker compose up -d --build --no-deps --force-recreate signalfi-web"
    echo "==> signalfi-web deployed."
}

deploy_manifest() {
    echo ""
    echo "==> Updating signalfi-manifest..."
    commit_and_push "${COMMIT_MSG:-}"
    ssh_run "cd $REMOTE_APP_PATH && git pull && \
      cd /root && docker compose up -d --build --no-deps --force-recreate signalfi-manifest"
    echo "==> signalfi-manifest deployed."
}

deploy_app() {
    echo ""
    echo "==> Updating app services (web + manifest)..."
    commit_and_push "${COMMIT_MSG:-}"
    ssh_run "
      cd $REMOTE_APP_PATH && git pull
      docker compose up -d --build --no-deps --force-recreate signalfi-web
      cd /root && docker compose up -d --build --no-deps --force-recreate signalfi-manifest
    "
    echo "==> App services deployed."
}

deploy_stack() {
    # NEW SERVER ONLY — uses repo-root docker-compose.yml
    local target_host="${REMOTE_TARGET:-}"
    local target_path="${REMOTE_TARGET_PATH:-/opt/signalfi}"
    [[ -z "$target_host" ]] && { echo "Set REMOTE_TARGET=hostname before running stack deploy." >&2; exit 1; }
    echo ""
    echo "==> Full stack rebuild on $target_host..."
    commit_and_push "${COMMIT_MSG:-}"
    ssh "root@$target_host" "cd $target_path && git pull && docker compose up -d --build"
    echo "==> Full stack deployed on $target_host."
}

deploy_setup() {
    # NEW SERVER ONLY
    local target_host="${REMOTE_TARGET:-}"
    local target_path="${REMOTE_TARGET_PATH:-/opt/signalfi}"
    [[ -z "$target_host" ]] && { echo "Set REMOTE_TARGET=hostname before running setup." >&2; exit 1; }
    local repo_url
    repo_url=$(git remote get-url origin)
    echo ""
    echo "==> Setting up new server: $target_host"
    commit_and_push "${COMMIT_MSG:-}"
    ssh "root@$target_host" "
      git clone $repo_url $target_path 2>/dev/null || (cd $target_path && git pull)
    "
    echo ""
    echo "Next steps:"
    echo "  1. Copy .env to root@$target_host:$target_path/.env"
    echo "  2. ssh root@$target_host 'cd $target_path && ./setup.sh'"
    echo "  3. REMOTE_TARGET=$target_host REMOTE_TARGET_PATH=$target_path ./deploy.sh stack"
}

# ── entry point ───────────────────────────────────────────────────────────────

TARGET="${1:-}"
COMMIT_MSG="${2:-}"

if [[ -z "$TARGET" ]]; then
    echo "Signalfi Deploy"
    echo "───────────────────────────────────────"
    echo "Existing server ($REMOTE_HOST):"
    echo "  1) Update control server       (signalfi-web)"
    echo "  2) Update admin/OTA service    (signalfi-manifest)"
    echo "  3) Update both app services"
    echo ""
    echo "New server deployment:"
    echo "  4) Full stack rebuild          (set REMOTE_TARGET=host first)"
    echo "  5) First-time setup            (set REMOTE_TARGET=host first)"
    read -r -p "Choice [1-5]: " choice
    case "$choice" in
        1) TARGET="web" ;;
        2) TARGET="manifest" ;;
        3) TARGET="app" ;;
        4) TARGET="stack" ;;
        5) TARGET="setup" ;;
        *) echo "Cancelled." && exit 0 ;;
    esac
fi

case "$TARGET" in
    web)      deploy_web ;;
    manifest) deploy_manifest ;;
    app)      deploy_app ;;
    stack)    deploy_stack ;;
    setup)    deploy_setup ;;
    *) echo "Unknown target: $TARGET. Use: web | manifest | app | stack | setup" && exit 1 ;;
esac

echo ""
echo "==> Done."
