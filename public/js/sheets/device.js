/**
 * Device detail sheet — per-device info and controls
 */

import { sendCommand } from '../ws.js';
import { closeSheet, showToast } from '../app.js';

// Each path segment must start with [a-z0-9]; underscores allowed anywhere except segment-start
const NODE_REGEX = /^[a-z0-9][a-z0-9._\-]*(\/[a-z0-9][a-z0-9._\-]*)*$/;

let currentScout = null;
let _openSheet = null;
const identifyQueue = []; // ordered array of MACs awaiting display

const FIELD_DEFS = [
  { key: 'status', label: 'Status' },
  { key: 'ip', label: 'IP Address', mono: true },
  { key: 'mac', label: 'MAC Address', mono: true },
  { key: 'node', label: 'Node Path', mono: true },
  { key: 'ver', label: 'Firmware' },
  { key: 'dhcp', label: 'DHCP' },
  { key: 'subnet', label: 'Subnet', mono: true },
  { key: 'gateway', label: 'Gateway', mono: true },
  { key: 'ftp', label: 'FTP' },
];

function updateIdentifyBanner() {
  const span = document.querySelector('#device-sheet-body .identify-banner span:last-child');
  if (!span) return;
  const n = identifyQueue.length;
  span.textContent = n > 0 ? `Device is Identifying — ${n} more pending` : 'Device is Identifying';
}

function enqueueIdentifying(mac) {
  if (currentScout && currentScout.mac === mac) {
    // Already showing this device — re-render to reflect the identifying state
    const scout = window.appState.scouts.find(s => s.mac === mac);
    if (scout) renderDeviceSheet(scout);
    return;
  }
  if (identifyQueue.includes(mac)) return;

  if (currentScout === null) {
    const scout = window.appState.scouts.find(s => s.mac === mac);
    if (!scout) return;
    _openSheet('device');
    renderDeviceSheet(scout);
  } else {
    identifyQueue.push(mac);
    if (currentScout.status === 'identifying') updateIdentifyBanner();
  }
}

function advanceQueue() {
  currentScout = null;
  while (identifyQueue.length > 0) {
    const nextMac = identifyQueue.shift();
    const nextScout = window.appState.scouts.find(s => s.mac === nextMac);
    if (nextScout) {
      renderDeviceSheet(nextScout);
      return;
    }
    // Scout gone from state — discard and try next
  }
  closeSheet();
}

function buildSheet() {
  const el = document.getElementById('sheet-device');
  el.innerHTML = '';

  // Handle
  const handle = document.createElement('div');
  handle.className = 'sheet-handle';
  el.appendChild(handle);

  // Header (dynamic — filled on open)
  const header = document.createElement('div');
  header.className = 'sheet-header';
  const titleGroup = document.createElement('div');
  titleGroup.className = 'sheet-title-group';
  const title = document.createElement('span');
  title.className = 'sheet-title';
  title.id = 'device-sheet-title';
  title.textContent = 'Device';
  titleGroup.appendChild(title);
  const closeBtn = document.createElement('button');
  closeBtn.className = 'sheet-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', () => advanceQueue());
  header.appendChild(titleGroup);
  header.appendChild(closeBtn);
  el.appendChild(header);

  const body = document.createElement('div');
  body.className = 'sheet-body';
  body.id = 'device-sheet-body';
  el.appendChild(body);
}

