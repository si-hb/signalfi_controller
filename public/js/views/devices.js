/**
 * Devices view — accordion tree with device cards
 */

import { sendCommand } from '../ws.js';
import { updateSelectionUI, showToast, openSheet } from '../app.js';
import { openDeviceSheet } from '../sheets/device.js';

const EXPAND_STORAGE_KEY = 'signalfi_expanded';

let currentSearchTerm = '';
let viewMode = 'grid'; // 'grid' | 'list'
let ptrStartY = 0;
let ptrPulling = false;

// ─── Expand/Collapse State ───────────────────────────────────────────────────

function getExpandedPaths() {
  try {
    const raw = sessionStorage.getItem(EXPAND_STORAGE_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function setExpandedPaths(set) {
  try {
    sessionStorage.setItem(EXPAND_STORAGE_KEY, JSON.stringify([...set]));
  } catch {
    // ignore
  }
}

function isExpanded(path) {
  return getExpandedPaths().has(path);
}

function toggleExpanded(path) {
  const set = getExpandedPaths();
  if (set.has(path)) set.delete(path);
  else set.add(path);
  setExpandedPaths(set);
}

// ─── Tree Building ───────────────────────────────────────────────────────────

/**
 * Build a prefix tree from scouts.
 * Returns { children: Map<segment, node>, scouts: [] }
 * where each tree node has the same shape.
 */
function buildTree(scouts) {
  const root = { children: new Map(), scouts: [] };

  for (const scout of scouts) {
    if (!scout.node || !scout.node.trim()) {
      // Unorganized
      root.scouts.push(scout);
      continue;
    }

    const segments = scout.node.trim().split('/').filter(Boolean);
    let cursor = root;

    // Navigate to the PARENT node — all segments except the last.
    // The last segment is the device's display name, not a folder.
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      if (!cursor.children.has(seg)) {
        cursor.children.set(seg, { children: new Map(), scouts: [] });
      }
      cursor = cursor.children.get(seg);
    }
    cursor.scouts.push(scout);
  }

  return root;
}

// ─── Status helpers ──────────────────────────────────────────────────────────

function statusSortPriority(status) {
  if (!status || status === 'offline') return 2;
  if (status === 'idle') return 1;
  return 0; // online and active (announcing, etc.)
}

function sortedScouts(scouts) {
  return [...scouts].sort((a, b) => statusSortPriority(a.status) - statusSortPriority(b.status));
}

function getStatusClass(status) {
  if (!status || status === 'offline') return 'offline';
  if (status === 'announce') return 'announce';
  if ([
    'connecting to server', 'rebooting', 'downloading firmware',
    'flashing firmware', 'pulling firmware', 'going offline',
  ].includes(status)) return 'warn';
  return 'online';
}

function getStatusIcon(statusClass) {
  switch (statusClass) {
    case 'offline': return '⬡';
    case 'announce': return '📢';
    case 'warn': return '⟳';
    default: return '⬢';
  }
}

// ─── Selection helpers ───────────────────────────────────────────────────────

function getAllMacsUnderPath(pathPrefix, scouts) {
  const macs = [];
  for (const s of scouts) {
    if (s.node && (s.node === pathPrefix || s.node.startsWith(pathPrefix + '/'))) {
      macs.push(s.mac);
    }
  }
  return macs;
}

function checkboxStateForPath(pathPrefix, scouts) {
  const macs = getAllMacsUnderPath(pathPrefix, scouts);
  if (macs.length === 0) return 'none';
  const sel = window.selectionState.selectedMacs;
  const selected = macs.filter(m => sel.has(m)).length;
  if (selected === 0) return 'none';
  if (selected === macs.length) return 'checked';
  return 'partial';
}

// ─── Card / Row Factories ─────────────────────────────────────────────────────

function makeStatusDot(statusClass) {
  const dot = document.createElement('span');
  dot.className = `status-dot ${statusClass}`;
  return dot;
}

function makeDeviceCard(scout) {
  const statusClass = getStatusClass(scout.status);
  const displayName = scout.node ? scout.node.split('/').pop() : scout.mac;

  const card = document.createElement('div');
  card.className = `device-card${statusClass === 'announce' ? ' announcing' : ''}`;
  card.dataset.mac = scout.mac;

  if (window.selectionState.selectedMacs.has(scout.mac) || window.selectionState.broadcastMode) {
    card.classList.add('selected');
  }

  // Icon
  const icon = document.createElement('span');
  icon.className = `card-icon status-${statusClass}`;
  if (statusClass === 'online') {
    const img = document.createElement('img');
    img.src = '/images/signalfi_icon.svg';
    img.alt = '';
    img.setAttribute('aria-hidden', 'true');
    icon.appendChild(img);
  } else {
    icon.textContent = getStatusIcon(statusClass);
  }

  // Card body wrapper (for list view)
  const cardBody = document.createElement('div');
  cardBody.className = 'card-body';

  const name = document.createElement('span');
  name.className = 'card-name';
  name.textContent = displayName;

  const mac = document.createElement('span');
  mac.className = 'card-mac';
  mac.textContent = scout.mac || '';

  const statusRow = document.createElement('div');
  statusRow.className = 'card-status';
  const dot = makeStatusDot(statusClass);
  const statusText = document.createElement('span');
  statusText.className = 'card-status-text';
  statusText.textContent = scout.status || 'offline';
  statusRow.appendChild(dot);
  statusRow.appendChild(statusText);

  cardBody.appendChild(name);
  cardBody.appendChild(mac);
  cardBody.appendChild(statusRow);

  card.appendChild(icon);
  card.appendChild(cardBody);

  // Click: select or identify; long-press: open device detail
  let longPressTimer = null;
  let wasLongPress = false;

  card.addEventListener('pointerdown', () => {
    wasLongPress = false;
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      wasLongPress = true;
      openSheet('device');
      openDeviceSheet(scout);
    }, 600);
  });

  card.addEventListener('pointerup', () => {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  });

  card.addEventListener('pointermove', () => {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  });

  card.addEventListener('click', () => {
    if (wasLongPress) { wasLongPress = false; return; }

    if (window.selectionState.identifyMode) {
      sendCommand({ cmd: 'identify', mac: scout.mac });
      showToast(`Identifying ${displayName}…`);
      return;
    }

    const sel = window.selectionState.selectedMacs;
    if (sel.has(scout.mac)) {
      sel.delete(scout.mac);
    } else {
      sel.add(scout.mac);
    }
    card.classList.toggle('selected', sel.has(scout.mac));
    updateSelectionUI();
    // Refresh accordion checkboxes above this card
    updateAccordionCheckboxes();
  });

  return card;
}

