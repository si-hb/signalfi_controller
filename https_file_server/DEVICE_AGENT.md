# Signalfi OTA & Media Sync — Firmware Implementation Guide

**Audience:** IoT firmware developer or AI coding agent implementing OTA firmware updates and file sync for a Signalfi device.  
**Platform:** Teensy 4.1 (IMXRT1062) with Ethernet (QNEthernet library)

---

## Overview

The Signalfi update system uses a two-phase HTTP flow:

1. **Manifest fetch** — device asks a public API whether an update is available for its model and current firmware version.
2. **Authenticated download** — if an update is available, the device uses a `downloadToken` from the manifest to authenticate file downloads.

**Manifest types:**

- `firmware` — flash a new firmware `.hex` image, optionally sync audio files
- `files` — push (put) or delete arbitrary files on the device

The manifest endpoint requires no credentials. File downloads require a valid Bearer token in the `Authorization` header.

**Firmware format:** Intel HEX (`.hex`). Integrity is verified using **CRC32** (IEEE 802.3). SHA256 is also included for reference.

**Admin interface:** `http://apis.symphonyinteractive.ca/ota/admin/` — browser-based tool for uploading firmware/files, building manifests, and pushing OTA. Also exposes a VS Code / CI upload endpoint.

---

## Endpoints

| Purpose              | URL                                                                             | Auth         |
|----------------------|---------------------------------------------------------------------------------|--------------|
| Manifest API         | `http://apis.symphonyinteractive.ca/ota/v1/manifest`                            | None         |
| Firmware download    | `http://apis.symphonyinteractive.ca/ota/v1/firmware/<filename>.hex`             | Bearer token |
| Audio download       | `http://apis.symphonyinteractive.ca/ota/v1/audio/<filename>`                    | Bearer token |
| General file         | `http://apis.symphonyinteractive.ca/ota/v1/files/<filename>`                    | Bearer token |
| Model config         | `http://apis.symphonyinteractive.ca/ota/config/models/<modelId>.json`           | Bearer token |
| Device config        | `http://apis.symphonyinteractive.ca/ota/config/devices/<mac>.json`              | Bearer token |
| Update report        | `http://apis.symphonyinteractive.ca/ota/report`                                 | None         |
| Health check         | `http://apis.symphonyinteractive.ca/ota/health`                                 | None         |
| Config MQTT topic    | `scout/$group/<modelId>/$config` on `apis.symphonyinteractive.ca:1883`          | Password     |

**Token auth:** The device receives a one-time `token` field in the MQTT push payload. Use it as a Bearer token on all OTA HTTP requests (manifest fetch + file downloads):
```
Authorization: Bearer <64-hex-token>
```
The token is **never** put in the URL query string (device side). It is valid for the period specified at manifest generation (default 30 days).

> **HTTP is intentional during the firmware debugging phase.** Plaintext traffic allows packet captures and avoids TLS handshake failures while validating the OTA flow. Once validated, upgrade URLs to `https://` (server-side HTTPS labels are already configured and ready to uncomment).

---

## Sequence Diagram

```
Device                        Manifest API                File Server       MQTT Broker
  |                               |                           |                  |
  | subscribe scout/<mac>/$action ──────────────────────────────────────────────► |
  | subscribe scout/$group/<model>/$action ─────────────────────────────────────► |
  |                               |                           |                  |
  |  ◄── { act:"frm", mdl:"SF-100", mid:"<uuid>",            |                  |
  |         url:"/ota/v1/manifest", token:"<64hex>" } ───────────────────────────|
  |                               |                           |                  |
  | mdl matches → build fetch URL:                            |                  |
  |   http://host + url + ?manifestId=mid                     |                  |
  |-- GET /ota/v1/manifest?manifestId=<uuid>                  |                  |
  |   Authorization: Bearer <token> ──────────────────────► |                  |
  |<-- 200 JSON manifest ────────────────────────────────────|                  |
  |    { manifestId, type, update, downloadToken,             |                  |
  |      firmware{url,crc32,size}, audio[], sync }            |                  |
  |                               |                           |                  |
  | type=="firmware" && update==true:                         |                  |
  |-- GET /ota/v1/firmware/<file> (range requests)            |                  |
  |   Authorization: Bearer <downloadToken> ───────────────► |                  |
  |                                                           |─ auth_request ─► |
  |<── 206 binary ─────────────────────────────────────────── |                  |
  |                               |                           |                  |
  | Verify CRC32                  |                           |                  |
  | Write to flash                |                           |                  |
  |-- POST /ota/report ─────────► |                           |                  |
  | Reboot into new firmware      |                           |                  |
  |                               |                           |                  |
  | for each audio in manifest:   |                           |                  |
  |   if local CRC32 != manifest CRC32:                       |                  |
  |-- GET /ota/v1/audio/<file>    |                           |                  |
  |   Authorization: Bearer <downloadToken> ───────────────► |                  |
  |<── 206 binary ─────────────────────────────────────────── |                  |
  |                               |                           |                  |
  | type=="files" && update==true:                            |                  |
  |   for each {op,id,url,crc32} in files[]:                  |                  |
  |     put: CRC32 pre-check → download if mismatch           |                  |
  |     delete: remove local file (skip system files)         |                  |
  |   if sync==true: delete local files NOT in put list       |                  |
  |     (except system-protected files)                       |                  |
```

---

## Manifest Response Format

### Firmware manifest (`type: "firmware"`)

```json
{
  "type": "firmware",
  "manifestId": "ffdd9a50-dae3-44f8-a8da-9167e6fdaf38",
  "modelId": "SF-100",
  "version": "1.2.0",
  "backup": "program",
  "update": true,
  "reason": "Bug fixes",
  "downloadToken": "63a54ebcc465b17ecd60798efbbda47efc695d30088e002fbf6a26fed5f7b3d1",
  "delaySeconds": 0,
  "firmware": {
    "version": "1.2.0",
    "url": "http://apis.symphonyinteractive.ca/ota/v1/firmware/SF-100-1.2.0.hex",
    "crc32": "a1b2c3d4",
    "sha256": "e3b0c44298fc1c149afbf4c8996fb924...",
    "size": 524288
  },
  "audio": [
    {
      "id": "chime01.wav",
      "url": "http://apis.symphonyinteractive.ca/ota/v1/audio/chime01.wav",
      "crc32": "f1e2d3c4",
      "sha256": "a3b1d5...",
      "size": 102400
    }
  ]
}
```

> **`manifestId`** is a stable RFC 4122 v4 UUID. It only changes when the firmware file or version changes. The device passes it back in the manifest fetch URL as `?manifestId=<uuid>` so the server can locate the exact manifest without model ambiguity.

