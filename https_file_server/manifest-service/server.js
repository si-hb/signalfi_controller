'use strict';

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const mqtt    = require('mqtt');
const multer  = require('multer');

const app = express();
app.use(express.json());

const PORT            = process.env.PORT            || 3001;
const MANIFEST_ROOT   = process.env.MANIFEST_ROOT   || '/opt/signalfi/manifests';
const TOKEN_ROOT      = process.env.TOKEN_ROOT      || '/opt/signalfi/tokens';
const REPORTS_ROOT    = process.env.REPORTS_ROOT    || '/opt/signalfi/reports';
const CONFIG_ROOT     = process.env.CONFIG_ROOT     || '/opt/signalfi/configs';
const FIRMWARE_ROOT   = process.env.FIRMWARE_ROOT   || '/opt/signalfi/files/firmware';
const AUDIO_ROOT      = process.env.AUDIO_ROOT      || '/opt/signalfi/files/audio';
const FILES_BASE_URL  = process.env.FILES_BASE_URL  || 'http://apis.symphonyinteractive.ca';
const FILES_PATH_PREFIX = process.env.FILES_PATH_PREFIX || '/ota/v1';
const ADMIN_TOKEN     = process.env.ADMIN_TOKEN     || '';
const MQTT_BROKER     = process.env.MQTT_BROKER_URL || 'mqtt://signalfi-svc:OtaService2024!@mosquitto:1883';
const MQTT_PREFIX     = process.env.MQTT_TOPIC_PREFIX || 'scout';

const TOKEN_RE = /^[0-9a-f]{64}$/i;

console.log(`[manifest] starting v2`);
console.log(`[manifest] manifest root: ${MANIFEST_ROOT}`);
console.log(`[manifest] firmware root: ${FIRMWARE_ROOT}`);
console.log(`[manifest] audio root:    ${AUDIO_ROOT}`);
console.log(`[manifest] token root:    ${TOKEN_ROOT}`);
console.log(`[manifest] reports root:  ${REPORTS_ROOT}`);
console.log(`[manifest] config root:   ${CONFIG_ROOT}`);
console.log(`[manifest] mqtt broker:   ${MQTT_BROKER}`);
console.log(`[manifest] mqtt prefix:   ${MQTT_PREFIX}`);
console.log(`[manifest] admin token:   ${ADMIN_TOKEN ? 'set' : 'UNSET (admin API is open)'}`);

// ── Ensure writable directories exist ────────────────────────────────────────

for (const dir of [FIRMWARE_ROOT, AUDIO_ROOT, path.join(MANIFEST_ROOT, 'models'), TOKEN_ROOT, REPORTS_ROOT]) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
}

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

