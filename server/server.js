'use strict';

const fs          = require('fs');
const path        = require('path');
const http        = require('http');
const express     = require('express');
const { WebSocketServer } = require('ws');

const mqttModule  = require('./mqtt');
const state       = require('./state');
const persistence = require('./persistence');
const createRouter = require('./routes');

// ---------------------------------------------------------------------------
// Timestamp helper
// ---------------------------------------------------------------------------
const ts = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Configuration loader
// ---------------------------------------------------------------------------
function loadConfig() {
  let fileConfig = {};
  try {
    fileConfig = JSON.parse(fs.readFileSync('config.json', 'utf8'));
    console.log(`[${ts()}] [CONFIG] Loaded config.json`);
  } catch {
    // No config.json — use defaults / env vars only
  }

  return {
    mqtt: {
      host:        process.env.MQTT_HOST        || fileConfig.mqtt?.host        || 'apis.symphonyinteractive.ca',
      port:        parseInt(process.env.MQTT_PORT        || fileConfig.mqtt?.port        || 1883),
      username:    process.env.MQTT_USERNAME    || fileConfig.mqtt?.username    || '',
      password:    process.env.MQTT_PASSWORD    || fileConfig.mqtt?.password    || '',
      tls:         (process.env.MQTT_TLS        || String(fileConfig.mqtt?.tls  || 'false')) === 'true',
      caCert:      process.env.MQTT_CA_CERT     || fileConfig.mqtt?.caCert      || '',
      clientCert:  process.env.MQTT_CLIENT_CERT || fileConfig.mqtt?.clientCert  || '',
      clientKey:   process.env.MQTT_CLIENT_KEY  || fileConfig.mqtt?.clientKey   || '',
      clientId:    process.env.MQTT_CLIENT_ID   || fileConfig.mqtt?.clientId    || `signalfi-web-${process.pid}`,
      topicPrefix: process.env.MQTT_TOPIC_PREFIX|| fileConfig.mqtt?.topicPrefix || 'scout',
    },
    http: {
      host:       process.env.HTTP_HOST        || fileConfig.http?.host        || '0.0.0.0',
      port:       parseInt(process.env.HTTP_PORT       || fileConfig.http?.port        || 3000),
      staticDir:  process.env.HTTP_STATIC_DIR  || fileConfig.http?.staticDir   || './public',
    },
    paths: {
      dataDir:     process.env.DATA_DIR     || fileConfig.paths?.dataDir     || './data',
      firmwareDir: process.env.FIRMWARE_DIR || fileConfig.paths?.firmwareDir || './firmware',
      audioDir:    process.env.AUDIO_DIR    || fileConfig.paths?.audioDir    || './audio',
    },
    auth: {
      token: process.env.AUTH_TOKEN || fileConfig.auth?.token || '',
    },
  };
}