### Files manifest (`type: "files"`)

Used to push or delete arbitrary files on the device (audio, config, assets).

```json
{
  "type": "files",
  "manifestId": "a3c1e592-11ab-4f7e-b210-3d8e9f0a1234",
  "modelId": "SF-100",
  "update": true,
  "reason": "Updated audio pack",
  "downloadToken": "...",
  "delaySeconds": 0,
  "sync": true,
  "files": [
    {
      "op": "put",
      "id": "chime02.wav",
      "url": "http://apis.symphonyinteractive.ca/ota/v1/audio/chime02.wav",
      "crc32": "b2c3d4e5",
      "sha256": "...",
      "size": 98304
    },
    {
      "op": "put",
      "id": "config.json",
      "url": "http://apis.symphonyinteractive.ca/ota/v1/files/config.json",
      "crc32": "12345678",
      "sha256": "...",
      "size": 512
    },
    { "op": "delete", "id": "old-chime.wav" }
  ]
}
```

**Fields:**

- `type` — `"firmware"` or `"files"`. Absent in legacy manifests — treat as `"firmware"`.
- `manifestId` — stable RFC 4122 v4 UUID. Use this in `?manifestId=` query param when fetching the manifest.
- `update` — `true` = action required; `false` = no-op (draft or up to date).
- `downloadToken` — 64-hex Bearer token for all file downloads. Valid for the duration specified at manifest generation (default 30 days).
- `crc32` — 8-hex CRC32 (IEEE 802.3). **Primary integrity check on device** — fast to compute on embedded hardware. Always compare before downloading (skip if already current).
- `sha256` — included for reference; use CRC32 for runtime verification.
- `files[].op` — `"put"` = download and store; `"delete"` = remove from device storage.
- `sync` — (files manifest only) `true` = after processing all ops, delete every local audio file **not** listed as a `put` op. System-protected files are never deleted regardless of this flag.
- `audio` — firmware manifests only; audio files to sync (same logic as `files` with implicit `op: put`).
- `backup` — (firmware manifest only) controls what backup action the device takes before flashing:

| Value | Behaviour |
| --- | --- |
| absent / `null` / `""` | No backup action — existing `backup.hex` is left unchanged |
| `"file"` | Copy the incoming (checksum-verified) `.hex` to `backup.hex` before flashing |
| `"program"` | Dump the currently running flash image to `backup.hex` before flashing — preserves the last proven firmware as the rollback target |

  **When to use each:** Use `"program"` when deploying a risky or experimental update — the device can roll back to whatever was running before. Use `"file"` when you want the incoming firmware to serve as the rollback target (e.g. you are confident in the new build and want it stored). Omit `backup` for routine pushes where the existing backup is still valid.

---

## Persistent Storage on Teensy 4.1

**All persistence uses the built-in SD card** (`BUILTIN_SDCARD`). EEPROM and LittleFS are not used. The firmware initialises the SD card with `SD.begin(BUILTIN_SDCARD)` in every function that reads or writes persistent state.

**SD card** (`BUILTIN_SDCARD`) holds all large persistent data:

| File / Path                      | Description                                                     |
|----------------------------------|-----------------------------------------------------------------|
| `config.json`                    | Primary device configuration (IP, MQTT host, etc.)             |
| `config_backup.json`             | Backup copy — automatically restored if primary is corrupt     |
| `firmware.hex`                   | Staged firmware pending flash (deleted after apply)            |
| `checksum.json`                  | Checksum metadata for staged firmware (deleted after apply)    |
| `/firmware/backup.hex`           | Known-good firmware backup — **see recovery strategy below**   |
| `/firmware/backup_checksum.json` | Checksum for the backup image                                  |
| Audio files (`/audio/`)          | WAV files used for playback                                     |

**EEPROM** holds only the boot counter — one byte, atomic, readable before SD initialization:

| EEPROM address | Type   | Description                                                       |
|----------------|--------|-------------------------------------------------------------------|
| `0`            | uint8  | Boot counter — incremented before each OTA reboot, cleared after confirmed-good boot |

**Why EEPROM for the boot counter:** SD card file writes are not atomic — power loss mid-write leaves a corrupt JSON file that parses as `count=0`, silently defeating rollback. EEPROM writes are atomic at the byte level and are available before `SD.begin()`, which is critical because SD itself may be unhealthy in exactly the boot-loop scenario where rollback is most needed.

**Boot counter pattern:**
- `EEPROM.write(0, counter + 1)` immediately before calling `updateFirmware()` / rebooting.
- On successful boot (MQTT connected, normal operation confirmed), `EEPROM.write(0, 0)`.
- At startup: if `EEPROM.read(0) >= 3`, trigger rollback from `/firmware/backup.hex`.

**Firmware backup strategy:**
- Before flashing, copy the incoming `firmware.hex` → `/firmware/backup.hex` (and its checksum).
- The backup is only overwritten on the *next* successful OTA — so it always holds the last known-good image.
- On rollback trigger: reflash from `/firmware/backup.hex` using the same `updateFirmware()` call.

---

## Teensy 4.1 Code Examples

All examples use:
- **QNEthernet** for TCP/IP (native Ethernet on Teensy 4.1)
- **ArduinoJson** (v7) for JSON parsing
- **mbedTLS** (bundled with Teensyduino) for SHA256

### 1 — Manifest Fetch

The device receives a `frm` MQTT push containing `mid` (manifestId), `url` (path only), and `token` (Bearer). It constructs the full URL and fetches with the Bearer token.

