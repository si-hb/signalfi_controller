'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mqtt = require('mqtt');

const app = express();
app.use(express.json());

const PORT          = process.env.PORT          || 3001;
const MANIFEST_ROOT = process.env.MANIFEST_ROOT || '/opt/signalfi/manifests';
const TOKEN_ROOT    = process.env.TOKEN_ROOT    || '/opt/signalfi/tokens';
const REPORTS_ROOT  = process.env.REPORTS_ROOT  || '/opt/signalfi/reports';
const CONFIG_ROOT   = process.env.CONFIG_ROOT   || '/opt/signalfi/configs';
const MQTT_BROKER   = process.env.MQTT_BROKER_URL || 'mqtt://signalfi-svc:OtaService2024!@mosquitto:1883';
const MQTT_PREFIX   = process.env.MQTT_TOPIC_PREFIX || 'scout';

const TOKEN_RE = /^[0-9a-f]{64}$/i;

console.log(`[manifest] starting v2`);
console.log(`[manifest] manifest root: ${MANIFEST_ROOT}`);
console.log(`[manifest] token root:    ${TOKEN_ROOT}`);
console.log(`[manifest] reports root:  ${REPORTS_ROOT}`);
console.log(`[manifest] config root:   ${CONFIG_ROOT}`);
console.log(`[manifest] mqtt broker:   ${MQTT_BROKER}`);
console.log(`[manifest] mqtt prefix:   ${MQTT_PREFIX}`);

// ── MQTT client ──────────────────────────────────────────────────────────────

let mqttClient = null;

function connectMqtt() {
  mqttClient = mqtt.connect(MQTT_BROKER, {
    reconnectPeriod: 5000,
    connectTimeout: 10000,
    clientId: `signalfi-manifest-${Date.now()}`,
  });
  mqttClient.on('connect',  () => console.log(`[mqtt] connected to ${MQTT_BROKER}`));
  mqttClient.on('error',   err => console.error(`[mqtt] error: ${err.message}`));
  mqttClient.on('offline',  () => console.log('[mqtt] offline — will reconnect'));
}

connectMqtt();

function mqttPublish(topic, payload) {
  if (mqttClient && mqttClient.connected) {
    mqttClient.publish(topic, payload, { retain: true }, err => {
      if (err) console.error(`[mqtt] publish error: ${err.message}`);
      else     console.log(`[mqtt] published → ${topic}: ${payload}`);
    });
  } else {
    console.warn(`[mqtt] not connected — skipped publish to ${topic}`);
  }
}

function fileSha256(filePath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch (_) { return null; }
}

// ── OTA manifest watcher → MQTT push ─────────────────────────────────────────
// Watches manifests/models/*.json — publishes to:
//   <prefix>/$group/<modelId>/$ota
// Devices subscribe to:
//   <prefix>/$broadcast/$ota        — mass OTA
//   <prefix>/$group/<modelId>/$ota  — model-specific notification
//   <prefix>/<MAC>/$ota             — device-specific (future)

const MODELS_DIR = path.join(MANIFEST_ROOT, 'models');

function publishOtaNotification(filePath) {
  try {
    const manifest = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!manifest.update) return;
    const modelId = path.basename(filePath, '.json');
    const topic   = `${MQTT_PREFIX}/$group/${modelId}/$ota`;
    const payload = JSON.stringify({ modelId, version: manifest.firmware?.version, update: true });
    mqttPublish(topic, payload);
  } catch (err) {
    console.error(`[mqtt] OTA watch handler error: ${err.message}`);
  }
}

function watchManifests() {
  if (!fs.existsSync(MODELS_DIR)) {
    console.warn(`[manifest] models dir not found: ${MODELS_DIR}`);
    return;
  }
  fs.watch(MODELS_DIR, (eventType, filename) => {
    if (!filename || !filename.endsWith('.json')) return;
    setTimeout(() => publishOtaNotification(path.join(MODELS_DIR, filename)), 500);
  });
  console.log(`[manifest] watching ${MODELS_DIR} for OTA publish events`);
}

watchManifests();

// ── Config file watcher → MQTT push ──────────────────────────────────────────
// Watches configs/models/*.json  → publishes to <prefix>/$group/<modelId>/$config
// Watches configs/devices/*.json → publishes to <prefix>/<mac>/$config
// Payload includes URL, SHA256, Bearer token so device can fetch and validate.
// Devices subscribe to:
//   <prefix>/$broadcast/$config         — future: global config push
//   <prefix>/$group/<modelId>/$config   — model-level shared settings
//   <prefix>/<mac>/$config              — per-device overrides

const CONFIG_MODELS_DIR  = path.join(CONFIG_ROOT, 'models');
const CONFIG_DEVICES_DIR = path.join(CONFIG_ROOT, 'devices');
const CONFIG_BASE_URL    = process.env.CONFIG_BASE_URL || 'http://apis.symphonyinteractive.ca/ota/v1/config';

function buildConfigToken(id) {
  // Look for a matching token in TOKEN_ROOT (same expiry system as firmware tokens)
  try {
    const files = fs.readdirSync(TOKEN_ROOT);
    // Find a config-scoped token: any valid token prefixed with "cfg-<id>-"
    // OR accept any valid non-expired token if a dedicated one is not found.
    // Token file naming: <64hex>_cfg_<id>  or  <64hex>_cfg_<id>_exp<unix>
    for (const file of files) {
      const tag = `_cfg_${id}`;
      if (!file.includes(tag)) continue;
      const hex = file.substring(0, 64);
      if (!TOKEN_RE.test(hex)) continue;
      const expMatch = file.match(/_exp(\d+)$/);
      if (expMatch && Date.now() / 1000 >= parseInt(expMatch[1], 10)) continue;
      return hex;
    }
  } catch (_) {}
  return null;
}

