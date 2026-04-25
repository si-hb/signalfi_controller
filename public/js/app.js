/**
 * SignalFi Control — main application entry point
 */

import { initWS, sendCommand, registerMessageHandler, setAuthToken as wsSetAuthToken } from './ws.js';
import { initDevicesView, renderDevices, updateScoutCard, setSearchTerm, toggleViewMode } from './views/devices.js';
import { initSettingsView, renderSettings, updateStoreSection, initTheme, getSyncOffset } from './views/settings.js';
import { initInfoView, renderInfo, renderInfoRow } from './views/info.js';
import { initLogView, refreshLog, handleLogEntry, handleLogClearTap } from './views/log.js';
import { initLightingSheet, openLightingSheet } from './sheets/lighting.js';
import { renderSoundSheet } from './sheets/sound.js';
import { initPresetsSheet, openPresetsSheet } from './sheets/presets.js';
import { initDeviceSheet, openDeviceSheet, updateDeviceSheetForScout, onBackdropClose } from './sheets/device.js';
import { fetchState, fetchAudio, setAuthToken as apiSetAuthToken, loadAuthToken } from './api.js';

// ─── Render Scheduling ────────────────────────────────────────────────────────

let _renderPending = false;

export function scheduleRender() {
  if (_renderPending) return;
  _renderPending = true;
  requestAnimationFrame(() => { _renderPending = false; renderDevices(); });
}

// ─── Authentication Setup ─────────────────────────────────────────────────────

const AUTH_SESSION_KEY = 'signalfi-control-session';
const AUTH_PERMS_KEY   = 'signalfi-control-perms';
let _expireTimer       = null;
let _pendingCurrentPw  = ''; // carry login-password into change-pw dialog

function _getStoredToken()   { return sessionStorage.getItem(AUTH_SESSION_KEY) || ''; }
function _setStoredToken(t)  { sessionStorage.setItem(AUTH_SESSION_KEY, t); }
function _clearStoredToken() {
  sessionStorage.removeItem(AUTH_SESSION_KEY);
  sessionStorage.removeItem(AUTH_PERMS_KEY);
}

function scheduleExpiry(expiresAt) {
  if (_expireTimer) clearTimeout(_expireTimer);
  if (!expiresAt) return;
  const ms = expiresAt - Date.now();
  if (ms <= 0) { showLoginDialog(); return; }
  _expireTimer = setTimeout(() => {
    _clearStoredToken();
    apiSetAuthToken(null);
    wsSetAuthToken(null);
    showLoginDialog();
  }, ms);
}

function _showDialog(id)  { document.getElementById(id).classList.remove('hidden'); }
function _hideDialog(id)  { document.getElementById(id).classList.add('hidden'); }

function showLoginDialog() {
  _hideDialog('auth-changepw-dialog');
  _hideDialog('auth-denied-dialog');
  _showDialog('auth-login-dialog');
  document.getElementById('auth-login-error').classList.add('hidden');
  document.getElementById('auth-login-password').value = '';
  document.getElementById('auth-login-username').focus();
}

function showChangePasswordDialog({ forced = false } = {}) {
  _hideDialog('auth-login-dialog');
  _showDialog('auth-changepw-dialog');
  document.getElementById('auth-changepw-current').value = _pendingCurrentPw || '';
  document.getElementById('auth-changepw-current').readOnly = !!forced && !!_pendingCurrentPw;
  document.getElementById('auth-changepw-new').value     = '';
  document.getElementById('auth-changepw-confirm').value = '';
  document.getElementById('auth-changepw-error').classList.add('hidden');
  document.getElementById('auth-changepw-new').focus();
}

function showAccessDenied() {
  _hideDialog('auth-login-dialog');
  _hideDialog('auth-changepw-dialog');
  _showDialog('auth-denied-dialog');
}

function _showError(elId, msg) {
  const el = document.getElementById(elId);
  if (msg) { el.textContent = msg; el.classList.remove('hidden'); }
  else      { el.classList.add('hidden'); }
}