```cpp
#include <QNEthernet.h>
#include <ArduinoJson.h>

using namespace qindesign::network;

const char* MODEL_ID    = "SF-100";
const char* OTA_HOST    = "apis.symphonyinteractive.ca";
const int   OTA_PORT    = 80;

// Called from the frm MQTT handler with fields extracted from the MQTT payload.
// manifestPath: "/ota/v1/manifest"  (the "url" field from MQTT)
// manifestId:   "<uuid>"            (the "mid" field from MQTT)
// bearerToken:  "<64hex>"           (the "token" field from MQTT)
//
// Returns true if an update is available and fills out, crc32Out, sizeOut,
// dlTokenOut (the downloadToken for subsequent file downloads), and typeOut.
bool fetchManifest(const String& manifestPath, const String& manifestId,
                   const String& bearerToken,
                   String& typeOut, String& dlTokenOut,
                   String& firmwareUrlOut, String& firmwareCrc32Out, uint32_t& firmwareSizeOut) {
    EthernetClient client;

    if (!client.connect(OTA_HOST, OTA_PORT)) {
        Serial.println("[OTA] manifest connect failed");
        return false;
    }

    // Build path: /ota/v1/manifest?manifestId=<uuid>
    String path = manifestPath + "?manifestId=" + manifestId;

    client.printf("GET %s HTTP/1.1\r\n"
                  "Host: %s\r\n"
                  "Authorization: Bearer %s\r\n"
                  "Connection: close\r\n\r\n",
                  path.c_str(), OTA_HOST, bearerToken.c_str());

    // Skip HTTP headers
    int httpStatus = 0;
    while (client.connected()) {
        String line = client.readStringUntil('\n');
        if (line.startsWith("HTTP/")) httpStatus = line.substring(9, 12).toInt();
        if (line == "\r") break;
    }

    if (httpStatus != 200) {
        Serial.printf("[OTA] manifest HTTP %d\n", httpStatus);
        client.stop();
        return false;
    }

    // Parse JSON body
    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, client);
    client.stop();

    if (err) {
        Serial.printf("[OTA] JSON parse error: %s\n", err.c_str());
        return false;
    }

    bool update = doc["update"].as<bool>();
    if (!update) {
        Serial.printf("[OTA] no update: %s\n", doc["reason"] | "up to date");
        return false;
    }

    typeOut          = doc["type"] | "firmware";
    dlTokenOut       = doc["downloadToken"].as<String>();
    firmwareUrlOut   = doc["firmware"]["url"].as<String>();
    firmwareCrc32Out = doc["firmware"]["crc32"].as<String>();  // 8-hex e.g. "a1b2c3d4"
    firmwareSizeOut  = doc["firmware"]["size"].as<uint32_t>();
    return true;
}
```

### 2 — Chunked Firmware Download with Range Requests

The file server supports `Accept-Ranges: bytes`. Use range requests to download in chunks to avoid running out of RAM on large firmware images.

```cpp
// CRC32 (IEEE 802.3) — inline, no external library needed
static const uint32_t CRC32_TABLE[256] = {/* generated at startup or use PROGMEM table */};

void crc32_init(uint32_t& crc) { crc = 0xFFFFFFFF; }
void crc32_update(uint32_t& crc, const uint8_t* buf, size_t len) {
    // Standard CRC32 using pre-built table
    for (size_t i = 0; i < len; i++) {
        crc = (crc >> 8) ^ CRC32_TABLE[(crc ^ buf[i]) & 0xFF];
    }
}
String crc32_finish(uint32_t crc) {
    crc ^= 0xFFFFFFFF;
    char hex[9];
    snprintf(hex, sizeof(hex), "%08lx", (unsigned long)crc);
    return String(hex);
}

// Build CRC32 table (call once at startup)
void buildCrc32Table(uint32_t* table) {
    for (uint32_t i = 0; i < 256; i++) {
        uint32_t c = i;
        for (int j = 0; j < 8; j++) c = (c & 1) ? 0xEDB88320UL ^ (c >> 1) : c >> 1;
        table[i] = c;
    }
}

// Downloads url using Authorization: Bearer <token> header, in CHUNK_SIZE chunks.
// Writes each chunk via writeChunk callback. Returns true on success.
// After download, crc32Out is populated with the 8-hex CRC32 digest.
bool downloadFile(const String& url, const String& token,
                  uint32_t totalSize,
                  std::function<bool(const uint8_t*, size_t, size_t offset)> writeChunk,
                  String& crc32Out) {

    const size_t CHUNK_SIZE = 8192;  // 8 KB — tune to available RAM
    const char* host = "apis.symphonyinteractive.ca";

    uint32_t crc;
    crc32_init(crc);

    uint32_t offset = 0;
    while (offset < totalSize) {
        uint32_t end = min((uint32_t)(offset + CHUNK_SIZE - 1), totalSize - 1);

        EthernetClient client;
        if (!client.connect(host, 80)) {
            Serial.println("[OTA] file connect failed");
            return false;
        }

        // Strip "http://host" prefix from url to get just the path
        int pathStart = url.indexOf('/', 7);  // skip "http://"
        String path = url.substring(pathStart);

        client.printf("GET %s HTTP/1.1\r\n"
                      "Host: %s\r\n"
                      "Authorization: Bearer %s\r\n"
                      "Range: bytes=%u-%u\r\n"
                      "Connection: close\r\n\r\n",
                      path.c_str(), host, token.c_str(), offset, end);

        // Skip HTTP headers
        int httpStatus = 0;
        while (client.connected()) {
            String line = client.readStringUntil('\n');
            if (line.startsWith("HTTP/")) httpStatus = line.substring(9, 12).toInt();
            if (line == "\r") break;
        }

        if (httpStatus != 206 && httpStatus != 200) {
            Serial.printf("[OTA] HTTP %d on range %u-%u\n", httpStatus, offset, end);
            client.stop();
            return false;
        }

        // Read chunk
        uint8_t buf[512];
        size_t chunkOffset = 0;
        while (client.connected() || client.available()) {
            int n = client.read(buf, sizeof(buf));
            if (n <= 0) { delay(1); continue; }

            crc32_update(crc, buf, n);

            if (!writeChunk(buf, n, offset + chunkOffset)) {
                Serial.println("[OTA] writeChunk failed — aborting");
                client.stop();
                return false;
            }
            chunkOffset += n;
        }
        client.stop();
        offset += chunkOffset;

        Serial.printf("[OTA] downloaded %u / %u bytes\n", offset, totalSize);
    }

    crc32Out = crc32_finish(crc);
    return true;
}
```

### 3 — OTA Flash Write (Teensy 4.1)

The firmware uses **FlasherX** (patched, included in `lib/FlasherX-Patched/`) to flash Intel HEX images. The staged file is written to SD card first, then passed to `updateFirmware()`.

Before flashing: increment the EEPROM boot counter, then copy the incoming firmware to `/firmware/backup.hex` on SD as a known-good fallback.