function mqttPublish(topic, payload, retain = true) {
  if (mqttClient && mqttClient.connected) {
    mqttClient.publish(topic, payload, { retain }, err => {
      if (err) console.error(`[mqtt] publish error: ${err.message}`);
      else     console.log(`[mqtt] published → ${topic}: ${payload}`);
    });
  } else {
    console.warn(`[mqtt] not connected — skipped publish to ${topic}`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function fileSha256(filePath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch (_) { return null; }
}

function safeFilename(filename) {
  // Reject any path traversal attempts
  return typeof filename === 'string' && !filename.includes('/') && !filename.includes('\\') && filename.length > 0;
}

function listDir(dir, ext) {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => !ext || f.toLowerCase().endsWith(ext))
      .map(f => {
        const fp  = path.join(dir, f);
        const st  = fs.statSync(fp);
        return { name: f, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch (_) { return []; }
}

// ── OTA manifest watcher → MQTT push ─────────────────────────────────────────

const MODELS_DIR = path.join(MANIFEST_ROOT, 'models');

function publishOtaNotification(filePath) {
  try {
    const manifest = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!manifest.update) return;
    const modelId = path.basename(filePath, '.json');
    const topic   = `${MQTT_PREFIX}/$group/${modelId}/$action`;
    const payload = JSON.stringify({ act: 'frm', mdl: modelId });
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
  fs.watch(MODELS_DIR, (_eventType, filename) => {
    if (!filename || !filename.endsWith('.json')) return;
    setTimeout(() => publishOtaNotification(path.join(MODELS_DIR, filename)), 500);
  });
  console.log(`[manifest] watching ${MODELS_DIR} for OTA publish events`);
}

watchManifests();

// ── Config file watcher → MQTT push ──────────────────────────────────────────

const CONFIG_MODELS_DIR  = path.join(CONFIG_ROOT, 'models');
const CONFIG_DEVICES_DIR = path.join(CONFIG_ROOT, 'devices');
const CONFIG_BASE_URL    = process.env.CONFIG_BASE_URL || 'http://apis.symphonyinteractive.ca/ota/v1/config';

function buildConfigToken(id) {
  try {
    const files = fs.readdirSync(TOKEN_ROOT);
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
    const payload = JSON.stringify({ type, ...(type === 'model' ? { modelId: base } : { mac: base }), url, sha256, token });
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
    fs.watch(dir, (_eventType, filename) => {
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
      console.log(`[validate] token expired at ${new Date(parseInt(m[1], 10) * 1000).toISOString()}`);
      return false;
    }
  } catch (_) {}
  return false;
}

// ── Admin auth middleware ─────────────────────────────────────────────────────

function adminAuth(req, res, next) {
  if (!ADMIN_TOKEN || ADMIN_TOKEN.trim() === '') return next();
  const match = (req.headers['authorization'] || '').match(/^Bearer\s+(.+)$/);
  if (match && match[1] === ADMIN_TOKEN) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

// ── Admin static UI ───────────────────────────────────────────────────────────

app.use('/ota/admin', express.static(path.join(__dirname, 'public')));

// ── Admin API (protected) ─────────────────────────────────────────────────────

app.use('/ota/admin/api', adminAuth);

// ── Multer upload config ──────────────────────────────────────────────────────

const firmwareUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, FIRMWARE_ROOT),
    filename:    (_req, file,  cb) => cb(null, file.originalname),
  }),
  fileFilter: (_req, file, cb) => cb(null, file.originalname.toLowerCase().endsWith('.bin')),
  limits: { fileSize: 8 * 1024 * 1024 },
});

const audioUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, AUDIO_ROOT),
    filename:    (_req, file,  cb) => cb(null, file.originalname),
  }),
  fileFilter: (_req, file, cb) => cb(null, file.originalname.toLowerCase().endsWith('.wav')),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// ── Admin API — file listings ─────────────────────────────────────────────────

app.get('/ota/admin/api/files/firmware', (_req, res) => {
  const files = listDir(FIRMWARE_ROOT, '.bin').map(f => ({
    ...f,
    sha256: fileSha256(path.join(FIRMWARE_ROOT, f.name)),
  }));
  res.json(files);
});

app.get('/ota/admin/api/files/audio', (_req, res) => {
  res.json(listDir(AUDIO_ROOT, '.wav'));
});

app.get('/ota/admin/api/manifests', (_req, res) => {
  const files = listDir(MODELS_DIR, '.json');
  const manifests = files.map(f => {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(MODELS_DIR, f.name), 'utf8'));
      return { modelId: path.basename(f.name, '.json'), version: m.firmware?.version || m.version || null, update: !!m.update, mtime: f.mtime };
    } catch (_) {
      return { modelId: path.basename(f.name, '.json'), version: null, update: false, mtime: f.mtime };
    }
  });
  res.json(manifests);
});

