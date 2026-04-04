'use strict';

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const mqtt    = require('mqtt');
const multer  = require('multer');

const app = express();
app.use(express.json());

const PORT              = process.env.PORT              || 3001;
const MANIFEST_ROOT     = process.env.MANIFEST_ROOT     || '/opt/signalfi/manifests';
const TOKEN_ROOT        = process.env.TOKEN_ROOT        || '/opt/signalfi/tokens';
const REPORTS_ROOT      = process.env.REPORTS_ROOT      || '/opt/signalfi/reports';
const CONFIG_ROOT       = process.env.CONFIG_ROOT       || '/opt/signalfi/configs';
const FIRMWARE_ROOT     = process.env.FIRMWARE_ROOT     || '/opt/signalfi/files/firmware';
const AUDIO_ROOT        = process.env.AUDIO_ROOT        || '/opt/signalfi/files/audio';
const FILES_ROOT        = process.env.FILES_ROOT        || '/opt/signalfi/files/general';
const FILES_BASE_URL    = process.env.FILES_BASE_URL    || 'http://apis.symphonyinteractive.ca';
const FILES_PATH_PREFIX = process.env.FILES_PATH_PREFIX || '/ota/v1';
const ADMIN_TOKEN       = process.env.ADMIN_TOKEN       || '';
const MQTT_BROKER       = process.env.MQTT_BROKER_URL   || 'mqtt://signalfi-svc:OtaService2024!@mosquitto:1883';
const MQTT_PREFIX       = process.env.MQTT_TOPIC_PREFIX || 'scout';
const DEVICE_MODEL      = process.env.DEVICE_MODEL      || 'SF-100';

const TOKEN_RE          = /^[0-9a-f]{64}$/i;
const DEVICE_TIMEOUT_MS = 10 * 60 * 1000; // 10 min = online window

console.log(`[manifest] starting v3`);
console.log(`[manifest] manifest root:  ${MANIFEST_ROOT}`);
console.log(`[manifest] firmware root:  ${FIRMWARE_ROOT}`);
console.log(`[manifest] audio root:     ${AUDIO_ROOT}`);
console.log(`[manifest] files root:     ${FILES_ROOT}`);
console.log(`[manifest] token root:     ${TOKEN_ROOT}`);
console.log(`[manifest] reports root:   ${REPORTS_ROOT}`);
console.log(`[manifest] config root:    ${CONFIG_ROOT}`);
console.log(`[manifest] mqtt broker:    ${MQTT_BROKER}`);
console.log(`[manifest] mqtt prefix:    ${MQTT_PREFIX}`);
console.log(`[manifest] admin token:    ${ADMIN_TOKEN ? 'set' : 'UNSET (admin API is open)'}`);

// ── CRC32 (IEEE 802.3 / standard, inline — no extra dependency) ───────────────

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function bufCrc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC32_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return ((c ^ 0xFFFFFFFF) >>> 0).toString(16).padStart(8, '0');
}

// ── Ensure writable directories ───────────────────────────────────────────────

for (const dir of [FIRMWARE_ROOT, AUDIO_ROOT, FILES_ROOT, path.join(MANIFEST_ROOT, 'models'), TOKEN_ROOT, REPORTS_ROOT]) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
}

// ── MQTT client + device presence tracking ────────────────────────────────────

const deviceLastSeen = new Map(); // deviceId -> timestamp (ms)
let mqttClient = null;

function connectMqtt() {
  mqttClient = mqtt.connect(MQTT_BROKER, {
    reconnectPeriod: 5000,
    connectTimeout:  10000,
    clientId: `signalfi-manifest-${Date.now()}`,
  });

  mqttClient.on('connect', () => {
    console.log(`[mqtt] connected to ${MQTT_BROKER}`);
    // Subscribe to all scout messages for device presence tracking
    mqttClient.subscribe(`${MQTT_PREFIX}/#`, { qos: 0 }, err => {
      if (err) console.error(`[mqtt] subscribe error: ${err.message}`);
      else     console.log(`[mqtt] subscribed to ${MQTT_PREFIX}/# for device tracking`);
    });
  });

  mqttClient.on('message', (topic) => {
    // Topic format: scout/<deviceId>/... or scout/$group/... or scout/$broadcast/...
    // Only track real device IDs (not $ pseudo-segments)
    const parts = topic.split('/');
    if (parts.length >= 2 && parts[0] === MQTT_PREFIX && parts[1] && !parts[1].startsWith('$')) {
      deviceLastSeen.set(parts[1], Date.now());
    }
  });

  mqttClient.on('error',   err => console.error(`[mqtt] error: ${err.message}`));
  mqttClient.on('offline',  () => console.log('[mqtt] offline — will reconnect'));
}

connectMqtt();