```cpp
#include <SD.h>
#include <EEPROM.h>

#define BOOT_COUNTER_ADDR  0   // EEPROM byte — atomic, readable before SD.begin()
#define ROLLBACK_THRESHOLD 3

// --- Boot counter (EEPROM — atomic, available before SD init) ---

inline uint8_t readBootCounter()          { return EEPROM.read(BOOT_COUNTER_ADDR); }
inline void    writeBootCounter(uint8_t n){ EEPROM.write(BOOT_COUNTER_ADDR, n); }
inline void    clearBootCounter()         { EEPROM.write(BOOT_COUNTER_ADDR, 0); }

// --- Firmware backup (SD card — too large for EEPROM) ---

// Call BEFORE flashing. Copies the staged hex → /firmware/backup.hex.
// Only call after checksum has been verified — backup must be known-good.
void backupFirmwareToSD(const char* srcHex, const char* srcChecksum) {
    SD.begin(BUILTIN_SDCARD);
    if (!SD.exists("/firmware")) SD.mkdir("/firmware");

    auto copyFile = [](const char* from, const char* to) {
        File src = SD.open(from);
        File dst = SD.open(to, FILE_WRITE);
        if (src && dst) {
            uint8_t buf[512];
            while (src.available()) {
                int n = src.read(buf, sizeof(buf));
                dst.write(buf, n);
            }
        }
        if (src) src.close();
        if (dst) dst.close();
    };

    copyFile(srcHex,      "/firmware/backup.hex");
    copyFile(srcChecksum, "/firmware/backup_checksum.json");
    Serial.println("[OTA] Firmware backed up to /firmware/backup.hex");
}

// --- Flash apply sequence ---

void applyFirmwareUpdate(const char* hexFile, const char* checksumFile) {
    // 1. Back up the incoming (checksum-verified) firmware before flashing
    backupFirmwareToSD(hexFile, checksumFile);

    // 2. Increment EEPROM boot counter before rebooting — survives power loss
    writeBootCounter(readBootCounter() + 1);

    // 3. Flash via existing updateFirmware() — device reboots on success
    Serial.println("[OTA] Flashing — device will reboot");
    updateFirmware(hexFile, checksumFile);
    // updateFirmware() does not return on success.
    // If it returns, flashing failed — clear the counter.
    clearBootCounter();
}

// Call once normal operation is confirmed (e.g. MQTT connected)
void onSuccessfulBoot() {
    clearBootCounter();
    Serial.println("[Boot] boot counter cleared — firmware OK");
}
```

### 4 — Full OTA Flow (main loop integration)

```cpp
void checkForUpdate() {
    String token, firmwareUrl, firmwareCrc32;
    uint32_t firmwareSize;

    if (!fetchManifest(token, firmwareUrl, firmwareCrc32, firmwareSize)) {
        return;  // no update or network error
    }

    Serial.println("[OTA] Update available — downloading firmware");

    String computedCrc;
    bool ok = downloadFile(firmwareUrl, token, firmwareSize,
        [](const uint8_t* data, size_t len, size_t offset) {
            return writeChunkToFlash(data, len, offset);
        },
        computedCrc);

    if (!ok) {
        Serial.println("[OTA] Download failed");
        return;
    }

    if (!computedCrc.equalsIgnoreCase(firmwareCrc32)) {
        Serial.printf("[OTA] CRC32 mismatch!\n  expected: %s\n  got:      %s\n",
                      firmwareCrc32.c_str(), computedCrc.c_str());
        return;
    }

    Serial.println("[OTA] CRC32 verified — applying update");
    applyFirmwareUpdate();  // does not return — device reboots
}
```

### 5 — MQTT Push: `frm` Action

OTA is triggered via the existing `$action` topic. The server publishes a `frm` message containing everything the device needs: the manifest path, a stable manifest UUID, and a Bearer token.

**MQTT payload (group push, model-specific):**

```json
{
  "act":   "frm",
  "mdl":   "SF-100",
  "mid":   "ffdd9a50-dae3-44f8-a8da-9167e6fdaf38",
  "url":   "/ota/v1/manifest",
  "token": "586d617dec119258eeaf2a5da6235e6d38fd2f0988db03a6fea9097b228b4518"
}
```

Published to: `scout/$group/SF-100/$action`

- `mid` — manifestId UUID. Passed to the server as `?manifestId=<mid>` in the manifest fetch URL.
- `url` — path only (no hostname). Device prepends `http://apis.symphonyinteractive.ca`.
- `token` — 64-hex Bearer token. Used on **both** the manifest fetch and all file downloads.

**Broadcast push** (all devices, no `mdl` field):

```json
{ "act": "frm", "mid": "...", "url": "/ota/v1/manifest", "token": "..." }
```

Published to: `scout/$broadcast/$action`

Subscribe to broadcast in `setupMqtt()`:

```cpp
mqttClient.subscribe("scout/$broadcast/$action");
```

**Device-side handler — add to your existing `$action` dispatch:**

```cpp
// Use a 768-byte document to hold the full frm payload (mid + url + token are long strings)
if (strcmp(act, "frm") == 0) {
    const char* mdl   = doc["mdl"];
    const char* mid   = doc["mid"];
    const char* url   = doc["url"];
    const char* token = doc["token"];

    // mdl absent = broadcast; mdl present must match our model
    if (mdl && strcmp(mdl, MODEL_ID) != 0) {
        Serial.printf("[OTA] frm ignored — model mismatch (target=%s)\n", mdl);
        return;
    }
    if (!mid || !url || !token) {
        Serial.println("[OTA] frm ignored — missing mid/url/token");
        return;
    }

    Serial.printf("[OTA] frm received — mid=%s\n", mid);
    // Store for the fetch call (or pass directly if your stack allows)
    g_ota_mid   = String(mid);
    g_ota_url   = String(url);
    g_ota_token = String(token);
    checkForUpdate();
    return;
}
```

**Full action dispatch sketch (showing frm alongside existing actions):**

```cpp
// Use StaticJsonDocument<768> or larger to hold the full frm payload
void onActionMessage(const String& payload) {
    StaticJsonDocument<768> doc;
    if (deserializeJson(doc, payload) != DeserializationError::Ok) return;

    const char* act = doc["act"];
    if (!act) return;

    if      (strcmp(act, "ply") == 0) { handlePlay(doc); }
    else if (strcmp(act, "stp") == 0) { handleStop(); }
    else if (strcmp(act, "vol") == 0) { handleVolume(doc); }
    else if (strcmp(act, "pat") == 0) { handlePattern(doc); }
    else if (strcmp(act, "col") == 0) { handleColour(doc); }
    else if (strcmp(act, "brt") == 0) { handleBrightness(doc); }
    else if (strcmp(act, "rbt") == 0) { handleReboot(); }
    else if (strcmp(act, "frm") == 0) {
        const char* mdl   = doc["mdl"];
        const char* mid   = doc["mid"];
        const char* url   = doc["url"];
        const char* token = doc["token"];
        if (mdl && strcmp(mdl, MODEL_ID) != 0) return;  // model mismatch
        if (!mid || !url || !token) return;               // malformed
        g_ota_mid   = String(mid);
        g_ota_url   = String(url);
        g_ota_token = String(token);
        Serial.println("[OTA] frm — starting manifest check");
        checkForUpdate();
    }
    // ... other actions
}
```