function makeAccordionRow(path, count, busyCount, depth) {
  const segments = path.split('/');
  const label = segments[segments.length - 1];
  const parentPath = segments.slice(0, -1).join('/');
  const expanded = isExpanded(path);
  const scouts = (window.appState && window.appState.scouts) || [];
  const cbState = checkboxStateForPath(path, scouts);

  const row = document.createElement('div');
  row.className = `accordion-row indent-${depth}`;
  row.dataset.path = path;
  if (cbState === 'checked') row.classList.add('selected');
  else if (cbState === 'partial') row.classList.add('partial');

  // Checkbox
  const checkbox = document.createElement('div');
  checkbox.className = 'accordion-checkbox';
  if (cbState === 'checked') { checkbox.classList.add('checked'); checkbox.textContent = '✓'; }
  else if (cbState === 'partial') { checkbox.classList.add('partial-check'); checkbox.textContent = '−'; }
  checkbox.setAttribute('aria-label', 'Select group');

  // Chevron
  const chevron = document.createElement('span');
  chevron.className = `accordion-chevron${expanded ? ' expanded' : ''}`;
  chevron.textContent = '▶';

  // Label
  const labelEl = document.createElement('div');
  labelEl.className = 'accordion-label';
  if (parentPath) {
    const parentSpan = document.createElement('span');
    parentSpan.className = 'accordion-path-parent';
    parentSpan.textContent = parentPath;
    labelEl.appendChild(parentSpan);
  }
  const segSpan = document.createElement('span');
  segSpan.className = 'accordion-path-segment';
  segSpan.textContent = label;
  labelEl.appendChild(segSpan);

  // Badge
  const badge = document.createElement('span');
  badge.className = `accordion-badge${busyCount > 0 ? ' has-busy' : ''}`;
  badge.textContent = busyCount > 0 ? `${busyCount}/${count}` : String(count);

  row.appendChild(checkbox);
  row.appendChild(chevron);
  row.appendChild(labelEl);
  row.appendChild(badge);

  // Checkbox click → select/deselect subtree
  checkbox.addEventListener('click', (e) => {
    e.stopPropagation();
    const sel = window.selectionState.selectedMacs;
    const macs = getAllMacsUnderPath(path, scouts);
    const currentState = checkboxStateForPath(path, scouts);

    if (currentState === 'checked') {
      // Deselect all
      macs.forEach(m => sel.delete(m));
      window.selectionState.selectedPaths.delete(path);
    } else {
      // Select all
      macs.forEach(m => sel.add(m));
      window.selectionState.selectedPaths.add(path);
    }

    updateSelectionUI();
    renderDevices();
  });

  // Row click → expand/collapse
  row.addEventListener('click', () => {
    toggleExpanded(path);
    const content = document.querySelector(`.accordion-content[data-path="${CSS.escape(path)}"]`);
    if (content) {
      const nowExpanded = isExpanded(path);
      content.classList.toggle('collapsed', !nowExpanded);
      chevron.classList.toggle('expanded', nowExpanded);
    }
  });

  return row;
}

