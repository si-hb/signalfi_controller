# SignalFi — Node-RED Flow Documentation

## Overview

SignalFi is a professional AV and building-automation control system built in Node-RED. It manages a network of distributed IoT audio/visual announcement devices called **Signalfi devices** — small embedded units that play audio files, drive RGB LED rings, and respond to remote commands over MQTT. The system connects to a cloud MQTT broker at `apis.symphonyinteractive.ca` and maintains a live registry of all online Signalfi devices, their network details, and their logical grouping into a **node tree** (a hierarchical path structure such as `zone/floor/room`). Operators use a Node-RED Dashboard to trigger audio announcements and LED patterns either to individual Signalfi devices, to named node groups, or as a broadcast to every reachable device simultaneously.

---

## Functional Areas

### 1. Signalfi device Discovery and Presence Tracking

Signalfi devices publish their state to the MQTT topic `scout/<MAC>/$state` whenever their status changes. The flow subscribes to `scout/+/$state` and processes every incoming message through the **Track Signalfi devices** function node, which maintains a persistent global array (`scouts[]`) stored to disk. Each entry records the Signalfi device's MAC address, IP address, firmware version, subnet, gateway, DHCP flag, USB/FTP status, OLED brightness level, node assignment, and current operational status.

Statuses tracked: `online`, `offline`, `idle`, `announce`, `identifying`, `rebooting`, `going offline`, `connecting to server`, `downloading firmware`, `flashing firmware`, `pulling firmware`.

When the MQTT broker connection is established, the flow broadcasts `{"act":"get"}` to `scout/$broadcast/$action` to request a fresh status report from all Signalfi devices.

### 2. Node Tree Management

Signalfi devices report a **node** path (e.g. `lobby/main` or `floor2/conf-a`). The **Update node list** function builds a hierarchical node registry (`nodes[]`) by decomposing each Signalfi device's node path into its constituent segments, creating parent nodes as required. Each node entry tracks its index, member count (number of Signalfi devices whose path begins with that node), and a real-time count of how many Signalfi devices are currently announcing on it. The node list is sorted alphabetically, renumbered, and published to the dashboard.

### 3. Announcement Control

The central control plane. An announcement consists of several parameters that are saved into the global `scout` object (persisted to disk):

| Parameter | Type | Range / Options |
|---|---|---|
| Audio file | Dropdown | ~17 `.wav` files |
| Volume | Slider | 0.0 – 1.0 (logistic S-curve applied on device) |
| Audio repeat | Slider | 0 – 10 |
| LED colour | Colour picker + dropdown | Hex RGB |
| LED pattern | Dropdown | 0–12 (Off, Solid, Blink, Rotate, Pulse, Flash, Wave Outwards, Wave Inwards, Audio Follow, Left, Right, Up, Down) |
| LED brightness | Slider | 0 – 255 |
| Timeout (duration) | Slider | 0 – 100 seconds |

These parameters are sent immediately to Signalfi devices as individual MQTT commands when changed, and are combined into a single `ply` (play) command when **ANNOUNCE** is pressed.

**Announcement destinations** — one of three modes, stored in flow context:

- **Node** — all Signalfi devices registered under a specific node path, via topic `scout/$group/<node>/$action`
- **Broadcast** — every Signalfi device, via topic `scout/$broadcast/$action`
- **Selected Signalfi devices** — only individually checked Signalfi devices, via their MAC-addressed topics `scout/<MAC>/$action`

### 4. Preset Management

Named presets capture the full set of announcement parameters (audio, pattern, colour, duration, volume, repeat, brightness) and are stored persistently to disk (`presets[]`). Operators can:

- **Save** the current settings as a new named preset (prompted dialog)
- **Recall** a preset from a dropdown (restores all UI controls)
- **Delete** a selected preset (with confirmation dialog)
- **Trigger** a preset directly to a selected node (one-click announce)

### 5. Test and Calibration

A dedicated group of controls for audio/LED testing:

- **Tone** — plays a sine-wave tone at a configurable frequency via `{"act":"cal","sig":"tone","frq":<Hz>}`. A musical-note slider converts semitone values (0–76, A110 scale) to Hz and displays the note name.
- **Tone Freq slider** — direct frequency entry (200–10,000 Hz in 100 Hz steps).
- **Pink noise** — plays pink noise via `{"act":"cal","sig":"pink"}`.
- **Sweep** — plays a frequency sweep audio file (`sweep.wav`).
- **Store Volume** — writes the current volume setting persistently to all Signalfi devices in the current announce destination via `{"act":"vrt","vol":<value>}`.

### 6. Node Configuration (Tab 2)

Provides management of the node tree and preset library separate from live control:

- **Node list** — selectable list of all known nodes with index numbers and member counts; supports mutually exclusive selection.
- **Node summary table** — tabular view showing node index, name, member count, and busy (announcing) count.
- **Node Announce Presets group** — trigger or stop a preset on the currently selected node.
- **Reset and refresh** — clears orphan nodes from the registry and renumerates all nodes.

### 7. Signalfi device Details (Tab 3)

#### Checkup group
- **Broker LED indicator** — glows yellow when MQTT broker is connected, red when disconnected.
- **Identify switch** — when enabled, clicking any row in the summary table causes that Signalfi device to play a distinctive chime sequence (`chime01.wav`, white, pattern 4 / Ladder, 1 second) for physical identification.

#### Status table
A full-width data table showing all tracked Signalfi devices sorted first by status priority (identifying → announcing → transitional → idle → online → offline) then by IP address. Columns: IP, Status, Version, MAC, Subnet, Gateway, DHCP, Node, USB, FTP, OLED Level.

Clicking a row selects the device (highlighted in a separate detail card on Tab 1) and updates the Signalfi device list's checked state.

### 8. Signalfi device-Specific Operations (Tab 1 — Control group)

Buttons that send commands to the currently targeted Signalfi device(s):

| Button | MQTT Action |
|---|---|
| ANNOUNCE | `{"act":"ply", ...all params}` |
| STOP | `{"act":"stp"}` |
| ACKNOWLEDGE | `{"act":"ack"}` |
| REFRESH | `{"act":"get"}` broadcast |
| FIRMWARE UPDATE | `{"act":"upd"}` — pull OTA firmware |
| SD FIRMWARE UPDATE | `{"act":"fls"}` — flash from SD card (disabled in UI) |
| REBOOT | `{"act":"rbt"}` |

### 9. Announce Node Configuration (Tab 1)

Allows the operator to type and validate a node path that Signalfi devices should be configured to listen on. The path is validated against a regex (`^[a-z0-9][a-z0-9\/.\-]*[a-z0-9]$`) before being sent to selected Signalfi devices via `{"act":"nod","nod":"<path>"}`.

### 10. File Upload / Pull (Tab 1)

A text input for a filename and an UPLOAD FILE button that sends `{"act":"fle","file":"<filename>"}` to pull a file from the server to the Signalfi device's storage.

---

## Data Sources and Protocols

### MQTT

**Broker:** `apis.symphonyinteractive.ca:1883` (unencrypted, MQTT v3.1.1)

| Direction | Topic Pattern | Purpose |
|---|---|---|
| Subscribe | `scout/+/$state` | Signalfi device status updates |
| Subscribe | `scout/+/$msg` | Signalfi device debug/log messages |
| Publish | `scout/$broadcast/$action` | Commands to all Signalfi devices |
| Publish | `scout/$group/<node>/$action` | Commands to all Signalfi devices on a node |
| Publish | `scout/<MAC>/$action` | Command to one specific Signalfi device |

#### Inbound State Message Fields (`$state`)

```json
{
  "status": "online|offline|idle|announce|...",
  "ip": "192.168.x.x",
  "ver": "1.2.3",
  "mask": "255.255.255.0",
  "gate": "192.168.x.1",
  "dhcp": true,
  "usb": false,
  "ftp": false
}
```

Also carries `key_press` events (type: `ascii`/`control`, key: character or `DEL`/`BACK`/`ENTER`) and `act`/`sta` play-status updates.

#### Outbound Action Message Fields (`$action`)

