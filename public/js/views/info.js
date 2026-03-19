/**
 * Info view — broker status, node tree, device status table
 */

import { resetNodes, flushOffline } from '../api.js';
import { showToast } from '../app.js';
import { sendCommand } from '../ws.js';

const STATUS_PRIORITY = {
  identifying: 0,
  announce: 1,
  'connecting to server': 2,
  rebooting: 2,
  'downloading firmware': 2,
  'flashing firmware': 2,
  'pulling firmware': 2,
  'going offline': 2,
  idle: 3,
  online: 3,
  offline: 4,
};

function getStatusPriority(status) {
  if (!status) return 4;
  return STATUS_PRIORITY[status.toLowerCase()] ?? 3;
}

function getStatusClass(status) {
  if (!status || status === 'offline') return 'offline';
  if (status === 'announce') return 'announce';
  if (status === 'identifying') return 'identifying';
  if ([
    'connecting to server', 'rebooting', 'downloading firmware',
    'flashing firmware', 'pulling firmware', 'going offline',
  ].includes(status)) return 'warn';
  return 'online';
}

// ─── Node Tree Selection ──────────────────────────────────────────────────────
const nodeTreeSel = new Set(); // set of selected path strings

let pathCounts = new Map();

function getAffectedMacs(selPaths, scouts) {
  const macs = new Set();
  for (const scout of scouts) {
    if (!scout.node) continue;
    for (const p of selPaths) {
      if (scout.node === p || scout.node.startsWith(p + '/')) {
        macs.add(scout.mac);
        break;
      }
    }
  }
  return macs;
}

function updateNodeTreeTally() {
  const tallyEl = document.getElementById('node-tree-tally');
  if (!tallyEl) return;
  const scouts = (window.appState && window.appState.scouts) || [];
  const n = getAffectedMacs(nodeTreeSel, scouts).size;
  if (n === 0) {
    tallyEl.hidden = true;
    tallyEl.textContent = '';
  } else {
    tallyEl.hidden = false;
    tallyEl.textContent = `${n} device${n !== 1 ? 's' : ''} selected`;
  }
}

