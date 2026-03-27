# Signalfi OTA & Media Sync — Firmware Implementation Guide

**Audience:** IoT firmware developer or AI coding agent implementing OTA firmware updates and audio file synchronisation for a Signalfi device.  
**Platform:** Teensy 4.1 (IMXRT1062) with Ethernet (QNEthernet library)

---

## Overview

The Signalfi update system uses a two-phase HTTP flow:

1. **Manifest fetch** — device asks a public API whether an update is available for its model and current firmware version.
2. **Authenticated download** — if an update is available, the device uses a `downloadToken` from the manifest to authenticate firmware and audio file downloads.

The manifest endpoint requires no credentials. File downloads require a valid token passed as a query parameter.

---

## Endpoints

| Purpose            | URL                                                                           | Auth |
|--------------------|-------------------------------------------------------------------------------|------|
| Manifest API       | `http://apis.symphonyinteractive.ca/ota/v1/manifest`                          | None |
| Firmware download  | `http://apis.symphonyinteractive.ca/ota/v1/firmware/<filename>`               | Bearer token |
| Audio download     | `http://apis.symphonyinteractive.ca/ota/v1/audio/<filename>`                  | Bearer token |
| Model config       | `http://apis.symphonyinteractive.ca/ota/v1/config/models/<modelId>.json`      | Bearer token |
| Device config      | `http://apis.symphonyinteractive.ca/ota/v1/config/devices/<mac>.json`         | Bearer token |
| Update report      | `http://apis.symphonyinteractive.ca/ota/v1/report`                            | None |
| Manifest health    | `http://apis.symphonyinteractive.ca/ota/v1/health`                            | None |
| File server health | `http://apis.symphonyinteractive.ca/ota/health`                               | None |
| OTA MQTT topic     | `scout/$group/<modelId>/$ota` on `apis.symphonyinteractive.ca:1883`           | Password |
| Config MQTT topic  | `scout/$group/<modelId>/$config` on `apis.symphonyinteractive.ca:1883`        | Password |

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
  | subscribe scout/$group/<modelId>/$ota────────────────────────────────────────────► |
  |                               |                           |                  |
  | ── on MQTT msg OR startup ─────────────────────────────────────────────────►|
  |-- GET /ota/v1/manifest        |                           |                  |
  |     ?modelId=&firmwareVersion=|                           |                  |
  |                          ---> |                           |                  |
  |<-- 200 JSON manifest ---------|                           |                  |
  |    { update, downloadToken,   |                           |                  |
  |      firmware{url,sha256},    |                           |                  |
  |      audio[] }                |                           |                  |
  |                               |                           |                  |
  | if update == true:            |                           |                  |
  |-- GET /ota/v1/firmware/<file> |                           |                  |
  |   Authorization: Bearer <tok>──────────────────────────► |                  |
  |                                                           |─ auth_request ─► |
  |                                                           |    (internal)    |
  |<── 206 binary (range request) ─────────────────────────── |                  |
  |                               |                           |                  |
  | Verify SHA256                 |                           |                  |
  | Write to flash                |                           |                  |
  |-- POST /ota/v1/report ──────► |                           |                  |
  |   { deviceId, version,        |                           |                  |
  |     status: "applied" }       |                           |                  |
  | Reboot into new firmware      |                           |                  |
  |                               |                           |                  |
  | for each audio in manifest:   |                           |                  |
  |   if local sha256 != manifest |                           |                  |
  |-- GET /ota/v1/audio/<file>    |                           |                  |
  |   Authorization: Bearer <tok>──────────────────────────► |                  |
  |<── 200 binary ──────────────────────────────────────────── |                  |
```

---

## Manifest Response Format

```json
{
  "modelId": "SF-100",
  "version": "1.1.0",
  "update": true,
  "reason": "New firmware available",
  "compatibleFrom": [],
  "downloadToken": "63a54ebcc465b17ecd60798efbbda47efc695d30088e002fbf6a26fed5f7b3d1",
  "firmware": {
    "url": "http://apis.symphonyinteractive.ca/ota/v1/firmware/firmware-1.1.0.bin",
    "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "size": 524288
  },
  "audio": [
    {
      "id": "audio-pack-1",
      "url": "http://apis.symphonyinteractive.ca/ota/v1/audio/audio-pack-1.wav",
      "sha256": "a3b1d5...",
      "size": 102400
    }
  ]
}
```

**Fields:**
- `update` — `true` = firmware update available; `false` = no action needed.
- `compatibleFrom` — if non-empty, the device's current `firmwareVersion` must be in this list to receive the update. Empty array = all versions eligible.
- `downloadToken` — 64-hex string; pass as `?token=<value>` on all file downloads.
- `audio` — array of audio files to sync. Empty array = no audio changes.
- When `update: false`, the response contains no `firmware` or `downloadToken` fields.

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

// Returns true if an update is available; fills token, firmwareUrl, firmwareSha256
bool fetchManifest(String& token, String& firmwareUrl, String& firmwareSha256, uint32_t& firmwareSize) {
    EthernetClient client;
    const char* host = "apis.symphonyinteractive.ca";

    if (!client.connect(host, 80)) {
        Serial.println("[OTA] manifest connect failed");
        return false;
    }

    String path = String("/ota/v1/manifest?modelId=") + MODEL_ID + "&firmwareVersion=" + FIRMWARE_VER;
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

    token        = doc["downloadToken"].as<String>();
    firmwareUrl  = doc["firmware"]["url"].as<String>();
    firmwareSha256 = doc["firmware"]["sha256"].as<String>();
    firmwareSize = doc["firmware"]["size"].as<uint32_t>();
    return true;
}
```

