#!/usr/bin/env node
'use strict';

/**
 * generate-config.js
 *
 * Creates or updates a Signalfi device config file, generates a time-limited
 * Bearer token, and uploads both to the server via SFTP. Uploading the config
 * triggers an MQTT push to all subscribed devices via fs.watch in the manifest
 * service.
 *
 * Two modes:
 *   --model SF-100          → model-level config (shared settings)
 *                             uploaded to /configs/models/SF-100.json
 *                             token stored as <hex>_cfg_SF-100_exp<unix>
 *                             MQTT → scout/$group/SF-100/$config
 *
 *   --mac aa-bb-cc-dd-ee-ff → per-device config (individual overrides)
 *                             uploaded to /configs/devices/aa-bb-cc-dd-ee-ff.json
 *                             token stored as <hex>_cfg_aa-bb-cc-dd-ee-ff_exp<unix>
 *                             MQTT → scout/aa-bb-cc-dd-ee-ff/$config
 *
 * Config file: either provide --config <path> to upload an existing JSON file,
 * or build one interactively with --mqtt-host / --mqtt-user / etc. flags.
 *
 * Token: 64-hex stored as <hex>_cfg_<id>_exp<unix> in /tokens/
 *        Device sends it as: Authorization: Bearer <hex>
 *        Default expiry: 30 days. Use --token-days to override.
 *
 * Usage (model config from file):
 *   node generate-config.js \
 *     --model SF-100 \
 *     --config ./SF-100-config.json \
 *     [--token-days 30] \
 *     [--sftp-host apis.symphonyinteractive.ca] \
 *     [--sftp-port 2222] \
 *     [--dry-run]
 *
 * Usage (per-device config inline):
 *   node generate-config.js \
 *     --mac aa-bb-cc-dd-ee-ff \
 *     --node-path /venue/building-a/floor2/conf-room \
 *     --display-name conf-room \
 *     [--static-ip 192.168.1.50] \
 *     [--model SF-100]              (inherit model defaults on device) \
 *     [--token-days 30] \
 *     [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Client = require('ssh2-sftp-client');
const argv = require('minimist')(process.argv.slice(2), {
  string: ['model', 'mac', 'config', 'node-path', 'display-name', 'static-ip',
           'sftp-host', 'sftp-user', 'sftp-pass', 'sftp-port',
           'mqtt-host', 'mqtt-user', 'mqtt-pass'],
  boolean: ['dry-run'],
  default: {
    'sftp-host':   'apis.symphonyinteractive.ca',
    'sftp-port':   '2222',
    'sftp-user':   'symphony',
    'sftp-pass':   'Si9057274427',
    'mqtt-host':   'apis.symphonyinteractive.ca',
    'mqtt-port':   1883,
    'token-days':  30,
    'dry-run':     false,
  },
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function die(msg) {
  console.error(`[error] ${msg}`);
  process.exit(1);
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sha256Buf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ── Validate args ─────────────────────────────────────────────────────────────

if (!argv.model && !argv.mac) die('--model <modelId> or --mac <aa-bb-cc-dd-ee-ff> required');

const isModel  = !argv.mac;
const id       = isModel ? argv.model : argv.mac.toLowerCase().replace(/:/g, '-');
const subdir   = isModel ? 'models' : 'devices';
const remotePath = `/configs/${subdir}/${id}.json`;
const tokenId  = id;

// ── Build config JSON ─────────────────────────────────────────────────────────

let configJson;

if (argv.config) {
  const configPath = path.resolve(argv.config);
  if (!fs.existsSync(configPath)) die(`config file not found: ${configPath}`);
  configJson = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  console.log(`[config] loaded from ${configPath}`);
} else if (isModel) {
  // Build model config from flags
  configJson = {
    modelId:  argv.model,
    version:  argv.version || '1.0',
    mqtt: {
      host:        argv['mqtt-host'],
      port:        argv['mqtt-port'] || 1883,
      username:    argv['mqtt-user'] || 'symphony',
      password:    argv['mqtt-pass'] || 'Si9057274427',
      tls:         false,
      topicPrefix: 'scout',
    },
    services: { ota: true, audio: true, reporting: true },
    otaServer: 'http://apis.symphonyinteractive.ca',
  };
  console.log('[config] built model config from flags');
} else {
  // Build per-device config from flags
  configJson = {
    mac:         id,
    ...(argv.model ? { modelId: argv.model } : {}),
    nodePath:    argv['node-path']    || '',
    displayName: argv['display-name'] || id,
    network: {
      staticIp: argv['static-ip'] || '',
      gateway:  argv.gateway || '',
      dns:      argv.dns || '',
    },
  };
  console.log('[config] built device config from flags');
}

// Bump version timestamp so device can detect a change
if (!configJson.version) configJson.version = new Date().toISOString().slice(0, 10);
configJson._updatedAt = new Date().toISOString();

const configBuf    = Buffer.from(JSON.stringify(configJson, null, 2));
const configSha256 = sha256Buf(configBuf);

// ── Token generation ──────────────────────────────────────────────────────────

const tokenHex    = crypto.randomBytes(32).toString('hex');
const expSec      = Math.floor(Date.now() / 1000) + argv['token-days'] * 86400;
const tokenFile   = `${tokenHex}_cfg_${tokenId}_exp${expSec}`;
const remoteToken = `/tokens/${tokenFile}`;

// ── Summary ───────────────────────────────────────────────────────────────────

const baseUrl = `http://apis.symphonyinteractive.ca/ota/v1/config/${subdir}/${id}.json`;

console.log('\n─────────────────────────────────────────');
console.log(`  Type:         ${isModel ? 'model' : 'device'}`);
console.log(`  ID:           ${id}`);
console.log(`  Config SHA256: ${configSha256}`);
console.log(`  Token (hex):  ${tokenHex}`);
console.log(`  Token expiry: ${new Date(expSec * 1000).toISOString()}`);
console.log(`  Remote config: ${remotePath}`);
console.log(`  Remote token:  ${remoteToken}`);
console.log(`  Download URL:  ${baseUrl}`);
console.log(`\n  Device fetch:\n  curl -H "Authorization: Bearer ${tokenHex}" \\\n    ${baseUrl}`);
console.log('─────────────────────────────────────────\n');

if (argv['dry-run']) {
  console.log('[dry-run] no files uploaded');
  process.exit(0);
}

// ── SFTP upload ───────────────────────────────────────────────────────────────

const sftp = new Client();

(async () => {
  await sftp.connect({
    host:     argv['sftp-host'],
    port:     parseInt(argv['sftp-port'], 10),
    username: argv['sftp-user'],
    password: argv['sftp-pass'],
  });
  console.log(`[sftp] connected to ${argv['sftp-host']}:${argv['sftp-port']}`);

  // Write config JSON
  await sftp.put(configBuf, remotePath);
  console.log(`[sftp] uploaded config → ${remotePath}`);

  // Write empty token file (name encodes expiry and scope)
  await sftp.put(Buffer.alloc(0), remoteToken);
  console.log(`[sftp] uploaded token  → ${remoteToken}`);

  await sftp.end();
  console.log('[sftp] done');
  console.log('\n[✓] Config uploaded. Manifest service will publish MQTT notification within 1 second.');
  console.log(`[✓] MQTT topic: scout/${isModel ? '$group/' + id : id}/$config`);
})().catch(err => {
  console.error(`[sftp] error: ${err.message}`);
  process.exit(1);
});
