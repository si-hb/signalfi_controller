# Signalfi OTA & File Server — Infrastructure Reference

**Server:** `apis.symphonyinteractive.ca` (159.203.52.36)  
**Stack:** HTTP-first (HTTPS upgrade path documented below)  
**Single hostname:** all OTA endpoints under `apis.symphonyinteractive.ca/ota/`

---

## Architecture Overview

```
                    apis.symphonyinteractive.ca (159.203.52.36)
                    ─────────────────────────────────────────────
HTTP/HTTPS  ──►  Traefik :80/:443
                   │
                   ├── /ota/v1/*            ──►  signalfi-manifest :3001
                   ├── /ota/v1/firmware/*   ──►  signalfi-files :80  (priority wins)
                   ├── /ota/v1/audio/*      ──►  signalfi-files :80  (priority wins)
                   ├── weather.apis.*       ──►  node-red :1880
                   └── signalfi.apis.*      ──►  signalfi-web :3000

MQTT        ──►  mosquitto :1883 (plain)  /  :8883 (TLS, future)
                              :9001 (WS)  /  :9443 (WSS, future)
                   └── signalfi/ota/<modelId>  ← OTA push notifications

SFTP        ──►  sftpgo :2022
                   /firmware/   →  /opt/signalfi/files/firmware/
                   /audio/      →  /opt/signalfi/files/audio/
                   /manifests/  →  /opt/signalfi/manifests/
                   /tokens/     →  /opt/signalfi/tokens/
```

All services are defined in a single `/root/docker-compose.yml` on the server.

