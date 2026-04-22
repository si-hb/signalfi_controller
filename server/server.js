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
      dataDir:  process.env.DATA_DIR  || fileConfig.paths?.dataDir  || './data',
      audioDir: process.env.AUDIO_DIR || fileConfig.paths?.audioDir || './audio',
    },
    auth: {
      token:        process.env.AUTH_TOKEN        || fileConfig.auth?.token        || '',
      noderedAuthUrl: process.env.NODERED_AUTH_URL || fileConfig.auth?.noderedAuthUrl || '',
    },
  };
}

// ---------------------------------------------------------------------------
// OTP / SMS auth store (in-memory, per process lifetime)
// ---------------------------------------------------------------------------
const crypto = require('crypto');

const OTP_TTL_MS       = 5  * 60 * 1000;
const SESSION_TTL_MS   = 365 * 24 * 60 * 60 * 1000; // permanent — browser sessionStorage clears on refresh
const OTP_MAX_ATTEMPTS = 5;

const otpStore     = new Map(); // normPhone → { code, expiresAt, attempts }
const sessionStore = new Map(); // token     → { phone, expiresAt }

function normPhone(p) { return p.replace(/\D/g, ''); }
function genOtp()     { return String(Math.floor(100000 + Math.random() * 900000)); }
function genSession() { return crypto.randomBytes(32).toString('hex'); }

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of otpStore)     if (v.expiresAt < now) otpStore.delete(k);
  for (const [k, v] of sessionStore) if (v.expiresAt < now) sessionStore.delete(k);
}, 60_000);

