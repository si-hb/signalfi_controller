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