---

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/ota/v1/manifest?modelId=&firmwareVersion=` | None | Device queries for update |
| GET | `/ota/v1/firmware/<file>` | Bearer token | Download firmware binary |
| GET | `/ota/v1/audio/<file>` | Bearer token | Download audio file |
| POST | `/ota/v1/report` | None | Device reports update result |
| GET | `/ota/v1/health` | None | Manifest service health |
| GET | `/ota/health` | None | File server health |

**Token auth:** `Authorization: Bearer <64-hex>` header (no query param).

---

## Services

### signalfi-manifest (Node.js, :3001)
- Serves all `/ota/*` paths except firmware/audio files
- Validates tokens for nginx `auth_request`
- Watches `manifests/models/*.json` for changes → MQTT push to `signalfi/ota/<modelId>`
- Logs device update reports to `/opt/signalfi/reports/updates.log`
- Source: `manifest-service/`

### signalfi-files (nginx, :80)
- Serves `/ota/v1/firmware/` and `/ota/v1/audio/` (higher Traefik priority)
- `auth_request` to manifest service validates `Authorization: Bearer` header
- Range requests enabled for chunked firmware download
- Config: `nginx.conf`

### sftpgo (:2022)
- User: `symphony` / `Si9057274427`
- 4 virtual directories for admin uploads
- Bootstrap: `sftpgo/init-data.json`

### mosquitto (:1883/:9001)
- MQTT broker for push notifications
- OTA topic: `signalfi/ota/<modelId>` (retained message, published on manifest update)
- Internal service user: `signalfi-svc` / `OtaService2024!`
- Device user: `symphony` / `Si9057274427`

---

## Token System

Tokens are **64-character hex strings** stored as files in `/opt/signalfi/tokens/`.

**File naming:**
- `<64-hex>` — eternal token (no expiry)
- `<64-hex>_exp<unix_seconds>` — token with expiry (created by `generate-manifest.js` default)

**How validation works:**
1. Device sends `Authorization: Bearer <64-hex>` on file requests
2. nginx `auth_request` subrequest forwards the header to `signalfi-manifest:3001/ota/v1/validate`
3. Manifest service looks for a matching token file, checks expiry suffix if present
4. Returns 200 (allowed) or 401 (denied)
5. No container restarts required to issue or revoke tokens

**Create a token manually:**
```bash
TOKEN=$(openssl rand -hex 32)
EXPIRY=$(( $(date +%s) + 2592000 ))  # 30 days
ssh root@apis.symphonyinteractive.ca "touch /opt/signalfi/tokens/${TOKEN}_exp${EXPIRY}"
echo $TOKEN  # give this to the device, used as: Authorization: Bearer <TOKEN>
```

**Revoke a token:**
```bash
ssh root@apis.symphonyinteractive.ca "rm /opt/signalfi/tokens/<hex>*"
```

---

## Host Directory Layout

```
/opt/signalfi/
├── files/
│   ├── firmware/       ← .bin firmware images served at /ota/v1/firmware/
│   └── audio/          ← .wav audio assets served at /ota/v1/audio/
├── manifests/
│   ├── default.json    ← fallback for unknown models
│   └── models/
│       └── SF-100.json ← per-model manifest (update: true → triggers MQTT push + OTA)
├── tokens/             ← zero-byte files: <64-hex> or <64-hex>_exp<timestamp>
└── reports/
    └── updates.log     ← JSONL: device OTA success/failure reports
```

---

## compatibleFrom Field

This field controls which device firmware versions are eligible to receive an update.

| Value | Behavior |
|-------|----------|
| `["*"]` | All versions eligible (default when using generate-manifest.js) |
| `["1.0.0", "1.1.0"]` | Only devices running listed versions receive the update |
| `[]` (empty array) | **No devices eligible** — safe default, prevents accidental pushes |
| field absent | Update sent to all (treated as `["*"]`) |

> ⚠️ Publishing with `compatibleFrom: []` blocks all devices. Always use `["*"]` or a version list when `update: true`.

---

## Uploading Files via SFTP

**SFTP credentials:**
```
Host:     apis.symphonyinteractive.ca
Port:     2022
User:     symphony
Password: Si9057274427
```

**Virtual paths available after login:**
```
/firmware/    →  /opt/signalfi/files/firmware/
/audio/       →  /opt/signalfi/files/audio/
/manifests/   →  /opt/signalfi/manifests/
/tokens/      →  /opt/signalfi/tokens/
```

**CLI:**
```bash
sftp -P 2022 symphony@apis.symphonyinteractive.ca
sftp> put firmware-v1.1.bin /firmware/firmware-v1.1.bin
sftp> quit
```

---

## Publishing a Firmware Update

The `tools/generate-manifest.js` script handles the full publish workflow:

1. Computes SHA256 and byte length of firmware binary
2. Generates 64-hex token with 30-day expiry (`<hex>_exp<timestamp>`)
3. Connects via SFTP and uploads: firmware binary, token file, manifest JSON
4. sftpgo write triggers `fs.watch` in manifest service → MQTT publish to `signalfi/ota/<modelId>`
5. Subscribed devices receive push notification and immediately poll the manifest

**Prerequisites:**
```bash
cd tools/
npm install
```

**Minimal usage (uses production defaults):**
```bash
node generate-manifest.js --model SF-100 --firmware ./firmware.bin --version 1.1.0
```

**Full options:**
```bash
node generate-manifest.js \
  --model SF-100 \
  --firmware /path/to/firmware.bin \
  --version 1.1.0 \
  --compat-from 1.0.0,0.9.1 \    # default: ["*"] (all versions)
  --token-days 30 \               # default: 30 days
  --audio ./sound1.wav \
  --files-base-url http://apis.symphonyinteractive.ca \
  --sftp-host apis.symphonyinteractive.ca \
  --sftp-port 2022 \
  --sftp-user symphony \
  --sftp-pass Si9057274427 \
  --dry-run
```

The manifest written to `/manifests/models/SF-100.json`:
```json
{
  "modelId": "SF-100",
  "compatibleFrom": ["*"],
  "update": true,
  "downloadToken": "<64-hex>",
  "firmware": {
    "version": "1.1.0",
    "url": "http://apis.symphonyinteractive.ca/ota/v1/firmware/SF-100-1.1.0.bin",
    "sha256": "<sha256>",
    "size": 524288
  },
  "audio": []
}
```

---

## Device OTA Report

After a successful update, device POSTs:

```bash
curl -X POST http://apis.symphonyinteractive.ca/ota/v1/report \
  -H 'Content-Type: application/json' \
  -d '{"deviceId":"SF-100-001","modelId":"SF-100","firmwareVersion":"1.1.0","status":"applied"}'
```

Reports are appended to `/opt/signalfi/reports/updates.log` (JSONL format) and readable via SFTP at `/reports/updates.log`.

---

## Rebuilding the Stack (Redeploy)

```bash
# 1. SSH to server
ssh root@apis.symphonyinteractive.ca

# 2. Stop all services
cd /root && docker compose down

# 3. Remove stale volumes (only if wiping state)
docker volume rm root_sftpgo-state root_mqtt-broker-data

# 4. Recreate directory layout
mkdir -p /opt/signalfi/files/firmware /opt/signalfi/files/audio
mkdir -p /opt/signalfi/manifests/models /opt/signalfi/tokens /opt/signalfi/reports
chown -R 1000:1000 /opt/signalfi/files /opt/signalfi/manifests /opt/signalfi/tokens /opt/signalfi/reports

# 5. Restore config files (run locally from this folder)
scp nginx.conf root@apis.symphonyinteractive.ca:/root/nginx-ota.conf
scp sftpgo/init-data.json root@apis.symphonyinteractive.ca:/root/sftpgo-init.json
scp docker-compose.yml root@apis.symphonyinteractive.ca:/root/docker-compose.yml
scp manifests/default.json root@apis.symphonyinteractive.ca:/opt/signalfi/manifests/default.json
scp manifests/models/SF-100.json root@apis.symphonyinteractive.ca:/opt/signalfi/manifests/models/SF-100.json
scp -r manifest-service root@apis.symphonyinteractive.ca:/opt/signalfi/compose/

# 6. Re-add MQTT users (after volume wipe)
docker compose up -d mosquitto
sleep 3
docker exec --user root root-mosquitto-1 \
  mosquitto_passwd -b /mosquitto/config/pass.txt symphony 'Si9057274427'
docker exec --user root root-mosquitto-1 \
  mosquitto_passwd -b /mosquitto/config/pass.txt signalfi-svc 'OtaService2024!'
docker restart root-mosquitto-1

# 7. Start full stack
docker compose up -d --build

# 8. Verify
curl http://apis.symphonyinteractive.ca/ota/v1/health
curl http://apis.symphonyinteractive.ca/ota/health
curl 'http://apis.symphonyinteractive.ca/ota/v1/manifest?modelId=SF-100&firmwareVersion=1.0.0'
nc -z apis.symphonyinteractive.ca 1883 && echo "MQTT OK"
nc -z apis.symphonyinteractive.ca 2022 && echo "SFTP OK"
```

---

## Upgrade Path: HTTP → HTTPS

1. **Uncomment HTTPS labels** in `/root/docker-compose.yml` for `signalfi-manifest` and `signalfi-files`
2. **Add `middlewares=redirect-https`** to each -http router label
3. `ssh root@apis.symphonyinteractive.ca "cd /root && docker compose up -d signalfi-manifest signalfi-files"`
4. Traefik auto-issues Let's Encrypt cert for `apis.symphonyinteractive.ca` (DNS exists)
5. **Update manifests:** change `firmware.url` from `http://` to `https://` → triggers MQTT push automatically
6. **Update device firmware** URL prefix from `http://` to `https://` — no other code changes needed

---

## Upgrade Path: MQTT → MQTTS

1. Copy TLS cert/key for `apis.symphonyinteractive.ca` to `/root/config/`
2. Add `listener 8883` TLS block to `/root/config/mosquitto.conf`
3. Uncomment `:8883` and `:9443` port mappings in `docker-compose.yml`
4. `docker compose up -d mosquitto`
5. Update devices to connect on port 8883 with TLS
6. Once all devices migrated, remove `:1883` exposure

---

## Health Checks

```bash
curl http://apis.symphonyinteractive.ca/ota/v1/health    # manifest service
curl http://apis.symphonyinteractive.ca/ota/health        # file server
nc -z apis.symphonyinteractive.ca 1883 && echo "MQTT OK"
nc -z apis.symphonyinteractive.ca 2022 && echo "SFTP OK"
ssh root@apis.symphonyinteractive.ca "docker ps --format 'table {{.Names}}\t{{.Status}}'"
```