function publishConfigNotification(filePath, type) {
  try {
    if (!fs.existsSync(filePath)) return;
    const base    = path.basename(filePath, '.json');
    const sha256  = fileSha256(filePath);
    const token   = buildConfigToken(base);
    const url     = `${CONFIG_BASE_URL}/${type}s/${base}.json`;
    const topic   = type === 'model'
      ? `${MQTT_PREFIX}/$group/${base}/$config`
      : `${MQTT_PREFIX}/${base}/$config`;
    const payload = JSON.stringify({ type, ...(type==='model' ? { modelId: base } : { mac: base }), url, sha256, token });
    mqttPublish(topic, payload);
  } catch (err) {
    console.error(`[mqtt] config watch handler error: ${err.message}`);
  }
}

function watchConfigs() {
  for (const [dir, type] of [[CONFIG_MODELS_DIR, 'model'], [CONFIG_DEVICES_DIR, 'device']]) {
    if (!fs.existsSync(dir)) {
      console.warn(`[config] dir not found, skipping watch: ${dir}`);
      continue;
    }
    fs.watch(dir, (eventType, filename) => {
      if (!filename || !filename.endsWith('.json')) return;
      setTimeout(() => publishConfigNotification(path.join(dir, filename), type), 500);
    });
    console.log(`[config] watching ${dir} for config publish events`);
  }
}

watchConfigs();

// ── Token validation ──────────────────────────────────────────────────────────

function validateToken(token) {
  if (!token || !TOKEN_RE.test(token)) return false;
  if (fs.existsSync(path.join(TOKEN_ROOT, token))) return true;
  try {
    const files = fs.readdirSync(TOKEN_ROOT);
    for (const file of files) {
      if (!file.startsWith(token + '_exp') && !file.startsWith(token + '_cfg')) continue;
      if (file.startsWith(token + '_cfg')) {
        const expMatch = file.match(/_exp(\d+)$/);
        if (expMatch && Date.now() / 1000 >= parseInt(expMatch[1], 10)) { continue; }
        return true;
      }
      const m = file.match(/_exp(\d+)$/);
      if (!m) continue;
      if (Date.now() / 1000 < parseInt(m[1], 10)) return true;
      console.log(`[validate] token expired at ${new Date(parseInt(m[1],10) * 1000).toISOString()}`);
      return false;
    }
  } catch (_) {}
  return false;
}

// ── Routes ───────────────────────────────────────────────────────────────────

app.get('/ota/v1/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/ota/health',    (_req, res) => res.json({ status: 'ok' }));

app.get('/ota/v1/manifest', (req, res) => {
  const modelId = req.query.modelId;
  const firmwareVersion = req.query.firmwareVersion || null;

  if (!modelId) return res.status(400).json({ error: 'modelId query parameter required' });

  const modelPath   = path.join(MANIFEST_ROOT, 'models', `${modelId}.json`);
  const defaultPath = path.join(MANIFEST_ROOT, 'default.json');

  let filePath = null;
  if (fs.existsSync(modelPath))   { filePath = modelPath;   console.log(`[manifest] ${modelId} -> model manifest`); }
  else if (fs.existsSync(defaultPath)) { filePath = defaultPath; console.log(`[manifest] ${modelId} -> default manifest`); }
  else return res.status(404).json({ error: 'no manifest found for this model' });

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error(`[manifest] failed to read ${filePath}: ${err.message}`);
    return res.status(500).json({ error: 'failed to read manifest' });
  }

  if (manifest.update) {
    const compatibleFrom = manifest.compatibleFrom;
    if (Array.isArray(compatibleFrom)) {
      if (compatibleFrom.length === 0) {
        return res.json({ modelId, update: false, reason: 'no eligible versions configured' });
      }
      if (!compatibleFrom.includes('*')) {
        if (!firmwareVersion || !compatibleFrom.includes(firmwareVersion)) {
          return res.json({ modelId, update: false, reason: 'current firmware version not eligible' });
        }
      }
    }
  }

  const { compatibleFrom: _strip, ...response } = manifest;
  response.modelId = modelId;
  res.json(response);
});

app.get('/ota/v1/validate', (req, res) => {
  let token = null;
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) token = auth.slice(7).trim();
  if (!token) {
    const originalUri = req.headers['x-original-uri'];
    if (originalUri) {
      try { token = new URL(originalUri, 'http://x').searchParams.get('token'); } catch (_) {}
    }
  }
  if (!validateToken(token)) {
    console.log(`[validate] rejected`);
    return res.status(401).json({ valid: false });
  }
  console.log(`[validate] accepted`);
  res.json({ valid: true });
});

app.post('/ota/v1/report', (req, res) => {
  const { deviceId, modelId, firmwareVersion, status } = req.body || {};
  const entry = {
    timestamp: new Date().toISOString(),
    deviceId: deviceId || 'unknown', modelId: modelId || 'unknown',
    firmwareVersion: firmwareVersion || 'unknown', status: status || 'unknown',
    ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
  };
  console.log(`[report] ${JSON.stringify(entry)}`);
  try {
    fs.mkdirSync(REPORTS_ROOT, { recursive: true });
    fs.appendFileSync(path.join(REPORTS_ROOT, 'updates.log'), JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error(`[report] failed to write log: ${err.message}`);
  }
  res.json({ received: true });
});

app.listen(PORT, () => console.log(`[manifest] listening on port ${PORT}`));