async function _submitLogin() {
  const username = document.getElementById('auth-login-username').value.trim();
  const password = document.getElementById('auth-login-password').value;
  if (!username || !password) return;
  const btn = document.getElementById('auth-login-submit');
  btn.disabled = true; btn.textContent = 'Signing in…';
  _showError('auth-login-error', '');
  try {
    const res = await fetch('/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.token) {
      _setStoredToken(data.token);
      apiSetAuthToken(data.token);
      wsSetAuthToken(data.token);
      sessionStorage.setItem(AUTH_PERMS_KEY, JSON.stringify({
        username: data.username, permissions: data.permissions, mustChangePassword: data.mustChangePassword,
      }));
      scheduleExpiry(data.expiresAt);
      _hideDialog('auth-login-dialog');

      if (data.mustChangePassword) {
        _pendingCurrentPw = password;
        showChangePasswordDialog({ forced: true });
        return;
      }
      if (!data.permissions || !data.permissions.webAccess) {
        showAccessDenied();
        return;
      }
      initApp();
    } else if (res.status === 423) {
      _showError('auth-login-error', data.message || 'Account temporarily locked');
    } else {
      _showError('auth-login-error', data.error || 'Invalid credentials');
    }
  } catch (_) { _showError('auth-login-error', 'Sign-in failed'); }
  finally { btn.disabled = false; btn.textContent = 'Sign In'; }
}

async function _submitChangePassword() {
  const currentPassword = document.getElementById('auth-changepw-current').value;
  const newPassword     = document.getElementById('auth-changepw-new').value;
  const confirm         = document.getElementById('auth-changepw-confirm').value;
  if (!currentPassword || !newPassword) return;
  if (newPassword !== confirm) {
    _showError('auth-changepw-error', 'New passwords do not match');
    return;
  }
  const btn = document.getElementById('auth-changepw-submit');
  btn.disabled = true; btn.textContent = 'Changing…';
  _showError('auth-changepw-error', '');
  try {
    const token = _getStoredToken();
    const res   = await fetch('/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      _hideDialog('auth-changepw-dialog');
      _pendingCurrentPw = '';
      // Re-check session — mustChangePassword should now be false
      const checkRes  = await fetch('/auth/check', { headers: { 'Authorization': `Bearer ${token}` } });
      const checkData = await checkRes.json().catch(() => ({}));
      sessionStorage.setItem(AUTH_PERMS_KEY, JSON.stringify(checkData));
      if (!checkData.permissions || !checkData.permissions.webAccess) {
        showAccessDenied();
        return;
      }
      initApp();
    } else {
      _showError('auth-changepw-error', data.error || 'Change failed');
    }
  } catch (_) { _showError('auth-changepw-error', 'Change failed'); }
  finally { btn.disabled = false; btn.textContent = 'Change Password'; }
}

async function _signOut() {
  const token = _getStoredToken();
  try {
    await fetch('/auth/logout', { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } });
  } catch (_) {}
  _clearStoredToken();
  apiSetAuthToken(null);
  wsSetAuthToken(null);
  showLoginDialog();
}

document.getElementById('auth-login-submit').addEventListener('click', _submitLogin);
document.getElementById('auth-login-username').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('auth-login-password').focus(); });
document.getElementById('auth-login-password').addEventListener('keydown', e => { if (e.key === 'Enter') _submitLogin(); });

document.getElementById('auth-changepw-submit').addEventListener('click', _submitChangePassword);
['auth-changepw-current', 'auth-changepw-new', 'auth-changepw-confirm'].forEach(id => {
  document.getElementById(id).addEventListener('keydown', e => { if (e.key === 'Enter') _submitChangePassword(); });
});
document.getElementById('auth-denied-signout').addEventListener('click', _signOut);

