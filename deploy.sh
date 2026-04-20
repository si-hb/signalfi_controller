#!/usr/bin/env bash
# Signalfi deploy script
# Usage: ./deploy.sh [web|manifest|app|infra|stack|setup|airgap-build|airgap] ["commit message"]
#
#   web            — rebuild signalfi-web on the existing server
#   manifest       — sync infra configs, rebuild signalfi-manifest
#   app            — web + manifest
#   infra          — sync all infra configs + bring up the /root stack
#   setup          — first-time init on a NEW remote server (git clone + setup.sh)
#   stack          — full rebuild on a new remote server (setup + infra + app)
#   airgap-build   — local build of all airgap images [--package to emit a bundle tarball]
#   airgap         — local bringup of the airgap stack (no SSH; runs on the CM4)
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

# ── Air-gap targets — local only, no SSH ─────────────────────────────────────
#
# These run on the CM4 itself.  The runtime is driven by CONTAINER_RUNTIME in
# .env (auto-detects if unset).  Versioning in the bundle filename comes from
# `git describe --always --dirty` so every bundle is traceable back to a commit.

airgap_runtime() {
    # Resolves the container runtime the same way setup.sh does.
    if [[ -n "${CONTAINER_RUNTIME:-}" ]]; then
        echo "$CONTAINER_RUNTIME"
    elif command -v docker >/dev/null 2>&1; then
        echo docker
    elif command -v podman >/dev/null 2>&1; then
        echo podman
    else
        die "Neither docker nor podman is installed"
    fi
}

airgap_compose() {
    local rt; rt=$(airgap_runtime)
    "$rt" compose \
        -f "$SCRIPT_DIR/https_file_server/docker-compose.yml" \
        -f "$SCRIPT_DIR/https_file_server/docker-compose.airgap.yml" \
        "$@"
}

deploy_airgap_build() {
    local package=0
    for arg in "$@"; do
        case "$arg" in
            --package) package=1 ;;
        esac
    done

    local rt; rt=$(airgap_runtime)
    log "Building air-gap stack with $rt"

    # Load .env so AIRGAP_NETWORK_MODE is known when picking the profile to
    # build.  `served` has more images to build than `byo` (dnsmasq-chrony).
    if [[ -f "$SCRIPT_DIR/.env" ]]; then
        # shellcheck disable=SC1091
        set -a; source "$SCRIPT_DIR/.env"; set +a
    fi
    local profile_args=()
    if [[ "${AIRGAP_NETWORK_MODE:-}" == "served" ]]; then
        profile_args=(--profile served)
    fi

    airgap_compose "${profile_args[@]}" pull --ignore-buildable || true
    airgap_compose "${profile_args[@]}" build --pull

    if [[ $package -eq 1 ]]; then
        local version; version=$(cd "$SCRIPT_DIR" && git describe --always --dirty 2>/dev/null || date +%Y%m%d)
        local bundle_dir="$SCRIPT_DIR/.bundles/signalfi-airgap-bundle-$version"
        local bundle_tar="$SCRIPT_DIR/.bundles/signalfi-airgap-bundle-$version.tar.gz"

        log "Packaging bundle → $bundle_tar"
        rm -rf "$bundle_dir"
        install -d -m 755 "$bundle_dir/images" "$bundle_dir/repo" "$bundle_dir/tools" "$bundle_dir/docs"

        # Save every image the airgap stack references.
        local images
        images=$(airgap_compose "${profile_args[@]}" config --images | sort -u | tr '\n' ' ')
        # shellcheck disable=SC2086
        log "  saving images: $images"
        # shellcheck disable=SC2086
        "$rt" save -o "$bundle_dir/images/signalfi-airgap-images.tar" $images

        # Repo snapshot — git archive respects .gitignore.
        (cd "$SCRIPT_DIR" && git archive --format=tar HEAD | tar -x -C "$bundle_dir/repo")

        # Render the customer README against current .env values.
        if [[ -f "$SCRIPT_DIR/docs/airgap/CUSTOMER_README.template.md" ]]; then
            # shellcheck disable=SC2016
            envsubst '$AIRGAP_NETWORK_MODE $AIRGAP_HOST_IP $AIRGAP_SUBNET $AIRGAP_DHCP_RANGE $AIRGAP_DEVICE_INTERFACE $SIGNALFI_SERVER_IP' \
                < "$SCRIPT_DIR/docs/airgap/CUSTOMER_README.template.md" \
                > "$bundle_dir/docs/CUSTOMER_README.md"
        fi
        # Smoketest + snippets ship inside the bundle so customers can verify
        # without needing anything else from the repo.
        cp -r "$SCRIPT_DIR/docs/airgap/snippets"      "$bundle_dir/docs/" 2>/dev/null || true
        cp    "$SCRIPT_DIR/tools/signalfi-smoketest.sh" "$bundle_dir/tools/" 2>/dev/null || true

        (cd "$SCRIPT_DIR/.bundles" && tar czf "$(basename "$bundle_tar")" "$(basename "$bundle_dir")")
        log "Bundle: $bundle_tar"
    fi

    log "airgap-build done."
}

deploy_airgap() {
    # Local bringup — expects setup.sh --airgap to have already run and the
    # rendered dnsmasq/chrony configs to be in place for served mode.
    if [[ -f "$SCRIPT_DIR/.env" ]]; then
        # shellcheck disable=SC1091
        set -a; source "$SCRIPT_DIR/.env"; set +a
    fi
    : "${AIRGAP_NETWORK_MODE:?.env must set AIRGAP_NETWORK_MODE (served | byo)}"

    local profile_args=()
    [[ "$AIRGAP_NETWORK_MODE" == "served" ]] && profile_args=(--profile served)

    log "Bringing up air-gap stack ($AIRGAP_NETWORK_MODE)"
    airgap_compose "${profile_args[@]}" up -d

    # App stack (signalfi-web) comes up from its own compose file at repo root.
    local rt; rt=$(airgap_runtime)
    (cd "$SCRIPT_DIR" && "$rt" compose up -d --build)

    log "Air-gap stack is up."
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

Local air-gap (runs on the CM4 itself):
  7) Build air-gap images       (add --package for a distributable tarball)
  8) Bring up the air-gap stack
MENU
    read -r -p "Choice [1-8]: " choice
    case "$choice" in
        1) TARGET="web" ;;
        2) TARGET="manifest" ;;
        3) TARGET="app" ;;
        4) TARGET="infra" ;;
        5) TARGET="setup" ;;
        6) TARGET="stack" ;;
        7) TARGET="airgap-build" ;;
        8) TARGET="airgap" ;;
        *) echo "Cancelled." && exit 0 ;;
    esac
fi

case "$TARGET" in
    web)           deploy_web ;;
    manifest)      deploy_manifest ;;
    app)           deploy_app ;;
    infra)         deploy_infra ;;
    setup)         deploy_setup ;;
    stack)         deploy_stack ;;
    airgap-build)  shift; deploy_airgap_build "$@" ;;
    airgap)        deploy_airgap ;;
    *) die "Unknown target: $TARGET.  Use: web | manifest | app | infra | setup | stack | airgap-build | airgap" ;;
esac

log "Done."
