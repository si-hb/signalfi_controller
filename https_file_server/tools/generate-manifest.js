#!/usr/bin/env node
'use strict';

/**
 * generate-manifest.js
 *
 * Generates a Signalfi OTA manifest for a device model, computes SHA256 hashes,
 * generates a time-limited download token, and uploads everything to the server
 * via SFTP. Uploading the manifest triggers an MQTT push to all subscribed devices.
 *
 * Token: 64-hex string stored as <hex>_exp<unix_seconds> in /tokens/
 *        Devices send it as: Authorization: Bearer <hex>
 *        Default expiry: 30 days. Use --token-days to override.
 *
 * compatibleFrom: defaults to ["*"] (all versions eligible).
 *   Use --compat-from 1.0.0,1.1.0 to restrict to specific versions.
 *   Empty (omitted) = ["*"]. To block all devices set --compat-from "" (empty string).
 *
 * Usage:
 *   node generate-manifest.js \
 *     --model SF-100 \
 *     --version 1.1.0 \
 *     --firmware ./SF-100-1.1.0.bin \
 *     [--compat-from 1.0.0,0.9.1]   (default: all versions) \
 *     [--token-days 30]              (default: 30 days) \
 *     [--audio ./announcement1.wav,./chime.wav] \
 *     [--delay 0] \
 *     [--files-base-url http://apis.symphonyinteractive.ca] \
 *     [--sftp-host apis.symphonyinteractive.ca] \
 *     [--sftp-port 2022] \
 *     [--sftp-user symphony] \
 *     [--sftp-pass Si9057274427] \
 *     [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const argv = require('minimist')(process.argv.slice(2), {
  string: ['model', 'version', 'firmware', 'compat-from', 'audio', 'files-base-url',
           'sftp-host', 'sftp-user', 'sftp-pass', 'sftp-port'],
  boolean: ['dry-run'],
  default: {
    'files-base-url': 'http://apis.symphonyinteractive.ca',
    'sftp-host': 'apis.symphonyinteractive.ca',
    'sftp-port': '2022',
    'sftp-user': 'symphony',
    'sftp-pass': 'Si9057274427',
    'token-days': 30,
    'delay': 0,
    'dry-run': false,
  },
});

// ── Validation ───────────────────────────────────────────────────────────────

function die(msg) {
  console.error(`[error] ${msg}`);
  process.exit(1);
}

if (!argv.model)    die('--model is required (e.g. --model SF-100)');
if (!argv.version)  die('--version is required (e.g. --version 1.1.0)');
if (!argv.firmware) die('--firmware is required (path to .bin file)');

const firmwarePath = path.resolve(argv.firmware);
if (!fs.existsSync(firmwarePath)) die(`firmware file not found: ${firmwarePath}`);

const audioPaths = argv.audio
  ? argv.audio.split(',').map(p => path.resolve(p.trim())).filter(Boolean)
  : [];

for (const ap of audioPaths) {
  if (!fs.existsSync(ap)) die(`audio file not found: ${ap}`);
}

const compatFrom = argv['compat-from'] !== undefined && argv['compat-from'] !== ''
  ? argv['compat-from'].split(',').map(v => v.trim()).filter(Boolean)
  : ['*'];  // default: all versions eligible

// ── Helpers ──────────────────────────────────────────────────────────────────

function sha256File(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

function fileSize(filePath) {
  return fs.statSync(filePath).size;
}

// ── Build manifest ───────────────────────────────────────────────────────────

console.log(`\n[generate] model:      ${argv.model}`);
console.log(`[generate] version:    ${argv.version}`);
console.log(`[generate] firmware:   ${firmwarePath}`);
console.log(`[generate] compat:     ${compatFrom.join(', ')}`);
console.log(`[generate] token-days: ${argv['token-days']}`);

// Token: 64-hex + expiry suffix for filesystem-based expiry checking
const tokenHex     = crypto.randomBytes(32).toString('hex');
const tokenExpiry  = Math.floor(Date.now() / 1000) + (Number(argv['token-days']) * 86400);
const downloadToken = tokenHex;  // devices use just the hex in Authorization: Bearer
const tokenFilename = `${tokenHex}_exp${tokenExpiry}`;  // filename on server

const baseUrl = argv['files-base-url'].replace(/\/$/, '');
const firmwareFilename = `${argv.model}-${argv.version}.bin`;

console.log(`\n[generate] computing SHA256 for firmware...`);
const firmwareSha256 = sha256File(firmwarePath);
const firmwareSize   = fileSize(firmwarePath);
console.log(`[generate] sha256: ${firmwareSha256}`);
console.log(`[generate] size:   ${firmwareSize} bytes`);

const audioEntries = [];
for (const ap of audioPaths) {
  const name = path.basename(ap);
  console.log(`\n[generate] computing SHA256 for audio: ${name}`);
  const sha256 = sha256File(ap);
  const size   = fileSize(ap);
  console.log(`[generate] sha256: ${sha256}`);
  console.log(`[generate] size:   ${size} bytes`);
  audioEntries.push({
    name,
    url: `${baseUrl}/ota/v1/audio/${name}`,
    sha256,
    size,
  });
}

const manifest = {
  modelId: argv.model,
  compatibleFrom: compatFrom,
  update: true,
  downloadToken,
  delaySeconds: Number(argv.delay) || 0,
  firmware: {
    version: argv.version,
    url: `${baseUrl}/ota/v1/firmware/${firmwareFilename}`,
    sha256: firmwareSha256,
    size: firmwareSize,
  },
  audio: audioEntries,
};

console.log(`\n[generate] manifest:\n${JSON.stringify(manifest, null, 2)}`);

if (argv['dry-run']) {
  console.log('\n[generate] dry-run — skipping SFTP upload');
  process.exit(0);
}

// ── SFTP upload ──────────────────────────────────────────────────────────────

const SftpClient = require('ssh2-sftp-client');
const sftp = new SftpClient();

async function upload() {
  const config = {
    host: argv['sftp-host'],
    port: parseInt(argv['sftp-port'], 10),
    username: argv['sftp-user'],
    password: argv['sftp-pass'],
  };

  console.log(`\n[sftp] connecting to ${config.host}:${config.port} as ${config.username}...`);
  await sftp.connect(config);
  console.log('[sftp] connected');

  // Firmware binary
  const remoteFirmware = `/firmware/${firmwareFilename}`;
  console.log(`[sftp] uploading firmware -> ${remoteFirmware}`);
  await sftp.put(firmwarePath, remoteFirmware);
  console.log('[sftp] firmware uploaded');

  // Audio files
  for (const ap of audioPaths) {
    const remotePath = `/audio/${path.basename(ap)}`;
    console.log(`[sftp] uploading audio -> ${remotePath}`);
    await sftp.put(ap, remotePath);
    console.log(`[sftp] ${path.basename(ap)} uploaded`);
  }

  // Manifest JSON
  const manifestJson = JSON.stringify(manifest, null, 2);
  const remoteManifest = `/manifests/models/${argv.model}.json`;
  console.log(`[sftp] writing manifest -> ${remoteManifest}`);
  await sftp.put(Buffer.from(manifestJson), remoteManifest);
  console.log('[sftp] manifest uploaded');

  // Token file — named <hex>_exp<unix_seconds> for server-side expiry checking
  // Devices send just the hex portion in: Authorization: Bearer <hex>
  const remoteToken = `/tokens/${tokenFilename}`;
  console.log(`[sftp] writing token -> ${remoteToken} (expires ${new Date(tokenExpiry * 1000).toISOString()})`);
  await sftp.put(Buffer.from(''), remoteToken);
  console.log('[sftp] token registered');

  await sftp.end();

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Upload complete                                             ║
╠══════════════════════════════════════════════════════════════╣
║  Model:    ${argv.model.padEnd(50)}║
║  Version:  ${argv.version.padEnd(50)}║
║  Token:    ${downloadToken.slice(0, 16)}...${downloadToken.slice(-8).padEnd(29)}║
║  Expires:  ${new Date(tokenExpiry * 1000).toISOString().padEnd(50)}║
╚══════════════════════════════════════════════════════════════╝

MQTT push will be sent to: signalfi/ota/${argv.model}

Test (devices use Authorization: Bearer header — no token in URL):
  curl "http://apis.symphonyinteractive.ca/ota/v1/manifest?modelId=${argv.model}&firmwareVersion=${compatFrom[0] === '*' ? '1.0.0' : (compatFrom[0] || '1.0.0')}"
  curl -H "Authorization: Bearer ${downloadToken}" \\
       "http://apis.symphonyinteractive.ca/ota/v1/firmware/${firmwareFilename}"
`);
}

upload().catch(err => {
  console.error(`[sftp] error: ${err.message}`);
  process.exit(1);
});
