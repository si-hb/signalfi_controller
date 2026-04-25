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
      token: process.env.AUTH_TOKEN || fileConfig.auth?.token || '',
    },
  };
}

// ---------------------------------------------------------------------------
// Authentication — delegate to signalfi-manifest via authClient
// ---------------------------------------------------------------------------
//
// Web doesn't store user records.  authClient.checkToken() asks manifest
// to validate the bearer (with a 60-second cache).  Permission gate
// here is webAccess; manifest owns the user database and permission
// flags themselves.  AUTH_TOKEN (deprecated) is honoured as a static
// bearer for one release so existing scripts keep working — tracked
// inside authClient via the manifest-side ADMIN_TOKEN forwarder.

const authClient = require('./authClient');

const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
let warnedAuthToken = false;

// Returns { valid, status, permissions, username, mustChangePassword }.
// Falls through to a cache-aware manifest validation; static AUTH_TOKEN
// (deprecated) is treated as a synthetic webAccess+admin session.
async function validateBearer(bearer) {
  if (!bearer) return { valid: false, status: 401 };
  if (AUTH_TOKEN && bearer === AUTH_TOKEN) {
    if (!warnedAuthToken) {
      console.warn(`[${ts()}] [AUTH] DEPRECATED: AUTH_TOKEN bearer used. Migrate to a per-user account; AUTH_TOKEN will be removed in the next release.`);
      warnedAuthToken = true;
    }
    return {
      valid: true,
      username: '__auth_token__',
      permissions: { administrator: true, webAccess: true, manifestAccess: true },
      mustChangePassword: false,
      isAuthToken: true,
    };
  }
  return authClient.checkToken(bearer);
}