function renderDeviceSheet(scout) {
  currentScout = scout;
  const body = document.getElementById('device-sheet-body');
  if (!body) return;
  body.innerHTML = '';

  // Title
  const titleEl = document.getElementById('device-sheet-title');
  if (titleEl) {
    const displayName = scout.node ? scout.node.split('/').pop() : scout.mac;
    titleEl.textContent = displayName;
  }

  // Identifying banner
  if (scout.status === 'identifying') {
    const banner = document.createElement('div');
    banner.className = 'identify-banner';
    const n = identifyQueue.length;
    const text = n > 0 ? `Device is Identifying — ${n} more pending` : 'Device is Identifying';
    banner.innerHTML = `<span class="identify-pulse"></span><span>${text}</span>`;
    body.appendChild(banner);
  }

  // Fields section
  const fieldsSection = document.createElement('div');
  fieldsSection.className = 'sheet-section';
  const fieldsLabel = document.createElement('div');
  fieldsLabel.className = 'sheet-section-label';
  fieldsLabel.textContent = 'Device Info';
  fieldsSection.appendChild(fieldsLabel);

  FIELD_DEFS.forEach(field => {
    const val = scout[field.key];
    if (val === undefined || val === null || val === '') return;

    const row = document.createElement('div');
    row.className = 'detail-field';

    const label = document.createElement('span');
    label.className = 'detail-field-label';
    label.textContent = field.label;

    const value = document.createElement('span');
    value.className = 'detail-field-value' + (field.mono ? ' monospace' : '');
    value.textContent = String(val);

    row.appendChild(label);
    row.appendChild(value);
    fieldsSection.appendChild(row);
  });
  body.appendChild(fieldsSection);

  // Set Node Path
  const nodeSection = document.createElement('div');
  nodeSection.className = 'sheet-section';
  const nodeLabel = document.createElement('div');
  nodeLabel.className = 'sheet-section-label';
  nodeLabel.textContent = 'Set Node Path';
  const nodeRow = document.createElement('div');
  nodeRow.className = 'input-row';
  const nodeInput = document.createElement('input');
  nodeInput.type = 'text';
  nodeInput.id = 'device-node-input';
  nodeInput.placeholder = 'building/floor/room';
  nodeInput.value = scout.node || '';
  nodeInput.setAttribute('autocapitalize', 'none');
  nodeInput.setAttribute('autocorrect', 'off');
  const nodeBtn = document.createElement('button');
  nodeBtn.textContent = 'Set';
  nodeBtn.id = 'device-node-btn';
  nodeRow.appendChild(nodeInput);
  nodeRow.appendChild(nodeBtn);
  nodeSection.appendChild(nodeLabel);
  nodeSection.appendChild(nodeRow);
  body.appendChild(nodeSection);

  // Action buttons
  const actionsSection = document.createElement('div');
  actionsSection.className = 'sheet-section';
  const actionsLabel = document.createElement('div');
  actionsLabel.className = 'sheet-section-label';
  actionsLabel.textContent = 'Actions';

  function makeActionBtn(label, id, classes) {
    const btn = document.createElement('button');
    btn.id = id;
    btn.className = classes;
    btn.style.marginBottom = '8px';
    btn.textContent = label;
    return btn;
  }

  const identifyBtn = makeActionBtn('Identify', 'device-identify-btn', 'btn-secondary cmd-btn');
  const rebootBtn = makeActionBtn('Reboot Device', 'device-reboot-btn', 'btn-secondary btn-warn cmd-btn');
  const otaBtn = makeActionBtn('Firmware Update (OTA)', 'device-ota-btn', 'btn-secondary cmd-btn');

  // Reboot confirm area
  const rebootConfirm = document.createElement('div');
  rebootConfirm.id = 'device-reboot-confirm';
  rebootConfirm.className = 'confirm-row';
  rebootConfirm.hidden = true;
  const rebootYes = document.createElement('button');
  rebootYes.className = 'btn-primary btn-danger';
  rebootYes.textContent = 'Yes, Reboot';
  const rebootNo = document.createElement('button');
  rebootNo.className = 'btn-secondary';
  rebootNo.textContent = 'Cancel';
  rebootConfirm.appendChild(rebootYes);
  rebootConfirm.appendChild(rebootNo);

  // OTA confirm area
  const otaConfirm = document.createElement('div');
  otaConfirm.id = 'device-ota-confirm';
  otaConfirm.className = 'confirm-row';
  otaConfirm.hidden = true;
  const otaYes = document.createElement('button');
  otaYes.className = 'btn-primary btn-warn';
  otaYes.textContent = 'Yes, Update';
  const otaNo = document.createElement('button');
  otaNo.className = 'btn-secondary';
  otaNo.textContent = 'Cancel';
  otaConfirm.appendChild(otaYes);
  otaConfirm.appendChild(otaNo);

  actionsSection.appendChild(actionsLabel);
  actionsSection.appendChild(identifyBtn);
  actionsSection.appendChild(rebootBtn);
  actionsSection.appendChild(rebootConfirm);
  actionsSection.appendChild(otaBtn);
  actionsSection.appendChild(otaConfirm);
  actionsSection.hidden = scout.status === 'identifying';
  body.appendChild(actionsSection);

  // Acknowledge section — shown only when status === 'identifying'
  const ackSection = document.createElement('div');
  ackSection.className = 'sheet-section';
  ackSection.id = 'device-ack-section';
  ackSection.hidden = scout.status !== 'identifying';

  const ackLabel = document.createElement('div');
  ackLabel.className = 'sheet-section-label';
  ackLabel.textContent = 'Acknowledgement Required';

  const ackBtn = document.createElement('button');
  ackBtn.id = 'device-ack-btn';
  ackBtn.className = 'btn-primary cmd-btn';
  ackBtn.style.cssText = 'width:100%;font-size:18px;padding:18px;margin-top:8px;';
  ackBtn.textContent = '✓ Acknowledge';

  ackSection.appendChild(ackLabel);
  ackSection.appendChild(ackBtn);
  body.appendChild(ackSection);

  // Pull File section
  const pullSection = document.createElement('div');
  pullSection.className = 'sheet-section';
  const pullLabel = document.createElement('div');
  pullLabel.className = 'sheet-section-label';
  pullLabel.textContent = 'Pull File to Device';
  const pullRow = document.createElement('div');
  pullRow.className = 'input-row';
  const pullInput = document.createElement('input');
  pullInput.type = 'text';
  pullInput.id = 'device-pull-input';
  pullInput.placeholder = 'filename.wav';
  const pullBtn = document.createElement('button');
  pullBtn.textContent = 'Pull';
  pullBtn.id = 'device-pull-btn';
  pullRow.appendChild(pullInput);
  pullRow.appendChild(pullBtn);
  pullSection.appendChild(pullLabel);
  pullSection.appendChild(pullRow);
  body.appendChild(pullSection);

  wireDeviceEvents(scout);
}

