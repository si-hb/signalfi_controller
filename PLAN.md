# SignalFi Web App — Architecture & Design Plan

## Project Goal

Build a responsive mobile-first web application that replicates the Node-RED dashboard for the SignalFi device control system. The app must work from any modern browser without installing software and must feel like a professional AV control panel, not a generic CRUD app.

**Primary use case:** a phone in portrait orientation held in one hand by an AV technician walking a venue.

---

## Node Path Addressing Model

This is the core concept that drives how the UI is organised. Every Signalfi device subscribes to three overlapping MQTT topic scopes:

| Scope | MQTT Topic | Usage |
|---|---|---|
| **Individual** | `scout/<MAC>/$action` | Command a single device by hardware address |
| **Area / Group** | `scout/$group/<node_path>/$action` | Command all Signalfi devices whose node path starts with this prefix |
| **Broadcast** | `scout/$broadcast/$action` | Command every reachable Signalfi device simultaneously |

A Signalfi device's **node path** is a hierarchical slash-delimited string such as `/venue/building-a/floor2/conf-room-b`. MQTT wildcard subscription means publishing to `scout/$group/venue/building-a/$action` automatically reaches every Signalfi device on every floor and room beneath that prefix — without the server needing to know the individual MAC addresses. This is how an operator can trigger an announcement to an entire floor, wing, or building with a single message.

**Key implications for the UI:**

- A Signalfi device's **display name** is derived from the **last segment** of its node path. For example, a Signalfi device with node path `/building_a/1st_floor/lobby/reception-desk` is named `reception-desk`.
- Signalfi devices are **grouped under their parent path** (all segments except the last). The device above belongs to the leaf group `/building_a/1st_floor/lobby`.
- The device list is a **fully recursive accordion tree**. Every intermediate path prefix that has children is itself a collapsible group. The example above produces the hierarchy:
  ```
  /building_a/                        ← top-level accordion node
    /building_a/1st_floor/            ← mid-level accordion node
      /building_a/1st_floor/lobby/    ← leaf group (contains device cards)
        reception-desk  [card]
      /building_a/1st_floor/restaurant/
        host-stand      [card]
        bar-unit        [card]
    /building_a/2nd_floor/
      ...
  ```
  An operator managing thousands of devices across many buildings, floors, and zones can collapse the entire tree to top-level nodes and drill down only to the area they need.
- **Selecting at any accordion level** targets that node path prefix via a single MQTT message — the broker's wildcard routing delivers it to every Signalfi device beneath that prefix automatically. There is no need to enumerate individual MACs.
- Selecting **individual device cards** targets their MAC addresses (multiple messages, one per device).
- Selecting **all** (or the root of the tree) uses the broadcast topic.
- Signalfi devices with **no node path configured** are collected into a special **Unorganized** section pinned at the bottom of the list. They are targeted by individual MAC address only.

---

## Backend

### Technology: Node.js with Express + MQTT.js + ws

**Recommendation:** A single Node.js process running:
- **Express** — serves the static frontend assets and a small REST API
- **MQTT.js** — maintains one persistent connection to `apis.symphonyinteractive.ca:1883`
- **ws** (the `ws` npm package) — a WebSocket server that pushes live state updates to all connected browser clients

**Justification:**
- The existing system is already JavaScript throughout (Node-RED is Node.js). Operators already have Node.js available or it is trivial to install.
- Node.js is the natural fit for MQTT bridging — it handles async I/O with minimal overhead and the `mqtt` npm package is the de facto standard client.
- A single process keeps deployment simple: one `node server.js` command, no separate worker processes, no Docker required unless preferred.
- The same `mqtt` package that Node-RED uses internally is battle-tested against the Symphony Interactive broker.
- Avoids the overhead of Python/FastAPI for a project with straightforward requirements.

### MQTT Connection Strategy

The backend subscribes to:
- `scout/+/$state` — all device status and state updates
- `scout/+/$msg` — device log/debug messages

It publishes to `scout/$broadcast/$action`, `scout/$group/<node>/$action`, and `scout/<MAC>/$action` on behalf of browser clients.

The backend acts as the single MQTT client. Browser clients never connect to MQTT directly. This prevents connection storms if many operator tabs are open simultaneously and keeps credentials (if any are added later) server-side.

**Status refresh:** Whenever the MQTT broker connection is established (startup or reconnect) the backend immediately publishes `{"act":"get"}` to `scout/$broadcast/$action`, triggering every reachable Signalfi device to report its current status. The same broadcast is sent whenever a new browser client completes its WebSocket handshake, ensuring the operator always sees an up-to-date view. Operators can also trigger a manual refresh from the UI (pull-to-refresh gesture on mobile), which sends the same broadcast.

**Destination routing** (mirrors Node-RED "Broadcast, Node or Device" logic):
1. **Area group selected** → single publish to `scout/$group/<node_path>/$action`
2. **Individual devices selected** → one publish per MAC to `scout/<MAC>/$action`
3. **Broadcast** → single publish to `scout/$broadcast/$action`

Targeting an area group is always preferred over iterating MACs when a full group is selected, as it is a single MQTT message and is resilient to new Signalfi devices joining mid-announcement.

### WebSocket Strategy

On every meaningful event — Signalfi device state update, node list change, MQTT broker status change — the backend serialises the full application state and broadcasts it to all connected browser WebSocket clients as a JSON message. The state envelope looks like:

```json
{
  "type": "state",
  "scouts": [...],
  "nodes": [...],
  "presets": [...],
  "scout": { ...current announcement params... },
  "mqttOnline": true
}
```