function mqttPublish(topic, payload, retain = false) {
  if (mqttClient && mqttClient.connected) {
    mqttClient.publish(topic, payload, { retain }, err => {
      if (err) console.error(`[mqtt] publish error: ${err.message}`);
      else     console.log(`[mqtt] published → ${topic}: ${payload}`);
    });
  } else {
    console.warn(`[mqtt] not connected — skipped publish to ${topic}`);
  }
}


// ── Helpers ───────────────────────────────────────────────────────────────────

function generateManifestId() {
  // 16-byte random UUID (RFC 4122 v4 format)
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

function fileSha256(filePath) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'); }
  catch (_) { return null; }
}

function fileCrc32(filePath) {
  try { return bufCrc32(fs.readFileSync(filePath)); }
  catch (_) { return null; }
}

function safeFilename(filename) {
  return typeof filename === 'string'
    && !filename.includes('/')
    && !filename.includes('\\')
    && filename.length > 0;
}

function listDir(dir, ext = null) {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => !ext || f.toLowerCase().endsWith(ext))
      .map(f => {
        const fp = path.join(dir, f);
        const st = fs.statSync(fp);
        return { name: f, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch (_) { return []; }
}

// ── Config file watcher → MQTT push ──────────────────────────────────────────

const MODELS_DIR        = path.join(MANIFEST_ROOT, 'models');
const CONFIG_MODELS_DIR = path.join(CONFIG_ROOT, 'models');
const CONFIG_DEVICES_DIR= path.join(CONFIG_ROOT, 'devices');
const CONFIG_BASE_URL   = process.env.CONFIG_BASE_URL || 'http://apis.symphonyinteractive.ca/ota/v1/config';

function buildConfigToken(id) {
  try {
    for (const file of fs.readdirSync(TOKEN_ROOT)) {
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
    const base   = path.basename(filePath, '.json');
    const sha256 = fileSha256(filePath);
    const token  = buildConfigToken(base);
    const url    = `${CONFIG_BASE_URL}/${type}s/${base}.json`;
    const topic  = type === 'model'
      ? `${MQTT_PREFIX}/$group/${base}/$config`
      : `${MQTT_PREFIX}/${base}/$config`;
    const payload = JSON.stringify({
      type,
      ...(type === 'model' ? { modelId: base } : { mac: base }),
      url, sha256, token,
    });
    mqttPublish(topic, payload, true);
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
    for (const file of fs.readdirSync(TOKEN_ROOT)) {
      if (!file.startsWith(token + '_exp') && !file.startsWith(token + '_cfg')) continue;
      if (file.startsWith(token + '_cfg')) {
        const expMatch = file.match(/_exp(\d+)$/);
        if (expMatch && Date.now() / 1000 >= parseInt(expMatch[1], 10)) continue;
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
app.use('/ota/admin/api', adminAuth);

// ── Multer upload config ──────────────────────────────────────────────────────

const firmwareUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, FIRMWARE_ROOT),
    filename:    (_req, file,  cb) => cb(null, file.originalname),
  }),
  fileFilter: (_req, file, cb) => cb(null, file.originalname.toLowerCase().endsWith('.hex')),
  limits: { fileSize: 32 * 1024 * 1024 },
});

const audioUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, AUDIO_ROOT),
    filename:    (_req, file,  cb) => cb(null, file.originalname),
  }),
  fileFilter: (_req, file, cb) => cb(null, file.originalname.toLowerCase().endsWith('.wav')),
  limits: { fileSize: 100 * 1024 * 1024 },
});

const generalUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, FILES_ROOT),
    filename:    (_req, file,  cb) => cb(null, file.originalname),
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// ── Admin API — device presence ───────────────────────────────────────────────

app.get('/ota/admin/api/devices/count', (_req, res) => {
  const cutoff = Date.now() - DEVICE_TIMEOUT_MS;
  let online = 0;
  for (const ts of deviceLastSeen.values()) {
    if (ts > cutoff) online++;
  }
  res.json({ online, total: deviceLastSeen.size });
});

// ── Admin API — file listings ─────────────────────────────────────────────────

app.get('/ota/admin/api/files/firmware', (_req, res) => {
  const files = listDir(FIRMWARE_ROOT, '.hex').map(f => ({
    ...f,
    crc32:  fileCrc32(path.join(FIRMWARE_ROOT, f.name)),
    sha256: fileSha256(path.join(FIRMWARE_ROOT, f.name)),
  }));
  res.json(files);
});

app.get('/ota/admin/api/files/audio', (_req, res) => {
  // CRC32/SHA256 omitted from listing — computed at push time only (files can be 100MB+)
  res.json(listDir(AUDIO_ROOT, '.wav'));
});

app.get('/ota/admin/api/files/general', (_req, res) => {
  res.json(listDir(FILES_ROOT));
});

// ── Admin API — manifest listing ──────────────────────────────────────────────