| act | Description | Additional Fields |
|---|---|---|
| `ply` | Play announcement | `aud`, `rpt`, `clr`, `pat`, `dur`, `vol`, `brt` |
| `stp` | Stop playback | — |
| `ack` | Acknowledge | — |
| `col` | Set LED colour | `clr` (hex string) |
| `pat` | Set LED pattern | `pat` (0–12) |
| `brt` | Set LED brightness | `brt` (0–255) |
| `volOut` | Set volume | `vol` (0.0–1.0) |
| `vrt` | Store volume persistently | `vol` |
| `cal` | Calibration signal | `sig` (`tone`/`pink`), `frq` (Hz) |
| `rbt` | Reboot | — |
| `upd` | Pull OTA firmware | — |
| `fls` | Flash from SD card | — |
| `fle` | Pull file | `file` (filename) |
| `get` | Request status report | — |
| `nod` | Set node path | `nod` (path string) |
| `dir` | List files | — |

---

## Key Logic

### Volume Curve

Volume is stored as a linear value [0, 1] but a logistic S-curve is applied before transmission:

```
y = 1 / (1 + e^(-k*(x-m)))
```

with steepness `k=6` and midpoint `m=0.75`. This produces fine-grained control in the low-to-mid range and rapid increase near the top, simulating a natural-feeling potentiometer taper.

### Broadcast Destination Routing

The **Broadcast, Node or Signalfi device** function applies a three-level precedence:
1. If `msg.topic == "node"` → route to a single named node group
2. If `announce == 1` (Broadcast mode) → publish to `scout/$broadcast/$action`
3. If `announce == 0` (Node mode) → publish to `scout/$group/<announce_node>/$action`
4. If `announce == 2` (Selected Signalfi devices) → iterate checked Signalfi devices and publish individually

### Signalfi device Presence State Machine

Signalfi devices are tracked across reconnects. On receiving a status message:
- If status is `offline` or `rebooting`, the Signalfi device entry is removed and re-added (full state reset)
- If status changes from `offline` → anything, the entry is also refreshed
- Otherwise only the `status` field is updated in-place

### Node Tree Auto-Discovery

When a Signalfi device reports a node path like `floor2/wing-b/room3`, the system automatically creates three entries: `floor2`, `floor2/wing-b`, and `floor2/wing-b/room3` if any are missing. The `members` count for each entry is computed by counting all Signalfi devices whose node path begins with that prefix.

### Round-Trip Time Measurement

Each broadcast send records a timestamp in `global.sentTimestamp`; the Track Signalfi devices function computes the round-trip time when a reply arrives and updates `global.longestTime` if a new record is set (logged to the debug sidebar).

---

## Current UI

The Node-RED Dashboard uses a dark theme (background `#111111`, accent `#097479`, teal-green widget colour) with three tabs.

### Tab 1 — Signalfi device Control & Configure

| Group | Widgets |
|---|---|
| **Target Device(s)** | Checked list of online Signalfi devices (IP + node description); Announcement destination selector (Node / Broadcast / Selected Signalfi devices) |
| **Control** | ANNOUNCE button; STOP button; ACKNOWLEDGE button; REFRESH button; Short status table (IP + status); Selected device detail card; FIRMWARE UPDATE; REBOOT |
| **LEDs** | Colour picker; Colour dropdown (Red/Orange/Blue/Green/Lt Blue/White); Brightness slider (0–255); Pattern dropdown (13 options); Timeout slider (0–100 s) |
| **Audio** | Audio file dropdown (~17 files); Volume slider (0–1); Store Volume button; Audio Repeat slider (0–10) |
| **Test & Calibration** | Tone Note slider (semitones); Note name display; Frequency display; Tone Freq slider (200–10000 Hz); TONE button; PINK button; SWEEP button |
| **Announce Node Configuration** | Node path text input; Validation status text; SEND NODE TO Selected Signalfi devices button |
| **Announcement Presets** | Save New Preset button; Recall Preset dropdown; Delete Selected button |
| **File Upload** | Filename text input; UPLOAD FILE button |

### Tab 2 — Node Configure

| Group | Widgets |
|---|---|
| **Nodes** | Reset and refresh button; Nodes selectable list (node path + index) |
| **Node Announce Presets** | Announce to Selected Node button; STOP Selected Node button; Presets selectable list |
| **Node Summary** | Table: #, Node, Members, Busy |

### Tab 3 — Signalfi device Details