// ─── Rendering ───────────────────────────────────────────────────────────────


function countBusyUnderNode(treeNode) {
  let busy = treeNode.scouts.filter(s => s.status === 'announce').length;
  for (const child of treeNode.children.values()) {
    busy += countBusyUnderNode(child);
  }
  return busy;
}

function scoutMatchesSearch(scout, term) {
  if (!term) return true;
  const t = term.toLowerCase();
  return (
    (scout.node && scout.node.toLowerCase().includes(t)) ||
    (scout.mac && scout.mac.toLowerCase().includes(t)) ||
    (scout.ip && scout.ip.toLowerCase().includes(t))
  );
}

function renderTreeNode(treeNode, path, depth, container) {
  const term = currentSearchTerm;
  let anyVisible = false;

  // Render children first (accordion groups)
  for (const [seg, child] of treeNode.children.entries()) {
    const childPath = path ? `${path}/${seg}` : seg;
    const busy = countBusyUnderNode(child);

    // Check if any scouts in this subtree match search
    const childScouts = getAllScoutsFromNode(child);
    const matchingScouts = term
      ? childScouts.filter(s => scoutMatchesSearch(s, term))
      : childScouts;

    if (matchingScouts.length === 0 && term) continue;

    anyVisible = true;

    const row = makeAccordionRow(childPath, matchingScouts.length, busy, depth);

    // Expand if search is active and there are matches
    const expanded = term ? true : isExpanded(childPath);

    const content = document.createElement('div');
    content.className = `accordion-content${expanded ? '' : ' collapsed'}`;
    content.dataset.path = childPath;

    renderTreeNode(child, childPath, depth + 1, content);

    container.appendChild(row);
    container.appendChild(content);
  }

  // Render leaf scouts as card grid
  const visibleScouts = sortedScouts(treeNode.scouts.filter(s => scoutMatchesSearch(s, term)));
  if (visibleScouts.length > 0) {
    anyVisible = true;
    const grid = document.createElement('div');
    grid.className = `card-grid indent-${depth}`;
    visibleScouts.forEach(scout => {
      grid.appendChild(makeDeviceCard(scout));
    });
    container.appendChild(grid);
  }

  return anyVisible;
}

function getAllScoutsFromNode(treeNode) {
  let scouts = [...treeNode.scouts];
  for (const child of treeNode.children.values()) {
    scouts = scouts.concat(getAllScoutsFromNode(child));
  }
  return scouts;
}

export function renderDevices() {
  const list = document.getElementById('device-list');
  if (!list) return;
  list.innerHTML = '';

  // Set view mode class
  list.classList.toggle('list-mode', viewMode === 'list');

  const scouts = (window.appState && window.appState.scouts) || [];

  if (scouts.length === 0 && !currentSearchTerm) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const icon = document.createElement('div');
    icon.className = 'empty-state-icon';
    icon.textContent = '📡';
    const text = document.createElement('div');
    text.className = 'empty-state-text';
    text.textContent = 'No devices found.\nConnect devices to the network and they will appear here.';
    empty.appendChild(icon);
    empty.appendChild(text);
    list.appendChild(empty);
    return;
  }

  const tree = buildTree(scouts);

  // Stash unorganized scouts before tree render (they are handled separately below)
  const unorganizedScouts = tree.scouts;
  tree.scouts = [];

  // Pull-to-refresh zone
  const ptrZone = document.createElement('div');
  ptrZone.className = 'ptr-zone';
  ptrZone.id = 'ptr-zone';
  ptrZone.innerHTML = '<div class="ptr-spinner">↻ Pull to refresh</div>';
  list.appendChild(ptrZone);

  // Render tree
  renderTreeNode(tree, '', 0, list);

  // Unorganized section
  const unorg = unorganizedScouts;
  const visibleUnorg = sortedScouts(unorg.filter(s => scoutMatchesSearch(s, currentSearchTerm)));
  if (visibleUnorg.length > 0) {
    const header = document.createElement('div');
    header.className = 'unorganized-header';
    header.textContent = 'Unorganized';
    list.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'card-grid';
    visibleUnorg.forEach(scout => grid.appendChild(makeDeviceCard(scout)));
    list.appendChild(grid);
  }

  // Empty search result
  if (currentSearchTerm) {
    const allVisible = list.querySelectorAll('.device-card').length;
    if (allVisible === 0) {
      list.innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      const icon = document.createElement('div');
      icon.className = 'empty-state-icon';
      icon.textContent = '🔍';
      const text = document.createElement('div');
      text.className = 'empty-state-text';
      text.textContent = `No devices matching "${currentSearchTerm}"`;
      empty.appendChild(icon);
      empty.appendChild(text);
      list.appendChild(empty);
    }
  }
}

