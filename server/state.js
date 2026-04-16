'use strict';

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

let scouts   = [];
let nodes    = [];
let presets  = [];
let settings = { aud: '', vol: 0.5, rpt: 0, clr: 'ffffff', pat: 1, dur: 10, brt: 200 };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Rebuild the nodes[] array from the current scouts list.
 * Each unique path segment prefix becomes a node entry.
 */
function rebuildNodes() {
  const pathMap = new Map(); // path -> Set of scout macs

  for (const scout of scouts) {
    const nodePath = (scout.node || '').replace(/^\/+/, '').replace(/\/+$/, '');
    if (!nodePath) continue;

    const segments = nodePath.split('/');
    for (let i = 1; i <= segments.length; i++) {
      const prefix = segments.slice(0, i).join('/');
      if (!pathMap.has(prefix)) {
        pathMap.set(prefix, new Set());
      }
      pathMap.get(prefix).add(scout.mac);
    }
  }

  // Build node entries
  const newNodes = [];
  for (const [path, memberMacs] of pathMap.entries()) {
    const memberList = Array.from(memberMacs);
    const busyCount = memberList.filter(mac => {
      const s = scouts.find(sc => sc.mac === mac);
      return s && s.status === 'announce';
    }).length;

    newNodes.push({
      path,
      members: memberList.length,
      busy: busyCount,
      index: 0, // renumbered below
    });
  }

  // Sort alphabetically and renumber
  newNodes.sort((a, b) => a.path.localeCompare(b.path));
  newNodes.forEach((n, i) => { n.index = i; });

  nodes = newNodes;
}

/**
 * Create a blank scout entry skeleton.
 */
function makeScout(mac) {
  return {
    mac,
    ip: '',
    status: 'offline',
    model: '',
    ver: '',
    mask: '',
    gate: '',
    dhcp: false,
    usb: false,
    ftp: false,
    node: '',
    oledLevel: 0,
    lastSeen: null,
  };
}

/**
 * Strip MQTT topic wrapper from a node path reported by a device.
 *
 *   "scout/$group/root/1/$action"       → "root/1"
 *   "scout/<MAC>/$action"               → ""   (individual device topic, no group)
 *   "scout/$broadcast/$action"          → ""   (broadcast, no group)
 *   "/root/1"                           → "root/1"
 *   "root/1"                            → "root/1"
 */
