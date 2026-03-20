/**
 * Presets sheet — save, load, and delete presets
 */

import { savePreset, deletePreset } from '../api.js';
import { sendCommand } from '../ws.js';
import { getDestination, closeSheet, showToast } from '../app.js';
import { getLightingState, setLightingState } from './lighting.js';
import { getSoundState, setSoundState } from './sound.js';

const PATTERN_NAMES = ['Off','Solid','Blink','Rotate','Pulse','Flash','Wave Out','Wave In','Audio','Left','Right','Up','Down'];

let liveMode = false;
let currentPresetName = null;

function buildSheet() {
  const el = document.getElementById('sheet-presets');
  el.innerHTML = '';

  // Handle
  const handle = document.createElement('div');
  handle.className = 'sheet-handle';
  el.appendChild(handle);

  // Header
  const header = document.createElement('div');
  header.className = 'sheet-header';
  const titleGroup = document.createElement('div');
  titleGroup.className = 'sheet-title-group';
  const title = document.createElement('span');
  title.className = 'sheet-title';
  title.textContent = 'Presets';
  titleGroup.appendChild(title);
  const closeBtn = document.createElement('button');
  closeBtn.className = 'sheet-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', closeSheet);
  header.appendChild(titleGroup);
  header.appendChild(closeBtn);
  el.appendChild(header);

  const body = document.createElement('div');
  body.className = 'sheet-body';

  // Save section
  const saveSection = document.createElement('div');
  saveSection.className = 'sheet-section';
  const saveLabel = document.createElement('div');
  saveLabel.className = 'sheet-section-label';
  saveLabel.textContent = 'Save Current Configuration';
  const inputRow = document.createElement('div');
  inputRow.className = 'input-row';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.id = 'preset-name-input';
  nameInput.placeholder = 'Preset name…';
  nameInput.maxLength = 64;
  const saveBtn = document.createElement('button');
  saveBtn.id = 'preset-save-btn';
  saveBtn.textContent = 'Save';
  inputRow.appendChild(nameInput);
  inputRow.appendChild(saveBtn);
  saveSection.appendChild(saveLabel);
  saveSection.appendChild(inputRow);
  body.appendChild(saveSection);

  // Live toggle
  const liveSection = document.createElement('div');
  liveSection.className = 'sheet-section';
  const liveRow = document.createElement('div');
  liveRow.className = 'toggle-row';
  const liveLabel = document.createElement('span');
  liveLabel.className = 'toggle-label';
  liveLabel.textContent = 'Live Announce on Tap';
  const toggleWrap = document.createElement('label');
  toggleWrap.className = 'toggle';
  const toggleInput = document.createElement('input');
  toggleInput.type = 'checkbox';
  toggleInput.id = 'preset-live-toggle';
  const toggleSlider = document.createElement('span');
  toggleSlider.className = 'toggle-slider';
  toggleWrap.appendChild(toggleInput);
  toggleWrap.appendChild(toggleSlider);
  liveRow.appendChild(liveLabel);
  liveRow.appendChild(toggleWrap);
  liveSection.appendChild(liveRow);

  const stopBtn = document.createElement('button');
  stopBtn.id = 'preset-stop-btn';
  stopBtn.className = 'btn-secondary cmd-btn';
  stopBtn.style.marginTop = '8px';
  stopBtn.textContent = 'Stop';
  liveSection.appendChild(stopBtn);

  body.appendChild(liveSection);

  // Preset list
  const listSection = document.createElement('div');
  listSection.className = 'sheet-section';
  const listLabel = document.createElement('div');
  listLabel.className = 'sheet-section-label';
  listLabel.textContent = 'Saved Presets';
  const presetList = document.createElement('div');
  presetList.className = 'preset-list';
  presetList.id = 'preset-list-container';
  listSection.appendChild(listLabel);
  listSection.appendChild(presetList);
  body.appendChild(listSection);

  el.appendChild(body);
}