app.get('/ota/admin/api/manifests/:modelId', (req, res) => {
  const { modelId } = req.params;
  if (!safeFilename(modelId)) return res.status(400).json({ error: 'invalid modelId' });
  const fp = path.join(MODELS_DIR, `${modelId}.json`);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'not found' });
  try {
    res.json(JSON.parse(fs.readFileSync(fp, 'utf8')));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/ota/admin/api/tokens', (_req, res) => {
  try {
    const files = fs.existsSync(TOKEN_ROOT) ? fs.readdirSync(TOKEN_ROOT) : [];
    const now = Date.now() / 1000;
    const tokens = files
      .filter(f => TOKEN_RE.test(f.substring(0, 64)))
      .map(f => {
        const hex = f.substring(0, 64);
        const expMatch = f.match(/_exp(\d+)/);
        const expiry = expMatch ? parseInt(expMatch[1], 10) : null;
        return {
          prefix: hex.slice(0, 8) + '…',
          expires: expiry ? new Date(expiry * 1000).toISOString() : null,
          expired: expiry ? now >= expiry : false,
          type: f.includes('_cfg_') ? 'config' : 'firmware',
        };
      })
      .sort((a, b) => (a.expired ? 1 : 0) - (b.expired ? 1 : 0));
    res.json(tokens);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/ota/admin/api/reports', (req, res) => {
  const page  = Math.max(0, parseInt(req.query.page  || '0', 10));
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10)));
  const logPath = path.join(REPORTS_ROOT, 'updates.log');
  try {
    if (!fs.existsSync(logPath)) return res.json({ total: 0, page, limit, entries: [] });
    const lines = fs.readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(l => l.trim())
      .reverse();  // newest first
    const total   = lines.length;
    const entries = lines.slice(page * limit, page * limit + limit).map(l => {
      try { return JSON.parse(l); } catch (_) { return { raw: l }; }
    });
    res.json({ total, page, limit, entries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin API — file uploads ──────────────────────────────────────────────────

app.post('/ota/admin/api/files/firmware', firmwareUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no .bin file received' });
  const sha256 = fileSha256(req.file.path);
  console.log(`[admin] firmware uploaded: ${req.file.originalname} (${req.file.size} bytes, sha256: ${sha256})`);
  res.json({ name: req.file.originalname, size: req.file.size, sha256 });
});

app.post('/ota/admin/api/files/audio', audioUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no .wav file received' });
  console.log(`[admin] audio uploaded: ${req.file.originalname} (${req.file.size} bytes)`);
  res.json({ name: req.file.originalname, size: req.file.size });
});

// ── Admin API — file deletes ──────────────────────────────────────────────────

app.delete('/ota/admin/api/files/firmware/:filename', (req, res) => {
  const { filename } = req.params;
  if (!safeFilename(filename)) return res.status(400).json({ error: 'invalid filename' });
  const fp = path.join(FIRMWARE_ROOT, filename);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'not found' });
  try {
    fs.unlinkSync(fp);
    console.log(`[admin] firmware deleted: ${filename}`);
    res.json({ deleted: filename });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/ota/admin/api/files/audio/:filename', (req, res) => {
  const { filename } = req.params;
  if (!safeFilename(filename)) return res.status(400).json({ error: 'invalid filename' });
  const fp = path.join(AUDIO_ROOT, filename);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'not found' });
  try {
    fs.unlinkSync(fp);
    console.log(`[admin] audio deleted: ${filename}`);
    res.json({ deleted: filename });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/ota/admin/api/manifests/:modelId', (req, res) => {
  const { modelId } = req.params;
  if (!safeFilename(modelId)) return res.status(400).json({ error: 'invalid modelId' });
  const fp = path.join(MODELS_DIR, `${modelId}.json`);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'not found' });
  try {
    fs.unlinkSync(fp);
    console.log(`[admin] manifest deleted: ${modelId}`);
    res.json({ deleted: modelId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin API — generate manifest ─────────────────────────────────────────────

app.post('/ota/admin/api/manifests/generate', (req, res) => {
  const {
    modelId,
    version,
    firmwareFile,
    audioFiles = [],
    compatibleFrom = ['*'],
    tokenDays = 30,
    reason = 'New firmware available',
    delaySeconds = 0,
  } = req.body || {};

  if (!modelId || !version || !firmwareFile)
    return res.status(400).json({ error: 'modelId, version, and firmwareFile are required' });
  if (!safeFilename(firmwareFile))
    return res.status(400).json({ error: 'invalid firmwareFile' });

  const firmwarePath = path.join(FIRMWARE_ROOT, firmwareFile);
  if (!fs.existsSync(firmwarePath))
    return res.status(400).json({ error: `firmware file not found: ${firmwareFile}` });

  try {
    // Generate download token
    const tokenHex    = crypto.randomBytes(32).toString('hex');
    const tokenExpiry = Math.floor(Date.now() / 1000) + Number(tokenDays) * 86400;
    // Write token file first — device may validate immediately after watcher fires
    fs.writeFileSync(path.join(TOKEN_ROOT, `${tokenHex}_exp${tokenExpiry}`), '');

    // Firmware SHA256 + size
    const firmwareSha256 = fileSha256(firmwarePath);
    const firmwareSize   = fs.statSync(firmwarePath).size;
    const firmwareFilename = `${modelId}-${version}.bin`;

    // Rename firmware to versioned name (if not already named that way)
    const versionedPath = path.join(FIRMWARE_ROOT, firmwareFilename);
    if (firmwarePath !== versionedPath && !fs.existsSync(versionedPath)) {
      fs.copyFileSync(firmwarePath, versionedPath);
    }

    // Audio entries
    const audioEntries = [];
    for (const af of audioFiles) {
      if (!safeFilename(af)) continue;
      const afPath = path.join(AUDIO_ROOT, af);
      if (!fs.existsSync(afPath)) {
        console.warn(`[admin] audio file not found, skipping: ${af}`);
        continue;
      }
      audioEntries.push({
        id:     af,
        url:    `${FILES_BASE_URL}${FILES_PATH_PREFIX}/audio/${af}`,
        sha256: fileSha256(afPath),
        size:   fs.statSync(afPath).size,
      });
    }

    // Build manifest
    const manifest = {
      modelId,
      version,
      update: true,
      reason,
      compatibleFrom: Array.isArray(compatibleFrom) ? compatibleFrom : [compatibleFrom],
      downloadToken: tokenHex,
      delaySeconds: Number(delaySeconds) || 0,
      firmware: {
        version,
        url:    `${FILES_BASE_URL}${FILES_PATH_PREFIX}/firmware/${firmwareFilename}`,
        sha256: firmwareSha256,
        size:   firmwareSize,
      },
      audio: audioEntries,
    };

    // Write manifest — triggers fs.watch → MQTT frm push automatically
    const manifestPath = path.join(MODELS_DIR, `${modelId}.json`);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    console.log(`[admin] manifest generated for ${modelId} v${version}`);
    res.json(manifest);

  } catch (err) {
    console.error(`[admin] manifest generate error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── Admin API — push OTA ──────────────────────────────────────────────────────

app.post('/ota/admin/api/ota/push', (req, res) => {
  const { modelId } = req.body || {};
  if (!modelId) return res.status(400).json({ error: 'modelId required' });
  const topic = `${MQTT_PREFIX}/$group/${modelId}/$action`;
  // Publish with retain:false for the explicit push — the watcher-triggered publish uses retain:true
  mqttPublish(topic, JSON.stringify({ act: 'frm', mdl: modelId }), false);
  console.log(`[admin] OTA push sent for ${modelId}`);
  res.json({ published: true, topic });
});

// ── Device API routes ─────────────────────────────────────────────────────────

app.get('/ota/v1/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/ota/health',    (_req, res) => res.json({ status: 'ok' }));

app.get('/ota/v1/manifest', (req, res) => {
  const modelId = req.query.modelId;
  const firmwareVersion = req.query.firmwareVersion || null;

  if (!modelId) return res.status(400).json({ error: 'modelId query parameter required' });

  const modelPath   = path.join(MANIFEST_ROOT, 'models', `${modelId}.json`);
  const defaultPath = path.join(MANIFEST_ROOT, 'default.json');

  let filePath = null;
  if (fs.existsSync(modelPath))        { filePath = modelPath;   console.log(`[manifest] ${modelId} -> model manifest`); }
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

// Alias without /v1/ — for future device firmware versions
app.get('/ota/manifest', (req, res) =>
  res.redirect(307, '/ota/v1/manifest?' + new URLSearchParams(req.query).toString()));

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

// Also accept /ota/report (without /v1/)
app.post('/ota/report', (req, res, next) => {
  req.url = '/ota/v1/report';
  app.handle(req, res, next);
});

app.listen(PORT, () => console.log(`[manifest] listening on port ${PORT}`));