async function setupAuth() {
  // Remove any legacy localStorage tokens
  localStorage.removeItem('signalfi-auth-token');

  const stored = _getStoredToken();
  if (stored) {
    try {
      const res = await fetch('/auth/check', { headers: { Authorization: `Bearer ${stored}` } });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        apiSetAuthToken(stored);
        wsSetAuthToken(stored);
        scheduleExpiry(data.expiresAt);
        sessionStorage.setItem(AUTH_PERMS_KEY, JSON.stringify(data));
        if (data.mustChangePassword) {
          showChangePasswordDialog({ forced: false });
          return false;
        }
        if (!data.permissions || !data.permissions.webAccess) {
          showAccessDenied();
          return false;
        }
        return true;
      }
    } catch (_) {}
    _clearStoredToken();
  }

  showLoginDialog();
  return false; // initApp() called after successful sign-in
}

// ─── Global State ─────────────────────────────────────────────────────────────

window.appState = {
  scouts: [],
  nodes: [],
  presets: [],
  settings: {},
  audioFiles: [],
  mqttStatus: 'disconnected',
  defaultVolume: 0.8,
};

window.selectionState = {
  mode: 'none',
  selectedPaths: new Set(),
  selectedMacs: new Set(),
  identifyMode: false,
  broadcastMode: false,
};

// ─── Toast ────────────────────────────────────────────────────────────────────

export function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast${type !== 'info' ? ' ' + type : ''}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.transition = 'opacity 0.3s';
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 350);
  }, 1250);
}

// ─── Sheet Management ─────────────────────────────────────────────────────────

let _returnSheetId = null;

export function openSheet(sheetId, options = {}) {
  _returnSheetId = options.returnTo || null;
  const keepId = options.keepVisible || null;
  const overlay = document.getElementById('sheet-overlay');

  overlay.querySelectorAll('.sheet').forEach(s => {
    if (keepId && s.id === `sheet-${keepId}`) return; // leave visible underneath
    s.hidden = true;
    s.classList.remove('sheet--over');
    s.classList.remove('sheet--dimmed');
  });

  const sheet = document.getElementById(`sheet-${sheetId}`);
  if (!sheet) return;
  sheet.hidden = false;
  if (keepId) {
    sheet.classList.add('sheet--over');
    document.getElementById(`sheet-${keepId}`).classList.add('sheet--dimmed');
  }
  overlay.hidden = false;

  // Run sheet-specific open logic
  if (sheetId === 'lighting') openLightingSheet();
  else if (sheetId === 'presets') openPresetsSheet(options.recallMode || false);
  // 'device' is opened via openDeviceSheet(scout) externally
}

export function closeSheet() {
  const overlay = document.getElementById('sheet-overlay');
  if (_returnSheetId) {
    const returnTo = _returnSheetId;
    _returnSheetId = null;
    // If the return-to sheet is still visible (stacked mode), just hide the top sheet
    const returnSheet = document.getElementById(`sheet-${returnTo}`);
    if (returnSheet && !returnSheet.hidden) {
      overlay.querySelectorAll('.sheet').forEach(s => {
        if (s.id !== `sheet-${returnTo}`) { s.hidden = true; s.classList.remove('sheet--over'); }
      });
      returnSheet.classList.remove('sheet--dimmed');
      return;
    }
    openSheet(returnTo);
    return;
  }
  overlay.hidden = true;
  overlay.querySelectorAll('.sheet').forEach(s => {
    s.hidden = true;
    s.classList.remove('sheet--over');
    s.classList.remove('sheet--dimmed');
  });
}

// Close sheet when clicking backdrop
document.getElementById('sheet-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) onBackdropClose();
});

// ─── Navigation ───────────────────────────────────────────────────────────────

