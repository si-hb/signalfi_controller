/**
 * Organise mode — drag-and-drop device and folder reorganisation.
 *
 * Two Sortable groups:
 *   sf-devices — drag .device-card elements between .card-grid containers
 *   sf-folders — drag .accordion-section elements between .tree-level containers
 *
 * On drop, sendCommand({ cmd: 'setNode', mac, node }) is sent for each affected device.
 */

import Sortable from '/js/vendor/sortable.esm.js';
import { sendCommand } from './ws.js';
import { showToast } from './app.js';

const NODE_REGEX = /^[a-z0-9][a-z0-9._\-]*(\/[a-z0-9][a-z0-9._\-]*)*$/;

let _active    = false;
let _sortables = [];

export const isOrganizing = () => _active;

export function enterOrganizeMode() {
  _active = true;
  document.getElementById('device-list').classList.add('organize-mode');
  // Expand all collapsed accordions so every card-grid is reachable as a drop target
  document.querySelectorAll('.accordion-content.collapsed')
    .forEach(el => el.classList.remove('collapsed'));
  applyOrganizeMode();
}

export function exitOrganizeMode() {
  _active = false;
  document.getElementById('device-list').classList.remove('organize-mode');
  _sortables.forEach(s => s.destroy());
  _sortables = [];
}

/**
 * Destroy and re-create all Sortable instances on the current DOM.
 * Called by enterOrganizeMode() and by renderDevices() whenever the DOM is rebuilt
 * while organise mode is active.
 */
export function applyOrganizeMode() {
  _sortables.forEach(s => s.destroy());
  _sortables = [];

  // ── Device cards — drag .device-card between .card-grid elements ─────────
  document.querySelectorAll('.card-grid').forEach(grid => {
    _sortables.push(new Sortable(grid, {
      group:        { name: 'sf-devices', pull: true, put: true },
      animation:    150,
      handle:       '.drag-handle',
      draggable:    '.device-card',
      ghostClass:   'sortable-ghost',
      chosenClass:  'sortable-chosen',
      onEnd(evt) {
        if (evt.from === evt.to) return;   // reorder within same grid — no semantic meaning
        _moveDevice(evt.item.dataset.mac, evt.to.dataset.path ?? '', evt);
      },
    }));
  });

  // ── Folder sections — drag .accordion-section between .tree-level elements
  document.querySelectorAll('.tree-level').forEach(level => {
    _sortables.push(new Sortable(level, {
      group:        { name: 'sf-folders', pull: true, put: true },
      animation:    150,
      handle:       '.folder-drag-handle',
      draggable:    '.accordion-section',
      ghostClass:   'sortable-ghost',
      chosenClass:  'sortable-chosen',
      onEnd(evt) {
        if (evt.from === evt.to && evt.oldIndex === evt.newIndex) return;
        _moveFolder(evt.item.dataset.path, evt.to.dataset.path ?? '', evt);
      },
    }));
  });
}

// ─── Drop handlers ────────────────────────────────────────────────────────────

function _revert(evt) {
  // Put the item back where it came from
  const ref = evt.from.children[evt.oldDraggableIndex] ?? null;
  evt.from.insertBefore(evt.item, ref);
}

function _moveDevice(mac, newParentPath, evt) {
  const scouts = window.appState?.scouts ?? [];
  const scout  = scouts.find(s => s.mac === mac);
  if (!scout) return;

  const deviceName = scout.node ? scout.node.split('/').pop() : mac.replace(/:/g, '');
  const newNode    = newParentPath ? `${newParentPath}/${deviceName}` : deviceName;

  if (!NODE_REGEX.test(newNode)) {
    showToast(`Cannot move — "${deviceName}" contains characters not allowed in a node path`, 'error');
    _revert(evt);
    return;
  }

  scout.node = newNode;   // optimistic local update — confirmed on next WS echo
  sendCommand({ cmd: 'setNode', mac, node: newNode });
}

function _moveFolder(sourcePath, newParentPath, evt) {
  // Guard: cannot drop into own subtree
  if (newParentPath === sourcePath || newParentPath.startsWith(sourcePath + '/')) {
    showToast('Cannot move a folder into itself', 'error');
    _revert(evt);
    return;
  }

  const scouts        = window.appState?.scouts ?? [];
  const folderName    = sourcePath.split('/').pop();
  const newFolderPath = newParentPath ? `${newParentPath}/${folderName}` : folderName;
  const prefix        = sourcePath + '/';
  const affected      = scouts.filter(s => s.node?.startsWith(prefix));

  if (!affected.length) {
    showToast('No devices in this folder to move', 'info');
    return;
  }

  let anyInvalid = false;
  for (const scout of affected) {
    const suffix  = scout.node.slice(sourcePath.length);   // includes leading '/'
    const newNode = newFolderPath + suffix;
    if (!NODE_REGEX.test(newNode)) {
      anyInvalid = true;
      continue;
    }
    scout.node = newNode;
    sendCommand({ cmd: 'setNode', mac: scout.mac, node: newNode });
  }

  if (anyInvalid) {
    showToast('Some device names contain invalid characters and were skipped', 'error');
  } else {
    showToast(`Moved "${folderName}" → ${newFolderPath || '(root)'}`, 'success');
  }
}