### 2 — Chunked Firmware Download with Range Requests

The file server supports `Accept-Ranges: bytes`. Use range requests to download in chunks to avoid running out of RAM on large firmware images.

```cpp
#include <mbedtls/sha256.h>

// Downloads url using Authorization: Bearer <token> header, in CHUNK_SIZE chunks.
// Writes each chunk via writeChunk callback. Returns true on success.
// After download, sha256Out is populated with the hex digest.
bool downloadFile(const String& url, const String& token,
                  uint32_t totalSize,
                  std::function<bool(const uint8_t*, size_t, size_t offset)> writeChunk,
                  String& sha256Out) {

    const size_t CHUNK_SIZE = 8192;  // 8 KB — tune to available RAM
    const char* host = "apis.symphonyinteractive.ca";

    mbedtls_sha256_context sha;
    mbedtls_sha256_init(&sha);
    mbedtls_sha256_starts(&sha, 0);  // 0 = SHA256 (not SHA224)

    uint32_t offset = 0;
    while (offset < totalSize) {
        uint32_t end = min((uint32_t)(offset + CHUNK_SIZE - 1), totalSize - 1);

        EthernetClient client;
        if (!client.connect(host, 80)) {
            Serial.println("[OTA] file connect failed");
            mbedtls_sha256_free(&sha);
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
            if (line.startsWith("HTTP/")) {
                httpStatus = line.substring(9, 12).toInt();
            }
            if (line == "\r") break;
        }

        if (httpStatus != 206 && httpStatus != 200) {
            Serial.printf("[OTA] HTTP %d on range %u-%u\n", httpStatus, offset, end);
            client.stop();
            mbedtls_sha256_free(&sha);
            return false;
        }

        // Read chunk
        uint8_t buf[512];
        size_t chunkOffset = 0;
        while (client.connected() || client.available()) {
            int n = client.read(buf, sizeof(buf));
            if (n <= 0) { delay(1); continue; }

            mbedtls_sha256_update(&sha, buf, n);

            if (!writeChunk(buf, n, offset + chunkOffset)) {
                Serial.println("[OTA] writeChunk failed — aborting");
                client.stop();
                mbedtls_sha256_free(&sha);
                return false;
            }
            chunkOffset += n;
        }
        client.stop();
        offset += chunkOffset;

        Serial.printf("[OTA] downloaded %u / %u bytes\n", offset, totalSize);
    }

    // Finalise SHA256
    uint8_t hash[32];
    mbedtls_sha256_finish(&sha, hash);
    mbedtls_sha256_free(&sha);

    sha256Out = "";
    for (int i = 0; i < 32; i++) {
        char hex[3];
        snprintf(hex, sizeof(hex), "%02x", hash[i]);
        sha256Out += hex;
    }
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
    String token, firmwareUrl, firmwareSha256;
    uint32_t firmwareSize;

    if (!fetchManifest(token, firmwareUrl, firmwareSha256, firmwareSize)) {
        return;  // no update or network error
    }

    Serial.println("[OTA] Update available — downloading firmware");

    String computedSha;
    bool ok = downloadFile(firmwareUrl, token, firmwareSize,
        [](const uint8_t* data, size_t len, size_t offset) {
            return writeChunkToFlash(data, len, offset);
        },
        computedSha);

    if (!ok) {
        Serial.println("[OTA] Download failed");
        return;
    }

    if (!computedSha.equalsIgnoreCase(firmwareSha256)) {
        Serial.printf("[OTA] SHA256 mismatch!\n  expected: %s\n  got:      %s\n",
                      firmwareSha256.c_str(), computedSha.c_str());
        return;
    }

    Serial.println("[OTA] SHA256 verified — applying update");
    applyFirmwareUpdate();  // does not return — device reboots
}
```

### 5 — MQTT Push Subscription

Devices subscribe to `scout/$group/<modelId>/$ota` on startup. When the server publishes a new manifest, devices receive an immediate push and trigger a manifest check — no polling required.