function renderPresetList() {
  const container = document.getElementById('preset-list-container');
  if (!container) return;
  container.innerHTML = '';

  const presets = (window.appState && window.appState.presets) || [];
  if (presets.length === 0) {
    const empty = document.createElement('div');
    empty.style.padding = '16px';
    empty.style.textAlign = 'center';
    empty.style.color = 'var(--text-muted)';
    empty.style.fontSize = '13px';
    empty.textContent = 'No presets saved yet';
    container.appendChild(empty);
    return;
  }

  presets.forEach(preset => {
    const item = document.createElement('div');
    item.className = 'preset-item';
    item.dataset.name = preset.name;

    const heart = document.createElement('span');
    heart.className = 'preset-heart';
    heart.textContent = preset.name === currentPresetName ? '♥' : '♡';

    const info = document.createElement('div');
    info.className = 'preset-info';

    const name = document.createElement('div');
    name.className = 'preset-name';
    name.textContent = preset.name;

    const detail = document.createElement('div');
    detail.className = 'preset-detail';
    const parts = [];
    if (preset.aud) parts.push(preset.aud);
    if (preset.clr) parts.push('#' + preset.clr);
    if (preset.pat !== undefined) parts.push(PATTERN_NAMES[preset.pat] || ('Pattern ' + preset.pat));
    detail.textContent = parts.join(' · ') || 'No details';

    info.appendChild(name);
    info.appendChild(detail);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'preset-delete';
    deleteBtn.setAttribute('aria-label', 'Delete preset');
    deleteBtn.textContent = '🗑';
    deleteBtn.dataset.name = preset.name;

    item.appendChild(heart);
    item.appendChild(info);
    item.appendChild(deleteBtn);
    container.appendChild(item);
  });
}

function wireEvents() {
  // Save button
  document.getElementById('preset-save-btn').addEventListener('click', async () => {
    const nameInput = document.getElementById('preset-name-input');
    const name = nameInput.value.trim();
    if (!name) {
      showToast('Enter a preset name', 'warn');
      return;
    }

    const light = getLightingState();
    const sound = getSoundState();
    const preset = {
      name,
      clr: light.colour.replace(/^#/, ''),
      brt: light.brightness,
      pat: light.pattern,
      dur: light.timeout,
      aud: sound.selectedFile || '',
      vol: sound.volume,
      rpt: sound.loops,
    };

    try {
      await savePreset(preset);
      // Update local appState
      if (window.appState) {
        const existing = window.appState.presets.findIndex(p => p.name === name);
        if (existing >= 0) {
          window.appState.presets[existing] = preset;
        } else {
          window.appState.presets.push(preset);
        }
      }
      nameInput.value = '';
      currentPresetName = name;
      renderPresetList();
      showToast('Preset saved', 'success');
    } catch (err) {
      showToast('Failed to save preset', 'error');
      console.error(err);
    }
  });

  // Live toggle
  document.getElementById('preset-live-toggle').addEventListener('change', (e) => {
    liveMode = e.target.checked;
  });

  // Stop button
  document.getElementById('preset-stop-btn').addEventListener('click', () => {
    sendCommand({ cmd: 'stop', ...getDestination() });
    clearPresetHighlight();
    showToast('Stopped');
  });

  // Preset list (event delegation)
  document.getElementById('preset-list-container').addEventListener('click', async (e) => {
    const deleteBtn = e.target.closest('.preset-delete');
    if (deleteBtn) {
      e.stopPropagation();
      const name = deleteBtn.dataset.name;
      try {
        await deletePreset(name);
        if (window.appState) {
          window.appState.presets = window.appState.presets.filter(p => p.name !== name);
        }
        if (currentPresetName === name) currentPresetName = null;
        renderPresetList();
        showToast('Preset deleted');
      } catch (err) {
        showToast('Failed to delete preset', 'error');
        console.error(err);
      }
      return;
    }

    const item = e.target.closest('.preset-item');
    if (!item) return;

    const name = item.dataset.name;
    const presets = (window.appState && window.appState.presets) || [];
    const preset = presets.find(p => p.name === name);
    if (!preset) return;

    // Load settings into lighting and sound state
    if (preset.clr !== undefined) setLightingState({ colour: '#' + preset.clr });
    if (preset.brt !== undefined) setLightingState({ brightness: preset.brt });
    if (preset.pat !== undefined) setLightingState({ pattern: preset.pat });
    if (preset.dur !== undefined) setLightingState({ timeout: preset.dur });
    if (preset.aud !== undefined) setSoundState({ selectedFile: preset.aud || null });
    if (preset.vol !== undefined) setSoundState({ volume: preset.vol });
    if (preset.rpt !== undefined) setSoundState({ loops: preset.rpt });

    currentPresetName = name;
    renderPresetList();

    if (liveMode) {
      const dest = getDestination();
      sendCommand({
        cmd: 'announce',
        colour: '#' + preset.clr,
        brightness: preset.brt,
        pattern: preset.pat,
        timeout: preset.dur,
        audio: preset.aud || null,
        loops: preset.rpt,
        ...dest,
      });
    } else {
      showToast('Preset loaded', 'success');
      closeSheet();
    }
  });
}

export function initPresetsSheet() {
  buildSheet();
  wireEvents();
}

export function clearPresetHighlight() {
  currentPresetName = null;
  renderPresetList();
}

export function openPresetsSheet() {
  const toggle = document.getElementById('preset-live-toggle');
  if (toggle) toggle.checked = liveMode;
  renderPresetList();
}