function cleanNodePath(raw) {
  if (!raw) return '';
  // Any topic that ends with /$action — inspect the middle segment
  const mqttMatch = raw.match(/^[^/]+\/(.+?)\/\$action$/);
  if (mqttMatch) {
    const middle = mqttMatch[1];
    // $group/<path> → return <path>
    const groupMatch = middle.match(/^\$group\/(.+)$/);
    if (groupMatch) return groupMatch[1];
    // $broadcast or any other special token → no group
    return '';
  }
  // Plain path — just strip leading/trailing slashes
  return raw.replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * Merge payload fields into an existing scout entry.
 */
function mergeScoutFields(scout, payload) {
  if (payload.ip    !== undefined) scout.ip        = payload.ip;
  if (payload.ver   !== undefined) scout.ver       = payload.ver;
  if (payload.mask  !== undefined) scout.mask      = payload.mask;
  if (payload.gate  !== undefined) scout.gate      = payload.gate;
  if (payload.dhcp  !== undefined) scout.dhcp      = payload.dhcp;
  if (payload.usb   !== undefined) scout.usb       = payload.usb;
  if (payload.ftp   !== undefined) scout.ftp       = payload.ftp;
  if (payload.oled  !== undefined) scout.oledLevel = payload.oled;
  // model: firmware sends 'mdl' in status messages and 'model' in get responses
  const incomingModel = payload.mdl ?? payload.model;
  if (incomingModel !== undefined && incomingModel !== '') scout.model = incomingModel;

  // Node path: only update from a get-response payload (act === 'get').
  // Status updates (sta field) always carry the trigger topic in nod, not
  // the device's own configured path — ignore nod in those messages entirely.
  if (payload.act === 'get') {
    const rawNode = payload.nod ?? payload.node;
    if (rawNode !== undefined) {
      const cleaned = cleanNodePath(rawNode);
      if (cleaned) scout.node = cleaned;
    }
  }

  // Status: devices use three different field names
  //   status — full state message  (e.g. { status: "online", ip: "..." })
  //   sts    — short status field
  //   sta    — play/idle status update  (e.g. { sta: "announce" })
  const incomingStatus = payload.status ?? payload.sts ?? payload.sta;
  if (incomingStatus !== undefined) scout.status = incomingStatus;

  scout.lastSeen = new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Exports — state mutation
// ---------------------------------------------------------------------------

/**
 * Process an incoming $state message for a scout.
 * Returns a delta object: { scoutUpdate, nodeUpdate }
 *   scoutUpdate: { mac, scout } | null
 *   nodeUpdate:  { nodes }      | null
 */
function processScoutState(mac, payload) {
  const incomingStatus = payload.status ?? payload.sts ?? payload.sta ?? '';
  const isOfflineOrRebooting = incomingStatus === 'offline' || incomingStatus === 'rebooting';

  let existingIndex = scouts.findIndex(s => s.mac === mac);
  let nodesChanged  = false;

  const prevNodeBefore = existingIndex !== -1 ? scouts[existingIndex].node : '(new)';
  const rawNod = payload.nod ?? payload.node;
  console.log(`[STATE] ${mac} status="${incomingStatus}" offline=${isOfflineOrRebooting} prevNode="${prevNodeBefore}" rawNod=${JSON.stringify(rawNod)}`);

  if (isOfflineOrRebooting) {
    // Full reset: remove and re-add as a blank entry updated with payload
    // Preserve the known node path so the device doesn't lose its position in the tree
    const preservedNode = existingIndex !== -1 ? scouts[existingIndex].node : '';
    if (existingIndex !== -1) {
      scouts.splice(existingIndex, 1);
    }
    const entry = makeScout(mac);
    entry.node = preservedNode;
    mergeScoutFields(entry, payload);
    scouts.push(entry);
    nodesChanged = true;
  } else {
    if (existingIndex === -1) {
      // New scout we haven't seen before
      const entry = makeScout(mac);
      mergeScoutFields(entry, payload);
      scouts.push(entry);
      nodesChanged = true;
    } else {
      const prev = scouts[existingIndex];
      const prevNode = prev.node;
      mergeScoutFields(prev, payload);
      if (prev.node !== prevNode) {
        nodesChanged = true;
      }
    }
  }

  rebuildNodes();

  const updatedScout = scouts.find(s => s.mac === mac) || null;
  console.log(`[STATE] ${mac} → node="${updatedScout ? updatedScout.node : '(not found)'}" status="${updatedScout ? updatedScout.status : ''}" nodesChanged=${nodesChanged}`);

  return {
    scoutUpdate: updatedScout ? { mac, scout: updatedScout } : null,
    nodeUpdate:  { nodes: [...nodes] },
  };
}

/**
 * Process an incoming $msg (debug) message for a scout.
 */
function processScoutMessage(mac, payload) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [MSG] scout=${mac}`, JSON.stringify(payload));
  return null;
}

// ---------------------------------------------------------------------------
// Exports — read access
// ---------------------------------------------------------------------------

function getState() {
  return {
    scouts:   [...scouts],
    nodes:    [...nodes],
    presets:  [...presets],
    settings: { ...settings },
  };
}

function getScouts()   { return [...scouts];   }
function getNodes()    { return [...nodes];    }
function getPresets()  { return [...presets];  }
function getSettings() { return { ...settings }; }

// ---------------------------------------------------------------------------
// Exports — write access
// ---------------------------------------------------------------------------

function setSettings(partial) {
  settings = { ...settings, ...partial };
  return { ...settings };
}

function setPresets(list) {
  presets = Array.isArray(list) ? [...list] : [];
  return [...presets];
}

function addPreset(preset) {
  const idx = presets.findIndex(p => p.name === preset.name);
  if (idx !== -1) {
    presets[idx] = { ...preset };
  } else {
    presets.push({ ...preset });
  }
  return [...presets];
}

function deletePreset(name) {
  presets = presets.filter(p => p.name !== name);
  return [...presets];
}

/**
 * Replace the in-memory state wholesale (used after loading from disk).
 */
function loadState({ scouts: s, nodes: n, presets: p, settings: st }) {
  if (Array.isArray(s))   scouts   = s;
  if (Array.isArray(n))   nodes    = n;
  if (Array.isArray(p))   presets  = p;
  if (st && typeof st === 'object') settings = { ...settings, ...st };
}

/**
 * Clear all node entries and rebuild from current scouts.
 */
function resetNodes() {
  nodes = [];
  rebuildNodes();
  return [...nodes];
}

/**
 * Remove all scouts whose status is 'offline' (or has no status).
 * Returns the list of MACs that were removed.
 */
function flushOfflineScouts() {
  const removed = scouts.filter(s => !s.status || s.status === 'offline').map(s => s.mac);
  scouts = scouts.filter(s => s.status && s.status !== 'offline');
  rebuildNodes();
  return removed;
}

module.exports = {
  processScoutState,
  processScoutMessage,
  getState,
  getScouts,
  getNodes,
  getPresets,
  getSettings,
  setSettings,
  setPresets,
  addPreset,
  deletePreset,
  loadState,
  resetNodes,
  flushOfflineScouts,
};
