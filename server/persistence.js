'use strict';

const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readJson(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    const ts = new Date().toISOString();
    console.error(`[${ts}] [PERSISTENCE] Failed to write ${filePath}:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// Debounce registry: one debounce handle per unique key
// ---------------------------------------------------------------------------

const debounceHandles = {};

function debounceWrite(key, fn, delayMs = 1000) {
  if (debounceHandles[key]) {
    clearTimeout(debounceHandles[key]);
  }
  debounceHandles[key] = setTimeout(() => {
    delete debounceHandles[key];
    fn();
  }, delayMs);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load all state files from dataDir.
 * Returns { scouts, nodes, presets, settings } with safe empty defaults.
 */
function load(dataDir) {
  ensureDir(dataDir);
  return {
    scouts:   readJson(path.join(dataDir, 'scouts.json'),   []),
    nodes:    readJson(path.join(dataDir, 'nodes.json'),    []),
    presets:  readJson(path.join(dataDir, 'presets.json'),  []),
    settings: readJson(path.join(dataDir, 'settings.json'), {}),
  };
}

/**
 * Save all state files (debounced per file).
 */
function save(dataDir, { scouts, nodes, presets, settings }) {
  saveScouts(dataDir, scouts);
  saveNodes(dataDir, nodes);
  savePresets(dataDir, presets);
  saveSettings(dataDir, settings);
}

function saveScouts(dataDir, scouts) {
  ensureDir(dataDir);
  debounceWrite('scouts', () => {
    writeJson(path.join(dataDir, 'scouts.json'), scouts);
  });
}

function saveNodes(dataDir, nodes) {
  ensureDir(dataDir);
  debounceWrite('nodes', () => {
    writeJson(path.join(dataDir, 'nodes.json'), nodes);
  });
}

function savePresets(dataDir, presets) {
  ensureDir(dataDir);
  debounceWrite('presets', () => {
    writeJson(path.join(dataDir, 'presets.json'), presets);
  });
}

function saveSettings(dataDir, settings) {
  ensureDir(dataDir);
  debounceWrite('settings', () => {
    writeJson(path.join(dataDir, 'settings.json'), settings);
  });
}

module.exports = {
  load,
  save,
  saveScouts,
  saveNodes,
  savePresets,
  saveSettings,
};
