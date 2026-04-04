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
| Manifest API         | `http://apis.symphonyinteractive.ca/ota/manifest`                               | None         |
| Firmware download    | `http://apis.symphonyinteractive.ca/ota/firmware/<filename>.hex`                | Bearer token |
| Audio download       | `http://apis.symphonyinteractive.ca/ota/audio/<filename>`                       | Bearer token |
| General file         | `http://apis.symphonyinteractive.ca/ota/v1/files/<filename>`                    | Bearer token |
| Model config         | `http://apis.symphonyinteractive.ca/ota/config/models/<modelId>.json`           | Bearer token |
| Device config        | `http://apis.symphonyinteractive.ca/ota/config/devices/<mac>.json`              | Bearer token |
| Update report        | `http://apis.symphonyinteractive.ca/ota/report`                                 | None         |
| Health check         | `http://apis.symphonyinteractive.ca/ota/health`                                 | None         |
| Config MQTT topic    | `scout/$group/<modelId>/$config` on `apis.symphonyinteractive.ca:1883`          | Password     |

**Token auth:** Use the `downloadToken` from the manifest as a Bearer token:
```
Authorization: Bearer <64-hex-token>
```
The token is **never** put in the URL query string.

> **HTTP is intentional during the firmware debugging phase.** Plaintext traffic allows packet captures and avoids TLS handshake failures while validating the OTA flow. Once validated, upgrade URLs to `https://` (server-side HTTPS labels are already configured and ready to uncomment).

---

## Sequence Diagram

```
Device                        Manifest API                File Server       MQTT Broker
  |                               |                           |                  |
  | subscribe scout/<mac>/$action (existing) ──────────────────────────────────────► |
  | subscribe scout/$group/<node>/$action (existing) ──────────────────────────────► |
  |                               |                           |                  |
  | ── on act:frm (mdl matches) OR startup ─────────────────────────────────────►|
  |-- GET /ota/manifest           |                           |                  |
  |     ?modelId=&firmwareVersion=|                           |                  |
  |                          ---> |                           |                  |
  |<-- 200 JSON manifest ---------|                           |                  |
  |    { update, downloadToken,   |                           |                  |
  |      firmware{url,sha256},    |                           |                  |
  |      audio[] }                |                           |                  |
  |                               |                           |                  |
  | if update == true:            |                           |                  |
  |-- GET /ota/firmware/<file>    |                           |                  |
  |   Authorization: Bearer <tok>──────────────────────────► |                  |
  |                                                           |─ auth_request ─► |
  |                                                           |    (internal)    |
  |<── 206 binary (range request) ─────────────────────────── |                  |
  |                               |                           |                  |
  | Verify CRC32                  |                           |                  |
  | Write to flash                |                           |                  |
  |-- POST /ota/report ─────────► |                           |                  |
  |   { deviceId, version,        |                           |                  |
  |     status: "applied" }       |                           |                  |
  | Reboot into new firmware      |                           |                  |
  |                               |                           |                  |
  | for each audio in manifest:   |                           |                  |
  |   if local sha256 != manifest |                           |                  |
  |-- GET /ota/audio/<file>       |                           |                  |
  |   Authorization: Bearer <tok>──────────────────────────► |                  |
  |<── 200 binary ──────────────────────────────────────────── |                  |
```

---

## Manifest Response Format

### Firmware manifest (`type: "firmware"`)

