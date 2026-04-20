#!/usr/bin/env bash
# Signalfi server setup — idempotent first-time init + drift repair.
#
# Two modes:
#   (no flag)   — production deploy against the live /root/ layout.
#   --airgap    — single-PC air-gapped install (served or byo, see .env).
#
# Run on the TARGET server, from the checked-out signalfi-web repo at
# /opt/signalfi_controller.  Safe to re-run; existing data, volumes, and
# the Let's Encrypt acme.json are preserved.
#
# Usage:
#   cd /opt/signalfi_controller && sudo ./setup.sh            # production
#   cd /opt/signalfi_controller && sudo ./setup.sh --airgap   # air-gapped
#
# Environment (either exported or in /opt/signalfi_controller/.env):
#   Production:
#     MQTT_USERS — "user1 'password1'  user2 'password2'  …" (pass.txt seed)
#   Air-gap adds:
#     AIRGAP_NETWORK_MODE      served | byo
#     CONTAINER_RUNTIME        docker | podman  (auto-detected if unset)
#     AIRGAP_DEVICE_INTERFACE  e.g. eth0
#     AIRGAP_HOST_IP           served-mode only
#     AIRGAP_SUBNET            served-mode only  (e.g. 10.10.0.0/24)
#     AIRGAP_DHCP_RANGE        served-mode only  (e.g. 10.10.0.100,10.10.0.250)

set -euo pipefail

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "$0")" && pwd)}"
INFRA_DIR="/root"
DATA_ROOT="/opt/signalfi"
NETWORK_NAME="root_default"
AIRGAP=0

log() { printf '==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# ── Arg parse ─────────────────────────────────────────────────────────────
for arg in "$@"; do
    case "$arg" in
        --airgap) AIRGAP=1 ;;
        -h|--help)
            sed -n '2,/^set/p' "$0" | sed 's/^# \?//' ; exit 0 ;;
        *) die "Unknown argument: $arg" ;;
    esac
done

[[ $EUID -eq 0 ]] || die "setup.sh must run as root"
[[ -d "$REPO_DIR/https_file_server" ]] || die "Repo not found at $REPO_DIR (expected a signalfi-web checkout)"

# ── Load .env ────────────────────────────────────────────────────────────
if [[ -f "$REPO_DIR/.env" ]]; then
    set -a; source "$REPO_DIR/.env"; set +a
fi

# ── Container runtime detection (Docker or Podman) ───────────────────────
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-}"
if [[ -z "$CONTAINER_RUNTIME" ]]; then
    if   command -v docker >/dev/null 2>&1; then CONTAINER_RUNTIME=docker
    elif command -v podman >/dev/null 2>&1; then CONTAINER_RUNTIME=podman
    else die "Neither docker nor podman is installed"
    fi
fi
case "$CONTAINER_RUNTIME" in
    docker|podman) ;;
    *) die "CONTAINER_RUNTIME must be docker or podman (got: $CONTAINER_RUNTIME)" ;;
esac
command -v "$CONTAINER_RUNTIME" >/dev/null || die "$CONTAINER_RUNTIME not installed"

# compose() — resolves to `docker compose` or `podman compose` based on runtime.
compose() { "$CONTAINER_RUNTIME" compose "$@"; }

log "Container runtime: $CONTAINER_RUNTIME"

# ── 1. Data tree (both modes) ────────────────────────────────────────────
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

# ── 2. Docker network (both modes) ───────────────────────────────────────
if ! "$CONTAINER_RUNTIME" network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
    log "Creating $CONTAINER_RUNTIME network $NETWORK_NAME"
    "$CONTAINER_RUNTIME" network create "$NETWORK_NAME"
else
    log "$CONTAINER_RUNTIME network $NETWORK_NAME already exists"
fi

# ── 3. Infra config files (both modes) ───────────────────────────────────
log "Syncing infra configs into $INFRA_DIR"
install -d -m 755 "$INFRA_DIR/config"
install -d -m 755 "$INFRA_DIR/traefik-dynamic"
install -d -m 755 "$INFRA_DIR/certs"

install -m 644 "$REPO_DIR/https_file_server/config/mosquitto.conf" "$INFRA_DIR/config/mosquitto.conf"
install -m 644 "$REPO_DIR/https_file_server/nginx.conf"             "$INFRA_DIR/nginx-ota.conf"
install -m 644 "$REPO_DIR/https_file_server/sftpgo/init-data.json"  "$INFRA_DIR/sftpgo-init.json"