function buildInfoView() {
  const view = document.getElementById('view-info');
  view.innerHTML = '';

  // Broker status
  const brokerHeading = document.createElement('div');
  brokerHeading.className = 'section-heading';
  brokerHeading.textContent = 'Broker Status';
  view.appendChild(brokerHeading);

  const brokerCard = document.createElement('div');
  brokerCard.className = 'settings-card';
  brokerCard.id = 'broker-status-card';
  view.appendChild(brokerCard);

  // Node tree
  const nodeHeading = document.createElement('div');
  nodeHeading.className = 'section-heading';
  nodeHeading.textContent = 'Node Tree';
  view.appendChild(nodeHeading);

  const nodeCard = document.createElement('div');
  nodeCard.className = 'settings-card';

  // Top toolbar: reset button + tally
  const nodeToolbar = document.createElement('div');
  nodeToolbar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;gap:8px;';

  const resetBtn = document.createElement('button');
  resetBtn.className = 'btn-secondary btn-danger';
  resetBtn.id = 'reset-nodes-btn';
  resetBtn.textContent = 'Clear Node Group Assignment';

  const tally = document.createElement('span');
  tally.id = 'node-tree-tally';
  tally.hidden = true;
  tally.style.cssText = 'font-size:12px;color:var(--accent-bright);font-weight:600;white-space:nowrap;';

  nodeToolbar.appendChild(resetBtn);
  nodeToolbar.appendChild(tally);
  nodeCard.appendChild(nodeToolbar);

  // Inline confirm row
  const confirmRow = document.createElement('div');
  confirmRow.id = 'reset-nodes-confirm';
  confirmRow.className = 'confirm-row';
  confirmRow.hidden = true;
  const confirmMsg = document.createElement('span');
  confirmMsg.id = 'reset-nodes-confirm-msg';
  confirmMsg.style.cssText = 'font-size:13px;color:var(--text-muted);flex:1;';
  const confirmYes = document.createElement('button');
  confirmYes.className = 'btn-primary btn-danger';
  confirmYes.id = 'reset-nodes-confirm-yes';
  confirmYes.textContent = 'Yes, Reset';
  const confirmNo = document.createElement('button');
  confirmNo.className = 'btn-secondary';
  confirmNo.textContent = 'Cancel';
  confirmRow.appendChild(confirmMsg);
  confirmRow.appendChild(confirmYes);
  confirmRow.appendChild(confirmNo);
  nodeCard.appendChild(confirmRow);

  const nodeTree = document.createElement('div');
  nodeTree.className = 'node-tree';
  nodeTree.id = 'info-node-tree';

  nodeCard.appendChild(nodeTree);
  view.appendChild(nodeCard);

  // Device table
  const tableHeading = document.createElement('div');
  tableHeading.className = 'section-heading';
  tableHeading.textContent = 'Device Summary';
  view.appendChild(tableHeading);

  const tableWrap = document.createElement('div');
  tableWrap.className = 'settings-card';
  tableWrap.style.overflow = 'hidden';

  const flushBtn = document.createElement('button');
  flushBtn.className = 'btn-secondary btn-danger';
  flushBtn.id = 'flush-offline-btn';
  flushBtn.textContent = 'Flush Offline Devices';
  flushBtn.style.margin = '12px 0px 0';
  tableWrap.appendChild(flushBtn);

  const scrollWrap = document.createElement('div');
  scrollWrap.className = 'table-scroll-wrap';
  scrollWrap.style.border = 'none';
  scrollWrap.style.borderRadius = '0';

  const table = document.createElement('table');
  table.className = 'info-table';
  table.id = 'device-status-table';

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  ['IP', 'Status', 'Node', 'Version', 'MAC'].forEach(col => {
    const th = document.createElement('th');
    th.textContent = col;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  tbody.id = 'device-status-tbody';
  table.appendChild(tbody);

  scrollWrap.appendChild(table);
  tableWrap.appendChild(scrollWrap);
  view.appendChild(tableWrap);

  // Bottom padding
  const pad = document.createElement('div');
  pad.style.height = '32px';
  view.appendChild(pad);

  // Wire events
  flushBtn.addEventListener('click', async () => {
    const scouts = (window.appState && window.appState.scouts) || [];
    const offlineCount = scouts.filter(s => !s.status || s.status === 'offline').length;
    if (offlineCount === 0) {
      showToast('No offline devices to flush');
      return;
    }
    flushBtn.disabled = true;
    flushBtn.textContent = 'Flushing…';
    try {
      const result = await flushOffline();
      flushBtn.textContent = 'Flush Offline Devices';
      flushBtn.disabled = false;
      // Remove flushed scouts from local state immediately
      if (window.appState && result.removed) {
        const removedSet = new Set(result.removed);
        window.appState.scouts = window.appState.scouts.filter(s => !removedSet.has(s.mac));
      }
      renderInfo();
      showToast(`Flushed ${result.removed.length} offline device${result.removed.length !== 1 ? 's' : ''}`, 'success');
    } catch (err) {
      flushBtn.textContent = 'Flush Offline Devices';
      flushBtn.disabled = false;
      showToast('Failed to flush offline devices', 'error');
      console.error(err);
    }
  });

  resetBtn.addEventListener('click', () => {
    const scouts = (window.appState && window.appState.scouts) || [];
    const hasSel = nodeTreeSel.size > 0;
    const n = hasSel ? getAffectedMacs(nodeTreeSel, scouts).size : scouts.filter(s => s.node).length;
    const msg = hasSel
      ? `Reset node assignments for ${n} selected device${n !== 1 ? 's' : ''}?`
      : `Reset node assignments for all ${n} device${n !== 1 ? 's' : ''}?`;
    const confirmMsgEl = document.getElementById('reset-nodes-confirm-msg');
    if (confirmMsgEl) confirmMsgEl.textContent = msg;
    document.getElementById('reset-nodes-confirm').hidden = false;
    resetBtn.disabled = true;
  });

  confirmYes.addEventListener('click', async () => {
    document.getElementById('reset-nodes-confirm').hidden = true;
    resetBtn.disabled = false;
    const scouts = (window.appState && window.appState.scouts) || [];
    const hasSel = nodeTreeSel.size > 0;

    if (!hasSel) {
      // No selection — reset all via REST (existing behaviour)
      try {
        await resetNodes();
        if (window.appState) {
          window.appState.nodes = [];
          window.appState.scouts = window.appState.scouts.map(s => ({ ...s, node: null }));
        }
        nodeTreeSel.clear();
        renderInfo();
        showToast('Node assignments reset', 'success');
      } catch (err) {
        showToast('Failed to reset nodes', 'error');
        console.error(err);
      }
      return;
    }

    // Selective reset — send setNode with node:'' via WS
    // Deduplicate: remove child paths when a parent is already selected
    const sorted = [...nodeTreeSel].sort((a, b) => a.length - b.length);
    const effective = sorted.filter(p =>
      !sorted.some(other => other !== p && p.startsWith(other + '/'))
    );

    effective.forEach(path => {
      // Check whether this is a leaf (single device) or a branch (group topic)
      const allPaths = [...(pathCounts ? pathCounts.keys() : [])];
      const isLeaf = !allPaths.some(ap => ap.startsWith(path + '/'));
      const macsUnder = scouts.filter(s => s.node && (s.node === path || s.node.startsWith(path + '/'))).map(s => s.mac);

      if (macsUnder.length === 1 || isLeaf) {
        // Single device — use individual MAC command
        sendCommand({ cmd: 'setNode', mac: macsUnder[0], node: '' });
      } else {
        // Multiple devices under this path — use group topic
        sendCommand({ cmd: 'setNode', node: '', destination: 'group', target: path });
      }
    });

    const n = getAffectedMacs(nodeTreeSel, scouts).size;
    nodeTreeSel.clear();
    renderInfo();
    showToast(`Node assignments reset for ${n} device${n !== 1 ? 's' : ''}`, 'success');
  });

  confirmNo.addEventListener('click', () => {
    document.getElementById('reset-nodes-confirm').hidden = true;
    resetBtn.disabled = false;
  });
}

function renderBrokerCard() {
  const card = document.getElementById('broker-status-card');
  if (!card) return;
  card.innerHTML = '';

  const mqttStatus = (window.appState && window.appState.mqttStatus) || 'disconnected';
  const scouts = (window.appState && window.appState.scouts) || [];

  const online = scouts.filter(s => s.status && s.status !== 'offline').length;
  const offline = scouts.filter(s => !s.status || s.status === 'offline').length;
  const announcing = scouts.filter(s => s.status === 'announce').length;
  const rtt = window.appState && window.appState.rtt;

  const rows = [
    { label: 'MQTT Broker', value: mqttStatus, isStatus: true },
    { label: 'Total Devices', value: String(scouts.length) },
    { label: 'Online', value: String(online) },
    { label: 'Offline', value: String(offline) },
    { label: 'Announcing', value: String(announcing) },
  ];

  if (rtt !== undefined) {
    rows.push({ label: 'RTT', value: `${rtt}ms` });
  }

  rows.forEach(row => {
    const el = document.createElement('div');
    el.className = 'broker-stat-row';

    const label = document.createElement('span');
    label.className = 'broker-stat-label';
    label.textContent = row.label;

    const value = document.createElement('span');
    value.className = 'broker-stat-value';

    if (row.isStatus) {
      const dot = document.createElement('span');
      const dotClass = mqttStatus === 'connected' ? 'online' :
        mqttStatus === 'reconnecting' ? 'warn' : 'offline';
      dot.className = `status-dot ${dotClass}`;
      dot.style.marginRight = '6px';
      dot.style.display = 'inline-block';
      value.appendChild(dot);
      const text = document.createElement('span');
      text.textContent = mqttStatus;
      value.appendChild(text);
    } else {
      value.textContent = row.value;
    }

    el.appendChild(label);
    el.appendChild(value);
    card.appendChild(el);
  });
}

function renderNodeTree() {
  const tree = document.getElementById('info-node-tree');
  if (!tree) return;
  tree.innerHTML = '';

  const scouts = (window.appState && window.appState.scouts) || [];

  // Build path counts from scouts
  pathCounts = new Map();
  const pathBusy = new Map();

  scouts.forEach(scout => {
    if (!scout.node) return;
    const segs = scout.node.split('/');
    for (let i = 1; i <= segs.length; i++) {
      const prefix = segs.slice(0, i).join('/');
      pathCounts.set(prefix, (pathCounts.get(prefix) || 0) + 1);
      if (scout.status === 'announce') {
        pathBusy.set(prefix, (pathBusy.get(prefix) || 0) + 1);
      }
    }
  });

  // Build sorted unique paths
  const allPaths = [...pathCounts.keys()].sort();

  if (allPaths.length === 0) {
    const empty = document.createElement('div');
    empty.style.padding = '12px 14px';
    empty.style.color = 'var(--text-muted)';
    empty.style.fontSize = '13px';
    empty.textContent = 'No nodes assigned.';
    tree.appendChild(empty);
    return;
  }

  allPaths.forEach(path => {
    const depth = path.split('/').length - 1;
    const row = document.createElement('div');
    row.className = 'node-tree-row';
    row.style.cssText = `padding-left:${14 + depth * 16}px;cursor:pointer;`;

    // Determine selection state for this path
    const macsUnder = scouts.filter(s => s.node && (s.node === path || s.node.startsWith(path + '/'))).map(s => s.mac);
    const affectedMacs = getAffectedMacs(nodeTreeSel, scouts);
    const selectedUnder = macsUnder.filter(m => affectedMacs.has(m)).length;
    const cbState = selectedUnder === 0 ? 'none' : selectedUnder === macsUnder.length ? 'checked' : 'partial';

    if (cbState !== 'none') row.classList.add('selected');

    // Checkbox
    const cb = document.createElement('span');
    cb.className = 'node-tree-cb';
    if (cbState === 'checked') { cb.classList.add('checked'); cb.textContent = '✓'; }
    else if (cbState === 'partial') { cb.classList.add('partial'); cb.textContent = '−'; }

    const name = document.createElement('span');
    name.className = 'node-tree-name';
    name.textContent = path;

    row.appendChild(cb);
    row.appendChild(name);

    // Leaf nodes always contain exactly 1 device — skip count unless busy
    const isLeaf = !allPaths.some(p => p.startsWith(path + '/'));
    const c = pathCounts.get(path) || 0;
    const b = pathBusy.get(path) || 0;
    if (!isLeaf || b > 0) {
      const count = document.createElement('span');
      count.className = 'node-tree-count';
      count.textContent = b > 0 ? `${b}/${c} busy` : `${c} device${c !== 1 ? 's' : ''}`;
      if (b > 0) count.style.color = 'var(--status-busy)';
      row.appendChild(count);
    }

    // Click to toggle selection
    row.addEventListener('click', () => {
      const allCovered = macsUnder.length > 0 && macsUnder.every(m => affectedMacs.has(m));
      if (allCovered) {
        // Deselect: remove this path and any child paths
        nodeTreeSel.delete(path);
        for (const p of [...nodeTreeSel]) {
          if (p.startsWith(path + '/')) nodeTreeSel.delete(p);
        }
      } else {
        // Select: add this path; remove child paths (parent covers them)
        nodeTreeSel.add(path);
        for (const p of [...nodeTreeSel]) {
          if (p !== path && p.startsWith(path + '/')) nodeTreeSel.delete(p);
        }
      }
      renderNodeTree();
      updateNodeTreeTally();
    });

    tree.appendChild(row);
  });

  updateNodeTreeTally();
}

function renderDeviceTable() {
  const tbody = document.getElementById('device-status-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const scouts = (window.appState && window.appState.scouts) || [];

  // Sort: identifying > announcing > transitional > idle/online > offline, then by IP
  const sorted = [...scouts].sort((a, b) => {
    const pa = getStatusPriority(a.status);
    const pb = getStatusPriority(b.status);
    if (pa !== pb) return pa - pb;
    // Sort by IP (numeric)
    const ia = (a.ip || '').split('.').map(Number);
    const ib = (b.ip || '').split('.').map(Number);
    for (let i = 0; i < 4; i++) {
      if ((ia[i] || 0) !== (ib[i] || 0)) return (ia[i] || 0) - (ib[i] || 0);
    }
    return 0;
  });

  sorted.forEach(scout => {
    const tr = document.createElement('tr');
    const statusClass = getStatusClass(scout.status);

    const tdIp = document.createElement('td');
    tdIp.className = 'monospace';
    tdIp.textContent = scout.ip || '—';

    const tdStatus = document.createElement('td');
    const dot = document.createElement('span');
    dot.className = `status-dot ${statusClass}`;
    dot.style.marginRight = '5px';
    dot.style.display = 'inline-block';
    tdStatus.appendChild(dot);
    const statusText = document.createTextNode(scout.status || 'offline');
    tdStatus.appendChild(statusText);

    const tdNode = document.createElement('td');
    tdNode.className = 'monospace';
    tdNode.textContent = scout.node || '—';

    const tdVersion = document.createElement('td');
    tdVersion.textContent = scout.ver || '—';

    const tdMac = document.createElement('td');
    tdMac.className = 'monospace';
    tdMac.textContent = scout.mac || '—';

    tr.dataset.mac = scout.mac;
    tr.appendChild(tdIp);
    tr.appendChild(tdStatus);
    tr.appendChild(tdNode);
    tr.appendChild(tdVersion);
    tr.appendChild(tdMac);
    tbody.appendChild(tr);
  });
}

function updateDeviceTableRow(mac, scout) {
  const tr = document.querySelector(`#device-status-tbody tr[data-mac="${CSS.escape(mac)}"]`);
  if (!tr) { renderDeviceTable(); return; }

  const statusClass = getStatusClass(scout.status);
  const tdStatus = tr.children[1];
  if (tdStatus) {
    tdStatus.innerHTML = '';
    const dot = document.createElement('span');
    dot.className = `status-dot ${statusClass}`;
    dot.style.marginRight = '5px';
    dot.style.display = 'inline-block';
    tdStatus.appendChild(dot);
    tdStatus.appendChild(document.createTextNode(scout.status || 'offline'));
  }
}

export function renderInfo() {
  renderBrokerCard();
  renderNodeTree();
  renderDeviceTable();
}

/**
 * Lightweight update for a scout status change that should not cause a re-sort.
 * Updates the broker card, node tree, and the specific table row in-place.
 */
export function renderInfoRow(mac, scout) {
  renderBrokerCard();
  renderNodeTree();
  updateDeviceTableRow(mac, scout);
}

export function initInfoView() {
  buildInfoView();
  renderInfo();
}