> The device's normal group subscriptions already cover model-level targeting:
>
> - `scout/$group/SF-100/$action` — model-specific group
> - `scout/<mac>/$action` — per-device
>
> The server publishes `frm` to whichever is appropriate. The `mdl` field provides a secondary safety check so a mis-routed message cannot trigger an OTA on the wrong device model.

### 6 — Device Report (POST after successful update)

After flashing succeeds and the device reboots, send a report so the server knows the update was applied:

```cpp
void reportUpdate(const String& firmwareVersion, const String& status) {
    EthernetClient client;
    const char* host = "apis.symphonyinteractive.ca";
    if (!client.connect(host, 80)) { Serial.println("[Report] connect failed"); return; }

    String body = String("{\"deviceId\":\"") + DEVICE_ID + "\","
                  "\"modelId\":\"" + MODEL_ID + "\","
                  "\"firmwareVersion\":\"" + firmwareVersion + "\","
                  "\"status\":\"" + status + "\"}";

    client.printf("POST /ota/report HTTP/1.1\r\nHost: %s\r\n"
                  "Content-Type: application/json\r\nContent-Length: %d\r\n"
                  "Connection: close\r\n\r\n%s",
                  host, body.length(), body.c_str());
    while (client.connected()) { String l = client.readStringUntil('\n'); if (l == "\r") break; }
    client.stop();
    Serial.printf("[Report] sent: %s\n", status.c_str());
}
```

### 7 — Audio Sync

Check each audio file in the manifest against the locally stored SHA256. Download only if changed.

```cpp
struct AudioFile {
    String id;
    String url;
    String crc32;   // 8-hex CRC32 for runtime verification
    uint32_t size;
};

// Load saved CRC32 for a file from SD card (e.g. stored in a JSON index)
String loadFileCrc(const String& id);
// Save updated CRC32 after successful download
void saveFileCrc(const String& id, const String& crc32);
// Write audio bytes to SD card
bool writeAudioChunk(const uint8_t* data, size_t len, size_t offset);

void syncAudio(const JsonArray& audioList, const String& token) {
    for (JsonObject item : audioList) {
        AudioFile af;
        af.id    = item["id"].as<String>();
        af.url   = item["url"].as<String>();
        af.crc32 = item["crc32"].as<String>();
        af.size  = item["size"].as<uint32_t>();

        String localCrc = loadFileCrc(af.id);
        if (localCrc.equalsIgnoreCase(af.crc32)) {
            Serial.printf("[Audio] %s up to date\n", af.id.c_str());
            continue;
        }

        Serial.printf("[Audio] downloading %s\n", af.id.c_str());
        String computedCrc;
        bool ok = downloadFile(af.url, token, af.size,
            [](const uint8_t* data, size_t len, size_t offset) {
                return writeAudioChunk(data, len, offset);
            },
            computedCrc);

        if (!ok) {
            Serial.printf("[Audio] %s download failed\n", af.id.c_str());
            continue;
        }

        if (!computedCrc.equalsIgnoreCase(af.crc32)) {
            Serial.printf("[Audio] %s CRC32 mismatch\n", af.id.c_str());
            continue;
        }

        saveFileCrc(af.id, af.crc32);
        Serial.printf("[Audio] %s synced\n", af.id.c_str());
    }
}
```

### 6 — Files Manifest Handling

A manifest with `type: "files"` contains a `files` array of `put` and `delete` operations. Key behaviours:

- **CRC32 pre-check** — before downloading a `put` file, compute the local file's CRC32 and compare against the manifest. Skip the download if they match (idempotent, bandwidth-efficient).
- **`sync: true`** — after all ops, delete every local audio file **not** listed as a `put` op. System-protected files (`sweep.wav`, `pink.wav`) are never deleted.
- **Protected system files** — never delete regardless of `delete` ops or sync mode.

```cpp
// System files that must never be deleted
static const char* SYSTEM_FILES[] = { "sweep.wav", "pink.wav", nullptr };

bool isSystemFile(const char* filename) {
    for (int i = 0; SYSTEM_FILES[i]; i++) {
        if (strcmp(filename, SYSTEM_FILES[i]) == 0) return true;
    }
    return false;
}

// Load/save CRC32 for a file (SD card — e.g. a JSON index file like "file_crcs.json")
String loadFileCrc(const String& id);
void   saveFileCrc(const String& id, const String& crc32);

// Write/delete a file on SD card
bool writeFileChunk(const String& id, const uint8_t* data, size_t len, size_t offset);
void deleteLocalFile(const String& id);

void syncFiles(const JsonDocument& manifest, const String& token) {
    JsonArrayConst fileList = manifest["files"].as<JsonArrayConst>();
    bool doSync = manifest["sync"] | false;
    int  total  = fileList.size();
    int  i      = 0;

    // Collect the "keep" set for sync cleanup
    std::set<String> keepSet;

    for (JsonObjectConst item : fileList) {
        i++;
        const char* op  = item["op"]  | "put";
        const char* id  = item["id"]  | "";
        if (!id || !strlen(id)) continue;

        char prefix[16];
        snprintf(prefix, sizeof(prefix), "[%d/%d]", i, total);

        if (strcmp(op, "delete") == 0) {
            // Never delete system-protected files
            if (isSystemFile(id)) {
                Serial.printf("[Files] %s delete %s — system file, skipping\n", prefix, id);
                continue;
            }
            deleteLocalFile(id);
            Serial.printf("[Files] %s deleted %s\n", prefix, id);
            continue;
        }

        // op == "put"
        keepSet.insert(String(id));

        String url   = item["url"]   | "";
        String crc32 = item["crc32"] | "";
        uint32_t sz  = item["size"]  | 0;

        if (!url.length()) {
            Serial.printf("[Files] %s put %s — no URL, skipping\n", prefix, id);
            continue;
        }

        // CRC32 pre-check: skip download if local file is already current
        if (crc32.length()) {
            String localCrc = loadFileCrc(id);
            if (localCrc.equalsIgnoreCase(crc32)) {
                Serial.printf("[Files] %s put %s — already current (CRC32 match)\n", prefix, id);
                continue;
            }
        }

        Serial.printf("[Files] %s put %s — downloading (%u bytes)\n", prefix, id, sz);
        String computedCrc;
        bool ok = downloadFile(url, token, sz,
            [&](const uint8_t* data, size_t len, size_t offset) {
                return writeFileChunk(id, data, len, offset);
            },
            computedCrc);

        if (!ok) {
            Serial.printf("[Files] %s put %s — download failed\n", prefix, id);
            continue;
        }
        if (crc32.length() && !computedCrc.equalsIgnoreCase(crc32)) {
            Serial.printf("[Files] %s put %s — CRC32 mismatch (got %s, expected %s)\n",
                          prefix, id, computedCrc.c_str(), crc32.c_str());
            continue;
        }

        saveFileCrc(id, computedCrc);
        Serial.printf("[Files] %s put %s — stored\n", prefix, id);
    }

    // Sync mode: delete local files not in the keep set (except system files)
    if (doSync) {
        // Enumerate local audio directory on SD card
        SD.begin(BUILTIN_SDCARD);
        File dir = SD.open("/audio");
        while (true) {
            File entry = dir.openNextFile();
            if (!entry) break;
            String fname = entry.name();
            entry.close();
            if (isSystemFile(fname.c_str())) continue;  // never delete system files
            if (keepSet.find(fname) == keepSet.end()) {
                SD.remove(("/audio/" + fname).c_str());
                Serial.printf("[Files] [sync] deleted %s\n", fname.c_str());
            }
        }
        dir.close();
    }
}

// In checkForUpdate — dispatch on manifest type:
void processManifest(const JsonDocument& manifest, const String& token) {
    const char* type = manifest["type"] | "firmware";
    if (strcmp(type, "files") == 0) {
        syncFiles(manifest, token);
    } else {
        // firmware type — handled by existing OTA flash flow
        // audio sync runs after firmware is applied
        syncAudio(manifest["audio"].as<JsonArrayConst>(), token);
    }
}
```