// Express middleware factory — same shape the routes previously expected.
function createAuthMiddleware() {
  return async (req, res, next) => {
    // Allow health checks from localhost without auth
    const ip = req.ip || req.connection.remoteAddress;
    if ((ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') && req.path === '/state') {
      return next();
    }
    const authHeader = req.headers.authorization || '';
    const match = authHeader.match(/^Bearer\s+(.+)$/);
    const bearer = match ? match[1] : (req.query.token || '');
    const result = await validateBearer(bearer);
    if (!result.valid) {
      if (result.upstreamError) return res.status(503).json({ error: 'auth service unreachable' });
      console.warn(`[${ts()}] [AUTH] Unauthorized ${req.method} ${req.path}`);
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!result.isAuthToken && result.mustChangePassword) {
      return res.status(403).json({ error: 'password-change-required' });
    }
    if (!result.permissions || !result.permissions.webAccess) {
      return res.status(403).json({ error: 'requires webAccess' });
    }
    req.user  = result;
    req.token = bearer;
    return next();
  };
}

// Used by WebSocket verifyClient — async-friendly.  Returns a boolean.
async function isValidToken(_config, bearer) {
  const r = await validateBearer(bearer);
  if (!r.valid) return false;
  if (!r.isAuthToken && r.mustChangePassword) return false;
  return !!(r.permissions && r.permissions.webAccess);
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
      // useDeviceVol=true → omit volume from the announce payload so the
      // firmware's `vol != null` guard (see case 'announce' below) drops
      // the vol key from the outgoing ply.  Devices treat an absent vol
      // as "use my stored default" — matches the firmware convention
      // where every preset field is optional and the device fills in
      // what's missing.  Defaults to false to preserve the pre-existing
      // behaviour of forcing the preset's vol onto every device.
      const useDeviceVol = msg.useDeviceVol === true;
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
        volume:      useDeviceVol ? undefined : preset.vol,
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
  async function verifyClient(info, callback) {
    let bearer = '';
    const authHeader = info.req.headers.authorization || '';
    const match = authHeader.match(/^Bearer\s+(.+)$/);
    if (match) bearer = match[1];
    if (!bearer && info.req.url) {
      const url = new URL(info.req.url, `http://${info.req.headers.host || 'localhost'}`);
      bearer = url.searchParams.get('token') || '';
    }
    try {
      const ok = await isValidToken(config, bearer);
      if (ok) return callback(true);
    } catch (err) {
      console.error(`[${ts()}] [AUTH] WS verifyClient threw: ${err.message}`);
    }
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

  // ---- /auth/* — same-origin proxies to signalfi-manifest ----
  // The browser never talks directly to manifest because of CORS;
  // these proxies forward the bearer + body and return the manifest
  // response verbatim.  /auth/invalidate is the back-channel manifest
  // calls when a user logs out or has their permissions changed.

  async function proxyToManifest(method, path, req, res, { forwardBearer = true } = {}) {
    const url = `${authClient.MANIFEST_URL}${path}`;
    const headers = { 'Content-Type': 'application/json' };
    if (forwardBearer && req.headers.authorization) headers.Authorization = req.headers.authorization;
    try {
      const r = await fetch(url, {
        method,
        headers,
        body:   method === 'GET' ? undefined : JSON.stringify(req.body || {}),
        signal: AbortSignal.timeout(10000),
      });
      const body = await r.text();
      res.status(r.status);
      res.set('Content-Type', r.headers.get('content-type') || 'application/json');
      return res.send(body);
    } catch (err) {
      console.error(`[${ts()}] [AUTH] proxy ${method} ${path} failed:`, err.message);
      return res.status(502).json({ error: 'auth service unreachable' });
    }
  }

  app.post('/auth/login',           (req, res) => proxyToManifest('POST', '/ota/auth/login', req, res, { forwardBearer: false }));
  app.post('/auth/change-password', (req, res) => proxyToManifest('POST', '/ota/auth/change-password', req, res));
  app.post('/auth/logout', async (req, res) => {
    // Drop our cache entry up front so a quick reconnect doesn't get a
    // ghost grace-window result, then forward to manifest.
    const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/);
    if (m) authClient.invalidate(m[1]);
    return proxyToManifest('POST', '/ota/auth/logout', req, res);
  });
  app.get('/auth/check',            (req, res) => proxyToManifest('GET',  '/ota/auth/check', req, res));

  // DELETE /auth/sessions — admin: terminate everything everywhere.
  app.delete('/auth/sessions', async (req, res) => {
    authClient.invalidateAll();
    broadcast({ type: 'session-terminated' });
    return proxyToManifest('DELETE', '/ota/auth/sessions', req, res);
  });

  // POST /auth/invalidate {token?, all?}
  // Internal-only — manifest calls this on logout/role-change.  No auth
  // header expected; the docker-network mount is the boundary.  We
  // refuse public exposure by checking req.ip against a small allowlist.
  app.post('/auth/invalidate', (req, res) => {
    const ip = req.ip || req.connection.remoteAddress || '';
    // Accept loopback + RFC1918 + IPv6-private — manifest is on the
    // same docker network, never reachable from the public internet.
    const isInternal = ip === '127.0.0.1' || ip === '::1' || ip.startsWith('::ffff:127.')
      || /^(::ffff:)?(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(ip);
    if (!isInternal) {
      console.warn(`[${ts()}] [AUTH] /auth/invalidate refused from ${ip}`);
      return res.status(403).json({ error: 'forbidden' });
    }
    if (req.body?.all) {
      authClient.invalidateAll();
      broadcast({ type: 'session-terminated' });
    } else if (req.body?.token) {
      authClient.invalidate(req.body.token);
    }
    return res.json({ ok: true });
  });

  // ---- Mount REST routes with auth middleware ----
  app.use('/api', createAuthMiddleware(), createRouter(config, state, persistence, broadcast, logStore));

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
        // Node list changed (new device, path change, offline transition)
        // — republish the retained online-only tree for MQTT subscribers.
        publishNodes();
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
      // Seed the retained scout/$server/presets + /nodes topics so any
      // subscriber (including a node-red that reconnected before us)
      // picks up the current lists immediately.
      publishPresets();
      publishNodes();
    }
  }

  // Publish the full preset list as a retained message so any subscriber
  // (primarily node-red) can see the current presets just by subscribing
  // to scout/$server/presets — no request needed.  Retained means new
  // subscribers get the latest value immediately on subscribe.  Called
  // when MQTT connects, on explicit getPresets commands, and from the
  // preset POST/DELETE routes (see routes.js).
  function publishPresets() {
    const prefix = config.mqtt.topicPrefix;
    mqttModule.publish(`${prefix}/$server/presets`, state.getPresets(), { retain: true });
  }

  // Same pattern as publishPresets but for the node tree.  The list
  // published here is filtered to nodes whose members are not offline
  // (see state.getOnlineNodes) — so node-red targeting ends up with only
  // groups that currently have a reachable device, matching what a user
  // would see in the UI's active-devices view.  Retained so new
  // subscribers (including node-red after a flow redeploy) get the
  // current list immediately.
  function publishNodes() {
    const prefix = config.mqtt.topicPrefix;
    mqttModule.publish(`${prefix}/$server/nodes`, state.getOnlineNodes(), { retain: true });
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
    // getPresets — republish the retained scout/$server/presets list.
    // Handled here (not inside handleCommand) because publishPresets lives
    // in the mqtt-connection scope.  Also spares the device-facing
    // buildTopics() / publishToTopics() machinery that handleCommand
    // runs before its switch — a retained-topic publish shouldn't be
    // gated on destination/target resolution.
    if (payload.cmd === 'getPresets') {
      publishPresets();
      return;
    }
    if (payload.cmd === 'getNodes') {
      publishNodes();
      return;
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