// ---------------------------------------------------------------------------
// Colour normaliser — strip leading '#' before sending to devices
// ---------------------------------------------------------------------------
function normaliseColour(val, fallback = 'ffffff') {
  if (!val) return fallback;
  return String(val).replace(/^#/, '');
}

// ---------------------------------------------------------------------------
// MQTT topic builder helpers
// ---------------------------------------------------------------------------
function buildTopics(config, destination, target) {
  const prefix = config.mqtt.topicPrefix;
  const topics = [];

  if (destination === 'broadcast') {
    topics.push(`${prefix}/$broadcast/$action`);
  } else if (destination === 'group' && typeof target === 'string' && target) {
    // Strip leading/trailing slashes
    const nodePath = target.replace(/^\/+/, '').replace(/\/+$/, '');
    topics.push(`${prefix}/$group/${nodePath}/$action`);
  } else if (destination === 'selected' && Array.isArray(target)) {
    for (const mac of target) {
      topics.push(`${prefix}/${mac}/$action`);
    }
  }

  return topics;
}

function publishToTopics(topics, payload) {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  for (const topic of topics) {
    console.log(`[${ts()}] [PUBLISH] ${topic} → ${raw}`);
    mqttModule.publish(topic, raw);
  }
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------
function handleCommand(config, msg, broadcast) {
  const { cmd, destination, target } = msg;

  // ---- Commands targeting a single device by MAC ----

  if (cmd === 'reboot' && msg.mac) {
    const prefix = config.mqtt.topicPrefix;
    publishToTopics([`${prefix}/${msg.mac}/$action`], { act: 'rbt' });
    return;
  }

  if (cmd === 'firmwareUpdate' && msg.mac) {
    const prefix = config.mqtt.topicPrefix;
    publishToTopics([`${prefix}/${msg.mac}/$action`], { act: 'upd' });
    return;
  }

  if (cmd === 'identify' && msg.mac) {
    const prefix = config.mqtt.topicPrefix;
    publishToTopics([`${prefix}/${msg.mac}/$action`], {
      act: 'ply',
      aud: 'chime01.wav',
      rpt: 1,
      clr: 'ffffff',
      pat: 4,
      dur: 1000,
      vol: '0.8',
      brt: 255,
    });
    return;
  }

  if (cmd === 'setNode' && msg.mac) {
    const prefix = config.mqtt.topicPrefix;
    publishToTopics([`${prefix}/${msg.mac}/$action`], { act: 'nod', nod: msg.node || '' });
    return;
  }

  if (cmd === 'pullFile' && msg.mac) {
    const prefix = config.mqtt.topicPrefix;
    publishToTopics([`${prefix}/${msg.mac}/$action`], { act: 'fle', file: msg.file || '' });
    return;
  }

  // ---- refresh — broadcasts get to all devices ----

  if (cmd === 'refresh') {
    const prefix = config.mqtt.topicPrefix;
    publishToTopics([`${prefix}/$broadcast/$action`], { act: 'get' });
    return;
  }

  // ---- updateSettings ----

  if (cmd === 'updateSettings' && msg.settings) {
    const updated = state.setSettings(msg.settings);
    persistence.saveSettings(config.paths.dataDir, updated);
    broadcast({ type: 'state', ...state.getState() });
    return;
  }

  // ---- Routable commands (broadcast / group / selected) ----

  const topics = buildTopics(config, destination, target);
  if (!topics.length) {
    console.warn(`[${ts()}] [CMD] No topics resolved for cmd=${cmd} destination=${destination}`);
    return;
  }

  let payload;

  switch (cmd) {
    case 'announce': {
      const p = msg.payload || {};
      // Accept both flat fields (from UI) and short-key payload sub-object
      payload = {
        act: 'ply',
        vol: msg.volume  ?? p.vol ?? 0.5,
        rpt: msg.loops   ?? p.rpt ?? 0,
        clr: normaliseColour(msg.colour ?? p.clr),
        pat: msg.pattern ?? p.pat ?? 1,
        dur: (msg.timeout ?? p.dur ?? 10) * 1000,
        brt: msg.brightness ?? p.brt ?? 200,
      };
      const aud = msg.audio ?? p.aud ?? '';
      if (aud) payload.aud = aud;
      break;
    }

    case 'stop':
      payload = { act: 'stp' };
      break;

    case 'acknowledge':
      payload = { act: 'ack' };
      break;

    case 'setColour':
      payload = { act: 'col', clr: normaliseColour(msg.colour) };
      break;

    case 'setPattern':
      payload = { act: 'pat', pat: msg.pattern ?? 1 };
      break;

    case 'setBrightness':
      payload = { act: 'brt', brt: msg.brightness ?? 200 };
      break;

    case 'setVolume':
      payload = { act: 'volOut', vol: msg.volume ?? 0.5 };
      break;

    case 'setFrequency':
      payload = { act: 'cal', frq: msg.frequency ?? 440 };
      break;

    case 'storeVolume':
      payload = { act: 'vrt', vol: msg.volume ?? 0.5 };
      break;

    case 'calibrate': {
      const sig = msg.signal || 'tone';
      if (sig === 'tone') {
        payload = { act: 'cal', sig: 'tone', frq: msg.frequency ?? 440, vol: msg.volume ?? 0.5 };
      } else if (sig === 'pink') {
        payload = { act: 'cal', sig: 'pink', vol: msg.volume ?? 0.5 };
      } else if (sig === 'sweep') {
        payload = { act: 'ply', aud: 'sweep.wav', vol: msg.volume ?? 0.5 };
      } else {
        console.warn(`[${ts()}] [CMD] Unknown calibrate signal: ${sig}`);
        return;
      }
      break;
    }

    default:
      console.warn(`[${ts()}] [CMD] Unknown command: ${cmd}`);
      return;
  }

  publishToTopics(topics, payload);
}

// ---------------------------------------------------------------------------
// Audio file listing (reused for state snapshots)
// ---------------------------------------------------------------------------
const FALLBACK_AUDIO = [
  'chime01.wav','chime02.wav','chime03.wav','clock.wav','doorbell.wav',
  'dtr.wav','farfrom.wav','oc-bil.wav','ocean.wav','oc-eng.wav',
  'oc-fra.wav','oc-orc.wav','royal.wav','royer.wav','startme.wav','stereo.wav',
];

function listAudioFiles(audioDir) {
  try {
    if (fs.existsSync(audioDir)) {
      const files = fs.readdirSync(audioDir)
        .filter(f => f.toLowerCase().endsWith('.wav'))
        .sort();
      if (files.length > 0) return files;
    }
  } catch { /* fall through */ }
  return FALLBACK_AUDIO;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
async function main() {
  const config = loadConfig();

  console.log(`[${ts()}] [SERVER] Starting SignalFi Web`);
  console.log(`[${ts()}] [SERVER] MQTT broker: ${config.mqtt.host}:${config.mqtt.port}`);
  console.log(`[${ts()}] [SERVER] HTTP listen: ${config.http.host}:${config.http.port}`);
  console.log(`[${ts()}] [SERVER] Data dir:    ${config.paths.dataDir}`);

  // ---- Load persisted state ----
  const persisted = persistence.load(config.paths.dataDir);
  state.loadState(persisted);
  console.log(`[${ts()}] [SERVER] Loaded persisted state: ${persisted.scouts.length} scouts, ${persisted.presets.length} presets`);

  // ---- Build Express app ----
  const app = express();
  app.use(express.json());

  // Static files
  const staticDir = path.resolve(config.http.staticDir);
  if (fs.existsSync(staticDir)) {
    app.use(express.static(staticDir));
    console.log(`[${ts()}] [SERVER] Serving static files from ${staticDir}`);
  } else {
    console.warn(`[${ts()}] [SERVER] Static dir not found: ${staticDir} (continuing without static files)`);
  }

  // ---- HTTP server ----
  const httpServer = http.createServer(app);

  // ---- WebSocket server ----
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  let mqttOnline = false;

  // ---- Broadcast helper ----
  function broadcast(message) {
    const raw = JSON.stringify(message);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) {
        try {
          client.send(raw);
        } catch (err) {
          console.error(`[${ts()}] [WS] Send error:`, err.message);
        }
      }
    }
  }

  // Debounced full-state broadcast (aggregates rapid MQTT messages)
  let fullStateBroadcastHandle = null;
  function scheduledFullStateBroadcast() {
    if (fullStateBroadcastHandle) clearTimeout(fullStateBroadcastHandle);
    fullStateBroadcastHandle = setTimeout(() => {
      fullStateBroadcastHandle = null;
      broadcast({
        type:       'state',
        ...state.getState(),
        mqttOnline,
        audioFiles: listAudioFiles(config.paths.audioDir),
      });
    }, 200);
  }

  // ---- Mount REST routes ----
  app.use('/api', createRouter(config, state, persistence, broadcast));

  // ---- WS connection handler ----
  wss.on('connection', (ws, req) => {
    const remoteIp = req.socket.remoteAddress;
    console.log(`[${ts()}] [WS] Client connected from ${remoteIp} (total: ${wss.clients.size})`);

    // Send full state snapshot immediately
    try {
      ws.send(JSON.stringify({
        type:       'state',
        ...state.getState(),
        mqttOnline,
        audioFiles: listAudioFiles(config.paths.audioDir),
      }));
    } catch (err) {
      console.error(`[${ts()}] [WS] Failed to send initial state:`, err.message);
    }

    // Trigger a get broadcast so all devices report their current state
    const prefix = config.mqtt.topicPrefix;
    mqttModule.publish(`${prefix}/$broadcast/$action`, JSON.stringify({ act: 'get' }));

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        console.warn(`[${ts()}] [WS] Received non-JSON message from ${remoteIp}`);
        return;
      }

      console.log(`[${ts()}] [WS] Command from ${remoteIp}: cmd=${msg.cmd}`);

      try {
        handleCommand(config, msg, broadcast);
      } catch (err) {
        console.error(`[${ts()}] [WS] Command handling error:`, err.message);
      }
    });

    ws.on('close', () => {
      console.log(`[${ts()}] [WS] Client disconnected from ${remoteIp} (total: ${wss.clients.size})`);
    });

    ws.on('error', (err) => {
      console.error(`[${ts()}] [WS] Client error from ${remoteIp}:`, err.message);
    });
  });

  // ---- MQTT message handler ----
  function onMqttMessage(mac, topic, payload) {
    console.log(`[${ts()}] [MQTT] MSG ${topic}`, JSON.stringify(payload).slice(0, 120));
    const topicEnd = topic.split('/').pop();

    if (topicEnd === '$state') {
      const delta = state.processScoutState(mac, payload);

      // Persist updated scouts + nodes
      persistence.saveScouts(config.paths.dataDir, state.getScouts());
      persistence.saveNodes(config.paths.dataDir, state.getNodes());

      // Send targeted delta updates
      if (delta.scoutUpdate) {
        broadcast({ type: 'scoutUpdate', ...delta.scoutUpdate });
      }
      if (delta.nodeUpdate) {
        broadcast({ type: 'nodeUpdate', nodes: delta.nodeUpdate.nodes });
      }

      // Schedule a debounced full-state broadcast
      scheduledFullStateBroadcast();

    } else if (topicEnd === '$msg') {
      state.processScoutMessage(mac, payload);
    }
  }

  // ---- MQTT status handler ----
  function onMqttStatus(status) {
    mqttOnline = status === 'connected';
    broadcast({ type: 'mqttStatus', status });
    if (mqttOnline) {
      scheduledFullStateBroadcast();
    }
  }

  // ---- Connect MQTT (non-fatal if broker is unreachable) ----
  try {
    mqttModule.connect(config.mqtt, onMqttMessage, onMqttStatus);
  } catch (err) {
    console.error(`[${ts()}] [MQTT] Failed to initiate connection:`, err.message);
    // Server continues running — MQTT will retry automatically
  }

  // ---- Start HTTP server ----
  await new Promise((resolve, reject) => {
    httpServer.listen(config.http.port, config.http.host, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });

  console.log(`[${ts()}] [SERVER] Listening on http://${config.http.host}:${config.http.port}`);
  console.log(`[${ts()}] [SERVER] WebSocket endpoint: ws://${config.http.host}:${config.http.port}/ws`);
  console.log(`[${ts()}] [SERVER] REST API: http://${config.http.host}:${config.http.port}/api/state`);

  // ---- Graceful shutdown ----
  function shutdown(signal) {
    console.log(`\n[${ts()}] [SERVER] Received ${signal} — shutting down gracefully`);

    // Persist final state before exit
    persistence.save(config.paths.dataDir, state.getState());

    wss.close(() => {
      httpServer.close(() => {
        console.log(`[${ts()}] [SERVER] HTTP server closed`);
        process.exit(0);
      });
    });

    // Force exit after 5 s
    setTimeout(() => {
      console.error(`[${ts()}] [SERVER] Forced exit after timeout`);
      process.exit(1);
    }, 5000).unref();
  }

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    console.error(`[${ts()}] [SERVER] Uncaught exception:`, err);
  });

  process.on('unhandledRejection', (reason) => {
    console.error(`[${ts()}] [SERVER] Unhandled rejection:`, reason);
  });
}

main().catch((err) => {
  console.error(`[${ts()}] [SERVER] Fatal startup error:`, err);
  process.exit(1);
});