export function showView(viewName) {
  // Hide all views
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  // Show target
  const target = document.getElementById(`view-${viewName}`);
  if (target) target.classList.add('active');

  // Update tab active state
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === viewName);
  });

  // Update top bar title
  const titles = { devices: 'Devices', settings: 'Settings', info: 'Info', log: 'Log' };
  const titleEl = document.getElementById('top-bar-title');
  if (titleEl) titleEl.textContent = titles[viewName] || viewName;

  // Hide top-bar actions on non-device views
  const topBarDefault = document.getElementById('top-bar-default');
  const topBarSel = document.getElementById('top-bar-selection');
  const actionBar = document.getElementById('action-bar');

  if (viewName === 'log') refreshLog();

  const btnLogClear = document.getElementById('btn-log-clear');

  if (viewName !== 'devices') {
    // Show clean header on settings/info/log
    if (topBarDefault) topBarDefault.hidden = false;
    if (topBarSel) topBarSel.hidden = true;
    if (actionBar) actionBar.hidden = true;
    // Hide the device-specific buttons
    const btnSelectAll = document.getElementById('btn-select-all');
    const btnSearch = document.getElementById('btn-search');
    const btnViewToggle = document.getElementById('btn-view-toggle');
    const btnIdentify = document.getElementById('btn-identify');
    if (btnSelectAll) btnSelectAll.hidden = true;
    if (btnSearch) btnSearch.hidden = true;
    if (btnViewToggle) btnViewToggle.hidden = true;
    if (btnIdentify) btnIdentify.hidden = true;
    if (btnLogClear) btnLogClear.hidden = (viewName !== 'log');
  } else {
    const btnSelectAll = document.getElementById('btn-select-all');
    const btnSearch = document.getElementById('btn-search');
    const btnViewToggle = document.getElementById('btn-view-toggle');
    const btnIdentify = document.getElementById('btn-identify');
    if (btnSelectAll) btnSelectAll.hidden = false;
    if (btnSearch) btnSearch.hidden = false;
    if (btnViewToggle) btnViewToggle.hidden = false;
    if (btnIdentify) btnIdentify.hidden = false;
    if (btnLogClear) btnLogClear.hidden = true;
    updateSelectionUI();
  }
}

// ─── Selection ────────────────────────────────────────────────────────────────

export function clearSelection() {
  window.selectionState.selectedMacs.clear();
  window.selectionState.selectedPaths.clear();
  window.selectionState.broadcastMode = false;
  updateSelectionUI();
  renderDevices();
}

export function updateSelectionUI() {
  const sel = window.selectionState.selectedMacs;
  const count = sel.size;
  const isBroadcast = window.selectionState.broadcastMode;
  const hasSelection = count > 0 || isBroadcast;

  const defaultBar = document.getElementById('top-bar-default');
  const selBar = document.getElementById('top-bar-selection');
  const actionBar = document.getElementById('action-bar');
  const countEl = document.getElementById('selection-count');
  const btnSelectAll = document.getElementById('btn-select-all');

  // Only update if on devices view
  const devicesView = document.getElementById('view-devices');
  const isDevicesActive = devicesView && devicesView.classList.contains('active');

  if (isDevicesActive) {
    if (hasSelection) {
      if (defaultBar) defaultBar.hidden = true;
      if (selBar) selBar.hidden = false;
      if (actionBar) actionBar.hidden = false;
    } else {
      if (defaultBar) defaultBar.hidden = false;
      if (selBar) selBar.hidden = true;
      if (actionBar) actionBar.hidden = true;
    }
  }

  if (countEl) countEl.textContent = isBroadcast ? 'All Devices' : `${count} Selected`;
  if (btnSelectAll) btnSelectAll.classList.toggle('active', isBroadcast);

  window.selectionState.mode = hasSelection ? 'selection' : 'none';
  updateStoreSection();
}

// ─── Destination ─────────────────────────────────────────────────────────────