| Group | Widgets |
|---|---|
| **Checkup** | Broker LED indicator; Identify toggle switch |
| **Status** | Full Signalfi device details table (IP, Status, Version, MAC, Subnet, Gateway, DHCP, Node, USB, FTP, OLED Level) |

---

## Glossary

| Term | Meaning |
|---|---|
| **Signalfi** | An embedded IoT device that plays audio and drives an RGB LED ring. Manufactured by Symphony Interactive. |
| **Node** | A logical address path (e.g. `lobby/east`) that groups Signalfi devices for zone-based announcing. Not a Node.js concept. |
| **Broker** | The MQTT message broker at `apis.symphonyinteractive.ca` that relays all messages between the server and Signalfi devices. |
| **ply** | The MQTT action code for "play" — triggers an announcement on a Signalfi device. |
| **stp** | The MQTT action code for "stop". |
| **ack** | The MQTT action code for "acknowledge" — clears an active announcement. |
| **rbt** | The MQTT action code for "reboot". |
| **upd** | The MQTT action code for OTA firmware update (pull from server). |
| **fls** | The MQTT action code for SD card firmware flash. |
| **vrt** | The MQTT action code for storing volume persistently on the Signalfi device. |
| **cal** | The MQTT action code for calibration signal (tone/pink noise). |
| **nod** | The MQTT action code for setting a Signalfi device's node path. |
| **get** | The MQTT action code for requesting a Signalfi device's full status. |
| **MAC** | Media Access Control address — used as the unique Signalfi device identifier in MQTT topics. |
| **Preset** | A saved combination of audio file, volume, LED colour, pattern, brightness, repeat count, and timeout. |
| **Symphony Interactive** | The company that manufactures Signalfi devices and operates the cloud MQTT broker. |
| **OLED** | An organic LED display on some Signalfi hardware variants, with a configurable brightness level. |

---

## SignalFi Web Application

The web application is a complete replacement for the Node-RED dashboard. It is a responsive, mobile-first control panel that runs in any modern browser and communicates with the same MQTT broker via a Node.js/Express backend.

**Primary use case:** a phone in portrait orientation held by an AV technician walking a venue.

---

## Running the Server

```bash
npm install
node server/server.js
```

The server defaults to `http://0.0.0.0:3000`. Configuration is via `config.json` or environment variables.

### `config.json` options

```json
{
  "mqtt": {
    "host": "apis.symphonyinteractive.ca",
    "port": 1883,
    "username": "",
    "password": "",
    "tls": false,
    "clientId": "signalfi-web",
    "topicPrefix": "scout"
  },
  "http": {
    "host": "0.0.0.0",
    "port": 3000,
    "staticDir": "./public"
  },
  "paths": {
    "dataDir": "./data",
    "firmwareDir": "./firmware",
    "audioDir": "./audio"
  },
  "auth": {
    "token": ""
  }
}
```

Set `auth.token` to enable Bearer-token authentication on all REST and WebSocket endpoints. Leave blank to disable auth.

---

## File Server & Audio Storage

Audio files, firmware, and device configuration are served by a separate HTTPS file server stack (`https_file_server/`) running alongside the main app. Both stacks share host directories on the production server.

| Content | Host path | Served at | Managed via |
| --- | --- | --- | --- |
| Audio files | `/opt/signalfi/files/audio/` | `/ota/v1/audio/<file>` | sftpgo SFTP (virtual path `/audio`) |
| Firmware | `/opt/signalfi/files/firmware/` | `/ota/v1/firmware/<file>` | sftpgo SFTP (virtual path `/firmware`) |
| Device configs | `/opt/signalfi/configs/` | `/ota/v1/config/<file>` | sftpgo SFTP |
| Firmware manifests | `/opt/signalfi/manifests/` | `/ota/v1/manifest?modelId=<id>` | manifest service |

The signalfi-web container mounts `/opt/signalfi/files/audio` at `/app/audio` (read-only) so the audio file list in the UI always reflects whatever is currently on disk. The server watches this directory and broadcasts an updated file list to all connected clients whenever files are added or removed — no page refresh required.

See [`https_file_server/README.md`](https_file_server/README.md) for full infrastructure details including token management, SFTP access, and MQTT OTA notifications.

---

## Architecture

