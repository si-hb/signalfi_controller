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
const LogStore    = require('./logger');

// Module-level references set once main() wires everything up
let _logStore    = null;
let _broadcastFn = null;

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
// Authentication middleware — Bearer token validation
// ---------------------------------------------------------------------------
function createAuthMiddleware(config) {
  return (req, res, next) => {
    // If AUTH_TOKEN is not configured, skip auth (disabled)
    if (!config.auth.token || config.auth.token.trim() === '') {
      return next();
    }

    // Allow health checks from localhost (127.0.0.1 or ::1) without auth
    const ip = req.ip || req.connection.remoteAddress;
    if ((ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') && req.path === '/state') {
      return next();
    }

    // Extract Authorization header
    const authHeader = req.headers.authorization || '';
    const match = authHeader.match(/^Bearer\s+(.+)$/);
    const token = match ? match[1] : '';

    if (token === config.auth.token) {
      return next();
    }

    // Auth failed
    const ts = new Date().toISOString();
    console.warn(`[${ts}] [AUTH] Unauthorized access attempt to ${req.method} ${req.path}`);
    return res.status(401).json({ error: 'Unauthorized' });
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
// Topic / MAC helpers
// ---------------------------------------------------------------------------

/**
 * Extract a MAC address or group node path from an MQTT topic.
 * Returns { mac, node } — one or both may be null.
 *
 * Topic shapes:
 *   scout/$broadcast/$action          → { mac: null, node: null }
 *   scout/$group/sym/office/$action   → { mac: null, node: 'sym/office' }
 *   scout/AABBCCDDEEFF/$action        → { mac: 'AABBCCDDEEFF', node: null }
 */
function extractTopicMeta(topic) {
  const parts = topic.split('/');
  if (parts[1] === '$broadcast') return { mac: null, node: null };
  if (parts[1] === '$group') {
    const node = parts.slice(2, -1).join('/');
    return { mac: null, node: node || null };
  }
  return { mac: parts[1] || null, node: null };
}

/**
 * Build a short human-readable description of a WS client from its User-Agent.
 */
function describeClient(ip, ua) {
  if (!ua) return ip;

  let browser = '';
  if (/Edg\//i.test(ua))     browser = 'Edge';
  else if (/Chrome/i.test(ua))  browser = 'Chrome';
  else if (/Firefox/i.test(ua)) browser = 'Firefox';
  else if (/Safari/i.test(ua))  browser = 'Safari';
  else if (/curl/i.test(ua))    browser = 'curl';

  let device = '';
  if (/iPad/i.test(ua))                 device = 'iPad';
  else if (/iPhone/i.test(ua))          device = 'iPhone';
  else if (/Android.*Mobile/i.test(ua)) device = 'Android';
  else if (/Android/i.test(ua))         device = 'Android Tablet';
  else if (/Macintosh/i.test(ua))       device = 'Mac';
  else if (/Windows NT/i.test(ua))      device = 'Windows';
  else if (/Linux/i.test(ua))           device = 'Linux';

  const parts = [browser, device].filter(Boolean).join(' / ');
  return parts ? `${ip} (${parts})` : ip;
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

    if (_logStore) {
      const { mac, node } = extractTopicMeta(topic);
      const entry = _logStore.add({ ts: Date.now(), direction: 'tx', category: 'mqtt', mac, topic, payload: raw, node });
      if (_broadcastFn) _broadcastFn({ type: 'logEntry', entry });
    }
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

  if (cmd === 'setNode' && msg.mac && !destination) {
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
        rpt: msg.loops   ?? p.rpt ?? 0,
        clr: normaliseColour(msg.colour ?? p.clr),
        pat: msg.pattern ?? p.pat ?? 1,
        dur: (msg.timeout ?? p.dur ?? 10) * 1000,
        brt: msg.brightness ?? p.brt ?? 200,
      };
      // Only include vol when explicitly provided — omitting it lets devices use their stored default
      const vol = msg.volume ?? p.vol;
      if (vol != null) payload.vol = vol;
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

    case 'setNode':
      payload = { act: 'nod', nod: msg.node || '' };
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

  // ---- Log store ----
  const logStore = new LogStore(config.paths.dataDir);
  _logStore = logStore;

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

  // ---- WebSocket server with auth verification ----
  function verifyClient(info, callback) {
    // If AUTH_TOKEN is not configured, allow all connections
    if (!config.auth.token || config.auth.token.trim() === '') {
      return callback(true);
    }

    // Extract Bearer token from either header or query parameter
    let token = '';

    // Try Authorization header first
    const authHeader = info.req.headers.authorization || '';
    const match = authHeader.match(/^Bearer\s+(.+)$/);
    if (match) {
      token = match[1];
    }

    // Fall back to query parameter (?token=...)
    if (!token && info.req.url) {
      const url = new URL(info.req.url, `http://${info.req.headers.host || 'localhost'}`);
      token = url.searchParams.get('token') || '';
    }

    if (token === config.auth.token) {
      return callback(true);
    }

    const ts = new Date().toISOString();
    console.warn(`[${ts}] [AUTH] Unauthorized WebSocket upgrade attempt`);
    return callback(false, 401, 'Unauthorized');
  }

  const wss = new WebSocketServer({ server: httpServer, path: '/ws', verifyClient });

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

  _broadcastFn = broadcast;

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

  // ---- Mount REST routes with auth middleware ----
  app.use('/api', createAuthMiddleware(config), createRouter(config, state, persistence, broadcast, logStore));

  // ---- WS connection handler ----
  wss.on('connection', (ws, req) => {
    const remoteIp  = req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'] || '';
    const clientDesc = describeClient(remoteIp, userAgent);
    console.log(`[${ts()}] [WS] Client connected from ${clientDesc} (total: ${wss.clients.size})`);

    if (_logStore) {
      const entry = _logStore.add({
        ts: Date.now(), direction: 'sys', category: 'client',
        payload: JSON.stringify({ event: 'connect', ip: remoteIp, client: clientDesc }),
      });
      broadcast({ type: 'logEntry', entry });
    }

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

      if (msg.cmd === 'clearLog') {
        if (_logStore) {
          _logStore.clear();
          console.log(`[${ts()}] [WS] Log cleared by ${remoteIp}`);
        }
        return;
      }

      try {
        handleCommand(config, msg, broadcast);
      } catch (err) {
        console.error(`[${ts()}] [WS] Command handling error:`, err.message);
      }
    });

    ws.on('close', () => {
      console.log(`[${ts()}] [WS] Client disconnected from ${clientDesc} (total: ${wss.clients.size})`);
      if (_logStore) {
        const entry = _logStore.add({
          ts: Date.now(), direction: 'sys', category: 'client',
          payload: JSON.stringify({ event: 'disconnect', ip: remoteIp, client: clientDesc }),
        });
        if (_broadcastFn) _broadcastFn({ type: 'logEntry', entry });
      }
    });

    ws.on('error', (err) => {
      console.error(`[${ts()}] [WS] Client error from ${remoteIp}:`, err.message);
    });
  });

  // ---- MQTT message handler ----
  function onMqttMessage(mac, topic, payload) {
    console.log(`[${ts()}] [MQTT] MSG ${topic}`, JSON.stringify(payload).slice(0, 120));

    if (_logStore) {
      const scout = state.getScouts().find(s => s.mac === mac);
      const raw   = JSON.stringify(payload);
      const entry = _logStore.add({
        ts: Date.now(), direction: 'rx', category: 'mqtt',
        mac, topic, payload: raw, node: scout ? scout.node : null,
      });
      broadcast({ type: 'logEntry', entry });
    }

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

    if (_logStore) {
      const entry = _logStore.add({
        ts: Date.now(), direction: 'sys', category: 'server',
        topic: `${config.mqtt.host}:${config.mqtt.port}`,
        payload: `MQTT broker: ${status}`,
      });
      broadcast({ type: 'logEntry', entry });
    }

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

  logStore.add({
    ts: Date.now(), direction: 'sys', category: 'server',
    payload: `Server started — port ${config.http.port}, MQTT ${config.mqtt.host}:${config.mqtt.port}`,
  });

  // ---- Graceful shutdown ----
  function shutdown(signal) {
    console.log(`\n[${ts()}] [SERVER] Received ${signal} — shutting down gracefully`);

    logStore.add({
      ts: Date.now(), direction: 'sys', category: 'server',
      payload: `Server shutting down (${signal})`,
    });
    logStore.close();

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