For targeted updates (e.g. a single Signalfi device's status changed) a delta message type is used to avoid sending the whole state on every MQTT tick:

```json
{ "type": "scoutUpdate", "mac": "aa:bb:cc:dd:ee:ff", "state": {...} }
```

The browser WebSocket client merges deltas into its local state copy.

**Why WebSocket over SSE:** The browser also needs to send commands (announce, stop, change LEDs etc.) back to the server. WebSocket is bidirectional on a single connection, which eliminates the need for a separate REST API for most operations. SSE would require HTTP POSTs for commands, adding complexity.

### REST API (minimal, for non-interactive operations)

Only a handful of endpoints are needed that do not fit the WebSocket command pattern:

```
GET  /api/state            — full state snapshot on initial page load
POST /api/presets          — save a new preset
DELETE /api/presets/:name  — delete a preset
POST /api/scouts/reset-nodes — reset and re-enumerate the node list
```

All real-time commands (announce, stop, colour, brightness, etc.) go over the WebSocket as JSON command messages.

### Persistence

The backend replicates the Node-RED file-context storage by writing `data/scouts.json`, `data/nodes.json`, `data/presets.json`, and `data/scout.json` to disk. These files are read on startup to restore state across server restarts — identical to how the Node-RED flow uses `global.get("scouts","file")`.

### Server Configuration

All deployment-specific values are externalised from code. The server reads configuration at startup in this priority order: **environment variables → `config.json` file → built-in defaults**. This allows the same codebase to run in development (defaults), on a LAN server (config file), or in a containerised environment (env vars).

A documented `config.example.json` is committed to the repository. The live `config.json` is gitignored.

#### MQTT

| Variable / Key | Default | Description |
|---|---|---|
| `MQTT_HOST` | `apis.symphonyinteractive.ca` | Broker hostname or IP |
| `MQTT_PORT` | `1883` | Broker TCP port |
| `MQTT_USERNAME` | _(empty)_ | MQTT username if broker requires auth |
| `MQTT_PASSWORD` | _(empty)_ | MQTT password |
| `MQTT_TLS` | `false` | Enable TLS (`true` → port defaults to `8883`) |
| `MQTT_CA_CERT` | _(empty)_ | Absolute path to a PEM CA certificate file for TLS verification |
| `MQTT_CLIENT_CERT` | _(empty)_ | Absolute path to a PEM client certificate (mutual TLS) |
| `MQTT_CLIENT_KEY` | _(empty)_ | Absolute path to a PEM client private key (mutual TLS) |
| `MQTT_CLIENT_ID` | `signalfi-web-<pid>` | Client ID sent to broker on connect |
| `MQTT_TOPIC_PREFIX` | `scout` | Topic namespace prefix (e.g. change to `signalfi` if broker is reconfigured) |

#### HTTP Server

| Variable / Key | Default | Description |
|---|---|---|
| `HTTP_HOST` | `0.0.0.0` | Interface to bind (use `127.0.0.1` to restrict to localhost) |
| `HTTP_PORT` | `3000` | TCP port for the web server |
| `HTTP_STATIC_DIR` | `./public` | Path to the directory of static frontend assets |

#### Local File Paths

| Variable / Key | Default | Description |
|---|---|---|
| `DATA_DIR` | `./data` | Directory for persisted JSON state files (`devices.json`, `nodes.json`, `presets.json`, `settings.json`) |
| `FIRMWARE_DIR` | `./firmware` | Local directory where firmware images are staged for OTA distribution to devices |
| `AUDIO_DIR` | `./audio` | Local directory containing `.wav` audio files available for announcement; the server reads this directory at startup to populate the audio file list sent to clients |

The audio file list is therefore **dynamic by default** — adding or removing files from `AUDIO_DIR` and restarting the server (or triggering a `/api/reload` endpoint) updates the list in the UI without any code change.

#### Application Authentication

The existing Node-RED flow has no authentication. The web app defaults to no auth for initial deployment, consistent with that model. The server binds to `0.0.0.0` by default but should be restricted via `HTTP_HOST` when deployed on a machine with a public interface.

| Variable / Key | Default | Description |
|---|---|---|
| `AUTH_TOKEN` | _(empty)_ | If set, all WebSocket upgrade requests and REST calls must supply this value as a Bearer token in the `Authorization` header. Empty = auth disabled. |

#### Example `config.json`

```json
{
  "mqtt": {
    "host": "apis.symphonyinteractive.ca",
    "port": 1883,
    "username": "",
    "password": "",
    "tls": false,
    "caCert": "",
    "clientCert": "",
    "clientKey": "",
    "clientId": "signalfi-web",
    "topicPrefix": "scout"
  },
  "http": {
    "host": "0.0.0.0",
    "port": 3000
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

---

## Frontend

### Technology: Vanilla JavaScript (ES Modules) with no build step

**Recommendation:** Plain modern JavaScript using ES modules, the Fetch API, and the native WebSocket API — no framework, no bundler, no npm install on the client side.

**Justification:**
- The UI is essentially a single-screen control panel with a handful of views. It does not need React's component model or Vue's reactivity system for its level of complexity.
- Zero build toolchain means the project is immediately editable and deployable. An AV technician who needs to tweak a colour value or add an audio file to the dropdown does not need to understand webpack.
- Modern browsers support ES modules natively. A small module-per-feature structure keeps the code organised without a bundler.
- Total JavaScript payload will be under 50 KB uncompressed. Framework overhead is not justified.

If the team later decides a reactive framework is desirable (e.g. for adding more complex views), **Preact** (3 KB) is the preferred upgrade path — it is a drop-in for React syntax with no build toolchain requirement when loaded from a CDN.

### Real-Time Update Handling

The frontend opens a WebSocket to `ws://<host>/ws` on page load. On receive:

- `type: "state"` — replace the full local state object and re-render all panels
- `type: "scoutUpdate"` — find the scout in local state by MAC, update its fields, and re-render only the affected card and group header count
- `type: "nodeUpdate"` — rebuild group headings and badge counts
- `type: "mqttStatus"` — update the broker status indicator in the top bar

Re-rendering is done by calling small `render*()` functions that update the DOM in-place (no full page repaints). Device cards are keyed by `data-mac` attribute; only changed cards are updated.

On WebSocket disconnect, the app shows a prominent "Reconnecting…" banner and retries with exponential backoff (1 s, 2 s, 4 s, up to 30 s).

---

## UI Layout Proposal

### Visual Design Language

The app uses a **dark professional AV control panel** aesthetic. The primary screen is a device list in the style of a smart building panel — cards grouped by area, quick-select interaction, and action sheets that slide up from the bottom.

#### Colour Scheme

| Token | Value | Usage |
|---|---|---|
| `--bg-base` | `#0e0e0e` | Page background |
| `--bg-panel` | `#1a1a1a` | Panel / card background |
| `--bg-raised` | `#252525` | Raised elements, inputs, sheets |
| `--bg-selected` | `#0d3a3c` | Selected card tint (dark teal) |
| `--border` | `#2e2e2e` | Borders, dividers |
| `--accent` | `#097479` | Primary accent (teal) |
| `--accent-bright` | `#0eb8c0` | Active/hover state, selected border |
| `--text-primary` | `#eeeeee` | Main text |
| `--text-muted` | `#777777` | Labels, secondary text, MAC addresses |
| `--warn` | `#e87c2a` | Warnings, firmware buttons |
| `--danger` | `#c0392b` | Destructive actions |
| `--status-online` | `#2ecc71` | Online / idle indicator |
| `--status-offline` | `#444444` | Offline indicator |
| `--status-busy` | `#0eb8c0` | Announcing (pulsing teal) |
| `--status-warn` | `#e87c2a` | Transitional states |

Typography: system font stack (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`). Control labels in uppercase, `letter-spacing: 0.06em`. IP addresses and MACs in monospace. Group header counts in a rounded badge.

---

### Interaction Model

The app has a single primary view: **the device list**. All actions flow from there.

1. **Browse** — The device list renders as a recursive accordion tree built from node path prefixes. Every intermediate path node is a collapsible row. Leaf groups (paths that contain device cards) expand to show the 2-column card grid. The tree starts fully collapsed to top-level nodes and remembers per-level expand state in session storage.
2. **Refresh** — Pull down from the top of the device list to trigger a status refresh. The backend broadcasts `{"act":"get"}` to all Signalfi devices and updates the card grid as replies arrive. A spinner in the top bar confirms the refresh is in flight.
3. **Identify** — The **[⊕] identify toggle** in the top bar switches the tap behaviour of device cards. While active, a single tap on any card immediately fires the hardcoded identify announcement to that device's MAC address. This mode is intended for physical commissioning and walkthrough — the operator taps a card and the corresponding device chirps and lights up white, confirming its location. Identify mode is mutually exclusive with selection; the normal select-and-act flow is suspended while it is on.
4. **Select** — The **primary selection method is tapping an accordion row** to select an entire node path group. This is how devices are designed to be used — operated as zones, not individually. Tapping an individual card is also supported and is useful during testing and commissioning. Selected accordion rows and cards highlight with a teal tint; accordion rows show a checkbox (filled = all selected, dash = partial).
5. **Act** — When one or more items are selected, a bottom action bar appears with **Lighting** and **Sound** buttons, and a **heart icon** (♡) appears in the top bar for preset access.
6. **Configure** — Tapping Lighting or Sound opens a bottom sheet with the relevant controls and an **Announce** button.

Selection maps directly to MQTT destination:
- Accordion row selected at any depth → single node-path publish to that prefix (broker wildcard delivers to all children) — **this is the normal operating mode**
- Individual card(s) selected → one MAC-addressed publish per device (testing and commissioning use)
- All selected → broadcast publish

---

### Primary Screen — Devices View

This is the default and only persistent screen. Navigation to system settings and node management is via the top-right overflow menu or a secondary tab bar.

The device list is a **recursive accordion tree**. Each node path prefix that has children is a collapsible row at the appropriate indent level. Leaf groups (the direct parent path of device cards) expand to reveal the 2-column card grid. Signalfi devices with no node path are pinned at the bottom under **Unorganized**.

The device name on each card is the **last segment** of the node path. The group/accordion hierarchy is built from every intermediate prefix above that.

Pull-to-refresh is triggered by dragging the list downward past a threshold. A spinner appears in the top bar while the `{"act":"get"}` broadcast is in flight and dismisses once all expected replies have arrived (or after a 5-second timeout).

```
┌─────────────────────────────────────┐
│  Devices            [🔍] [⊞ Groups] │
├─────────────────────────────────────┤
│ ┌─────────────────────────────────┐ │
│ │  Search 128 devices...          │ │
│ └─────────────────────────────────┘ │
├─────────────────────────────────────┤
│ ▼ /building_a/          (86)    [☐] │  ← Top-level accordion, expanded
│  ▼ /building_a/1st_floor/  (34) [☐] │  ← Mid-level, expanded; indent +1
│   ▼ /building_a/1st_floor/lobby/(12)│  ← Leaf group, expanded; indent +2
│   │ ┌──────────┐ ┌──────────┐       │
│   │ │  [+]     │ │  [+]     │       │  ← Device cards, indent +3
│   │ │reception │ │west-panel│       │
│   │ │aa:bb:cc… │ │dd:ee:ff… │       │
│   │ │● Online  │ │● Online  │       │
│   │ └──────────┘ └──────────┘       │
│   │ ┌──────────┐                    │
│   │ │  [+]     │                    │
│   │ │main-desk │                    │
│   │ │11:22:33… │                    │
│   │ │⟳ Announce│                    │
│   │ └──────────┘                    │
│   ▶ /building_a/1st_floor/rest./(8) │  ← Leaf group, collapsed
│   ▶ /building_a/1st_floor/conf./(14)│
│  ▶ /building_a/2nd_floor/   (52)[☐] │  ← Mid-level, collapsed
│ ▶ /building_b/              (41)[☐] │  ← Top-level, collapsed
│ ▶ /building_c/              (27)[☐] │
├─────────────────────────────────────┤
│  Unorganized  (3)               [>] │  ← Always last; no node path set
│ ┌──────────┐ ┌──────────┐          │
│ │  [+]     │ │  [+]     │          │
│ │aa:bb:cc… │ │dd:ee:ff… │          │  ← MAC as primary label (no name)
│ │          │ │          │          │
│ │◌ Offline │ │● Online  │          │
│ └──────────┘ └──────────┘          │
└─────────────────────────────────────┘
```

**Accordion row anatomy:**
```
▼ /building_a/1st_floor/lobby/  (12)  [☐]
^  ^                            ^      ^
│  └─ path segment label        │      └─ select-all checkbox for this subtree
│     (last segment bold,       └─ total device count beneath this node
│      parents muted)
└─ expand/collapse chevron (▶ collapsed, ▼ expanded)
```

Each intermediate path level shows only its **own segment** as the primary label, with the parent prefix shown smaller and muted above it (or omitted when context is clear from indentation). This keeps rows readable at any depth without wrapping long paths.

**Card anatomy:**
```
┌──────────────────┐
│      [+]         │  ← SignalFi device icon ('+' in a box), always the same
│   device-name    │  ← Last segment of node path, bold; MAC if no path set
│  aa:bb:cc:dd:ee  │  ← MAC address, monospace, truncated to fit
│  ● Online        │  ← Status dot + current state word
└──────────────────┘
```

The `[+]` icon is the standard SignalFi device icon for all Signalfi devices — no type inference is made from the node path name. The icon tint reflects device status:
- Dimmed / grey = offline
- White = online / idle
- Pulsing teal = announcing
- Amber = transitional state (connecting, rebooting, updating)

---

### Multi-Select Mode

Tapping any card enters selection mode. The header transforms to show a count and an **Actions** button.

Tapping any accordion row checkbox (or any card) enters selection mode. The header transforms to show a count. The bottom action bar appears.

Selection at a parent accordion node automatically selects (and visually marks) the entire subtree beneath it. Deselecting any child reverts the parent to a partial (dash) state.

```
┌─────────────────────────────────────┐
│ ← 5 Devices Selected       [Actions]│
├─────────────────────────────────────┤
│ ┌─────────────────────────────────┐ │
│ │  Search 128 devices...          │ │
│ └─────────────────────────────────┘ │
├─────────────────────────────────────┤
│ – /building_a/          (86)    [–] │  ← Dash = partially selected subtree
│  ☑ /building_a/1st_floor/  (34) [☑]│  ← All children selected
│   ▼ /building_a/1st_floor/lobby/(12)│
│   │ ┌──────────┐ ┌──────────┐       │
│   │ │  [+]  ✓  │ │  [+]  ✓  │       │  ← Selected cards: teal border
│   │ │reception │ │west-panel│       │
│   │ │aa:bb:cc… │ │dd:ee:ff… │       │
│   │ │● Online  │ │● Online  │       │
│   │ └──────────┘ └──────────┘       │
│   ▼ /building_a/1st_floor/rest./(8) │
│   │ ┌──────────┐ ┌──────────┐       │
│   │ │  [+]  ✓  │ │  [+]  ✓  │       │
│   │ │host-stand│ │bar-unit  │       │
│   │ └──────────┘ └──────────┘       │
│  – /building_a/2nd_floor/   (52)[–] │  ← Partially selected
│   ▼ /building_a/2nd_floor/conf./(6) │
│   │ ┌──────────┐ ┌──────────┐       │
│   │ │  [+]  ✓  │ │  [+]     │       │  ← Mixed within leaf group
│   │ │av-panel  │ │rear-unit │       │
│   │ └──────────┘ └──────────┘       │
├─────────────────────────────────────┤
│ ┌───────────────┐ ┌───────────────┐ │
│ │   Lighting    │ │     Sound     │ │  ← Fixed bottom action bar
│ └───────────────┘ └───────────────┘ │
└─────────────────────────────────────┘
```

**Targeting logic when Announce is pressed:**
- Entire subtree selected via a parent accordion row → single MQTT publish to that node path prefix (e.g. `scout/$group/building_a/1st_floor/$action`)
- Mixed partial selection spanning multiple nodes → one publish per selected node path prefix where all children are selected, falling back to individual MAC publishes for partially-selected leaf groups
- All devices selected → broadcast publish

**Group header selection:** Tapping the group header row (not the expand chevron) toggles selection of every device in that group. If all are selected, tapping again deselects. The group header shows a filled checkbox indicator when all members are selected, a dash when partially selected.

**Targeting logic:**
- When an entire group is selected via the group header, the server sends a single MQTT message to `scout/$group/<node_path>/$action` (not individual MACs).
- When a mix of individual devices is selected (possibly spanning groups), the server sends individual MAC-addressed messages.
- "Select All" (via search box select-all gesture or triple-tap on header) → broadcast mode.

---

### Lighting Configure Sheet

Slides up from the bottom as a modal sheet when **Lighting** is tapped.

```
┌─────────────────────────────────────┐
│  Configure Lighting (5 Devices)     │  ← Sheet handle bar + title
├─────────────────────────────────────┤
│  [Color]  [Scenes]  [Patterns]      │  ← Segmented tabs within sheet
├─────────────────────────────────────┤
│                                     │
│         (  colour wheel  )          │  ← HSV colour wheel, full-width
│                                     │
│  Brightness ─────────●───────  80%  │  ← Brightness slider
│                                     │
│  Pattern  [●] Pulse  [ ] Strobe ... │  ← Pattern chips / icon row
│                                     │
│  Timeout  ────────●────────  30 min │  ← Timeout slider
│                                     │
├─────────────────────────────────────┤
│         [      Announce      ]      │  ← Full-width accent button
└─────────────────────────────────────┘
```

**Color tab:** HSV wheel + hex input. Quick-select swatches for common colours (White, Red, Orange, Green, Blue, Cyan).

**Patterns tab:** Large icon-button grid for the 13 LED patterns (Off, Solid, Blink, Rotate, Pulse, Flash, Wave Out, Wave In, Audio Follow, Left, Right, Up, Down).

---

### Sound Configure Sheet

```
┌─────────────────────────────────────┐
│  Configure Sound (5 Devices)        │
├─────────────────────────────────────┤
│  ● None (LEDs only)                 │  ← First option; no audio file sent
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │
│  ○ Alarm_01.mp3                     │  ← File list (radio buttons)
│  ○ Ambient_Birdsong                 │
│  ○ Ambient_Chime                    │
│  ○ Doorbell_Chime                   │
│  ○ Doorbell_Chime_2                 │
│  ○ ...                              │
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │
│  Volume  ──────────●──────  65%     │  ← Slider greyed out when None selected
│                                     │
│  Loops   [−]   3   [+]              │  ← Stepper greyed out when None selected
│                                     │
├─────────────────────────────────────┤
│         [      Announce      ]      │
└─────────────────────────────────────┘
```

Announce sends a full `{"act":"ply", ...}` MQTT message to the selected destination. When **None** is selected the `aud` field is omitted from the payload, triggering LED-only behaviour on the Signalfi device.

A **Stop** button appears alongside Announce when devices are in an announcing state:

```
│  [  ■ Stop  ]  [   Announce   ]    │
```

---

### Preset Sheet (heart icon)

Opened by tapping the **♡** icon in the top bar. Only available when a selection is active. A preset captures the complete current state of both palettes: audio file, volume, loops, LED colour, pattern, brightness, and timeout — everything needed to reproduce an announcement exactly.

```
┌─────────────────────────────────────┐
│  Presets                       [✕]  │
├─────────────────────────────────────┤
│  SAVE CURRENT SETTINGS              │
│  [  Preset name…             ] [💾] │  ← Text input + save button
├─────────────────────────────────────┤
│  LIVE  [  ○  ]                      │  ← Live toggle (off by default)
├─────────────────────────────────────┤
│  SAVED PRESETS                      │
│  ┌──────────────────────────────┐   │
│  │ ♥ Morning Chime              │   │  ← Active/loaded preset (filled heart)
│  │   Ambient_Chime · White · P4 │   │
│  ├──────────────────────────────┤   │
│  │ ♡ Evening Bell               │   │
│  │   Doorbell_Chime · Blue · P2 │   │
│  ├──────────────────────────────┤   │
│  │ ♡ Alert Red                  │   │
│  │   Alarm_01 · Red · Flash     │   │
│  └──────────────────────────────┘   │
└─────────────────────────────────────┘
```

**Swipe to delete:** swiping a preset row to the left reveals a red **Delete** button on the right edge of the row. Confirming removes the preset from the list. No separate delete button is shown in the default state.

```
│  ┌─────────────────────┐ ┌────────┐ │
│  │ ♡ Evening Bell      │ │ Delete │ │  ← Revealed by swipe-left
│  │ Doorbell · Blue · P2│ │  (red) │ │
│  └─────────────────────┘ └────────┘ │
```

**Live toggle:** controls what happens when a preset row is tapped.

- **Live OFF (default):** tapping a preset loads its values into the Lighting and Sound palettes only. No announcement is made. The operator can review or adjust the settings before announcing manually. The top-bar heart icon fills (♥) to confirm the preset is loaded.
- **Live ON:** tapping a preset immediately recalls its values **and** sends an Announce command to the active selection — a single touch triggers the full announcement. The Live toggle glows accent-teal when active as a clear visual warning that taps are consequential.

The Live toggle state persists for the session so an operator doing rapid back-to-back preset announcements does not need to re-enable it each time.

Recalling a preset (Live OFF) populates the Lighting and Sound sheets with the stored values. Any manual change to a palette value after recall clears the loaded indicator (♥ → ♡).

---

### Device Detail Sheet

Tapping a device card (not in multi-select mode, i.e. long-press to open detail instead of select) opens a bottom sheet with full device info and individual commands.

```
┌─────────────────────────────────────┐
│  Table Lamp 1                  [✕]  │
├─────────────────────────────────────┤
│  Status    ● Announcing             │
│  IP        192.168.1.42             │
│  MAC       aa:bb:cc:dd:ee:ff        │
│  Node      /living-room/lamp-1      │
│  Version   1.4.2                    │
│  DHCP      Yes                      │
├─────────────────────────────────────┤
│  SET NODE PATH                      │
│  [/living-room/lamp-1        ] [→]  │
├─────────────────────────────────────┤
│  ┌──────────┐  ┌──────────────────┐ │
│  │ ↺ Reboot │  │   🔍 Identify    │ │
│  └──────────┘  └──────────────────┘ │
│  [     Firmware Update (OTA)     ]  │
│  [         Pull File…            ]  │
└─────────────────────────────────────┘
```

---

### Top Bar & Search

Default state (nothing selected):
```
┌─────────────────────────────────────┐
│  Devices         [🔍] [⊞] [⊕]  [●] │
└─────────────────────────────────────┘
```

Identify mode active:
```
┌─────────────────────────────────────┐
│  Devices         [🔍] [⊞] [⊕̲]  [●] │  ← Identify icon glows teal when on
└─────────────────────────────────────┘
```

Selection active (identify off):
```
┌─────────────────────────────────────┐
│ ← 12 Selected     [♡]  [⊕]  [●]   │
└─────────────────────────────────────┘
```

- **[🔍]** — expands inline search field, filters cards by name, node path, or MAC in real time
- **[⊞]** — toggles flat list vs. grouped accordion view
- **[⊕]** — **Identify toggle.** Persistent mode switch, independent of selection state. When active the icon glows teal and a labelled banner appears below the top bar reading "Identify Mode — tap a device to identify". While identify mode is on, tapping any individual device card immediately sends a hardcoded identify announcement directly to that device by MAC address — no selection or confirmation step. Tapping an accordion row has no effect in identify mode (group identification is not supported). Identify mode is mutually exclusive with the normal select-and-act flow: selecting cards is disabled while it is on.
- **[●]** — MQTT broker connection status: green (connected), red (disconnected), amber (reconnecting). Tap to see connection details / retry.
- **[♡]** — Presets button. Appears **only when a selection is active and identify mode is off**. Opens the preset sheet for save/recall against the current selection. The icon fills (♥) when a preset is loaded into the active lighting/sound palette.

**Identify announcement payload** (hardcoded, sent to `scout/<MAC>/$action`):
```json
{
  "act": "ply",
  "aud": "chime01.wav",
  "rpt": 1,
  "clr": "ffffff",
  "pat": 4,
  "dur": 1000,
  "vol": "0.8",
  "brt": 255
}
```

The identify payload is never user-configurable from the UI. It is defined as a constant on the server and sent as a standard announce command routed exclusively to the individual device's MAC topic.

---

### Secondary Navigation

A minimal bottom tab bar provides access to non-primary views:

```
┌─────────────────────────────────────┐
│  [🏠 Devices] [⚙ Settings] [ℹ Info] │
└─────────────────────────────────────┘
```

- **Devices** — the primary card view (default)
- **Settings** — system configuration: presets management, calibration (tone/pink/sweep), file upload, node path management, broadcast controls
- **Info** — full device status table (IP, version, firmware, all fields), node tree summary, reset and refresh controls

This keeps the primary screen uncluttered and matches the mental model from the mockups: operators interact almost exclusively with the device card grid.

---

### Settings Screen

```
┌─────────────────────────────────────┐
│  Settings                     [●]   │
├─────────────────────────────────────┤
│  PRESETS                            │
│  ┌──────────────────────────────┐   │
│  │ Morning Chime          [✎][🗑]│   │  ← Rename (pencil) and Delete icons
│  ├──────────────────────────────┤   │
│  │ Ambient Blue           [✎][🗑]│   │
│  ├──────────────────────────────┤   │
│  │ Alert Red              [✎][🗑]│   │
│  └──────────────────────────────┘   │
├─────────────────────────────────────┤
│  CALIBRATION                        │
│  Volume  ──────────●──────  65%     │
│  Note    ────●─────────────  C4     │
│  Freq    ────────●──────────  440Hz │
│  [ ▶ Tone ]  [ ▶ Pink ]  [ ▶ Sweep]│
├─────────────────────────────────────┤
│  DEFAULT VOLUME                     │
│  ○ All Devices                      │
│  ● Selected Devices                 │
│  [  💾 Store Volume to Devices  ]   │
├─────────────────────────────────────┤
│  FILE MANAGEMENT                    │
│  [chime01.wav                 ]     │
│  [    Pull File to Devices    ]     │
├─────────────────────────────────────┤
│  ANNOUNCE TARGET                    │
│  [/lobby/main               ] [→]   │
├─────────────────────────────────────┤
│  [🏠 Devices] [⚙ Settings] [ℹ Info] │
└─────────────────────────────────────┘
```

**PRESETS** — manage the preset library only. Save and recall are handled via the heart-icon sheet on the Devices screen. Each preset row has an inline **rename** (pencil) icon that opens an edit-in-place text field, and a **delete** (bin) icon that removes the preset after a swipe-left reveal (matching the preset sheet interaction) or a single tap with an inline confirm prompt.

**CALIBRATION** — the volume slider sets the working volume level used by Tone, Pink, and Sweep test signals. The Note and Freq sliders are linked: moving Note snaps Freq to the nearest semitone-aligned frequency; moving Freq sets an exact value and moves Note to the nearest semitone.

**DEFAULT VOLUME** — stores the current volume slider value persistently to devices via `{"act":"vrt","vol":<value>}`:
- **All Devices** — sends to the broadcast topic (`scout/$broadcast/$action`), updating every reachable Signalfi device
- **Selected Devices** — sends to each individually selected device by MAC, or to selected group paths via the node-path topic, mirroring the same destination logic used by Announce

---

### Info Screen

```
┌─────────────────────────────────────┐
│  Info / Status                [●]   │
├─────────────────────────────────────┤
│  BROKER   ● Connected               │
│  Devices  128 online  · 4 offline   │
│  RTT      Last: 42ms  Peak: 180ms   │
├─────────────────────────────────────┤
│  NODES                    [↻ Reset] │
│  ┌──────────────────────────────┐   │
│  │ /lobby          5 devices 1↗ │   │
│  │  /lobby/main    3 devices 1↗ │   │
│  │  /lobby/foyer   2 devices 0  │   │
│  │ /floor2         8 devices 0  │   │
│  │  /floor2/conf-a 4 devices 0  │   │
│  └──────────────────────────────┘   │
├─────────────────────────────────────┤
│  DEVICE STATUS TABLE                │
│  ┌────────────────────────────────┐ │
│  │ IP          Status    Node     │ │
│  │ 192.168.1.42 announce lobby/m │ │
│  │ 192.168.1.43 idle     lobby/m │ │
│  │ 192.168.1.50 online   floor2/a│ │
│  └────────────────────────────────┘ │
├─────────────────────────────────────┤
│  [🏠 Devices] [⚙ Settings] [ℹ Info] │
└─────────────────────────────────────┘
```

---

### Tablet Layout (768 px+)

On tablet-width screens, the bottom tab bar becomes a **left sidebar** and the device grid moves to a two-column content area.

```
┌───────────┬────────────────────────────────────────┐
│           │  5 Devices Selected         [Actions]  │
│  🏠        ├──────────────────────────────────────  │
│ Devices   │  LIVING ROOM (14)               [>]   │
│           │  ┌────────┐ ┌────────┐ ┌────────┐    │
│  ⚙        │  │💡   ✓  │ │💡   ✓  │ │💡      │    │
│ Settings  │  │Lamp 1  │ │Lamp 2  │ │Lamp 3  │    │
│           │  └────────┘ └────────┘ └────────┘    │
│  ℹ        │                                        │
│ Info      │  KITCHEN (9)                    [>]   │
│           │  ┌────────┐ ┌────────┐              │
│           │  │🔊   ✓  │ │💡      │              │
│   [●]     │  │Speaker │ │Bulb    │              │
└───────────┴────────────────────────────────────────┘
```

Configure sheets remain as centre-aligned modal dialogs (max-width 480 px) rather than full-screen bottom sheets.

### Desktop Layout (1024 px+)

Three-column layout:

```
┌────────────┬───────────────────────────┬─────────────────┐
│  Sidebar   │  Device Card Grid         │  Detail Panel   │
│            │                           │                 │
│  🏠 Devices│  LIVING ROOM (14)   [>]   │  Selected:      │
│  ⚙ Settings│  [card][card][card][card] │  5 devices      │
│  ℹ Info    │                           │                 │
│            │  KITCHEN (9)        [>]   │  [Lighting]     │
│            │  [card][card][card]       │  [Sound  ]      │
│            │                           │                 │
│   [●]      │  BACKYARD (22)      [>]   │  Device Status   │
│            │  [card]...                │  Table (live)   │
└────────────┴───────────────────────────┴─────────────────┘
```

The right detail panel shows the selected device info (or nothing when nothing is selected) and the configure panels as inline cards rather than bottom sheets.

---

## File and Folder Structure

```
signalfi-web/
├── server/
│   ├── server.js          # Entry point: Express + WebSocket + MQTT bridge
│   ├── mqtt.js            # MQTT connection, subscribe, publish, routing logic
│   ├── state.js           # In-memory state: scouts[], nodes[], presets[], scout{}
│   ├── persistence.js     # Read/write JSON files in data/
│   └── routes.js          # Express REST API routes
├── public/
│   ├── index.html         # Single HTML file (app shell)
│   ├── css/
│   │   ├── base.css       # CSS custom properties, resets, typography
│   │   ├── layout.css     # Grid, flexbox, sidebar, bottom tab bar
│   │   ├── cards.css      # Device card styles, selection state, icons
│   │   ├── sheets.css     # Bottom sheet / modal overlay styles
│   │   ├── components.css # Buttons, sliders, steppers, radio lists
│   │   └── status.css     # Status dot colours, announcing pulse animation
│   └── js/
│       ├── app.js         # Main entry: WebSocket client, tab router, state
│       ├── ws.js          # WebSocket client (connect, reconnect, dispatch)
│       ├── views/
│       │   ├── devices.js # Device card grid, group headers, selection model
│       │   ├── settings.js# Presets, calibration, file upload, node target
│       │   └── info.js    # device status table, node tree, broker info
│       ├── sheets/
│       │   ├── lighting.js# Lighting configure sheet (colour, pattern, timeout)
│       │   ├── sound.js   # Sound configure sheet (file list, volume, loops)
│       │   └── device.js  # Individual device detail sheet
│       └── api.js         # REST calls (save/delete preset, reset nodes)
├── data/
│   ├── devices.json       # Persisted device registry
│   ├── nodes.json         # Persisted node registry
│   ├── presets.json       # Persisted presets
│   └── settings.json      # Persisted current announcement parameters
├── mockups/               # UI reference images
├── config.example.json    # Documented configuration template (committed)
├── config.json            # Live configuration (gitignored)
├── .env                   # Optional env-var overrides (gitignored)
├── firmware/              # Staged firmware images for OTA distribution
├── audio/                 # .wav files served to devices; populates UI file list
├── Dockerfile             # Container image definition
├── .dockerignore          # Files excluded from the image build context
├── compose.yml            # Docker Compose / Podman Compose service definition
├── Makefile               # Convenience targets: build, up, down, logs, shell
├── package.json           # Dependencies: express, mqtt, ws
├── package-lock.json
├── flows.json             # Reference only — do not modify
├── README.md
└── PLAN.md
```

**Dependencies (production):**
- `express` — HTTP server and static file serving
- `mqtt` — MQTT client
- `ws` — WebSocket server

**Dependencies (development):**
- None required. No build step.

Total npm install footprint: approximately 5 MB.

---

## Implementation Phases

### Phase 1 — Backend Foundation

**Goal:** A working server that bridges MQTT to WebSocket.

Deliverables:
- `server.js` starts Express, mounts static files, starts WebSocket server
- `mqtt.js` connects to `apis.symphonyinteractive.ca:1883`, subscribes to `scout/+/$state`
- `state.js` processes incoming state messages: updates `scouts[]` array, detects online/offline, rebuilds `nodes[]` hierarchy from node paths
- `persistence.js` loads state from `data/*.json` on startup, writes changes on update
- WebSocket server broadcasts `{ type: "state", ... }` on every MQTT update
- On MQTT broker connect (or reconnect), backend publishes `{"act":"get"}` to `scout/$broadcast/$action` to request fresh status from all Signalfi devices
- On new browser WebSocket connection, backend triggers the same broadcast so the connecting client gets current state immediately
- REST endpoint `GET /api/state` returns full snapshot
- Tested: `curl` confirms device data is received and returned

---

### Phase 2 — MQTT Command Publishing

**Goal:** Browser can issue commands that reach the MQTT broker.

Deliverables:
- WebSocket message handler on server accepts command objects:
  ```json
  { "cmd": "announce", "payload": { ... }, "destination": "group|broadcast|selected", "target": "/node/path or [MAC,...]" }
  { "cmd": "stop", "destination": "group", "target": "/node/path" }
  { "cmd": "setColour", "colour": "FF0000" }
  { "cmd": "setBrightness", "brightness": 200 }
  { "cmd": "setVolume", "volume": 0.5 }
  { "cmd": "reboot", "mac": "aa:bb:cc:dd:ee:ff" }
  ```
- Server-side routing: group target → single MQTT node-path publish; individual MACs → one publish each; broadcast → single publish
- `routes.js` implements REST endpoints for preset CRUD
- Tested: manual WebSocket frame sending triggers observable Signalfi device responses

---

### Phase 3 — Device Card Grid (Primary View)

**Goal:** Working Devices screen on mobile with live status.

Deliverables:
- `index.html` app shell with bottom tab bar (Devices / Settings / Info), fixed top bar with broker LED
- `ws.js` WebSocket client with reconnect logic
- `app.js` state object, tab router
- `devices.js` renders:
  - Tree-building logic: recursively decompose all node paths into prefix segments to build a nested tree structure; device name = last segment; each intermediate prefix node is a collapsible accordion row; leaf groups hold the 2-column card grid; Signalfi devices with no node path collected under `Unorganized` pinned at the bottom
  - Accordion expand/collapse with chevron toggle; expand state persisted in sessionStorage
  - Checkbox selection cascades down the tree on parent selection and rolls up partial-selection state to ancestors
  - Collapsible group headers (area name + device count badge)
  - 2-column card grid within each group
  - Device cards: SignalFi `[+]` icon (tinted by status), name (last path segment), MAC address, status dot + state word
  - Status dot: green (idle/online), pulsing teal (announcing), amber (transitional), grey (offline)
  - Card icons tinted based on status
  - Search field filters cards in real time
- Live updates: `scoutUpdate` WS message finds card by `data-mac` and updates status dot + icon tint without full re-render
- CSS: dark theme, card grid, status dot animations
- Tested on Chrome mobile simulation and a real phone

---

### Phase 4 — Selection Model & Action Bar

**Goal:** Multi-select and the Lighting/Sound action flow.

Deliverables:
- Tap-to-select on cards: toggles `selected` class, updates header to "N Selected / Actions"
- Group header tap selects/deselects entire group
- Bottom action bar animates up when selection count > 0
- Selection state tracks whether a full group is selected (to prefer node-path MQTT routing over MAC iteration)
- `sheets/lighting.js`: bottom sheet with colour wheel, brightness slider, pattern chips, timeout slider, Announce/Stop buttons
- `sheets/sound.js`: bottom sheet with None option + file radio list, volume slider, loops stepper, Announce/Stop buttons
- `sheets/presets.js`: preset sheet (save, recall, delete); opened via heart icon; only rendered when a selection is active
- Announce sends appropriate WebSocket command with destination and target derived from selection state
- Stop sends `{ "cmd": "stop", ... }` to the same destination
- Pull-to-refresh gesture triggers `{"act":"get"}` broadcast; top bar shows spinner while in flight
- Heart icon appears in top bar whenever selection is active (and identify mode is off); opens preset sheet
- **Identify toggle** `[⊕]` in top bar: toggles identify mode on/off; glows teal when active; shows "Identify Mode" banner below top bar
- While identify mode is on: card tap immediately sends hardcoded identify payload to `scout/<MAC>/$action`; accordion row taps are inert; selection is suspended
- Identify payload is a server-side constant — not user-configurable
- Tested: enable identify, tap a card — device plays chime01.wav with white ladder pattern; tap again — second device responds independently

---

### Phase 5 — Device Detail Sheet

**Goal:** Per-device management.

Deliverables:
- `sheets/device.js`: long-press (or info icon tap) on card opens detail sheet
- Shows all Signalfi device fields: IP, MAC, node path, status, version, DHCP, subnet, gateway, FTP, USB, OLED
- Set Node Path input with send button (validates against `^[a-z0-9][a-z0-9\/.\-]*[a-z0-9]$`)
- Reboot, Identify, Firmware Update (OTA), Pull File buttons
- Firmware Update and Reboot require a confirmation tap (double-tap on button or inline confirmation row)
- Tested: identify plays chime on physical Signalfi device; node path change persists on device

---

### Phase 6 — Settings and Info Screens

**Goal:** System management views.

Deliverables:
- `views/settings.js`: presets list (save/delete), calibration controls (tone, pink, sweep, store volume), file pull, announce node target
- `views/info.js`: broker status, device count summary, RTT display, node tree (hierarchical indented list with member/busy counts), full device status table, reset-and-refresh button
- Node tree in Info screen is read-only (for monitoring). Node assignment is done per-device from the device detail sheet.
- Tested: all calibration commands verified on Signalfi device; preset save/recall round-trip confirmed

---

### Phase 7 — Polish, Tablet/Desktop Layouts, Accessibility

**Goal:** Production-ready app across all screen sizes.

Deliverables:
- Tablet breakpoint (768 px): left sidebar nav, 3-column card grid
- Desktop breakpoint (1024 px): three-column layout with persistent detail panel on right
- Configure sheets become centred modals on tablet/desktop (max-width 480 px)
- CSS animations: announcing card pulse, card highlight flash on status change
- Custom confirm modals (replacing `window.confirm`)
- Toast notifications for success/error feedback ("Preset saved", "Invalid node path", "Reboot sent")
- Reconnecting banner when WebSocket is down; command buttons disabled with visual indication
- Accessibility: minimum 44 px tap targets, `aria-label` on icon buttons, sufficient colour contrast (WCAG AA)
- Final test on iPhone Safari, Android Chrome, iPad, and desktop

---

### Phase 8 — Containerisation

**Goal:** Package the application as a portable container image deployable anywhere Docker or Podman is available.

Deliverables:

**`Dockerfile`**
- Base image: `node:22-alpine` (small footprint, LTS)
- Multi-stage build: `deps` stage runs `npm ci --omit=dev`; final stage copies only production node_modules and app source — no dev tooling in the image
- Runs as a non-root user (`node`) for security
- Exposes port `3000` (overridable at runtime via `HTTP_PORT`)
- `WORKDIR /app`; data directories (`/app/data`, `/app/audio`, `/app/firmware`) created at build time so volume mounts attach cleanly
- `ENTRYPOINT ["node", "server/server.js"]`

**`.dockerignore`**
- Excludes: `node_modules/`, `data/`, `audio/`, `firmware/`, `config.json`, `.env`, `flows.json`, `mockups/`, `*.md`, `.git/`
- Keeps the build context minimal; runtime data lives in volumes, not the image

**`compose.yml`**
- Compatible with both `docker compose` (Docker v2 plugin) and `podman-compose`
- Single service `signalfi-web` built from the local `Dockerfile`
- Port mapping: `${HTTP_PORT:-3000}:3000`
- Volumes (named or bind-mount):
  - `./data:/app/data` — persisted JSON state (survives container restarts)
  - `./audio:/app/audio` — audio files; add files here and restart to update the UI list
  - `./firmware:/app/firmware` — staged OTA firmware images
  - `./config.json:/app/config.json:ro` — optional; mount only if file exists (operator uses env vars otherwise)
- `env_file: .env` — loads all `MQTT_*`, `HTTP_*`, `AUTH_TOKEN` etc. from `.env` if present
- `restart: unless-stopped`
- `healthcheck`: `curl -f http://localhost:3000/api/state || exit 1`, interval 30 s, timeout 5 s, retries 3

```yaml
# compose.yml
services:
  signalfi-web:
    build: .
    restart: unless-stopped
    ports:
      - "${HTTP_PORT:-3000}:3000"
    volumes:
      - ./data:/app/data
      - ./audio:/app/audio
      - ./firmware:/app/firmware
    env_file:
      - path: .env
        required: false
    environment:
      - MQTT_HOST=${MQTT_HOST:-apis.symphonyinteractive.ca}
      - MQTT_PORT=${MQTT_PORT:-1883}
      - MQTT_USERNAME=${MQTT_USERNAME:-}
      - MQTT_PASSWORD=${MQTT_PASSWORD:-}
      - MQTT_TLS=${MQTT_TLS:-false}
      - AUTH_TOKEN=${AUTH_TOKEN:-}
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/api/state"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
```

(Note: `wget` is used instead of `curl` as it is included in the Alpine base image.)

**`Makefile`**

Provides a single interface that works with either Docker or Podman. The `ENGINE` variable defaults to `docker` but can be overridden (`make up ENGINE=podman`).

```makefile
ENGINE ?= docker
COMPOSE = $(ENGINE) compose
IMAGE   = signalfi-web

.PHONY: build up down restart logs shell clean

build:          ## Build the container image
	$(ENGINE) build -t $(IMAGE) .

up:             ## Start the service in the background
	$(COMPOSE) up -d --build

down:           ## Stop and remove containers
	$(COMPOSE) down

restart:        ## Restart the service
	$(COMPOSE) restart

logs:           ## Tail service logs
	$(COMPOSE) logs -f

shell:          ## Open a shell inside the running container
	$(ENGINE) exec -it $$($(COMPOSE) ps -q signalfi-web) sh

clean:          ## Remove image and stopped containers
	$(COMPOSE) down --rmi local --volumes --remove-orphans
```

**Podman-specific notes:**
- `podman-compose` is a drop-in for `docker compose` and reads `compose.yml` without modification. Install via `pip install podman-compose` or the system package manager.
- Podman runs rootless by default. No daemon is required. Use `make up ENGINE=podman` or set `ENGINE=podman` in the shell environment.
- For systemd-managed auto-start on a server, generate a unit file after first run: `podman generate systemd --new --name signalfi-web > ~/.config/systemd/user/signalfi-web.service` then `systemctl --user enable --now signalfi-web`.
- TLS certificate files referenced by `MQTT_CA_CERT`, `MQTT_CLIENT_CERT`, `MQTT_CLIENT_KEY` must be bind-mounted into the container if used. Add entries to `compose.yml` volumes section, e.g. `./certs:/app/certs:ro`, and set the env vars to `/app/certs/<filename>`.

**Tested:**
- `make build` produces a sub-50 MB image
- `make up` starts the service; `curl http://localhost:3000/api/state` returns JSON
- Stopping and restarting the container preserves state in `./data/`
- `make up ENGINE=podman` works identically on a Podman host
- Systemd unit file starts the container on boot (Podman rootless)

---

## Deployment

### Local Development (no container)

```bash
npm install
node server/server.js
```

The server reads `config.json` (if present) then environment variables. Point a browser at `http://localhost:3000`.

### Local Container (Docker or Podman)

```bash
cp config.example.json config.json   # edit as needed, or use .env instead
make up                               # Docker
make up ENGINE=podman                 # Podman
make logs                             # follow output
make down                             # stop
```

Persistent data lives in `./data/`, `./audio/`, and `./firmware/` on the host — these directories are bind-mounted into the container and survive `make down` / `make up` cycles.

### Remote Deployment

The image contains no deployment-specific configuration. To deploy to another machine:

1. **Build and push** the image to a registry:
   ```bash
   docker build -t registry.example.com/signalfi-web:latest .
   docker push registry.example.com/signalfi-web:latest
   ```
   Or copy the `compose.yml` and build on the target machine.

2. **On the target machine**, create the data directories and a `.env` file with the correct `MQTT_HOST`, credentials, and any other overrides, then:
   ```bash
   docker compose up -d
   # or
   podman-compose up -d
   ```

3. **Ensure the container has LAN access** to the MQTT broker and to the Signalfi devices (for OTA and file-pull operations). If deploying inside a Docker network or behind a reverse proxy, ensure port 3000 (or the configured `HTTP_PORT`) is accessible to browser clients.

---

## Assumptions

1. **No authentication** is required for the initial deployment, consistent with the existing Node-RED flow. `AUTH_TOKEN` defaults to empty (disabled). Operators deploying on an exposed interface should set a token via environment variable or `config.json`.
2. The **MQTT broker** at `apis.symphonyinteractive.ca:1883` allows anonymous connections based on the existing flow. All connection parameters (host, port, credentials, TLS) are configurable via the Server Configuration settings — no code change is needed to point the app at a different broker.
3. **Audio file list** is populated dynamically from `AUDIO_DIR` at server startup. The 17 files found in the Node-RED flow are the expected default set; adding files to the directory and restarting the server makes them available in the UI with no code change.
4. **OTA firmware update** is included in the device detail sheet but styled as a destructive action requiring confirmation.
5. **File pull** (`{"act":"fle"}`) sends a filename to the Signalfi device — the web app only sends the command; it does not handle binary transfers from the browser. Files to be pulled must be pre-staged in `FIRMWARE_DIR` or `AUDIO_DIR` on the server.
6. The app is deployed on the **same LAN** as the Signalfi devices or on the Symphony Interactive server with LAN-reachable Signalfi devices. When running in a container, the host machine's LAN access is sufficient — no special Docker networking is needed as long as the container uses `host` network mode or the MQTT broker is reachable from the bridge network.
9. The container image is built locally first and verified working before being pushed to any registry. The `compose.yml` defaults to a local build (`build: .`) rather than pulling from a registry, so no registry setup is required for initial deployment.
7. **Device tree** is built by decomposing every Signalfi device's node path into all its prefix segments. Each prefix that has children becomes an accordion row in the UI. The device display name is the last segment of the path. Signalfi devices with no node path are grouped under the special `Unorganized` section pinned at the bottom. The accordion tree collapses and expands at every level, allowing operators to manage thousands of devices across deep hierarchies without being overwhelmed.
8. Selecting an **entire group** via the group header sends a single node-path MQTT message rather than iterating MAC addresses, making it efficient and resilient to new Signalfi devices joining that zone mid-operation.