| Layer | Technology |
|---|---|
| Backend | Node.js, Express, `ws` WebSocket library, `mqtt` client |
| Frontend | Vanilla JS ES modules — no build step, no framework |
| Real-time | WebSocket (`/ws`) — server pushes `state`, `scoutUpdate`, `nodeUpdate`, `mqttStatus` messages |
| Persistence | JSON files in `./data/` (`scouts.json`, `presets.json`, `nodes.json`, `settings.json`) |
| REST API | `GET /api/state`, `POST/DELETE /api/presets`, `GET /api/audio` |

### Frontend file structure

```
public/
  index.html
  js/
    app.js              — entry point, WebSocket, sheet management, selection logic
    ws.js               — WebSocket connection and message dispatch
    api.js              — REST calls (presets, audio, state fetch)
    utils.js            — throttle, audio-taper math, dB helpers, theme
    views/
      devices.js        — device accordion/card rendering, search, view-mode
      settings.js       — settings view (presets, calibration, store volume, node, file)
      info.js           — info view (device inventory table)
    sheets/
      lighting.js       — Scene configuration sheet (Color / Patterns / Sound tabs)
      presets.js        — Presets sheet (save, recall, delete, rename)
      device.js         — Device info sheet, identifying queue
      sound.js          — Sound state module
  css/
    layout.css          — app shell, navigation, views
    cards.css           — device cards and accordion rows
    sheets.css          — bottom sheet component and all sheet-specific styles
    components.css      — shared UI components (sliders, toggles, swatches, buttons)
```

---

## Feature Reference

### Device View

Devices are displayed in an **accordion tree** organised by node path. Each level of the path hierarchy is a collapsible group; devices with no node path appear in an "Unorganized" section at the bottom.

**View modes** — toggle between card grid (2–5 columns depending on viewport) and list mode via the icon in the top bar.

**Search** — live filter across device name, MAC address, and node path.

**Selection** — tap a card to select / deselect it. Tap the group checkbox in an accordion header to select / deselect all devices in that group. The **Select All** button enters *broadcast mode* — all devices are targeted and the MQTT broadcast topic is used regardless of individual selection state. Tapping any device while in broadcast mode exits broadcast mode, selecting all other online devices. Deselecting a group while in broadcast mode exits broadcast mode, selecting all devices not in that group.

**Destination priority** — when an action is sent, the server resolves the MQTT topic using this precedence:

1. Broadcast — if broadcast mode is active, or if the selected set equals all online devices.
2. Group path — if the selected set exactly matches all online devices under a single node path.
3. Individual MACs — one MQTT message per selected device.

**Device cards** — each card shows the SignalFi SVG icon (animated during announce), device name or node leaf, MAC address, and status badge. An **ⓘ** button opens the Device Info sheet.

**Pull-to-refresh** — pull down in the device list to trigger a `get` broadcast to all devices.

### Action Bar

Three persistent buttons at the bottom of the screen:

| Button | Action |
|---|---|
| **🎛️ Scene** | Opens the Scene configuration sheet |
| **Announce** | Sends `announce` with current scene settings to the current selection |
| **Stop** | Sends `stop` to the current selection |

When multiple devices are selected the Announce button sends a single MQTT message to the appropriate broadcast or group topic rather than individual per-device messages.

### Scene Sheet

A three-tab bottom sheet for configuring an announcement. Opens full-screen on mobile.

The header shows the title "Scene", a device count subtitle ("*N* Device(s) Selected" / "All Devices Selected"), a **♡ Presets** icon button, and a close button.

#### Color tab

- **9 colour swatches** — White, Red, Scarlet, Orange, Green, Emerald, Blue, Cobalt, Cyan. Swatches are labelled with their exact hex values; the named colours (Scarlet, Emerald, Cobalt) are distinct from the pure primaries.
- **Custom colour** — native colour picker plus a free-text hex input.
- **Brightness** — slider 0–255.

#### Patterns tab

13 LED patterns with icon and name: Off, Solid, Blink, Rotate, Pulse, Flash, Wave Out, Wave In, Audio, Left, Right, Up, Down.

#### Sound tab

- **Audio file list** — scrollable list of `.wav` files available on the server. Select "None (LEDs only)" to omit audio from the announcement.
- **Volume** — audio-taper slider (A-type logarithmic curve) with a dB readout. The value can be typed directly into the dB input field; Enter commits, Escape cancels.
- **Loops** — stepper (0–10).