### 7 — Retry / Backoff

Wrap manifest and download calls with exponential backoff:

```cpp
bool withRetry(int maxAttempts, std::function<bool()> fn) {
    uint32_t delayMs = 5000;
    for (int attempt = 1; attempt <= maxAttempts; attempt++) {
        if (fn()) return true;
        if (attempt < maxAttempts) {
            Serial.printf("[OTA] attempt %d failed, retrying in %ums\n", attempt, delayMs);
            delay(delayMs);
            delayMs = min(delayMs * 2, (uint32_t)60000);  // cap at 60s
        }
    }
    return false;
}

// Usage:
withRetry(5, []() {
    String token, url, crc;
    uint32_t size;
    return fetchManifest(token, url, crc, size);
});
```

### 7 — Rollback Detection

The EEPROM boot counter is read at the very start of `setup()` — before `SD.begin()` — so rollback detection works even when the SD card or filesystem is unhealthy. The firmware backup itself lives on SD (too large for EEPROM).

```cpp
// Call at the top of setup(), before SD.begin() or any other init
void checkRollback() {
    uint8_t counter = readBootCounter();  // EEPROM.read(0) — always safe
    if (counter < ROLLBACK_THRESHOLD) return;

    Serial.printf("[Boot] boot counter = %d — triggering rollback\n", counter);

    // Backup lives on SD — initialise it now
    SD.begin(BUILTIN_SDCARD);
    if (SD.exists("/firmware/backup.hex") &&
        SD.exists("/firmware/backup_checksum.json")) {
        Serial.println("[Boot] Reflashing from /firmware/backup.hex");
        clearBootCounter();  // reset before reflash so a second failure doesn't loop forever
        updateFirmware("/firmware/backup.hex", "/firmware/backup_checksum.json");
        // does not return on success — device reboots into backup firmware
    }

    // No backup available — halt and alert operator
    Serial.println("[Boot] No backup firmware found — halting");
    while (true) { delay(1000); }
}

// Call once normal operation is confirmed (e.g. MQTT connected)
void onSuccessfulBoot() {
    clearBootCounter();  // EEPROM.write(0, 0)
    Serial.println("[Boot] boot counter cleared — firmware OK");
}
```

---

## MQTT Push vs Polling

**Preferred: MQTT push.** Devices respond to `act: frm` arriving on their existing `$action` subscriptions. No extra topics needed.

- Server publishes `{ act:"frm", mdl:"SF-100", mid:"<uuid>", url:"/ota/v1/manifest", token:"<64hex>" }` to the group or device `$action` topic
- Device checks `mdl` field matches its own model, then builds `http://host + url + ?manifestId=mid` and fetches with `Authorization: Bearer <token>`
- The same `token` is reused for all file downloads during that OTA session
- Retry connection on disconnect with backoff

**Fallback polling** (optional, for devices where MQTT is unavailable):
- Poll manifest on startup, then every 6 hours
- During development, 30-second polling is acceptable for fast iteration

---

## Error Handling Summary

| Condition                        | Action                                              |
|----------------------------------|-----------------------------------------------------|
| Manifest server unreachable      | Retry with backoff, continue normal operation       |
| `update: false`                  | No action — normal operation                        |
| Download HTTP 403                | Token invalid or revoked — log, abort update        |
| CRC32 mismatch after download    | Discard download, log error, do not apply           |
| Flash write failure              | Log error, do not reboot                            |
| Boot counter ≥ threshold         | Rollback or halt                                    |
| Audio download fails             | Skip that file, continue with others                |

---

## Config Update Agent

Devices receive config pushes via MQTT — same mechanism as OTA but on the `$config` action topic. The server manages two config tiers: a **model config** (shared settings) and a **device config** (per-device overrides). The device merges both: model config first, device overrides on top.

### MQTT subscriptions for config

Add these to your `setupMqtt()` alongside your existing `$action` subscriptions:
```cpp
// Model config (shared: MQTT credentials, services, OTA server)
String modelConfigTopic = String("scout/$group/") + MODEL_ID + "/$config";
mqttClient.subscribe(modelConfigTopic);

// Per-device config (node path, static IP, display name)
String devConfigTopic = String("scout/") + DEVICE_MAC + "/$config";
mqttClient.subscribe(devConfigTopic);
```

Route in your message handler:
```cpp
if (topic.endsWith("/$config")) {
    onConfigNotification(payload);
} else if (topic.endsWith("/$action")) {
    onActionMessage(payload);  // handles frm, ply, stp, etc.
}
```

### Config notification payload

```json
{
  "type": "model",
  "modelId": "SF-100",
  "url": "http://apis.symphonyinteractive.ca/ota/config/models/SF-100.json",
  "sha256": "abc123...",
  "token": "<64-hex-bearer>"
}
```
For device configs: `"type": "device"`, `"mac": "aa-bb-cc-dd-ee-ff"`.

### Teensy 4.1 — config fetch and merge