export function getDestination() {
  const sel = window.selectionState;

  if (sel.broadcastMode) {
    return { destination: 'broadcast', target: null };
  }

  const macs = [...sel.selectedMacs];

  if (macs.length === 0) {
    return { destination: 'broadcast', target: null };
  }

  const scouts = (window.appState && window.appState.scouts) || [];

  // Rule 1: if every online device is selected → broadcast
  const onlineScouts = scouts.filter(s => s.status && s.status !== 'offline');
  if (onlineScouts.length > 0 && onlineScouts.length === macs.length &&
      onlineScouts.every(s => sel.selectedMacs.has(s.mac))) {
    return { destination: 'broadcast', target: null };
  }

  // Rule 2: check group paths — collect all ancestor group paths from selected scouts.
  // In the tree, a device's node field includes the device-name as the last segment,
  // so group paths are formed by all prefixes up to (but not including) the last segment.
  const candidatePaths = new Set();
  for (const mac of macs) {
    const scout = scouts.find(s => s.mac === mac);
    if (!scout || !scout.node) continue;
    const segments = scout.node.trim().split('/').filter(Boolean);
    for (let i = 1; i < segments.length; i++) {
      candidatePaths.add(segments.slice(0, i).join('/'));
    }
  }

  // Rule 2 cont: from most-specific (longest) to least-specific, find a group path
  // whose online members exactly match the selected set.
  const sortedPaths = [...candidatePaths].sort((a, b) => b.length - a.length);
  for (const path of sortedPaths) {
    const groupOnlineMacs = scouts
      .filter(s => s.node && (s.node === path || s.node.startsWith(path + '/')) &&
                   s.status && s.status !== 'offline')
      .map(s => s.mac);
    if (groupOnlineMacs.length === macs.length && groupOnlineMacs.every(m => sel.selectedMacs.has(m))) {
      return { destination: 'group', target: path };
    }
  }

  // Rule 3: individual MACs
  return { destination: 'selected', target: macs };
}

// ─── MQTT Indicator ──────────────────────────────────────────────────────────

export function updateMqttIndicator(status) {
  window.appState.mqttStatus = status;
  ['btn-mqtt-status', 'btn-mqtt-status-sel'].forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.className = `mqtt-indicator ${status}`;
  });

  // Show banner if reconnecting
  const banner = document.getElementById('reconnect-banner');
  if (banner) {
    banner.hidden = (status === 'connected');
  }

  if (status === 'disconnected' || status === 'reconnecting') {
    document.body.classList.add('ws-disconnected');
  } else {
    document.body.classList.remove('ws-disconnected');
  }
}

// ─── WS Message Handler ───────────────────────────────────────────────────────

// Sort priority used to decide whether a status change warrants a full re-render.
// Mirrors statusSortPriority() in devices.js — keep in sync.
function scoutSortPriority(status) {
  if (!status || status === 'offline') return 2;
  if (status === 'idle') return 1;
  return 0; // active: announce, identifying, transitional states
}