function wireDeviceEvents(scout) {
  // Node path live validation
  const nodeInput = document.getElementById('device-node-input');
  const nodeBtn = document.getElementById('device-node-btn');

  function validateNodeInput() {
    const val = nodeInput.value.trim().toLowerCase();
    const invalid = val.length > 0 && !NODE_REGEX.test(val);
    nodeInput.classList.toggle('input-invalid', invalid);
    return invalid;
  }

  nodeInput.addEventListener('input', validateNodeInput);

  // Set node path
  nodeBtn.addEventListener('click', () => {
    const val = nodeInput.value.trim().toLowerCase();
    if (!val) {
      showToast('Enter a node path', 'warn');
      return;
    }
    if (validateNodeInput()) {
      showToast('Invalid node path format', 'error');
      return;
    }
    sendCommand({ cmd: 'setNode', mac: scout.mac, node: val });
    showToast('Node path sent');
  });

  // Identify
  document.getElementById('device-identify-btn').addEventListener('click', () => {
    sendCommand({ cmd: 'identify', mac: scout.mac });
    showToast('Identifying…');
  });

  // Reboot
  document.getElementById('device-reboot-btn').addEventListener('click', () => {
    const confirm = document.getElementById('device-reboot-confirm');
    confirm.hidden = !confirm.hidden;
  });
  document.getElementById('device-reboot-confirm').querySelector('.btn-danger').addEventListener('click', () => {
    sendCommand({ cmd: 'reboot', mac: scout.mac });
    document.getElementById('device-reboot-confirm').hidden = true;
    showToast('Rebooting…');
    advanceQueue();
  });
  document.getElementById('device-reboot-confirm').querySelector('.btn-secondary').addEventListener('click', () => {
    document.getElementById('device-reboot-confirm').hidden = true;
  });

  // OTA firmware update
  document.getElementById('device-ota-btn').addEventListener('click', () => {
    const confirm = document.getElementById('device-ota-confirm');
    confirm.hidden = !confirm.hidden;
  });
  document.getElementById('device-ota-confirm').querySelector('.btn-warn').addEventListener('click', () => {
    sendCommand({ cmd: 'firmwareUpdate', mac: scout.mac });
    document.getElementById('device-ota-confirm').hidden = true;
    showToast('Firmware update started…');
    advanceQueue();
  });
  document.getElementById('device-ota-confirm').querySelector('.btn-secondary').addEventListener('click', () => {
    document.getElementById('device-ota-confirm').hidden = true;
  });

  // Acknowledge
  const ackBtn = document.getElementById('device-ack-btn');
  if (ackBtn) {
    ackBtn.addEventListener('click', () => {
      sendCommand({ cmd: 'acknowledge', destination: 'selected', target: [scout.mac] });
      // Do not close — let the device status update re-render the sheet naturally
    });
  }

  // Pull file
  document.getElementById('device-pull-btn').addEventListener('click', () => {
    const input = document.getElementById('device-pull-input');
    const filename = input.value.trim();
    if (!filename) {
      showToast('Enter a filename', 'warn');
      return;
    }
    sendCommand({ cmd: 'pullFile', mac: scout.mac, file: filename });
    showToast('Pull file sent');
  });
}

export function initDeviceSheet(openSheetFn) {
  _openSheet = openSheetFn;
  buildSheet();
}

export function openDeviceSheet(scout) {
  if (scout.status === 'identifying') {
    enqueueIdentifying(scout.mac);
  } else {
    renderDeviceSheet(scout);
  }
}

export function onBackdropClose() {
  if (currentScout !== null) {
    advanceQueue();
  } else {
    closeSheet();
  }
}

/**
 * Called on every scoutUpdate for the device currently shown in the sheet.
 * Re-renders to reflect latest status (actions vs acknowledge section).
 * Also removes devices from the queue if they leave identifying state.
 */
export function updateDeviceSheetForScout(mac, scout) {
  // Case A: currently displayed — re-render
  if (currentScout && currentScout.mac === mac) {
    renderDeviceSheet(scout);
    return;
  }
  // Case B: queued but no longer identifying — remove silently
  const queueIdx = identifyQueue.indexOf(mac);
  if (queueIdx !== -1 && scout.status !== 'identifying') {
    identifyQueue.splice(queueIdx, 1);
    if (currentScout && currentScout.status === 'identifying') updateIdentifyBanner();
  }
}