```cpp
#include <ArduinoJson.h>

// Persistent config stored on SD card (config.json / config_backup.json)
struct DeviceConfig {
    char nodePath[64];
    char displayName[32];
    char staticIp[16];
    char mqttHost[64];
    int  mqttPort;
    char mqttUser[32];
    char mqttPass[32];
    bool otaEnabled;
};

DeviceConfig g_config;

// Called when a $config MQTT notification arrives
void onConfigNotification(const String& payload) {
    StaticJsonDocument<512> doc;
    if (deserializeJson(doc, payload) != DeserializationError::Ok) return;

    const char* url   = doc["url"];
    const char* sha   = doc["sha256"];
    const char* token = doc["token"];
    const char* type  = doc["type"];

    if (!url || !token) return;

    Serial.printf("[config] fetching %s config from %s\n", type, url);

    // Fetch config JSON with Bearer token
    QNEthernetClient client;
    HttpClient http(client, "apis.symphonyinteractive.ca", 80);
    http.beginRequest();
    http.get(url);
    http.sendHeader("Authorization", String("Bearer ") + token);
    http.endRequest();

    if (http.responseStatusCode() != 200) {
        Serial.printf("[config] fetch failed: %d\n", http.responseStatusCode());
        return;
    }

    String body = http.responseBody();

    // Validate SHA256
    byte hash[32];
    mbedtls_sha256((const unsigned char*)body.c_str(), body.length(), hash, 0);
    char hexHash[65];
    for (int i = 0; i < 32; i++) sprintf(hexHash + i*2, "%02x", hash[i]);
    if (strcmp(hexHash, sha) != 0) {
        Serial.println("[config] SHA256 mismatch — ignoring");
        return;
    }

    // Parse and apply (merge strategy: model config sets base, device overrides on top)
    StaticJsonDocument<1024> cfg;
    if (deserializeJson(cfg, body) != DeserializationError::Ok) return;

    // Apply fields that are present (merge, don't overwrite everything)
    if (cfg.containsKey("nodePath"))    strlcpy(g_config.nodePath,    cfg["nodePath"],    sizeof(g_config.nodePath));
    if (cfg.containsKey("displayName")) strlcpy(g_config.displayName, cfg["displayName"], sizeof(g_config.displayName));
    if (cfg.containsKey("mqtt")) {
        JsonObject mqtt = cfg["mqtt"];
        if (mqtt.containsKey("host")) strlcpy(g_config.mqttHost, mqtt["host"], sizeof(g_config.mqttHost));
        if (mqtt.containsKey("port")) g_config.mqttPort = mqtt["port"];
        if (mqtt.containsKey("username")) strlcpy(g_config.mqttUser, mqtt["username"], sizeof(g_config.mqttUser));
        if (mqtt.containsKey("password")) strlcpy(g_config.mqttPass, mqtt["password"], sizeof(g_config.mqttPass));
    }
    if (cfg.containsKey("network")) {
        strlcpy(g_config.staticIp, cfg["network"]["staticIp"] | "", sizeof(g_config.staticIp));
    }
    if (cfg.containsKey("services")) {
        g_config.otaEnabled = cfg["services"]["ota"] | true;
    }

    // Persist to flash
    saveConfig(g_config);
    Serial.println("[config] config updated and saved");
    // Optionally reboot if network settings changed
}
```

### Startup: load both config tiers

On boot, subscribe to config topics **before** connecting to MQTT so retained messages replay immediately:

```cpp
void loadRemoteConfig() {
    // The broker replays the last retained $config message on subscribe.
    // Device receives model config first, then device-specific overrides.
    // No HTTP request at boot — only fetches when notified.
}
```

> On first connect, the broker replays the last retained `$config` message, so any config published while the device was offline is applied on next connect — no polling needed.

---

## VS Code / CI Automated Upload

The manifest service exposes a dedicated upload endpoint that accepts a firmware file and optionally generates a manifest and triggers an OTA push — suitable for a VS Code build task.

**Endpoint:** `POST http://apis.symphonyinteractive.ca/ota/admin/api/upload`

**Headers:** `Authorization: Bearer <ADMIN_TOKEN>`

**Form fields:**

| Field | Required | Description |
| ----- | -------- | ----------- |
| `file` | yes | The `.hex` firmware file |
| `model` | no | Model ID (e.g. `SF-100`) — required if `push=true` |
| `version` | no | Version string (e.g. `1.2.0`) |
| `push` | no | `true` to generate manifest and trigger OTA push |
| `target` | no | `group` (default) or `broadcast` |