# ── 4. Mosquitto password file (both modes) ──────────────────────────────
seed_mqtt_users() {
    if [[ -f "$INFRA_DIR/config/pass.txt" ]]; then
        log "Mosquitto pass.txt already present — leaving alone"
        return
    fi
    if [[ -z "${MQTT_USERS:-}" ]]; then
        log "WARN: /root/config/pass.txt missing and MQTT_USERS unset in .env — broker will refuse clients until pass.txt is generated"
        return
    fi
    log "Generating /root/config/pass.txt from MQTT_USERS"
    local first=1 user pass
    # shellcheck disable=SC2086
    set -- $MQTT_USERS
    while [[ $# -ge 2 ]]; do
        user="$1"; pass="$2"; shift 2
        if [[ $first -eq 1 ]]; then
            "$CONTAINER_RUNTIME" run --rm -v "$INFRA_DIR/config:/mosquitto/config" eclipse-mosquitto:2 \
                mosquitto_passwd -b -c /mosquitto/config/pass.txt "$user" "$pass"
            first=0
        else
            "$CONTAINER_RUNTIME" run --rm -v "$INFRA_DIR/config:/mosquitto/config" eclipse-mosquitto:2 \
                mosquitto_passwd -b /mosquitto/config/pass.txt "$user" "$pass"
        fi
        log "  added mosquitto user: $user"
    done
}
seed_mqtt_users

if [[ $AIRGAP -eq 0 ]]; then
    # ── Production path ──────────────────────────────────────────────────

    log "Production mode — installing Let's Encrypt cert + prod compose"
    install -m 644 "$REPO_DIR/https_file_server/traefik-dynamic/tls.yml" "$INFRA_DIR/traefik-dynamic/tls.yml"
    install -m 644 "$REPO_DIR/https_file_server/certs/signalfi-web.fullchain.pem" "$INFRA_DIR/certs/signalfi-web.fullchain.pem"
    install -m 600 "$REPO_DIR/https_file_server/certs/signalfi-web.key"           "$INFRA_DIR/certs/signalfi-web.key"
    install -m 644 "$REPO_DIR/https_file_server/docker-compose.yml"                "$INFRA_DIR/docker-compose.yml"

    if [[ ! -f "$INFRA_DIR/acme.json" ]]; then
        log "Creating $INFRA_DIR/acme.json for Traefik ACME"
        touch "$INFRA_DIR/acme.json"
    fi
    chmod 600 "$INFRA_DIR/acme.json"

    log "setup.sh complete (production)."
    echo ""
    echo "Next:"
    echo "  cd $INFRA_DIR          && $CONTAINER_RUNTIME compose up -d --build"
    echo "  cd $REPO_DIR           && $CONTAINER_RUNTIME compose up -d --build"
    exit 0
fi

# ── Air-gap path ─────────────────────────────────────────────────────────

AIRGAP_NETWORK_MODE="${AIRGAP_NETWORK_MODE:-}"
case "$AIRGAP_NETWORK_MODE" in
    served|byo) ;;
    *) die "AIRGAP_NETWORK_MODE must be 'served' or 'byo' in .env" ;;
esac

log "Air-gap mode: $AIRGAP_NETWORK_MODE"

# Airgap cert + airgap tls.yml override the prod equivalents.
[[ -f "$REPO_DIR/https_file_server/certs/signalfi-web-airgap.fullchain.pem" ]] \
    || die "Airgap cert missing — run ./tools/issue-airgap-cert.sh or see DEPLOY.md"
install -m 644 "$REPO_DIR/https_file_server/certs/signalfi-web-airgap.fullchain.pem" "$INFRA_DIR/certs/signalfi-web-airgap.fullchain.pem"
install -m 600 "$REPO_DIR/https_file_server/certs/signalfi-web-airgap.key"           "$INFRA_DIR/certs/signalfi-web-airgap.key"
install -m 644 "$REPO_DIR/https_file_server/traefik-dynamic/tls-airgap.yml" "$INFRA_DIR/traefik-dynamic/tls.yml"

# The airgap overlay is consumed directly from the repo; we still install the
# base compose into /root so existing deploy.sh targets keep working.
install -m 644 "$REPO_DIR/https_file_server/docker-compose.yml"        "$INFRA_DIR/docker-compose.yml"
install -m 644 "$REPO_DIR/https_file_server/docker-compose.airgap.yml" "$INFRA_DIR/docker-compose.airgap.yml"