app.get('/ota/admin/api/manifests', (_req, res) => {
  const files = listDir(MODELS_DIR, '.json');
  const manifests = files.map(f => {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(MODELS_DIR, f.name), 'utf8'));
      return {
        modelId: path.basename(f.name, '.json'),
        type:    m.type || 'firmware',
        version: m.firmware?.version || m.version || null,
        update:  !!m.update,
        mtime:   f.mtime,
      };
    } catch (_) {
      return { modelId: path.basename(f.name, '.json'), type: 'firmware', version: null, update: false, mtime: f.mtime };
    }
  });
  res.json(manifests);
});

app.get('/ota/admin/api/manifests/:modelId', (req, res) => {
  const { modelId } = req.params;
  if (!safeFilename(modelId)) return res.status(400).json({ error: 'invalid modelId' });
  const fp = path.join(MODELS_DIR, `${modelId}.json`);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'not found' });
  try { res.json(JSON.parse(fs.readFileSync(fp, 'utf8'))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Admin API — file uploads ──────────────────────────────────────────────────

app.post('/ota/admin/api/files/firmware', firmwareUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no .hex file received' });
  const crc32  = fileCrc32(req.file.path);
  const sha256 = fileSha256(req.file.path);
  console.log(`[admin] firmware uploaded: ${req.file.originalname} (${req.file.size} B, crc32: ${crc32})`);
  res.json({ name: req.file.originalname, size: req.file.size, crc32, sha256 });
});

app.post('/ota/admin/api/files/audio', audioUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no .wav file received' });
  const crc32  = fileCrc32(req.file.path);
  const sha256 = fileSha256(req.file.path);
  console.log(`[admin] audio uploaded: ${req.file.originalname} (${req.file.size} B)`);
  res.json({ name: req.file.originalname, size: req.file.size, crc32, sha256 });
});

app.post('/ota/admin/api/files/general', generalUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file received' });
  const crc32  = fileCrc32(req.file.path);
  const sha256 = fileSha256(req.file.path);
  console.log(`[admin] general file uploaded: ${req.file.originalname} (${req.file.size} B)`);
  res.json({ name: req.file.originalname, size: req.file.size, crc32, sha256 });
});

// ── Admin API — file deletes ──────────────────────────────────────────────────

function makeDeleteRoute(root) {
  return (req, res) => {
    const { filename } = req.params;
    if (!safeFilename(filename)) return res.status(400).json({ error: 'invalid filename' });
    const fp = path.join(root, filename);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'not found' });
    try {
      fs.unlinkSync(fp);
      console.log(`[admin] deleted: ${fp}`);
      res.json({ deleted: filename });
    } catch (err) { res.status(500).json({ error: err.message }); }
  };
}

app.delete('/ota/admin/api/files/firmware/:filename', makeDeleteRoute(FIRMWARE_ROOT));
app.delete('/ota/admin/api/files/audio/:filename',    makeDeleteRoute(AUDIO_ROOT));
app.delete('/ota/admin/api/files/general/:filename',  makeDeleteRoute(FILES_ROOT));