Volume and Loops controls are visually dimmed and disabled when no audio file is selected.

#### Timeout

Shared across Color and Patterns tabs (hidden on Sound tab). Range 0–300 seconds. A value of 0 displays **∞** (no timeout).

#### Footer

**Announce** (primary action) and **Stop** buttons.

### Presets Sheet

Accessible from the ♡ button in the Scene header, or as a standalone sheet from the Settings view.

When opened from the Scene sheet the Scene page remains visible and dimmed underneath (modal stack). Closing the Presets sheet returns to the Scene sheet.

- **Save** — enter a name and save the current Color, Patterns, Sound, and Timeout settings as a preset.
- **Live Announce on Tap** — when enabled, tapping a preset immediately sends an `announce` command (without volume, so devices use their stored default). When disabled, tapping a preset loads its settings into the Scene sheet.
- **Preset list** — tap to load, ✏️ to rename inline, 🗑 to delete.
- **Stop** button — stops playback on the current selection and clears the active preset highlight.

### Device Info Sheet

Opened via the **ⓘ** button on a device card. Displays:

- Device name (node path leaf or MAC), MAC address, IP address, firmware version, node path, subnet, gateway, DHCP status, USB/FTP status.
- **Acknowledge** — clears an active announcement.
- **Reboot** — reboots the device (with confirmation).
- **OTA Update** — triggers firmware pull (with confirmation).
- **Identifying queue** — if multiple devices enter *identifying* state simultaneously, they are queued. The sheet shows one at a time with a banner ("Device is Identifying — *N* more pending"). Dismissing the current device (acknowledge or close) advances to the next.

### Settings View

Accessed via the gear icon in the top bar.

#### Appearance

Dark / Light theme toggle (persisted to `localStorage`).

#### Presets

Full preset list with ✏️ rename and 🗑 delete actions.

#### Calibration

Send test signals to the current selection for speaker and LED verification.

- **Volume** — slider with dB text input (type an exact dB value, −40 to 0 dB). Sends `setVolume` live as the slider moves.
- **Note** — semitone slider (0–76, A2–G#8); drives the Frequency slider and displays the musical note name.
- **Freq** — frequency slider (200–10,000 Hz, 100 Hz steps) with a text input for direct entry. Also driven by the Note slider.
- **Tone / Pink / Sweep / Stop** — send calibration signals.

#### Store Default Volume

Set the stored default volume on devices (all devices or selected only). The heading shows the current dB level.

#### Set Node Target

Assign a node path string to all or selected devices. Path is validated against `^[a-z0-9][a-z0-9/._-]*(\/[a-z0-9][a-z0-9/._-]*)*$` before sending.

#### File Management

Pull a named `.wav` file from the server to device storage.

---

## Volume System

All volume controls use an **A-type audio taper** (logarithmic) mapping:

```text
gain  = 10 ^ (2 × (sliderPosition/100 − 1))
dB    = 40 × (sliderPosition/100 − 1)
```

The slider midpoint (50) corresponds to −20 dB (gain ≈ 0.1), matching the feel of a hardware potentiometer. Values are displayed in dB throughout the UI. Slider position 0 displays **−∞**. Volume is transmitted as a linear gain value (0.0–1.0, rounded to 4 decimal places).

When recalling a preset with **Live Announce on Tap** enabled, the `vol` field is intentionally omitted from the MQTT payload so each device uses its own stored default volume.

---

## Real-Time Updates

The server sends three message types over WebSocket:

| Type | When sent | Client action |
| --- | --- | --- |
| `state` | On connect; after any MQTT state change (debounced 200 ms) | Full app state refresh |
| `scoutUpdate` | On each individual device status change | In-place card update (or re-render if node path changed) |
| `nodeUpdate` | When the node tree changes | Info view refresh |
| `mqttStatus` | On MQTT connect/disconnect | MQTT indicator update |

Multiple `scoutUpdate` messages arriving in the same animation frame are coalesced into a single DOM render pass via `requestAnimationFrame` batching.

---

## Authentication

Both apps use account-based username/password auth. The admin server
(`signalfi-manifest`) is the auth authority; the control app
(`signalfi-web`) validates incoming session tokens against it.

**Permissions (per-user flags):**

- `administrator` — manage user accounts (sole power)
- `webAccess` — sign in to signalfi-web
- `manifestAccess` — sign in to the admin panel

A user can hold any combination. The default `admin` user has all three.

**Flow:**

1. First start: manifest creates `admin` / `admin` with
   `mustChangePassword: true`. Browser hits the login dialog.
2. Login `POST /ota/auth/login {username, password}` → returns a
   64-hex session token, expiry, permissions, and a `mustChangePassword`
   flag. Token lives in `sessionStorage` (cleared on tab close).
3. If `mustChangePassword` is set, every protected route returns
   `403 password-change-required` until the user posts a new password
   to `/ota/auth/change-password`.
4. signalfi-web doesn't own user records — it forwards the bearer to
   manifest's `/ota/auth/check` (60 s in-memory cache, 2 s upstream
   timeout), gates on `permissions.webAccess`. On logout/role-change,
   manifest pushes `POST /auth/invalidate` so web evicts the cache
   entry within ~2 s instead of waiting for TTL.