# ── Mode A: served ───────────────────────────────────────────────────────
if [[ "$AIRGAP_NETWORK_MODE" == "served" ]]; then

    : "${AIRGAP_DEVICE_INTERFACE:?served mode requires AIRGAP_DEVICE_INTERFACE}"
    : "${AIRGAP_HOST_IP:?served mode requires AIRGAP_HOST_IP}"
    : "${AIRGAP_SUBNET:?served mode requires AIRGAP_SUBNET}"
    : "${AIRGAP_DHCP_RANGE:?served mode requires AIRGAP_DHCP_RANGE}"

    ip link show "$AIRGAP_DEVICE_INTERFACE" >/dev/null 2>&1 \
        || die "Interface $AIRGAP_DEVICE_INTERFACE not found (ip link show)"

    # Free ports 53 / 67 / 123 on the host so the dnsmasq-chrony container can bind.
    log "Freeing ports 53/67/123 on the host"
    if systemctl is-enabled --quiet systemd-resolved 2>/dev/null; then
        log "  disabling systemd-resolved stub listener"
        install -d -m 755 /etc/systemd/resolved.conf.d
        cat > /etc/systemd/resolved.conf.d/airgap.conf <<'EOF'
[Resolve]
DNSStubListener=no
EOF
        systemctl restart systemd-resolved || true
        # Point /etc/resolv.conf at the stub-less resolved so the host can still resolve.
        ln -sf /run/systemd/resolve/resolv.conf /etc/resolv.conf || true
    fi
    for svc in chronyd chrony ntpd isc-dhcp-server; do
        if systemctl is-active --quiet "$svc" 2>/dev/null; then
            log "  stopping $svc"
            systemctl stop "$svc"
            systemctl disable "$svc" 2>/dev/null || true
        fi
    done

    # Render dnsmasq + chrony configs from the templates.
    log "Rendering /root/config/dnsmasq.conf and chrony.conf"
    export AIRGAP_DEVICE_INTERFACE AIRGAP_HOST_IP AIRGAP_SUBNET AIRGAP_DHCP_RANGE
    envsubst '$AIRGAP_DEVICE_INTERFACE $AIRGAP_HOST_IP $AIRGAP_SUBNET $AIRGAP_DHCP_RANGE' \
        < "$REPO_DIR/https_file_server/airgap/dnsmasq.conf.template" \
        > "$REPO_DIR/https_file_server/airgap/dnsmasq.conf.rendered"
    envsubst '$AIRGAP_SUBNET' \
        < "$REPO_DIR/https_file_server/airgap/chrony.conf.template" \
        > "$REPO_DIR/https_file_server/airgap/chrony.conf.rendered"

    # Pin the device interface to the static IP across reboots.
    log "Configuring static IP on $AIRGAP_DEVICE_INTERFACE ($AIRGAP_HOST_IP)"
    pin_static_ip() {
        local prefix="${AIRGAP_SUBNET##*/}"
        if command -v nmcli >/dev/null && systemctl is-active --quiet NetworkManager 2>/dev/null; then
            # Raspberry Pi OS default — NetworkManager.
            nmcli con delete signalfi-device 2>/dev/null || true
            nmcli con add type ethernet ifname "$AIRGAP_DEVICE_INTERFACE" \
                con-name signalfi-device \
                ipv4.method manual \
                ipv4.addresses "${AIRGAP_HOST_IP}/${prefix}" \
                ipv6.method disabled \
                autoconnect yes
            nmcli con up signalfi-device || true
        else
            # systemd-networkd fallback.
            install -d -m 755 /etc/systemd/network
            cat > "/etc/systemd/network/10-signalfi-${AIRGAP_DEVICE_INTERFACE}.network" <<EOF
[Match]
Name=${AIRGAP_DEVICE_INTERFACE}

[Network]
Address=${AIRGAP_HOST_IP}/${prefix}
IPForward=no
EOF
            systemctl enable --now systemd-networkd
            networkctl reload || systemctl restart systemd-networkd
        fi
    }
    pin_static_ip
fi

# ── Mode B: byo (customer-served) ────────────────────────────────────────
if [[ "$AIRGAP_NETWORK_MODE" == "byo" ]]; then
    log "byo mode — skipping DHCP/DNS/NTP setup."
    log "Remind the customer admin to apply the README's DNS A-records,"
    log "DHCP reservation, and firewall rules before plugging in devices."
fi

log "setup.sh complete (air-gap, $AIRGAP_NETWORK_MODE)."
echo ""
echo "Next:"
if [[ "$AIRGAP_NETWORK_MODE" == "served" ]]; then
    echo "  cd $INFRA_DIR && $CONTAINER_RUNTIME compose \\"
    echo "      -f docker-compose.yml -f docker-compose.airgap.yml \\"
    echo "      --profile served up -d --build"
else
    echo "  cd $INFRA_DIR && $CONTAINER_RUNTIME compose \\"
    echo "      -f docker-compose.yml -f docker-compose.airgap.yml up -d --build"
fi
echo "  cd $REPO_DIR  && $CONTAINER_RUNTIME compose up -d --build"