app.delete('/ota/admin/api/manifests/:modelId', (req, res) => {
  const { modelId } = req.params;
  if (!safeFilename(modelId)) return res.status(400).json({ error: 'invalid modelId' });
  const fp = path.join(MODELS_DIR, `${modelId}.json`);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'not found' });
  try {
    fs.unlinkSync(fp);
    console.log(`[admin] manifest deleted: ${modelId}`);
    res.json({ deleted: modelId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Admin API — save draft manifest (no token, no push) ───────────────────────

app.post('/ota/admin/api/manifests/draft', (req, res) => {
  const { modelId } = req.body || {};
  if (!modelId || !safeFilename(modelId))
    return res.status(400).json({ error: 'valid modelId required' });
  // Strip token and set update:false so devices ignore this draft
  const { downloadToken: _t, ...rest } = req.body;
  const draft = { ...rest, update: false, _draft: true };
  const fp = path.join(MODELS_DIR, `${modelId}.json`);
  try {
    fs.writeFileSync(fp, JSON.stringify(draft, null, 2));
    console.log(`[admin] draft saved: ${modelId}`);
    res.json({ saved: modelId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Admin API — upload manifest (verify + token + MQTT push) ──────────────────
// Handles both firmware and files manifest types.

function buildFileEntry(id, audioRoot, filesRoot, baseUrl, pathPrefix) {
  if (!safeFilename(id)) return null;
  let filePath = path.join(audioRoot, id);
  let url      = `${baseUrl}${pathPrefix}/audio/${id}`;
  if (!fs.existsSync(filePath)) {
    filePath = path.join(filesRoot, id);
    url      = `${baseUrl}${pathPrefix}/files/${id}`;
  }
  if (!fs.existsSync(filePath)) return null;
  return {
    op:     'put',
    id,
    url,
    crc32:  fileCrc32(filePath),
    sha256: fileSha256(filePath),
    size:   fs.statSync(filePath).size,
  };
}

app.post('/ota/admin/api/manifests/upload', (req, res) => {
  const {
    type           = 'firmware',
    modelId,
    version,
    firmwareFile,
    audioFiles     = [],
    files          = [],
    compatibleFrom = ['*'],
    tokenDays      = 30,
    reason         = 'Update available',
    delaySeconds   = 0,
    target         = 'group',
  } = req.body || {};

  if (!modelId || !safeFilename(modelId))
    return res.status(400).json({ error: 'valid modelId required' });

  try {
    const tokenHex    = crypto.randomBytes(32).toString('hex');
    const tokenExpiry = Math.floor(Date.now() / 1000) + Number(tokenDays) * 86400;
    fs.writeFileSync(path.join(TOKEN_ROOT, `${tokenHex}_exp${tokenExpiry}`), '');
    const manifestId  = generateManifestId();

    let manifest;

    if (type === 'firmware') {
      if (!version || !firmwareFile)
        return res.status(400).json({ error: 'version and firmwareFile required for firmware type' });
      if (!safeFilename(firmwareFile))
        return res.status(400).json({ error: 'invalid firmwareFile' });

      const firmwarePath = path.join(FIRMWARE_ROOT, firmwareFile);
      if (!fs.existsSync(firmwarePath))
        return res.status(400).json({ error: `firmware file not found: ${firmwareFile}` });

      // Produce a versioned filename e.g. SF-100-1.2.0.hex
      const ext            = path.extname(firmwareFile) || '.hex';
      const firmwareVersName = `${modelId}-${version}${ext}`;
      const versionedPath  = path.join(FIRMWARE_ROOT, firmwareVersName);
      if (firmwarePath !== versionedPath && !fs.existsSync(versionedPath)) {
        fs.copyFileSync(firmwarePath, versionedPath);
      }

      // Build audio entries
      const audioEntries = [];
      for (const af of audioFiles) {
        if (!safeFilename(af)) continue;
        const afPath = path.join(AUDIO_ROOT, af);
        if (!fs.existsSync(afPath)) { console.warn(`[admin] audio not found: ${af}`); continue; }
        audioEntries.push({
          id:     af,
          url:    `${FILES_BASE_URL}${FILES_PATH_PREFIX}/audio/${af}`,
          crc32:  fileCrc32(afPath),
          sha256: fileSha256(afPath),
          size:   fs.statSync(afPath).size,
        });
      }

      manifest = {
        manifestId,
        type: 'firmware',
        modelId,
        version,
        update: true,
        reason,
        compatibleFrom: Array.isArray(compatibleFrom) ? compatibleFrom : [compatibleFrom],
        downloadToken:  tokenHex,
        delaySeconds:   Number(delaySeconds) || 0,
        firmware: {
          version,
          url:    `${FILES_BASE_URL}${FILES_PATH_PREFIX}/firmware/${firmwareVersName}`,
          crc32:  fileCrc32(path.join(FIRMWARE_ROOT, firmwareVersName)),
          sha256: fileSha256(path.join(FIRMWARE_ROOT, firmwareVersName)),
          size:   fs.statSync(path.join(FIRMWARE_ROOT, firmwareVersName)).size,
        },
        audio: audioEntries,
      };

    } else if (type === 'files') {
      if (!files.length)
        return res.status(400).json({ error: 'files array required for files type' });

      const fileEntries = [];
      const errors      = [];
      for (const f of files) {
        if (!safeFilename(f.id)) { errors.push(`invalid id: ${f.id}`); continue; }
        if (f.op === 'delete') {
          fileEntries.push({ op: 'delete', id: f.id });
          continue;
        }
        const entry = buildFileEntry(f.id, AUDIO_ROOT, FILES_ROOT, FILES_BASE_URL, FILES_PATH_PREFIX);
        if (!entry) { errors.push(`file not found on server: ${f.id}`); continue; }
        fileEntries.push(entry);
      }

      if (errors.length)
        return res.status(400).json({ error: 'file verification failed', details: errors });

      manifest = {
        manifestId,
        type: 'files',
        modelId,
        update: true,
        reason,
        downloadToken: tokenHex,
        delaySeconds:  Number(delaySeconds) || 0,
        files: fileEntries,
      };

    } else {
      return res.status(400).json({ error: 'type must be firmware or files' });
    }

    const manifestPath = path.join(MODELS_DIR, `${modelId}.json`);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`[admin] manifest uploaded for ${modelId} (${type})`);

    const uploadTopic   = target === 'broadcast'
      ? `${MQTT_PREFIX}/$broadcast/$action`
      : `${MQTT_PREFIX}/$group/${modelId}/$action`;
    mqttPublish(uploadTopic, JSON.stringify({ act: 'frm', mdl: modelId, mid: manifestId, url: `/ota/v1/manifest`, token: tokenHex }), false);

    res.json(manifest);

  } catch (err) {
    console.error(`[admin] upload error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Backward-compat alias
app.post('/ota/admin/api/manifests/generate', (req, _res, next) => {
  req.url = '/ota/admin/api/manifests/upload';
  next('route');
});

// ── Admin API — save manifest definition (draft, no token, no push) ───────────
// Alias: /manifests/save and /manifests/draft both do the same thing.

function saveManifestDraft(req, res) {
  const { modelId } = req.body || {};
  if (!modelId || !safeFilename(modelId))
    return res.status(400).json({ error: 'valid modelId required' });
  const { downloadToken: _t, ...rest } = req.body;
  const draft = { ...rest, update: false, _draft: true };
  const fp = path.join(MODELS_DIR, `${modelId}.json`);
  try {
    fs.writeFileSync(fp, JSON.stringify(draft, null, 2));
    console.log(`[admin] manifest saved (draft): ${modelId}`);
    res.json({ saved: modelId });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

app.post('/ota/admin/api/manifests/save',  saveManifestDraft);
app.post('/ota/admin/api/manifests/draft', saveManifestDraft);

// ── Admin API — push OTA (verify files → fresh token → write manifest → MQTT) ─
// Body: { modelId, nodePath? , broadcast?: true }
// nodePath targets:  scout/$group/<nodePath>/$action
// broadcast targets: scout/$broadcast/$action

app.post('/ota/admin/api/ota/push', (req, res) => {
  const { modelId, nodePath, broadcast } = req.body || {};

  if (!modelId || !safeFilename(modelId))
    return res.status(400).json({ error: 'modelId required' });
  if (!broadcast && !nodePath)
    return res.status(400).json({ error: 'nodePath or broadcast:true required' });

  const manifestPath = path.join(MODELS_DIR, `${modelId}.json`);
  if (!fs.existsSync(manifestPath))
    return res.status(404).json({ error: `no manifest saved for ${modelId}` });

  let draft;
  try { draft = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch (err) { return res.status(500).json({ error: 'failed to read manifest' }); }

  try {
    // Fresh download token for this push
    const tokenHex    = crypto.randomBytes(32).toString('hex');
    const tokenExpiry = Math.floor(Date.now() / 1000) + 30 * 86400;
    fs.writeFileSync(path.join(TOKEN_ROOT, `${tokenHex}_exp${tokenExpiry}`), '');

    // Strip draft-only fields before building the published manifest
    const { _draft: _d, firmwareFile, tokenDays: _td, ...rest } = draft;
    const type = rest.type || 'firmware';

    // Normalise compatibleFrom: the draft may store it as a raw string ("*")
    if (rest.compatibleFrom && !Array.isArray(rest.compatibleFrom)) {
      rest.compatibleFrom = rest.compatibleFrom === '*'
        ? ['*']
        : rest.compatibleFrom.split(',').map(s => s.trim()).filter(Boolean);
    }

    const manifestId = generateManifestId();
    const manifest = { ...rest, update: true, downloadToken: tokenHex, manifestId };

    if (type === 'firmware') {
      // Resolve firmware filename: prefer the direct draft field (most reliable),
      // fall back to extracting from firmware.url (legacy manifests written by old code)
      let fwFilename = null;
      if (firmwareFile && safeFilename(firmwareFile)) {
        fwFilename = firmwareFile;
      } else if (manifest.firmware?.url) {
        const extracted = decodeURIComponent(manifest.firmware.url.split('/').pop());
        if (safeFilename(extracted)) fwFilename = extracted;
      }

      if (!fwFilename)
        return res.status(400).json({ error: 'cannot determine firmware filename from saved manifest — re-save from Manifest Builder then push again' });

      const fwPath = path.join(FIRMWARE_ROOT, fwFilename);
      if (!fs.existsSync(fwPath))
        return res.status(400).json({ error: `firmware file not found: ${fwFilename}` });

      manifest.firmware = {
        version: manifest.version || '0.0.0',
        url:    `${FILES_BASE_URL}${FILES_PATH_PREFIX}/firmware/${fwFilename}`,
        crc32:  fileCrc32(fwPath),
        sha256: fileSha256(fwPath),
        size:   fs.statSync(fwPath).size,
      };

    } else if (type === 'files') {
      const errors = [];
      manifest.files = (manifest.files || []).map(f => {
        if (f.op === 'delete') return f;
        const inAudio = path.join(AUDIO_ROOT, f.id);
        const inFiles = path.join(FILES_ROOT, f.id);
        const fp = fs.existsSync(inAudio) ? inAudio : fs.existsSync(inFiles) ? inFiles : null;
        if (!fp) { errors.push(`file not found: ${f.id}`); return f; }
        return { ...f, crc32: fileCrc32(fp), sha256: fileSha256(fp), size: fs.statSync(fp).size };
      });
      if (errors.length) return res.status(400).json({ error: 'file verification failed', details: errors });
    }

    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const topic   = broadcast
      ? `${MQTT_PREFIX}/$broadcast/$action`
      : `${MQTT_PREFIX}/$group/${nodePath}/$action`;
    // Token is the authorization credential for the device to access OTA endpoints.
    // Only devices on the broker receive it; they present it as Bearer on all OTA requests.
    const payload = JSON.stringify({ act: 'frm', mdl: modelId, mid: manifestId, url: `/ota/v1/manifest`, token: tokenHex });

    mqttPublish(topic, payload, false);
    console.log(`[admin] OTA pushed: ${topic}`);
    res.json({ published: true, topic, manifest });

  } catch (err) {
    console.error(`[admin] push error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── Admin API — auto push-firmware (inline manifest generation) ───────────────
// POST /ota/admin/api/ota/push-firmware
// Body: { firmwareFile, nodePath?, broadcast? }
// Derives version from filename (fw-x.y.z.hex), generates token, writes manifest, publishes MQTT.

app.post('/ota/admin/api/ota/push-firmware', (req, res) => {
  const { firmwareFile, nodePath, broadcast } = req.body || {};

  if (!firmwareFile || !safeFilename(firmwareFile))
    return res.status(400).json({ error: 'firmwareFile required' });
  if (!broadcast && !nodePath)
    return res.status(400).json({ error: 'nodePath or broadcast:true required' });

  const fwPath = path.join(FIRMWARE_ROOT, firmwareFile);
  if (!fs.existsSync(fwPath))
    return res.status(400).json({ error: `firmware file not found: ${firmwareFile}` });

  // Derive version from filename: fw-x.y.z.hex → x.y.z, else use filename stem
  const versionMatch = firmwareFile.match(/fw-(\d+\.\d+\.\d+)\.hex$/i);
  const version      = versionMatch ? versionMatch[1] : path.basename(firmwareFile, path.extname(firmwareFile));

  try {
    const tokenHex    = crypto.randomBytes(32).toString('hex');
    const tokenExpiry = Math.floor(Date.now() / 1000) + 30 * 86400;
    fs.writeFileSync(path.join(TOKEN_ROOT, `${tokenHex}_exp${tokenExpiry}`), '');

    // Reuse existing manifestId if the same firmware is being pushed again;
    // only generate a new one when the firmware file or version changes.
    const manifestPath = path.join(MODELS_DIR, `${DEVICE_MODEL}.json`);
    let manifestId;
    try {
      const existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifestId = (existing.firmware?.url?.endsWith(firmwareFile) && existing.version === version && existing.manifestId)
        ? existing.manifestId
        : generateManifestId();
    } catch (_) { manifestId = generateManifestId(); }

    const manifest = {
      manifestId,
      type:          'firmware',
      modelId:       DEVICE_MODEL,
      version,
      update:        true,
      reason:        'Firmware update available',
      compatibleFrom: ['*'],
      downloadToken: tokenHex,
      delaySeconds:  0,
      firmware: {
        version,
        url:    `${FILES_BASE_URL}${FILES_PATH_PREFIX}/firmware/${firmwareFile}`,
        crc32:  fileCrc32(fwPath),
        sha256: fileSha256(fwPath),
        size:   fs.statSync(fwPath).size,
      },
    };

    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const topic   = broadcast
      ? `${MQTT_PREFIX}/$broadcast/$action`
      : `${MQTT_PREFIX}/$group/${nodePath}/$action`;
    const payload = JSON.stringify({ act: 'frm', mdl: DEVICE_MODEL, mid: manifestId, url: `/ota/v1/manifest`, token: tokenHex });
    mqttPublish(topic, payload, false);

    console.log(`[admin] firmware push: ${firmwareFile} v${version} → ${topic}`);
    res.json({ published: true, topic, version, manifest });
  } catch (err) {
    console.error(`[admin] push-firmware error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── Admin API — auto push-files (inline manifest generation) ──────────────────
// POST /ota/admin/api/ota/push-files
// Body: { files: [{op, id}], nodePath?, broadcast? }
// Generates token, resolves checksums for 'put' ops, writes manifest, publishes MQTT.

app.post('/ota/admin/api/ota/push-files', (req, res) => {
  const { files = [], nodePath, broadcast } = req.body || {};

  if (!files.length)
    return res.status(400).json({ error: 'files array required' });
  if (!broadcast && !nodePath)
    return res.status(400).json({ error: 'nodePath or broadcast:true required' });

  try {
    const tokenHex    = crypto.randomBytes(32).toString('hex');
    const tokenExpiry = Math.floor(Date.now() / 1000) + 30 * 86400;
    fs.writeFileSync(path.join(TOKEN_ROOT, `${tokenHex}_exp${tokenExpiry}`), '');
    const manifestId  = generateManifestId();

    const errors      = [];
    const fileEntries = files.map(f => {
      if (!safeFilename(f.id)) { errors.push(`invalid id: ${f.id}`); return f; }
      if (f.op === 'delete') return { op: 'delete', id: f.id };
      const entry = buildFileEntry(f.id, AUDIO_ROOT, FILES_ROOT, FILES_BASE_URL, FILES_PATH_PREFIX);
      if (!entry) { errors.push(`file not found on server: ${f.id}`); return f; }
      return entry;
    });

    if (errors.length)
      return res.status(400).json({ error: 'file verification failed', details: errors });

    const manifest = {
      manifestId,
      type:          'files',
      modelId:       DEVICE_MODEL,
      update:        true,
      reason:        'File transfer',
      downloadToken: tokenHex,
      delaySeconds:  0,
      files:         fileEntries,
    };

    const manifestPath = path.join(MODELS_DIR, `${DEVICE_MODEL}.json`);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const topic   = broadcast
      ? `${MQTT_PREFIX}/$broadcast/$action`
      : `${MQTT_PREFIX}/$group/${nodePath}/$action`;
    const payload = JSON.stringify({ act: 'frm', mdl: DEVICE_MODEL, mid: manifestId, url: `/ota/v1/manifest`, token: tokenHex });
    mqttPublish(topic, payload, false);

    console.log(`[admin] files push: ${files.length} op(s) → ${topic}`);
    res.json({ published: true, topic, manifest });
  } catch (err) {
    console.error(`[admin] push-files error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── VS Code / CI automated upload endpoint ────────────────────────────────────
// POST /ota/admin/api/upload
// Headers: Authorization: Bearer <ADMIN_TOKEN>
// Form:    file=<firmware.hex>  model=SF-100  version=1.2.0  push=true  target=group

app.post('/ota/admin/api/upload', adminAuth, firmwareUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no .hex file received' });

  const crc32val = fileCrc32(req.file.path);
  const sha256   = fileSha256(req.file.path);
  const result   = { name: req.file.originalname, size: req.file.size, crc32: crc32val, sha256 };

  const model   = (req.body.model   || '').trim();
  const version = (req.body.version || '').trim();
  const push    = req.body.push === 'true';
  const target  = req.body.target || 'group';

  if (push && model) {
    const ext              = path.extname(req.file.originalname) || '.hex';
    const firmwareVersName = version ? `${model}-${version}${ext}` : req.file.originalname;
    const versionedPath    = path.join(FIRMWARE_ROOT, firmwareVersName);
    if (req.file.path !== versionedPath && !fs.existsSync(versionedPath)) {
      fs.copyFileSync(req.file.path, versionedPath);
    }
    try {
      const tokenHex    = crypto.randomBytes(32).toString('hex');
      const tokenExpiry = Math.floor(Date.now() / 1000) + 30 * 86400;
      fs.writeFileSync(path.join(TOKEN_ROOT, `${tokenHex}_exp${tokenExpiry}`), '');
      const manifestId  = generateManifestId();

      const manifest = {
        manifestId,
        type: 'firmware',
        modelId: model,
        version: version || '0.0.0',
        update:  true,
        reason:  'VS Code / CI build upload',
        compatibleFrom: ['*'],
        downloadToken:  tokenHex,
        delaySeconds:   0,
        firmware: {
          version: version || '0.0.0',
          url:    `${FILES_BASE_URL}${FILES_PATH_PREFIX}/firmware/${firmwareVersName}`,
          crc32:  fileCrc32(versionedPath),
          sha256: fileSha256(versionedPath),
          size:   fs.statSync(versionedPath).size,
        },
        audio: [],
      };

      const manifestPath = path.join(MODELS_DIR, `${model}.json`);
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      const ciTopic   = target === 'broadcast'
        ? `${MQTT_PREFIX}/$broadcast/$action`
        : `${MQTT_PREFIX}/$group/${model}/$action`;
      mqttPublish(ciTopic, JSON.stringify({ act: 'frm', mdl: model, mid: manifestId, url: `/ota/v1/manifest`, token: tokenHex }), false);
      result.topic = ciTopic;

      result.pushed   = true;
      result.topic    = target === 'broadcast'
        ? `${MQTT_PREFIX}/$broadcast/$action`
        : `${MQTT_PREFIX}/$group/${model}/$action`;
      result.manifest = manifest;
    } catch (err) {
      result.pushError = err.message;
    }
  }

  console.log(`[upload] ${req.file.originalname} push=${push} model=${model}`);
  res.json(result);
});

// ── Admin API — reports ───────────────────────────────────────────────────────

app.get('/ota/admin/api/reports', (req, res) => {
  const page    = Math.max(0, parseInt(req.query.page  || '0', 10));
  const limit   = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10)));
  const logPath = path.join(REPORTS_ROOT, 'updates.log');
  try {
    if (!fs.existsSync(logPath)) return res.json({ total: 0, page, limit, entries: [] });
    const lines = fs.readFileSync(logPath, 'utf8')
      .split('\n').filter(l => l.trim()).reverse();
    const total   = lines.length;
    const entries = lines.slice(page * limit, page * limit + limit).map(l => {
      try { return JSON.parse(l); } catch (_) { return { raw: l }; }
    });
    res.json({ total, page, limit, entries });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── General files serving (token-authenticated) ───────────────────────────────

app.get('/ota/v1/files/:filename', (req, res) => {
  let token = null;
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) token = auth.slice(7).trim();
  if (!validateToken(token)) return res.status(401).json({ valid: false });
  const { filename } = req.params;
  if (!safeFilename(filename)) return res.status(400).send('Invalid filename');
  const fp = path.join(FILES_ROOT, filename);
  if (!fs.existsSync(fp)) return res.status(404).send('Not found');
  res.sendFile(fp);
});

// ── Device API routes ─────────────────────────────────────────────────────────

app.get('/ota/v1/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/ota/health',    (_req, res) => res.json({ status: 'ok' }));

app.get('/ota/v1/manifest', (req, res) => {
  const manifestId      = req.query.manifestId || null;
  const modelId         = req.query.modelId    || null;
  const firmwareVersion = req.query.firmwareVersion || null;

  if (!manifestId && !modelId)
    return res.status(400).json({ error: 'manifestId or modelId query parameter required' });

  // Token auth: device presents token received via MQTT as Bearer header or ?token= query param
  let token = null;
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) token = auth.slice(7).trim();
  if (!token) token = req.query.token || null;
  if (!validateToken(token)) return res.status(401).json({ valid: false });

  let filePath = null;
  let resolvedModelId = modelId;

  if (manifestId) {
    // Scan models/ directory for a manifest whose manifestId field matches
    const modelsDir = path.join(MANIFEST_ROOT, 'models');
    try {
      const entries = fs.readdirSync(modelsDir).filter(f => f.endsWith('.json'));
      for (const entry of entries) {
        const p = path.join(modelsDir, entry);
        try {
          const m = JSON.parse(fs.readFileSync(p, 'utf8'));
          if (m.manifestId === manifestId) {
            filePath = p;
            resolvedModelId = m.modelId || entry.replace('.json', '');
            console.log(`[manifest] manifestId=${manifestId} -> ${entry}`);
            break;
          }
        } catch (_) { /* skip unreadable files */ }
      }
    } catch (err) {
      console.error(`[manifest] failed to scan models dir: ${err.message}`);
      return res.status(500).json({ error: 'failed to scan manifests' });
    }
    if (!filePath) return res.status(404).json({ error: 'no manifest found for this manifestId' });
  } else {
    // Legacy modelId-based lookup
    const modelPath   = path.join(MANIFEST_ROOT, 'models', `${modelId}.json`);
    const defaultPath = path.join(MANIFEST_ROOT, 'default.json');
    if (fs.existsSync(modelPath))        { filePath = modelPath;   console.log(`[manifest] modelId=${modelId} -> model manifest`); }
    else if (fs.existsSync(defaultPath)) { filePath = defaultPath; console.log(`[manifest] modelId=${modelId} -> default manifest`); }
    else return res.status(404).json({ error: 'no manifest found for this model' });
  }

  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (err) {
    console.error(`[manifest] failed to read ${filePath}: ${err.message}`);
    return res.status(500).json({ error: 'failed to read manifest' });
  }

  // Draft manifests (update:false) are sent as-is — device won't act
  if (manifest.update && manifest.type !== 'files') {
    const compatibleFrom = manifest.compatibleFrom;
    if (Array.isArray(compatibleFrom) && compatibleFrom.length > 0 && !compatibleFrom.includes('*')) {
      if (!firmwareVersion || !compatibleFrom.includes(firmwareVersion)) {
        return res.json({ modelId: resolvedModelId, update: false, reason: 'current firmware version not eligible' });
      }
    }
  }

  const { compatibleFrom: _strip, _draft, ...response } = manifest;
  response.modelId = resolvedModelId;
  res.json(response);
});

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
    console.log('[validate] rejected');
    return res.status(401).json({ valid: false });
  }
  console.log('[validate] accepted');
  res.json({ valid: true });
});

app.post('/ota/v1/report', (req, res) => {
  const { deviceId, modelId, firmwareVersion, status } = req.body || {};
  const entry = {
    timestamp:       new Date().toISOString(),
    deviceId:        deviceId        || 'unknown',
    modelId:         modelId         || 'unknown',
    firmwareVersion: firmwareVersion || 'unknown',
    status:          status          || 'unknown',
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

app.post('/ota/report', (req, res, next) => {
  req.url = '/ota/v1/report';
  app.handle(req, res, next);
});

app.listen(PORT, () => console.log(`[manifest] listening on port ${PORT}`));