```json
{
  "type": "firmware",
  "modelId": "SF-100",
  "version": "1.2.0",
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

### Files manifest (`type: "files"`)

Used to push or delete arbitrary files on the device (audio, config, assets).

```json
{
  "type": "files",
  "modelId": "SF-100",
  "update": true,
  "reason": "Updated audio pack",
  "downloadToken": "...",
  "delaySeconds": 0,
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
- `update` — `true` = action required; `false` = no-op (draft or up to date).
- `downloadToken` — 64-hex Bearer token for all file downloads. Valid for the duration specified at manifest generation (default 30 days).
- `crc32` — 8-hex CRC32 (IEEE 802.3). **Primary integrity check on device** — fast to compute on embedded hardware.
- `sha256` — included for reference; use CRC32 for runtime verification.
- `files[].op` — `"put"` = download and store; `"delete"` = remove from device storage.
- `audio` — firmware manifests only; audio files to sync (same logic as `files` with implicit `op: put`).

---

## Persistent Storage on Teensy 4.1

The device must persist the following across reboots (use EEPROM or LittleFS on the onboard flash):

| Key              | Type    | Description                                           |
|------------------|---------|-------------------------------------------------------|
| `firmware_ver`   | string  | Currently running firmware version e.g. `"1.0.0"`    |
| `model_id`       | string  | Device model e.g. `"SF-100"`                          |
| `boot_counter`   | uint8   | Incremented before each reboot; cleared after success |
| `audio_sha_<id>` | string  | SHA256 of each locally stored audio file              |

**Boot counter pattern for rollback detection:**
- Increment counter in EEPROM before applying new firmware.
- On successful boot, reset counter to 0.
- If counter ≥ 3 at startup, the new firmware is failing to boot — fall back to previous image.

---

## Teensy 4.1 Code Examples

All examples use:
- **QNEthernet** for TCP/IP (native Ethernet on Teensy 4.1)
- **ArduinoJson** (v7) for JSON parsing
- **mbedTLS** (bundled with Teensyduino) for SHA256

### 1 — Manifest Fetch

```cpp
#include <QNEthernet.h>
#include <ArduinoJson.h>

using namespace qindesign::network;

// Fill these from EEPROM at startup
const char* MODEL_ID = "SF-100";
const char* FIRMWARE_VER = "1.0.0";

// Returns true if an update is available; fills token, firmwareUrl, firmwareCrc32, firmwareSize
bool fetchManifest(String& token, String& firmwareUrl, String& firmwareCrc32, uint32_t& firmwareSize) {
    EthernetClient client;
    const char* host = "apis.symphonyinteractive.ca";

    if (!client.connect(host, 80)) {
        Serial.println("[OTA] manifest connect failed");
        return false;
    }

    String path = String("/ota/manifest?modelId=") + MODEL_ID + "&firmwareVersion=" + FIRMWARE_VER;
    client.print(String("GET ") + path + " HTTP/1.1\r\n"
                 "Host: " + host + "\r\n"
                 "Connection: close\r\n\r\n");

    // Skip HTTP headers
    while (client.connected()) {
        String line = client.readStringUntil('\n');
        if (line == "\r") break;
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
        Serial.printf("[OTA] no update: %s\n", doc["reason"] | "");
        return false;
    }

    token          = doc["downloadToken"].as<String>();
    firmwareUrl    = doc["firmware"]["url"].as<String>();
    firmwareCrc32  = doc["firmware"]["crc32"].as<String>();  // 8-hex CRC32
    firmwareSize   = doc["firmware"]["size"].as<uint32_t>();
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

Teensy 4.1 uses the `imxrt_t4_self_flash` mechanism via the `Updater` or direct `FlexSPI` writes. The recommended approach is via the Teensyduino `InternalStorageT4` class (available in Teensyduino ≥ 1.57):

```cpp
#include <InternalStorageT4.h>

bool writeChunkToFlash(const uint8_t* data, size_t len, size_t offset) {
    if (offset == 0) {
        if (!InternalStorageT4.open(firmwareSize)) {
            Serial.println("[OTA] InternalStorageT4.open failed");
            return false;
        }
    }
    for (size_t i = 0; i < len; i++) {
        InternalStorageT4.write(data[i]);
    }
    return true;
}

void applyFirmwareUpdate() {
    InternalStorageT4.close();

    // Increment boot counter in EEPROM before rebooting
    uint8_t counter = EEPROM.read(BOOT_COUNTER_ADDR);
    EEPROM.write(BOOT_COUNTER_ADDR, counter + 1);

    Serial.println("[OTA] Rebooting to apply update...");
    delay(100);
    InternalStorageT4.apply();  // triggers reset into new firmware
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

OTA is triggered via the existing `$action` topic — no dedicated `$ota` subscriptions needed. The server publishes `act: frm` to a **group topic** (model-specific) or a **broadcast topic** (all devices). The device inspects the `mdl` field; if absent, the message is from a broadcast and the device acts unconditionally.

**Group push** (model-specific):

```json
{ "act": "frm", "mdl": "SF-100" }
```

Published to: `scout/$group/SF-100/$action`

**Broadcast push** (all devices, operator-initiated):

```json
{ "act": "frm" }
```

Published to: `scout/$broadcast/$action`

Subscribe to broadcast in `setupMqtt()`:

```cpp
mqttClient.subscribe("scout/$broadcast/$action");
```

**Device-side handler — add to your existing `$action` dispatch:**

```cpp
// Inside your MQTT message handler, after parsing act from JSON:

if (act == "frm") {
    const char* targetModel = doc["mdl"] | (const char*)nullptr;
    // No mdl field = broadcast; mdl field must match our model
    if (targetModel && strcmp(targetModel, MODEL_ID) != 0) {
        Serial.printf("[OTA] frm ignored — model mismatch (target=%s, ours=%s)\n",
                      targetModel, MODEL_ID);
        return;
    }
    Serial.println("[OTA] frm received — triggering manifest check");
    checkForUpdate();
    return;
}
```

**Full action dispatch sketch (showing frm alongside existing actions):**

```cpp
void onActionMessage(const String& payload) {
    StaticJsonDocument<512> doc;
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
        const char* mdl = doc["mdl"];
        if (mdl && strcmp(mdl, MODEL_ID) == 0) {
            Serial.println("[OTA] frm — starting manifest check");
            checkForUpdate();
        } else {
            Serial.printf("[OTA] frm ignored — model mismatch\n");
        }
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

// Load saved CRC32 for a file from EEPROM/LittleFS
String loadFileCrc(const String& id);
// Save updated CRC32 after successful download
void saveFileCrc(const String& id, const String& crc32);
// Write audio bytes to LittleFS or SDRAM buffer
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

A manifest with `type: "files"` contains a `files` array of `put` and `delete` operations. The device should process these after receiving a `frm` action and fetching the manifest.

```cpp
// Write/delete a general file on LittleFS
bool writeFileChunk(const String& id, const uint8_t* data, size_t len, size_t offset);
void deleteLocalFile(const String& id);

void syncFiles(const JsonArray& fileList, const String& token) {
    for (JsonObject item : fileList) {
        const char* op  = item["op"]  | "put";
        const char* id  = item["id"]  | "";

        if (strcmp(op, "delete") == 0) {
            deleteLocalFile(id);
            Serial.printf("[Files] deleted %s\n", id);
            continue;
        }

        // op == "put" — download and store
        String url   = item["url"].as<String>();
        String crc32 = item["crc32"].as<String>();
        uint32_t sz  = item["size"].as<uint32_t>();

        String localCrc = loadFileCrc(id);
        if (localCrc.equalsIgnoreCase(crc32)) {
            Serial.printf("[Files] %s up to date\n", id);
            continue;
        }

        Serial.printf("[Files] downloading %s\n", id);
        String computedCrc;
        bool ok = downloadFile(url, token, sz,
            [&](const uint8_t* data, size_t len, size_t offset) {
                return writeFileChunk(id, data, len, offset);
            },
            computedCrc);

        if (!ok || !computedCrc.equalsIgnoreCase(crc32)) {
            Serial.printf("[Files] %s %s\n", id, ok ? "CRC32 mismatch" : "download failed");
            continue;
        }

        saveFileCrc(id, crc32);
        Serial.printf("[Files] %s stored\n", id);
    }
}

// In checkForUpdate — dispatch on manifest type:
void processManifest(const JsonDocument& manifest, const String& token) {
    const char* type = manifest["type"] | "firmware";
    if (strcmp(type, "files") == 0) {
        syncFiles(manifest["files"].as<JsonArray>(), token);
    } else {
        // firmware type — handled by existing OTA flash flow
        // audio sync runs after firmware is applied
        syncAudio(manifest["audio"].as<JsonArray>(), token);
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

```cpp
#define BOOT_COUNTER_ADDR  0   // EEPROM byte address
#define ROLLBACK_THRESHOLD 3

void checkRollback() {
    uint8_t counter = EEPROM.read(BOOT_COUNTER_ADDR);
    if (counter >= ROLLBACK_THRESHOLD) {
        Serial.printf("[Boot] boot counter = %d — firmware may be bad, triggering rollback\n", counter);
        // TODO: implement rollback to previous firmware image
        // (requires dual-bank flash or a known-good fallback)
        EEPROM.write(BOOT_COUNTER_ADDR, 0);
        // For now: halt and alert
        while (true) { delay(1000); }
    }
}

void onSuccessfulBoot() {
    // Call this once network is connected and normal operation confirmed
    EEPROM.write(BOOT_COUNTER_ADDR, 0);
}
```

---

## MQTT Push vs Polling

**Preferred: MQTT push.** Devices respond to `act: frm` arriving on their existing `$action` subscriptions. No extra topics needed.

- Server publishes `{ act: "frm", mdl: "<modelId>" }` to the group or device `$action` topic
- Device checks `mdl` field matches its own model, then calls `checkForUpdate()`
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

// Persistent config stored in EEPROM/LittleFS
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