**VS Code `.vscode/tasks.json` example:**

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Upload Firmware to OTA Server",
      "type": "shell",
      "command": "curl -s -X POST http://apis.symphonyinteractive.ca/ota/admin/api/upload -H 'Authorization: Bearer ${env:OTA_ADMIN_TOKEN}' -F 'file=@${workspaceFolder}/build/firmware.hex' -F 'model=SF-100' -F 'version=1.2.0' -F 'push=true' | python3 -m json.tool",
      "group": "build",
      "problemMatcher": []
    }
  ]
}
```

Set `OTA_ADMIN_TOKEN` in your shell environment or `.env` file (not committed to source control).

**Response:**

```json
{
  "name": "firmware.hex",
  "size": 524288,
  "crc32": "a1b2c3d4",
  "sha256": "e3b0c44...",
  "pushed": true,
  "topic": "scout/$group/SF-100/$action",
  "manifest": { ... }
}
```

---

## HTTPS Migration (Future)

When the server upgrades to HTTPS, only the URL prefix changes — token auth and all other logic stays identical:

1. Change manifest URL: `http://apis.symphonyinteractive.ca` → `https://apis.symphonyinteractive.ca`
2. Change firmware/audio download base URL to `https://`
3. Ensure QNEthernet + mbedTLS TLS client is initialised with the correct CA cert (Let's Encrypt ISRG Root X1) or use `client.setInsecure()` for initial testing

No token, MQTT, or report changes required.

---

## signalfi_soft Python Reference Implementation

`signalfi_soft` is a desktop simulator that exercises the full OTA flow against the live server. It is the canonical reference for the tested, working procedure. All code below is from `app/ui/main_window.py`.

### Constants

```python
# Audio files that must never be deleted by OTA or direct MQTT delete commands
SYSTEM_AUDIO_FILES = frozenset({'sweep.wav', 'pink.wav'})
```

### MQTT dispatch — `frm` action

```python
# mqtt_client.py — handler map entry
"frm": self.on_ota

# main_window.py — handler
def _hdl_ota(self, data: dict):
    mdl   = data.get("mdl", "")
    mid   = data.get("mid", "")
    url   = data.get("url", "")
    token = data.get("token", "")

    if mdl != "SF-100":
        self._log("OTA", f"frm ignored — model mismatch ({mdl})")
        return
    if not mid or not url or not token:
        self._log("OTA", "frm ignored — missing mid/url/token")
        return

    threading.Thread(target=self._ota_fetch_and_apply,
                     args=(mid, url, token), daemon=True).start()
```

### Manifest fetch

```python
def _ota_fetch_and_apply(self, mid: str, url: str, token: str):
    host = self._config.get("ota_host", "apis.symphonyinteractive.ca")
    port = self._config.get("ota_port", 80)
    full_url = f"http://{host}:{port}{url}?manifestId={mid}"
    self._log("OTA", f"Fetching manifest: {full_url}")
    try:
        req = urllib.request.Request(full_url)
        req.add_header("Authorization", f"Bearer {token}")
        with urllib.request.urlopen(req, timeout=15) as resp:
            manifest = json.loads(resp.read().decode())
    except Exception as e:
        self._log("OTA", f"Manifest fetch failed: {e}")
        return

    mtype = manifest.get("type", "firmware")
    if mtype == "files":
        self._simulate_ota_files(token, manifest)
    else:
        self._simulate_ota_firmware(token, manifest)
```

### Firmware OTA (with CRC32 verification)

```python
def _simulate_ota_firmware(self, token: str, manifest: dict):
    fw      = manifest.get("firmware", {})
    fw_url  = fw.get("url", "")
    fw_crc  = fw.get("crc32")   # 8-hex string e.g. "a1b2c3d4"
    fw_ver  = manifest.get("version", "?")

    self._log("OTA", f"Downloading firmware v{fw_ver}: {fw_url}")
    try:
        req = urllib.request.Request(fw_url)
        req.add_header("Authorization", f"Bearer {token}")
        with urllib.request.urlopen(req, timeout=60) as resp:
            fw_data = resp.read()
    except Exception as e:
        self._log("OTA", f"Firmware download failed: {e}")
        return

    self._log("OTA", f"Downloaded {len(fw_data):,} bytes")

    # CRC32 check — crc32 field is an 8-hex string, must parse with base 16
    if fw_crc is not None:
        try:
            actual_crc = binascii.crc32(fw_data) & 0xFFFFFFFF
            expected   = int(str(fw_crc), 16) & 0xFFFFFFFF
            if actual_crc == expected:
                self._log("OTA", f"CRC32 OK ({expected:#010x})")
            else:
                self._log("OTA", f"CRC32 MISMATCH: got {actual_crc:#010x}, "
                                  f"expected {expected:#010x} — aborting")
                return
        except Exception as e:
            self._log("OTA", f"CRC32 check error: {e} — aborting")
            return

    self._simulate_firmware_flash(fw.get("sha256", ""), source=f"OTA v{fw_ver}")
```

> **Important:** `int(fw_crc)` will raise `ValueError` on hex strings. Always use `int(str(fw_crc), 16)`.

### Files OTA (put/delete with CRC32 pre-check and sync)

```python
def _simulate_ota_files(self, token: str, manifest: dict):
    files  = manifest.get("files", [])
    sync   = manifest.get("sync", False)
    total  = len(files)

    for i, entry in enumerate(files, 1):
        op      = entry.get("op", "put")
        file_id = entry.get("id", "")
        prefix  = f"[{i}/{total}]"

        if op == "delete":
            # Never delete system-protected files
            if os.path.basename(file_id) in SYSTEM_AUDIO_FILES:
                self._log("OTA", f"{prefix} delete {file_id} — protected system file, skipping")
                continue
            dest = os.path.join(self._audio_dir, os.path.basename(file_id))
            if os.path.isfile(dest):
                os.remove(dest)
                self._log("OTA", f"{prefix} delete {file_id} — removed")
            else:
                self._log("OTA", f"{prefix} delete {file_id} — not found (skipped)")

        elif op == "put":
            file_url     = entry.get("url", "")
            expected_crc = entry.get("crc32")
            dest = os.path.join(self._audio_dir, os.path.basename(file_id))

            # CRC32 pre-check — skip download if local file is already current
            if expected_crc and os.path.isfile(dest):
                try:
                    with open(dest, "rb") as fh:
                        actual_crc = binascii.crc32(fh.read()) & 0xFFFFFFFF
                    if actual_crc == int(str(expected_crc), 16) & 0xFFFFFFFF:
                        self._log("OTA", f"{prefix} put {file_id} — already current (CRC32 match), skipping")
                        continue
                    else:
                        self._log("OTA", f"{prefix} put {file_id} — CRC32 mismatch, re-downloading")
                except Exception as e:
                    self._log("OTA", f"{prefix} put {file_id} — checksum check failed ({e}), re-downloading")

            # Download
            req = urllib.request.Request(file_url)
            req.add_header("Authorization", f"Bearer {token}")
            with urllib.request.urlopen(req, timeout=30) as resp:
                file_data = resp.read()
            with open(dest, "wb") as out:
                out.write(file_data)
            self._log("OTA", f"{prefix} put {file_id} — {len(file_data):,} bytes saved")

    # Sync: delete local files not in the manifest's put list
    # System-protected files are always excluded from deletion
    if sync:
        keep = {os.path.basename(e.get("id", "")) for e in files if e.get("op") == "put"}
        keep |= SYSTEM_AUDIO_FILES
        local = [f for f in os.listdir(self._audio_dir)
                 if os.path.isfile(os.path.join(self._audio_dir, f))]
        for fname in local:
            if fname not in keep:
                os.remove(os.path.join(self._audio_dir, fname))
                self._log("OTA", f"[sync] deleted {fname}")
```

### Protected system files — direct MQTT `del` action

```python
def _hdl_delete(self, data: dict):
    filename = data.get("file", "")
    if not filename or filename == "config.json" or filename in SYSTEM_AUDIO_FILES:
        self._log("MQTT", f"del: '{filename}' is a protected system file — ignored")
        return
    path = os.path.join(self._audio_dir, filename)
    if os.path.isfile(path):
        os.remove(path)
        self._log("MQTT", f"Deleted: {filename}")
    else:
        self._log("MQTT", f"del: file not found: {filename}")
```

### Debug log tag colours (`debug_panel.py`)

```python
TAG_COLORS = {
    ...
    "OTA": "#f48fb1",   # pink
    ...
}
```

---

## System-Protected Files

The following audio files must **never** be deleted by any OTA operation, sync mode, or direct MQTT delete command:

| File | Purpose |
|------|---------|
| `sweep.wav` | Frequency sweep used for system calibration |
| `pink.wav` | Pink noise reference signal |

Both the firmware and the server-side admin UI must honour this list. On the device, protect them in:

1. `op: "delete"` handling in the files manifest loop
2. Sync cleanup (add to the keep-set before enumerating local files)
3. Direct `del` MQTT action handler