```cpp
#include <QNEthernetMqtt.h>  // or use a PubSubClient-style MQTT library

// MQTT broker credentials
const char* MQTT_HOST = "apis.symphonyinteractive.ca";
const int   MQTT_PORT = 1883;
const char* MQTT_USER = "symphony";
const char* MQTT_PASS = "Si9057274427";

// Callback invoked when a message arrives on scout/$group/<modelId>/$ota
void onOtaNotification(const String& payload) {
    Serial.printf("[MQTT] OTA notification received: %s\n", payload.c_str());
    // Trigger an immediate manifest check
    checkForUpdate();
}

void setupMqtt(MqttClient& mqttClient) {
    mqttClient.setUsernamePassword(MQTT_USER, MQTT_PASS);
    if (!mqttClient.connect(MQTT_HOST, MQTT_PORT)) {
        Serial.printf("[MQTT] connect failed: %d\n", mqttClient.connectError());
        return;
    }
    // Model-specific OTA (primary — server publishes here on manifest update)
    String groupTopic = String("scout/$group/") + MODEL_ID + "/$ota";
    mqttClient.subscribe(groupTopic);
    // Broadcast OTA (all models — future mass-update support)
    mqttClient.subscribe("scout/$broadcast/$ota");
    // Individual device OTA (MAC-targeted — future)
    String macTopic = String("scout/") + DEVICE_MAC + "/$ota";
    mqttClient.subscribe(macTopic);
    Serial.printf("[MQTT] subscribed to group, broadcast, device topics\n");
}

void loopMqtt(MqttClient& mqttClient) {
    mqttClient.poll();
    if (mqttClient.available()) {
        String topic = mqttClient.messageTopic();
        String payload = mqttClient.readString();
        if (topic.endsWith("/$ota")) {
            onOtaNotification(payload);
        }
    }
}
```

> On first connect, the broker replays the last retained message immediately. This means if a firmware update was published while the device was offline, it will be notified as soon as it subscribes — no polling needed to catch up.

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

    client.printf("POST /ota/v1/report HTTP/1.1\r\nHost: %s\r\n"
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
    String sha256;
    uint32_t size;
};

// Load saved SHA256 for an audio file from EEPROM/LittleFS
String loadAudioSha(const String& id);
// Save updated SHA256 after successful download
void saveAudioSha(const String& id, const String& sha256);
// Write audio bytes to LittleFS or SDRAM buffer
bool writeAudioChunk(const uint8_t* data, size_t len, size_t offset);

void syncAudio(const JsonArray& audioList, const String& token) {
    for (JsonObject item : audioList) {
        AudioFile af;
        af.id     = item["id"].as<String>();
        af.url    = item["url"].as<String>();
        af.sha256 = item["sha256"].as<String>();
        af.size   = item["size"].as<uint32_t>();

        String localSha = loadAudioSha(af.id);
        if (localSha.equalsIgnoreCase(af.sha256)) {
            Serial.printf("[Audio] %s up to date\n", af.id.c_str());
            continue;
        }

        Serial.printf("[Audio] downloading %s\n", af.id.c_str());
        String computedSha;
        bool ok = downloadFile(af.url, token, af.size,
            [](const uint8_t* data, size_t len, size_t offset) {
                return writeAudioChunk(data, len, offset);
            },
            computedSha);

        if (!ok) {
            Serial.printf("[Audio] %s download failed\n", af.id.c_str());
            continue;
        }

        if (!computedSha.equalsIgnoreCase(af.sha256)) {
            Serial.printf("[Audio] %s SHA256 mismatch\n", af.id.c_str());
            continue;
        }

        saveAudioSha(af.id, af.sha256);
        Serial.printf("[Audio] %s synced\n", af.id.c_str());
    }
}
```

### 6 — Retry / Backoff

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
    String token, url, sha;
    uint32_t size;
    return fetchManifest(token, url, sha, size);
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

**Preferred: MQTT push.** Devices subscribe to `scout/$group/<modelId>/$ota` and respond to push notifications. No polling timer needed.

- Subscribe on startup → receive retained message if update was published while offline
- React immediately to push → no delay waiting for a poll window
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
| SHA256 mismatch after download   | Discard download, log error, do not apply           |
| Flash write failure              | Log error, do not reboot                            |
| Boot counter ≥ threshold         | Rollback or halt                                    |
| Audio download fails             | Skip that file, continue with others                |

---

## Config Update Agent

Devices receive config pushes via MQTT — same mechanism as OTA but on the `$config` action topic. The server manages two config tiers: a **model config** (shared settings) and a **device config** (per-device overrides). The device merges both: model config first, device overrides on top.

### MQTT subscriptions for config

Add these to your `setupMqtt()` alongside the `$ota` subscriptions:
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
} else if (topic.endsWith("/$ota")) {
    onOtaNotification(payload);
}
```

### Config notification payload

```json
{
  "type": "model",
  "modelId": "SF-100",
  "url": "http://apis.symphonyinteractive.ca/ota/v1/config/models/SF-100.json",
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

## HTTPS Migration (Future)

When the server upgrades to HTTPS, only the URL prefix changes — token auth and all other logic stays identical:

1. Change manifest URL: `http://apis.symphonyinteractive.ca` → `https://apis.symphonyinteractive.ca`
2. Change firmware/audio download base URL to `https://`
3. Ensure QNEthernet + mbedTLS TLS client is initialised with the correct CA cert (Let's Encrypt ISRG Root X1) or use `client.setInsecure()` for initial testing

No token, MQTT, or report changes required.
