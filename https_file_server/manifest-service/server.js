'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');

const app = express();
app.use(express.json());

const PORT          = process.env.PORT          || 3001;
const MANIFEST_ROOT = process.env.MANIFEST_ROOT || '/opt/signalfi/manifests';
const TOKEN_ROOT    = process.env.TOKEN_ROOT    || '/opt/signalfi/tokens';
const REPORTS_ROOT  = process.env.REPORTS_ROOT  || '/opt/signalfi/reports';
const MQTT_BROKER   = process.env.MQTT_BROKER_URL || 'mqtt://signalfi-svc:OtaService2024!@mosquitto:1883';

const TOKEN_RE = /^[0-9a-f]{64}$/i;

console.log(`[manifest] starting v2`);
console.log(`[manifest] manifest root: ${MANIFEST_ROOT}`);
console.log(`[manifest] token root:    ${TOKEN_ROOT}`);
console.log(`[manifest] reports root:  ${REPORTS_ROOT}`);
console.log(`[manifest] mqtt broker:   ${MQTT_BROKER}`);

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

// ── Manifest file watcher → MQTT push ────────────────────────────────────────
// When a models/*.json file is written, publish to signalfi/ota/<modelId>
// so subscribed devices immediately know to check for an update.

const MODELS_DIR = path.join(MANIFEST_ROOT, 'models');

function publishOtaNotification(filePath) {
  try {
    const manifest = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!manifest.update) return;
    const modelId = path.basename(filePath, '.json');
    const topic   = `signalfi/ota/${modelId}`;
    const payload = JSON.stringify({ modelId, version: manifest.firmware?.version, update: true });
    if (mqttClient && mqttClient.connected) {
      mqttClient.publish(topic, payload, { retain: true }, err => {
        if (err) console.error(`[mqtt] publish error: ${err.message}`);
        else     console.log(`[mqtt] published → ${topic}: ${payload}`);
      });
    } else {
      console.warn(`[mqtt] not connected — skipped publish to ${topic}`);
    }
  } catch (err) {
    console.error(`[mqtt] watch handler error: ${err.message}`);
  }
}

function watchManifests() {
  if (!fs.existsSync(MODELS_DIR)) {
    console.warn(`[manifest] models dir not found: ${MODELS_DIR}`);
    return;
  }
  fs.watch(MODELS_DIR, (eventType, filename) => {
    if (!filename || !filename.endsWith('.json')) return;
    // Small delay to let the SFTP write fully flush
    setTimeout(() => publishOtaNotification(path.join(MODELS_DIR, filename)), 500);
  });
  console.log(`[manifest] watching ${MODELS_DIR} for OTA publish events`);
}

watchManifests();

// ── Token validation ──────────────────────────────────────────────────────────
// Token files:
//   <64-hex>              → eternal token
//   <64-hex>_exp<unix_s>  → token with expiry

function validateToken(token) {
  if (!token || !TOKEN_RE.test(token)) return false;

  // Exact match (no expiry)
  if (fs.existsSync(path.join(TOKEN_ROOT, token))) return true;

  // Expiry-suffixed token
  try {
    const files = fs.readdirSync(TOKEN_ROOT);
    for (const file of files) {
      if (!file.startsWith(token + '_exp')) continue;
      const m = file.match(/_exp(\d+)$/);
      if (!m) continue;
      const expiry = parseInt(m[1], 10);
      if (Date.now() / 1000 < expiry) return true;
      console.log(`[validate] token expired at ${new Date(expiry * 1000).toISOString()}`);
      return false;
    }
  } catch (_) {}

  return false;
}

// ── Routes ───────────────────────────────────────────────────────────────────

// Health checks
app.get('/ota/v1/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/ota/health',    (_req, res) => res.json({ status: 'ok' }));

// Manifest endpoint
app.get('/ota/v1/manifest', (req, res) => {
  const modelId = req.query.modelId;
  const firmwareVersion = req.query.firmwareVersion || null;

  if (!modelId) {
    return res.status(400).json({ error: 'modelId query parameter required' });
  }

  const modelPath   = path.join(MANIFEST_ROOT, 'models', `${modelId}.json`);
  const defaultPath = path.join(MANIFEST_ROOT, 'default.json');

  let filePath = null;
  if (fs.existsSync(modelPath)) {
    filePath = modelPath;
    console.log(`[manifest] ${modelId} -> model manifest`);
  } else if (fs.existsSync(defaultPath)) {
    filePath = defaultPath;
    console.log(`[manifest] ${modelId} -> default manifest`);
  } else {
    return res.status(404).json({ error: 'no manifest found for this model' });
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error(`[manifest] failed to read ${filePath}: ${err.message}`);
    return res.status(500).json({ error: 'failed to read manifest' });
  }

  // compatibleFrom semantics (only applies when update:true):
  //   []           → no devices eligible (must be explicit)
  //   ["*"]        → all versions eligible
  //   ["1.0","1.1"] → only listed versions eligible
  if (manifest.update) {
    const compatibleFrom = manifest.compatibleFrom;
    if (Array.isArray(compatibleFrom)) {
      if (compatibleFrom.length === 0) {
        return res.json({ modelId, update: false, reason: 'no eligible versions configured — set compatibleFrom to ["*"] or a version list' });
      }
      if (!compatibleFrom.includes('*')) {
        if (!firmwareVersion || !compatibleFrom.includes(firmwareVersion)) {
          console.log(`[manifest] ${modelId} v${firmwareVersion} not in compatibleFrom [${compatibleFrom}]`);
          return res.json({ modelId, update: false, reason: 'current firmware version not eligible for this update' });
        }
      }
    }
  }

  const { compatibleFrom: _strip, ...response } = manifest;
  response.modelId = modelId;
  res.json(response);
});

// Token validation — called internally by nginx auth_request
// Primary: Authorization: Bearer <64-hex>
// Fallback: X-Original-URI header with ?token= param (legacy / transition support)
app.get('/ota/v1/validate', (req, res) => {
  let token = null;

  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) {
    token = auth.slice(7).trim();
  }

  if (!token) {
    const originalUri = req.headers['x-original-uri'];
    if (originalUri) {
      try {
        token = new URL(originalUri, 'http://x').searchParams.get('token');
      } catch (_) {}
    }
  }

  if (!validateToken(token)) {
    console.log(`[validate] rejected — invalid or expired token`);
    return res.status(401).json({ valid: false });
  }

  console.log(`[validate] accepted — token valid`);
  res.json({ valid: true });
});

// Device reports successful update back to server
// POST /ota/v1/report { deviceId, modelId, firmwareVersion, status }
app.post('/ota/v1/report', (req, res) => {
  const { deviceId, modelId, firmwareVersion, status } = req.body || {};
  const entry = {
    timestamp:       new Date().toISOString(),
    deviceId:        deviceId || 'unknown',
    modelId:         modelId  || 'unknown',
    firmwareVersion: firmwareVersion || 'unknown',
    status:          status   || 'unknown',
    ip:              req.headers['x-forwarded-for'] || req.socket.remoteAddress,
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