export function handleWsMessage(msg) {
  switch (msg.type) {
    case 'state': {
      const oldScouts = window.appState.scouts || [];
      window.appState = { ...window.appState, ...msg };
      const newScouts = window.appState.scouts || [];

      // Only re-render devices if the sort order or structure changed.
      // Skips re-sorting for announce→idle and other active→idle transitions.
      let needsDeviceRender = oldScouts.length !== newScouts.length;
      if (!needsDeviceRender) {
        for (const ns of newScouts) {
          const os = oldScouts.find(s => s.mac === ns.mac);
          if (!os) { needsDeviceRender = true; break; }
          if (os.node !== ns.node) { needsDeviceRender = true; break; }
          const prevPri = scoutSortPriority(os.status);
          const newPri  = scoutSortPriority(ns.status);
          // Re-render on any priority shift EXCEPT active→idle (announce/online→idle)
          if (prevPri !== newPri && !(prevPri < newPri && ns.status === 'idle')) {
            needsDeviceRender = true; break;
          }
        }
      }

      if (needsDeviceRender) scheduleRender();
      renderSettings();
      renderInfo();
      if (msg.mqttOnline !== undefined) updateMqttIndicator(msg.mqttOnline ? 'connected' : 'disconnected');
      // Refresh sound list in case audio files changed
      renderSoundSheet();
      break;
    }

    case 'scoutUpdate': {
      const idx = window.appState.scouts.findIndex(s => s.mac === msg.mac);
      const prevStatus = idx >= 0 ? window.appState.scouts[idx].status : null;
      const prevNode   = idx >= 0 ? window.appState.scouts[idx].node   : null;
      if (idx >= 0) {
        const incoming = { ...msg.scout };
        // Never overwrite a known node path with an empty one
        if (!incoming.node && window.appState.scouts[idx].node) {
          incoming.node = window.appState.scouts[idx].node;
        }
        window.appState.scouts[idx] = { ...window.appState.scouts[idx], ...incoming };
      } else {
        window.appState.scouts.push(msg.scout);
      }
      const updatedScout = window.appState.scouts.find(s => s.mac === msg.mac) || msg.scout;
      if (msg.scout.status === 'identifying') {
        // Auto-open the device sheet for this device (guard to avoid flicker if already open)
        const overlay = document.getElementById('sheet-overlay');
        if (overlay.hidden) openSheet('device');
        openDeviceSheet(updatedScout);
      } else {
        // Update the sheet if it is already showing this device
        updateDeviceSheetForScout(msg.mac, updatedScout);
      }
      const newStatus  = updatedScout.status;
      const nodeChanged = prevNode !== updatedScout.node;
      if (nodeChanged) {
        // Node path changed — must fully re-render so the card moves to the correct group.
        // updateScoutCard only does in-place DOM updates and would leave the card in its old group.
        scheduleRender();
      } else {
        // Pure status transition — update in-place, skipping renderDevices() for idle transitions
        // to avoid resorting the list unnecessarily.
        const idleFromOnline = newStatus === 'idle' && prevStatus && prevStatus !== 'offline';
        updateScoutCard(msg.mac, msg.scout, !idleFromOnline);
      }
      if (!nodeChanged && newStatus === 'idle' && prevStatus && prevStatus !== 'offline') {
        renderInfoRow(msg.mac, updatedScout);
      } else {
        renderInfo();
      }
      break;
    }

    case 'nodeUpdate':
      window.appState.nodes = msg.nodes;
      // Devices view builds its own tree from scouts — no renderDevices() needed here.
      // The accompanying scoutUpdate handles any device position changes.
      renderInfo();
      break;

    case 'mqttStatus':
      updateMqttIndicator(msg.status);
      renderInfo();
      break;

    case 'audioFiles':
      window.appState.audioFiles = msg.files;
      renderSoundSheet();
      break;

    case 'presets':
      window.appState.presets = msg.presets || [];
      renderSettings();
      break;

    case 'logEntry':
      handleLogEntry(msg.entry);
      break;

    case 'session-terminated':
      _clearStoredToken();
      apiSetAuthToken(null);
      wsSetAuthToken(null);
      if (_expireTimer) { clearTimeout(_expireTimer); _expireTimer = null; }
      showLoginDialog();
      break;

    default:
      break;
  }
}

// ─── Broadcast Mode Toggle ────────────────────────────────────────────────────

function toggleBroadcastMode() {
  const entering = !window.selectionState.broadcastMode;
  window.selectionState.broadcastMode = entering;
  if (entering) {
    window.selectionState.selectedMacs.clear();
    window.selectionState.selectedPaths.clear();
  }
  updateSelectionUI();
  renderDevices();
}

// ─── Identify Toggle ──────────────────────────────────────────────────────────

function toggleIdentify() {
  window.selectionState.identifyMode = !window.selectionState.identifyMode;
  document.getElementById('btn-identify').classList.toggle('active', window.selectionState.identifyMode);
  document.getElementById('btn-identify-sel').classList.toggle('active', window.selectionState.identifyMode);
  document.getElementById('identify-banner').hidden = !window.selectionState.identifyMode;
  if (window.selectionState.identifyMode) clearSelection();
}

// ─── Search ───────────────────────────────────────────────────────────────────

let searchVisible = false;

function openSearch() {
  searchVisible = true;
  document.getElementById('search-bar').hidden = false;
  document.getElementById('search-input').focus();
}

function closeSearch() {
  searchVisible = false;
  document.getElementById('search-bar').hidden = true;
  document.getElementById('search-input').value = '';
  setSearchTerm('');
}

