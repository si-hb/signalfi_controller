#!/usr/bin/env bash
# signalfi-smoketest.sh — verify an air-gap install end-to-end.
#
# Run from any machine on the device LAN (or the CM4 itself).  Exits 0 if
# every check passes; non-zero with a per-step summary otherwise.  Intended
# to be called from the customer runbook during install handoff.
#
# Usage:
#   ./signalfi-smoketest.sh <SIGNALFI_SERVER_IP>
#
# Optional env:
#   SIGNALFI_MQTT_USER   default: symphony
#   SIGNALFI_MQTT_PASS   default: (none — skips the MQTT check if unset)
#   SIGNALFI_CA_CERT     path to Signalfi Root CA (optional, enables strict
#                        TLS verification on the health-check curl)

set -u

SERVER_IP="${1:-}"
[[ -z "$SERVER_IP" ]] && { echo "Usage: $0 <SIGNALFI_SERVER_IP>" >&2; exit 2; }

MQTT_USER="${SIGNALFI_MQTT_USER:-symphony}"
MQTT_PASS="${SIGNALFI_MQTT_PASS:-}"
CA_CERT="${SIGNALFI_CA_CERT:-}"

HOSTNAME_API="apis.symphonyinteractive.ca"
HOSTNAME_ADMIN="admin.apis.symphonyinteractive.ca"

passed=0; failed=0
results=()

pass() { results+=("  ✓ $1"); passed=$((passed+1)); }
fail() { results+=("  ✗ $1 — $2"); failed=$((failed+1)); }

# ── 1. DNS — apis.* resolves to SERVER_IP ─────────────────────────────────
if command -v dig >/dev/null 2>&1; then
    got=$(dig +short +time=2 +tries=1 "$HOSTNAME_API" | head -1)
    if [[ "$got" == "$SERVER_IP" ]]; then
        pass "DNS: $HOSTNAME_API → $SERVER_IP"
    else
        fail "DNS: $HOSTNAME_API → '$got' (expected $SERVER_IP)" \
             "check served-mode dnsmasq or byo-mode customer DNS A-record"
    fi
else
    fail "DNS" "dig not installed; install dnsutils/bind-tools"
fi

# ── 2. TCP reachability to the server ────────────────────────────────────
if command -v nc >/dev/null 2>&1; then
    if nc -z -w3 "$SERVER_IP" 443 2>/dev/null; then
        pass "TCP: $SERVER_IP:443 reachable"
    else
        fail "TCP 443" "server not listening or firewall blocks; check Traefik is up"
    fi
    if nc -z -w3 "$SERVER_IP" 1883 2>/dev/null; then
        pass "TCP: $SERVER_IP:1883 reachable"
    else
        fail "TCP 1883" "MQTT broker not listening; check Mosquitto container"
    fi
else
    fail "TCP" "nc (netcat) not installed"
fi

# ── 3. OTA health endpoint — cert chain validates end-to-end ─────────────
curl_args=(--silent --show-error --max-time 5 --resolve "$HOSTNAME_API:443:$SERVER_IP")
if [[ -n "$CA_CERT" && -f "$CA_CERT" ]]; then
    curl_args+=(--cacert "$CA_CERT")
else
    curl_args+=(--insecure)
fi
http_code=$(curl "${curl_args[@]}" -o /dev/null -w '%{http_code}' "https://$HOSTNAME_API/ota/v1/health" 2>&1 || true)
case "$http_code" in
    200)     pass "HTTPS: /ota/v1/health → 200" ;;
    401|403) pass "HTTPS: /ota/v1/health → $http_code (endpoint exists, auth enforced)" ;;
    *)       fail "HTTPS: /ota/v1/health → $http_code" "signalfi-manifest not reachable or TLS chain broken" ;;
esac

# ── 4. Admin hostname — second SAN on the fullchain ───────────────────────
http_code=$(curl "${curl_args[@]}" --resolve "$HOSTNAME_ADMIN:443:$SERVER_IP" -o /dev/null \
    -w '%{http_code}' "https://$HOSTNAME_ADMIN/ota/admin/" 2>&1 || true)
case "$http_code" in
    200|301|302|401) pass "HTTPS admin: $HOSTNAME_ADMIN → $http_code" ;;
    *)               fail "HTTPS admin: $HOSTNAME_ADMIN → $http_code" "admin SAN missing from fullchain?" ;;
esac

# ── 5. MQTT — optional, only if password supplied ─────────────────────────
if [[ -n "$MQTT_PASS" ]] && command -v mosquitto_sub >/dev/null 2>&1; then
    if timeout 5 mosquitto_sub -h "$SERVER_IP" -p 1883 \
         -u "$MQTT_USER" -P "$MQTT_PASS" -t '$SYS/broker/version' -C 1 -q 0 >/dev/null 2>&1
    then
        pass "MQTT: auth + subscribe OK"
    else
        fail "MQTT" "auth failed or broker not responding (user=$MQTT_USER)"
    fi
elif [[ -n "$MQTT_PASS" ]]; then
    fail "MQTT" "mosquitto_sub not installed; install mosquitto-clients"
fi

# ── 6. NTP — only in served mode; caller skips by unsetting SIGNALFI_CHECK_NTP ─
if [[ "${SIGNALFI_CHECK_NTP:-1}" == "1" ]] && command -v chronyc >/dev/null 2>&1; then
    if timeout 3 chronyc -h "$SERVER_IP" tracking >/dev/null 2>&1; then
        pass "NTP: chrony responds at $SERVER_IP"
    else
        fail "NTP" "no NTP server at $SERVER_IP (expected in served mode; skip with SIGNALFI_CHECK_NTP=0)"
    fi
fi

# ── Report ────────────────────────────────────────────────────────────────
echo ""
echo "Signalfi air-gap smoketest — $SERVER_IP"
echo "───────────────────────────────────────"
printf '%s\n' "${results[@]}"
echo "───────────────────────────────────────"
echo "Passed: $passed    Failed: $failed"

[[ $failed -eq 0 ]]