function updateAccordionCheckboxes() {
  const scouts = (window.appState && window.appState.scouts) || [];
  document.querySelectorAll('#device-list .accordion-row').forEach(row => {
    const path = row.dataset.path;
    if (!path) return;
    const cbState = checkboxStateForPath(path, scouts);
    const cb = row.querySelector('.accordion-checkbox');
    if (!cb) return;
    cb.className = 'accordion-checkbox';
    cb.textContent = '';
    if (cbState === 'checked') {
      cb.classList.add('checked');
      cb.textContent = '✓';
      row.classList.add('selected');
      row.classList.remove('partial');
    } else if (cbState === 'partial') {
      cb.classList.add('partial-check');
      cb.textContent = '−';
      row.classList.remove('selected');
      row.classList.add('partial');
    } else {
      row.classList.remove('selected', 'partial');
    }
  });
}

export function updateScoutCard(mac, scout, allowFallback = true) {
  const card = document.querySelector(`.device-card[data-mac="${CSS.escape(mac)}"]`);
  if (!card) {
    // Card may not be in current tree — full re-render (skipped for idle transitions to avoid resorting)
    if (allowFallback) renderDevices();
    return;
  }

  const statusClass = getStatusClass(scout.status);

  // Update icon
  const icon = card.querySelector('.card-icon');
  if (icon) {
    icon.className = `card-icon status-${statusClass}`;
    if (statusClass === 'online') {
      icon.innerHTML = '<img src="/images/signalfi_icon.svg" alt="" aria-hidden="true">';
    } else {
      icon.textContent = getStatusIcon(statusClass);
    }
  }

  // Update status dot
  const dot = card.querySelector('.status-dot');
  if (dot) dot.className = `status-dot ${statusClass}`;

  // Update status text
  const statusText = card.querySelector('.card-status-text');
  if (statusText) statusText.textContent = scout.status || 'offline';

  // Update card-level classes
  card.classList.toggle('announcing', statusClass === 'announce');

  // Update name if changed
  const nameEl = card.querySelector('.card-name');
  if (nameEl && scout.node) {
    const displayName = scout.node.split('/').pop();
    nameEl.textContent = displayName;
  }
}

// ─── Pull-to-refresh ─────────────────────────────────────────────────────────

function initPullToRefresh() {
  const view = document.getElementById('view-devices');
  if (!view) return;

  view.addEventListener('touchstart', (e) => {
    if (view.scrollTop === 0) {
      ptrStartY = e.touches[0].clientY;
      ptrPulling = true;
    }
  }, { passive: true });

  view.addEventListener('touchmove', (e) => {
    if (!ptrPulling) return;
    const delta = e.touches[0].clientY - ptrStartY;
    if (delta > 60) {
      const zone = document.getElementById('ptr-zone');
      if (zone) zone.classList.add('active');
    }
  }, { passive: true });

  view.addEventListener('touchend', () => {
    if (!ptrPulling) return;
    ptrPulling = false;
    const zone = document.getElementById('ptr-zone');
    if (zone && zone.classList.contains('active')) {
      zone.classList.remove('active');
      sendCommand({ cmd: 'refresh' });
    }
  }, { passive: true });
}

// ─── Search ───────────────────────────────────────────────────────────────────

export function setSearchTerm(term) {
  currentSearchTerm = term.trim();
  renderDevices();
}

// ─── View Toggle ─────────────────────────────────────────────────────────────

export function toggleViewMode() {
  viewMode = viewMode === 'grid' ? 'list' : 'grid';
  renderDevices();
}

// ─── Init ─────────────────────────────────────────────────────────────────────

export function initDevicesView() {
  initPullToRefresh();
  renderDevices();
}