// ---------------------------------------------------------------------------
// Authentication middleware — Bearer token or SMS session
// ---------------------------------------------------------------------------
function createAuthMiddleware(config) {
  return (req, res, next) => {
    // Air-gap escape hatch: deployments without SMS connectivity set
    // DISABLE_OTP=true to bypass phone-code auth entirely.  Static
    // ADMIN_TOKEN still works if set.  Never ship a production image with
    // this flag — it exists so offline installs can use the admin UI.
    if (process.env.DISABLE_OTP === 'true' || process.env.DISABLE_OTP === '1') return next();
    if (!config.auth.token && !config.auth.noderedAuthUrl) return next();

    // Allow health checks from localhost without auth
    const ip = req.ip || req.connection.remoteAddress;
    if ((ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') && req.path === '/state') {
      return next();
    }

    const authHeader = req.headers.authorization || '';
    const match = authHeader.match(/^Bearer\s+(.+)$/);
    const bearer = match ? match[1] : (req.query.token || '');

    // Legacy static token
    if (config.auth.token && bearer === config.auth.token) return next();

    // SMS session token
    const session = sessionStore.get(bearer);
    if (session && session.expiresAt > Date.now()) return next();

    const now = new Date().toISOString();
    console.warn(`[${now}] [AUTH] Unauthorized access attempt to ${req.method} ${req.path}`);
    return res.status(401).json({ error: 'Unauthorized' });
  };
}

// Same check used by WebSocket verifyClient
function isValidToken(config, bearer) {
  if (process.env.DISABLE_OTP === 'true' || process.env.DISABLE_OTP === '1') return true;
  if (!config.auth.token && !config.auth.noderedAuthUrl) return true;
  if (config.auth.token && bearer === config.auth.token) return true;
  const session = sessionStore.get(bearer);
  return !!(session && session.expiresAt > Date.now());
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


  if (cmd === 'cpuLed' && msg.mac) {
    const prefix = config.mqtt.topicPrefix;
    publishToTopics([`${prefix}/${msg.mac}/$action`], { act: 'cpu', cpu: !!msg.cpu });
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
    // announcePreset — node-red (and other in-stack publishers) send
    // { cmd: 'announcePreset', preset: 'Chime3 Blue', destination, target,
    //   syncOffset } over the scout/$server/cmd MQTT topic.  We look up
    // the preset in in-memory state (populated at startup from
    // data/presets.json) and hand off to the announce path so the wire
    // format matches what the UI's "Live Announce on Tap" produces.
    case 'announcePreset': {
      const presetName = typeof msg.preset === 'string' ? msg.preset : '';
      if (!presetName) {
        console.warn(`[${ts()}] [CMD] announcePreset: missing "preset" name`);
        return;
      }
      const preset = state.getPresets().find(p => p.name === presetName);
      if (!preset) {
        const known = state.getPresets().map(p => p.name).join(', ') || '(none loaded)';
        console.warn(`[${ts()}] [CMD] announcePreset: unknown preset "${presetName}" — known: ${known}`);
        return;
      }
      return handleCommand(config, {
        cmd:         'announce',
        destination: msg.destination,
        target:      msg.target,
        colour:      '#' + preset.clr,
        brightness:  preset.brt,
        pattern:     preset.pat,
        timeout:     preset.dur,
        audio:       preset.aud || null,
        loops:       preset.rpt,
        volume:      preset.vol,
        syncOffset:  msg.syncOffset ?? 0,
      }, broadcast);
    }

    case 'announce': {
      const p = msg.payload || {};
      // Accept both flat fields (from UI) and short-key payload sub-object
      const followAudio = msg.followAudio ?? p.fol ?? false;
      payload = {
        act: 'ply',
        rpt: msg.loops   ?? p.rpt ?? 0,
        clr: normaliseColour(msg.colour ?? p.clr),
        pat: msg.pattern ?? p.pat ?? 1,
        dur: followAudio ? 0 : (msg.timeout ?? p.dur ?? 10) * 1000,
        brt: msg.brightness ?? p.brt ?? 200,
      };
      if (followAudio) payload.fol = true;
      // Only include vol when explicitly provided — omitting it lets devices use their stored default
      const vol = msg.volume ?? p.vol;
      if (vol != null) payload.vol = Math.round(vol * 1000) / 1000;
      const aud = msg.audio ?? p.aud ?? '';
      if (aud) payload.aud = aud;
      const syncOffset = msg.syncOffset ?? 0;
      if (syncOffset > 0) payload.syn = Date.now() + syncOffset;
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
function listAudioFiles(audioDir) {
  try {
    if (fs.existsSync(audioDir)) {
      return fs.readdirSync(audioDir)
        .filter(f => f.toLowerCase().endsWith('.wav'))
        .sort();
    }
  } catch { /* fall through */ }
  return [];
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
    let bearer = '';
    const authHeader = info.req.headers.authorization || '';
    const match = authHeader.match(/^Bearer\s+(.+)$/);
    if (match) bearer = match[1];
    if (!bearer && info.req.url) {
      const url = new URL(info.req.url, `http://${info.req.headers.host || 'localhost'}`);
      bearer = url.searchParams.get('token') || '';
    }
    if (isValidToken(config, bearer)) return callback(true);
    const now = new Date().toISOString();
    console.warn(`[${now}] [AUTH] Unauthorized WebSocket upgrade attempt`);
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

  // ---- OTP / SMS auth endpoints (unauthenticated) ----
  app.post('/auth/request', async (req, res) => {
    const raw   = String(req.body?.phone || '').trim();
    const phone = normPhone(raw);
    if (phone.length < 7 || phone.length > 15) return res.json({ accepted: false });
    if (!config.auth.noderedAuthUrl) {
      console.warn(`[${ts()}] [AUTH] NODERED_AUTH_URL not set — cannot deliver OTP`);
      return res.json({ accepted: false });
    }
    const code = genOtp();
    otpStore.set(phone, { code, expiresAt: Date.now() + OTP_TTL_MS, attempts: 0 });
    res.json({ accepted: true });
    fetch(config.auth.noderedAuthUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ phone: raw, code, origin: 'signalfi-control' }),
      signal:  AbortSignal.timeout(10000),
    }).then(async nr => {
      if (nr.ok) {
        const body = await nr.json().catch(() => ({}));
        const ttl  = Number(body.ttl) || 0;
        if (ttl > 0 && otpStore.has(phone)) otpStore.get(phone).sessionTtl = ttl * 1000;
        console.log(`[${ts()}] [AUTH] OTP sent to ${raw}${ttl ? ` (session TTL ${ttl}s)` : ''}`);
      } else {
        console.log(`[${ts()}] [AUTH] OTP rejected by Node-RED for ${raw} (${nr.status})`);
        otpStore.delete(phone);
      }
    }).catch(err => {
      console.error(`[${ts()}] [AUTH] Node-RED request failed:`, err.message);
      otpStore.delete(phone);
    });
  });

  app.post('/auth/verify', (req, res) => {
    const raw   = String(req.body?.phone || '').trim();
    const phone = normPhone(raw);
    const code  = String(req.body?.code  || '').trim();
    const entry = otpStore.get(phone);
    if (!entry || entry.expiresAt < Date.now()) return res.status(401).json({ error: 'expired' });
    entry.attempts++;
    if (entry.attempts > OTP_MAX_ATTEMPTS) {
      otpStore.delete(phone);
      return res.status(429).json({ error: 'too many attempts' });
    }
    if (entry.code !== code) return res.status(401).json({ error: 'invalid' });
    const ttlMs     = entry.sessionTtl || SESSION_TTL_MS;
    const expiresAt = Date.now() + ttlMs;
    otpStore.delete(phone);
    const token = genSession();
    sessionStore.set(token, { phone: raw, expiresAt });
    console.log(`[${ts()}] [AUTH] Session issued for ${raw} (expires ${new Date(expiresAt).toISOString()})`);
    return res.json({ token, expiresAt });
  });

  // DELETE /auth/sessions — terminate all sessions (internal network only, not exposed via Traefik)
  app.delete('/auth/sessions', (req, res) => {
    const count = sessionStore.size;
    sessionStore.clear();
    console.log(`[${ts()}] [AUTH] All sessions terminated (${count} cleared)`);
    // Push to all connected WS clients so they get kicked immediately
    broadcast({ type: 'session-terminated' });
    res.json({ cleared: count });
  });

  app.get('/auth/check', (req, res) => {
    const match  = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/);
    const bearer = match ? match[1] : '';
    if (config.auth.token && bearer === config.auth.token) return res.json({ valid: true, expiresAt: null });
    const session = sessionStore.get(bearer);
    if (session && session.expiresAt > Date.now()) return res.json({ valid: true, expiresAt: session.expiresAt });
    return res.status(401).json({ valid: false });
  });

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

  // ---- Server-command handler for scout/$server/cmd ----
  // Node-red (and other in-stack publishers) send JSON commands on that
  // topic; we funnel them through the same handleCommand() path the
  // WebSocket UI uses, so there's one execution pipeline for all
  // command-originated MQTT traffic.  All drops log and return — never
  // throw, since this runs inside the mqtt message callback.
  function onMqttServerCommand(payload) {
    if (!payload || typeof payload !== 'object' || typeof payload.cmd !== 'string') {
      console.warn(`[${ts()}] [MQTT] $server/cmd: dropped — payload must be an object with a string "cmd" field`);
      return;
    }
    console.log(`[${ts()}] [MQTT] $server/cmd: ${JSON.stringify(payload).slice(0, 200)}`);
    if (_logStore) {
      const entry = _logStore.add({
        ts: Date.now(), direction: 'rx', category: 'mqtt',
        topic: `${config.mqtt.topicPrefix}/$server/cmd`,
        payload: JSON.stringify(payload),
      });
      if (_broadcastFn) _broadcastFn({ type: 'logEntry', entry });
    }
    try {
      handleCommand(config, payload, broadcast);
    } catch (err) {
      console.error(`[${ts()}] [MQTT] $server/cmd handler error:`, err.message);
    }
  }

  // ---- Connect MQTT (non-fatal if broker is unreachable) ----
  try {
    mqttModule.connect(config.mqtt, onMqttMessage, onMqttStatus, onMqttServerCommand);
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

  // ---- Watch audio directory for changes and broadcast updated file list ----
  if (fs.existsSync(config.paths.audioDir)) {
    let audioWatchHandle = null;
    fs.watch(config.paths.audioDir, () => {
      if (audioWatchHandle) clearTimeout(audioWatchHandle);
      audioWatchHandle = setTimeout(() => {
        audioWatchHandle = null;
        console.log(`[${ts()}] [SERVER] Audio directory changed — broadcasting updated file list`);
        broadcast({
          type:       'state',
          ...state.getState(),
          mqttOnline,
          audioFiles: listAudioFiles(config.paths.audioDir),
        });
      }, 300);
    });
    console.log(`[${ts()}] [SERVER] Watching audio dir: ${config.paths.audioDir}`);
  }

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