**Account dropdown** — both apps surface the signed-in username + sign-out (and on the admin panel: Users management + Terminate Other Sessions) under a head/shoulders icon at the top right of the nav.

**Terminate Other Sessions** — admin-only; clears every session on the manifest *except* the caller's, plus every cached web token. Other browsers fall back to the login dialog within ~1 s via SSE/WS push.

**Recovery** — lost the admin password? Set `AIRGAP_BOOTSTRAP_RESET=true` in the manifest's environment and restart it. On startup the manifest rewrites `users.json` back to `admin/admin/mustChangePassword:true`. Unset the flag after recovery.

**Static bearer (deprecated)** — `ADMIN_TOKEN` (manifest) and `AUTH_TOKEN` (web) are honoured for one release as a synthetic admin session, with a deprecation warning on every use. Existing `curl -H 'Authorization: Bearer $ADMIN_TOKEN' …` scripts keep working during the rollout.

See [`AUTH_README.md`](AUTH_README.md) for the full architecture, endpoint shapes, and ops recipes.

**Traefik security:** The admin panel router has rate limiting (5 req/s average, burst 10) and HTTP→HTTPS redirect enforced at the Traefik layer.

## Reports

The admin panel Reports section shows:

- **Stats bar** — total updates, success count, failed count, unique devices, last update timestamp.
- **Filters** — filter by status (applied / failed / started) and by device identifier.
- **Live updates** — new OTA report entries appear at the top of the table in real time via SSE without a page refresh.
- **CSV export** — download all report entries as a dated CSV file.

---

## Multi-Model Support (SSH-100 and others)

Devices report their model via the `model` field in MQTT `$state` messages. The server tracks model per device and surfaces it throughout the UI.

### Firmware Upload and Targeting

When a firmware file is uploaded via the admin panel, the server parses the filename prefix (e.g. `SSH-100-fw-1.3.2.hex`) and writes a `.meta.json` sidecar file alongside it:

```json
{ "targetModels": ["SSH-100"] }
```

The firmware list API returns `targetModels` from the sidecar. The push dialog shows model badges on each firmware entry and a **target models** field (visible when Force is checked) to restrict or broaden the push scope.

### Push Endpoint Behaviour

- **Per-model push** (`POST /ota/admin/api/push`): iterates devices grouped by model; sends one push message per model group using the manifest's `targetModels` filter.
- **Push-files endpoint**: uses `mdl: ""` for model-agnostic broadcast; uses per-model grouping when targeting specific devices.
- **Force flag**: `force: true` in the push payload is passed through to `manifest.firmware.force`, bypassing the device-side CRC/version skip-flash guard and the model filter.

### Admin UI Changes

- **Firmware file list**: model badges on each entry showing which models the file targets.
- **Devices table**: 7-column layout with a Model column; model badges per row.
- **Live activity table**: model column added.
- **Push dialog**: force toggle; target models field shown when force is checked.
- **Device state refresh**: `GET /ota/admin/api/devices` now also broadcasts `{act:"get"}` to trigger fresh `$state` reports from all devices.
- **SSE device-state event**: includes `model` field so the admin UI updates badges in real time without a page refresh.