// ─── Wire Top Bar ─────────────────────────────────────────────────────────────

function wireTopBar() {
  document.getElementById('btn-select-all').addEventListener('click', toggleBroadcastMode);
  document.getElementById('btn-search').addEventListener('click', openSearch);
  document.getElementById('btn-search-close').addEventListener('click', closeSearch);

  document.getElementById('search-input').addEventListener('input', (e) => {
    setSearchTerm(e.target.value);
  });

  document.getElementById('search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSearch();
  });

  document.getElementById('btn-view-toggle').addEventListener('click', () => {
    toggleViewMode();
  });

  document.getElementById('btn-identify').addEventListener('click', toggleIdentify);
  document.getElementById('btn-identify-sel').addEventListener('click', toggleIdentify);

  document.getElementById('btn-clear-selection').addEventListener('click', () => {
    clearSelection();
  });

  document.getElementById('btn-presets').addEventListener('click', () => {
    openSheet('presets', { recallMode: true });
  });

  // MQTT status buttons — show info view on click
  ['btn-mqtt-status', 'btn-mqtt-status-sel'].forEach(id => {
    document.getElementById(id).addEventListener('click', () => showView('info'));
  });

  const btnLogClear = document.getElementById('btn-log-clear');
  if (btnLogClear) {
    btnLogClear.addEventListener('click', () => handleLogClearTap(btnLogClear));
  }
}

// ─── Wire Tab Navigation ─────────────────────────────────────────────────────

function wireTabNav() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      showView(view);
    });
  });
}

// ─── Wire Action Bar ──────────────────────────────────────────────────────────

function wireActionBar() {
  document.getElementById('btn-lighting').addEventListener('click', () => openSheet('lighting'));

  document.getElementById('btn-announce').addEventListener('click', () => {
    Promise.all([
      import('./sheets/lighting.js').then(m => m.getLightingState()),
      import('./sheets/sound.js').then(m => m.getSoundState()),
    ]).then(([light, sound]) => {
      sendCommand({
        cmd: 'announce',
        colour: light.colour,
        brightness: light.brightness,
        pattern: light.pattern,
        timeout: light.timeout,
        audio: sound.selectedFile,
        volume: sound.volume,
        loops: sound.loops,
        syncOffset: getSyncOffset(),
        ...getDestination(),
      });
    });
  });

  document.getElementById('btn-stop').addEventListener('click', () => {
    sendCommand({ cmd: 'stop', ...getDestination() });
  });
}

// ─── Load Initial State ───────────────────────────────────────────────────────

async function loadInitialState() {
  try {
    const state = await fetchState();
    window.appState = { ...window.appState, ...state };
    renderDevices();
    renderSettings();
    renderInfo();
    renderSoundSheet();
    if (state.mqttOnline !== undefined) {
      updateMqttIndicator(state.mqttOnline ? 'connected' : 'disconnected');
    }
  } catch (err) {
    console.warn('Could not fetch initial state:', err.message);
    // Not fatal — WS will push state when it connects
  }

  try {
    const audioData = await fetchAudio();
    if (audioData && audioData.files) {
      window.appState.audioFiles = audioData.files;
    } else if (Array.isArray(audioData)) {
      window.appState.audioFiles = audioData;
    }
    renderSoundSheet();
  } catch (err) {
    console.warn('Could not fetch audio files:', err.message);
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

// Called once auth is confirmed — starts WS and loads state
function initApp() {
  registerMessageHandler(handleWsMessage);
  initWS();
  loadInitialState();
  updateMqttIndicator('disconnected');
}

async function init() {
  initTheme();

  initLightingSheet();
  initPresetsSheet();
  initDeviceSheet(openSheet);

  initDevicesView();
  initSettingsView();
  initInfoView();
  initLogView();

  wireTopBar();
  wireTabNav();
  wireActionBar();

  const authOk = await setupAuth();
  if (authOk) initApp();
  // If !authOk, initApp() is called from _submitCode() after SMS verify
}

init();
