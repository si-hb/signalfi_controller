/**
 * Settings view — presets management, calibration, store volume, file management, node assignment
 */

import { sendCommand } from '../ws.js';
import { getDestination, showToast } from '../app.js';
import { deletePreset, savePreset } from '../api.js';
import { sliderToGain, gainToSlider, roundGain, throttle, applyTheme, getTheme, sliderToDb, gainToDb, dbToSlider } from '../utils.js';
import { clearPresetHighlight } from '../sheets/presets.js';

const NOTE_NAMES = ['A', 'A#', 'B', 'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#'];

function semitoneToHz(n) {
  return Math.round(110 * Math.pow(2, n / 12));
}

function hzToNearestSemitone(hz) {
  return Math.round(12 * Math.log2(hz / 110));
}

function semitoneToName(n) {
  const oct = Math.floor(n / 12) + 2;
  return NOTE_NAMES[n % 12] + oct;
}

// Calibration state
const calState = {
  volume: 50,
  semitone: 0,
  freq: 110,
};

// Store volume state
let storeTarget = 'all'; // 'all' | 'selected'
let nodeTarget = 'all'; // 'all' | 'selected'

// Each path segment must start with [a-z0-9]; underscores allowed anywhere except segment-start
const NODE_REGEX = /^[a-z0-9][a-z0-9\/._\-]*(\/[a-z0-9][a-z0-9\/._\-]*)*$/;

function buildSettingsView() {
  const view = document.getElementById('view-settings');
  view.innerHTML = '';

  // ── Appearance ───────────────────────────────────────────────────────────
  const appearanceHeading = document.createElement('div');
  appearanceHeading.className = 'section-heading';
  appearanceHeading.textContent = 'Appearance';
  view.appendChild(appearanceHeading);

  const appearanceCard = document.createElement('div');
  appearanceCard.className = 'settings-card';

  const themeRow = document.createElement('div');
  themeRow.className = 'toggle-row';
  const themeLabel = document.createElement('span');
  themeLabel.className = 'toggle-label';
  themeLabel.textContent = 'Theme';

  const themeGroup = document.createElement('div');
  themeGroup.className = 'radio-group';
  themeGroup.id = 'theme-group';
  themeGroup.style.marginBottom = '0';

  const currentTheme = getTheme();
  [['dark', 'Dark'], ['light', 'Light']].forEach(([value, label]) => {
    const option = document.createElement('div');
    option.className = 'radio-option' + (currentTheme === value ? ' selected' : '');
    option.dataset.value = value;
    option.textContent = label;
    themeGroup.appendChild(option);
  });

  themeRow.appendChild(themeLabel);
  themeRow.appendChild(themeGroup);
  appearanceCard.appendChild(themeRow);
  view.appendChild(appearanceCard);

  // ── Presets ──────────────────────────────────────────────────────────────
  const presetsHeading = document.createElement('div');
  presetsHeading.className = 'section-heading';
  presetsHeading.textContent = 'Presets';
  view.appendChild(presetsHeading);

  const presetsCard = document.createElement('div');
  presetsCard.className = 'settings-card';
  const presetListEl = document.createElement('div');
  presetListEl.className = 'preset-list';
  presetListEl.id = 'settings-preset-list';
  presetsCard.appendChild(presetListEl);
  view.appendChild(presetsCard);

  // ── Calibration ──────────────────────────────────────────────────────────
  const calHeading = document.createElement('div');
  calHeading.className = 'section-heading';
  calHeading.textContent = 'Calibration';
  view.appendChild(calHeading);

  const calCard = document.createElement('div');
  calCard.className = 'settings-card';

  // Volume slider
  const volRow = makeSliderRow('Volume', 'cal-vol', 0, 100, calState.volume, '');
  const volInitSpan = volRow.querySelector('#cal-vol-val');
  if (volInitSpan) {
    const calVolDbInput = document.createElement('input');
    calVolDbInput.type = 'text';
    calVolDbInput.className = 'db-input';
    calVolDbInput.id = 'cal-vol-val';
    calVolDbInput.value = sliderToDb(calState.volume);
    const calVolDbUnit = document.createElement('span');
    calVolDbUnit.className = 'db-unit';
    calVolDbUnit.textContent = 'dB';
    volInitSpan.replaceWith(calVolDbInput);
    calVolDbInput.after(calVolDbUnit);
  }
  calCard.appendChild(volRow);

  // Note slider (0–76 semitones)
  const noteRow = makeSliderRow('Note', 'cal-note', 0, 76, calState.semitone, '');
  // Remove numeric slider value for NOTE; keep the musical note label instead.
  const noteNumericDisplay = noteRow.querySelector('#cal-note-val');
  if (noteNumericDisplay) noteNumericDisplay.remove();
  // Add note name display
  const noteDisplay = document.createElement('span');
  noteDisplay.id = 'cal-note-name';
  noteDisplay.className = 'slider-value';
  noteDisplay.style.width = '40px';
  noteDisplay.textContent = semitoneToName(calState.semitone);
  noteRow.appendChild(noteDisplay);
  calCard.appendChild(noteRow);

  // Freq slider
  const freqRow = makeSliderRow('Freq', 'cal-freq', 200, 10000, calState.freq, '');
  const freqInitSpan = freqRow.querySelector('#cal-freq-val');
  if (freqInitSpan) {
    const calFreqTextInput = document.createElement('input');
    calFreqTextInput.type = 'text';
    calFreqTextInput.className = 'db-input';
    calFreqTextInput.id = 'cal-freq-val';
    calFreqTextInput.value = calState.freq;
    const calFreqUnit = document.createElement('span');
    calFreqUnit.className = 'db-unit';
    calFreqUnit.textContent = 'Hz';
    freqInitSpan.replaceWith(calFreqTextInput);
    calFreqTextInput.after(calFreqUnit);
  }
  calCard.appendChild(freqRow);

  // Tone buttons
  const toneSection = document.createElement('div');
  toneSection.className = 'sheet-section';
  toneSection.style.marginTop = '12px';
  const toneLabel = document.createElement('div');
  toneLabel.className = 'sheet-section-label';
  toneLabel.textContent = 'Send Test Signal';
  const toneBtns = document.createElement('div');
  toneBtns.style.display = 'flex';
  toneBtns.style.gap = '8px';

  ['Tone', 'Pink', 'Sweep'].forEach(label => {
    const btn = document.createElement('button');
    btn.className = 'btn-secondary cmd-btn';
    btn.style.flex = '1';
    btn.textContent = label;
    btn.dataset.calType = label.toLowerCase().replace(' ', '_');
    toneBtns.appendChild(btn);
  });

  const stopBtn = document.createElement('button');
  stopBtn.className = 'btn-secondary cmd-btn';
  stopBtn.id = 'cal-stop-btn';
  stopBtn.style.flex = '1';
  stopBtn.textContent = 'Stop';
  toneBtns.appendChild(stopBtn);
  toneSection.appendChild(toneLabel);
  toneSection.appendChild(toneBtns);
  calCard.appendChild(toneSection);

  view.appendChild(calCard);

  // ── Store Volume ──────────────────────────────────────────────────────────
  const storeHeading = document.createElement('div');
  storeHeading.className = 'section-heading';
  storeHeading.style.display = 'flex';
  storeHeading.style.justifyContent = 'space-between';
  storeHeading.style.alignItems = 'center';
  const storeHeadingTitle = document.createElement('span');
  storeHeadingTitle.id = 'store-volume-heading';
  storeHeadingTitle.textContent = 'SET DEFAULT VOLUME = ';
  const storeVolumeValue = document.createElement('span');
  storeVolumeValue.id = 'store-volume-value';
  storeVolumeValue.style.textTransform = 'none';
  storeVolumeValue.textContent = `${sliderToDb(calState.volume)} dB`;
  storeHeadingTitle.appendChild(storeVolumeValue);
  const storeDeviceCount = document.createElement('span');
  storeDeviceCount.id = 'store-device-count';
  storeDeviceCount.style.fontSize = '12px';
  storeDeviceCount.style.fontWeight = 'normal';
  storeDeviceCount.style.color = 'var(--text-muted)';
  storeHeading.appendChild(storeHeadingTitle);
  storeHeading.appendChild(storeDeviceCount);
  view.appendChild(storeHeading);

  const storeCard = document.createElement('div');
  storeCard.className = 'settings-card';

  const radioGroup = document.createElement('div');
  radioGroup.className = 'radio-group';
  radioGroup.id = 'store-target-group';

  ['All Devices', 'Selected Devices'].forEach((label, i) => {
    const option = document.createElement('div');
    option.className = 'radio-option' + (i === 0 ? ' selected' : '');
    option.dataset.value = i === 0 ? 'all' : 'selected';
    option.textContent = label;
    radioGroup.appendChild(option);
  });

  const storeBtn = document.createElement('button');
  storeBtn.className = 'btn-primary cmd-btn';
  storeBtn.id = 'store-volume-btn';
  storeBtn.style.marginTop = '8px';
  storeBtn.textContent = 'Set Default Volume';

  storeCard.appendChild(radioGroup);
  storeCard.appendChild(storeBtn);
  view.appendChild(storeCard);

  // ── Set Node Target ───────────────────────────────────────────────────────
  const nodeHeading = document.createElement('div');
  nodeHeading.className = 'section-heading';
  nodeHeading.style.display = 'flex';
  nodeHeading.style.justifyContent = 'space-between';
  nodeHeading.style.alignItems = 'center';
  const nodeHeadingTitle = document.createElement('span');
  nodeHeadingTitle.textContent = 'Set Node Target';
  const nodeDeviceCount = document.createElement('span');
  nodeDeviceCount.id = 'node-device-count';
  nodeDeviceCount.style.fontSize = '12px';
  nodeDeviceCount.style.fontWeight = 'normal';
  nodeDeviceCount.style.color = 'var(--text-muted)';
  nodeHeading.appendChild(nodeHeadingTitle);
  nodeHeading.appendChild(nodeDeviceCount);
  view.appendChild(nodeHeading);

  const nodeCard = document.createElement('div');
  nodeCard.className = 'settings-card';

  const nodeTargetGroup = document.createElement('div');
  nodeTargetGroup.className = 'radio-group';
  nodeTargetGroup.id = 'node-target-group';

  ['All Devices', 'Selected Devices'].forEach((label, i) => {
    const option = document.createElement('div');
    option.className = 'radio-option' + (i === 0 ? ' selected' : '');
    option.dataset.value = i === 0 ? 'all' : 'selected';
    option.textContent = label;
    nodeTargetGroup.appendChild(option);
  });

  const nodeDesc = document.createElement('p');
  nodeDesc.style.fontSize = '13px';
  nodeDesc.style.color = 'var(--text-muted)';
  nodeDesc.style.marginBottom = '12px';
  nodeDesc.textContent = 'Assign a node path to the target devices. Format: building/floor/room';

  const nodeRow = document.createElement('div');
  nodeRow.className = 'input-row';
  const nodeInput = document.createElement('input');
  nodeInput.type = 'text';
  nodeInput.id = 'settings-node-input';
  nodeInput.placeholder = 'building/floor/room';
  nodeInput.setAttribute('autocapitalize', 'none');
  nodeInput.setAttribute('autocorrect', 'off');
  const nodeBtn = document.createElement('button');
  nodeBtn.textContent = 'Set';
  nodeBtn.id = 'settings-node-btn';
  nodeRow.appendChild(nodeInput);
  nodeRow.appendChild(nodeBtn);

  nodeCard.appendChild(nodeTargetGroup);
  nodeCard.appendChild(nodeDesc);
  nodeCard.appendChild(nodeRow);
  view.appendChild(nodeCard);

  // ── File Management ───────────────────────────────────────────────────────
  const fileHeading = document.createElement('div');
  fileHeading.className = 'section-heading';
  fileHeading.textContent = 'File Management';
  view.appendChild(fileHeading);

  const fileCard = document.createElement('div');
  fileCard.className = 'settings-card';

  const fileLabel = document.createElement('div');
  fileLabel.className = 'sheet-section-label';
  fileLabel.textContent = 'Pull File to Devices';

  const fileRow = document.createElement('div');
  fileRow.className = 'input-row';
  const fileInput = document.createElement('input');
  fileInput.type = 'text';
  fileInput.id = 'settings-file-input';
  fileInput.placeholder = 'filename.wav';
  const fileBtn = document.createElement('button');
  fileBtn.textContent = 'Pull';
  fileBtn.id = 'settings-file-btn';
  fileRow.appendChild(fileInput);
  fileRow.appendChild(fileBtn);

  fileCard.appendChild(fileLabel);
  fileCard.appendChild(fileRow);
  view.appendChild(fileCard);

  // Add bottom padding
  const pad = document.createElement('div');
  pad.style.height = '32px';
  view.appendChild(pad);
}

function makeSliderRow(labelText, id, min, max, value, unit) {
  const row = document.createElement('div');
  row.className = 'slider-row';
  row.style.marginBottom = '14px';

  const label = document.createElement('label');
  label.textContent = labelText;
  label.htmlFor = id;

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.id = id;
  slider.min = String(min);
  slider.max = String(max);
  slider.value = String(value);

  const valDisplay = document.createElement('span');
  valDisplay.className = 'slider-value';
  valDisplay.id = id + '-val';
  valDisplay.textContent = value + unit;

  row.appendChild(label);
  row.appendChild(slider);
  row.appendChild(valDisplay);
  return row;
}

function renderPresetList() {
  const container = document.getElementById('settings-preset-list');
  if (!container) return;
  container.innerHTML = '';

  const presets = (window.appState && window.appState.presets) || [];
  const PATTERN_NAMES = ['Off','Solid','Blink','Rotate','Pulse','Flash','Wave Out','Wave In','Audio','Left','Right','Up','Down'];

  if (presets.length === 0) {
    const empty = document.createElement('div');
    empty.style.padding = '12px';
    empty.style.color = 'var(--text-muted)';
    empty.style.fontSize = '13px';
    empty.textContent = 'No presets saved.';
    container.appendChild(empty);
    return;
  }

  presets.forEach(preset => {
    const item = document.createElement('div');
    item.className = 'preset-item';
    item.dataset.name = preset.name;

    const heart = document.createElement('span');
    heart.className = 'preset-heart';
    heart.textContent = '♡';

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
    if (preset.pat !== undefined) parts.push(PATTERN_NAMES[preset.pat] || '');
    detail.textContent = parts.join(' · ') || '';

    info.appendChild(name);
    info.appendChild(detail);

    const editBtn = document.createElement('button');
    editBtn.className = 'preset-edit';
    editBtn.setAttribute('aria-label', 'Rename preset');
    editBtn.textContent = '✏️';
    editBtn.dataset.name = preset.name;

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'preset-delete';
    deleteBtn.setAttribute('aria-label', 'Delete preset');
    deleteBtn.textContent = '🗑';
    deleteBtn.dataset.name = preset.name;

    item.appendChild(heart);
    item.appendChild(info);
    item.appendChild(editBtn);
    item.appendChild(deleteBtn);
    container.appendChild(item);
  });
}

function wireSettingsEvents() {
  // Theme picker
  document.getElementById('theme-group').addEventListener('click', (e) => {
    const option = e.target.closest('.radio-option');
    if (!option) return;
    const theme = option.dataset.value;
    applyTheme(theme);
    document.querySelectorAll('#theme-group .radio-option').forEach(o => {
      o.classList.toggle('selected', o.dataset.value === theme);
    });
  });

  const sendVolThrottled = throttle(() => {
    sendCommand({ cmd: 'setVolume', volume: roundGain(sliderToGain(calState.volume)), ...getDestination() });
  }, 100);

  const sendFreqThrottled = throttle(() => {
    sendCommand({ cmd: 'setFrequency', frequency: calState.freq, ...getDestination() });
  }, 100);

  // Cal volume slider — live volume update only (does not trigger playback)
  const calVolSlider = document.getElementById('cal-vol');
  const calVolDbInput = document.getElementById('cal-vol-val');
  calVolSlider.addEventListener('input', () => {
    calState.volume = parseInt(calVolSlider.value);
    if (calVolDbInput && document.activeElement !== calVolDbInput) {
      calVolDbInput.value = sliderToDb(calState.volume);
    }
    if (window.appState) window.appState.defaultVolume = sliderToGain(calState.volume);
    const valEl = document.getElementById('store-volume-value');
    if (valEl) valEl.textContent = `${sliderToDb(calState.volume)} dB`;
    sendVolThrottled();
  });

  // Cal volume dB text input
  if (calVolDbInput) {
    const applyCalVolDb = () => {
      const db = parseFloat(calVolDbInput.value);
      if (!isNaN(db)) {
        const slider = dbToSlider(Math.max(-40, Math.min(0, db)));
        calState.volume = slider;
        calVolSlider.value = slider;
        calVolDbInput.value = sliderToDb(slider);
        if (window.appState) window.appState.defaultVolume = sliderToGain(slider);
        const valEl = document.getElementById('store-volume-value');
        if (valEl) valEl.textContent = `${sliderToDb(slider)} dB`;
        sendVolThrottled();
      } else {
        calVolDbInput.value = sliderToDb(calState.volume);
      }
    };
    calVolDbInput.addEventListener('blur', applyCalVolDb);
    calVolDbInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') calVolDbInput.blur();
      else if (e.key === 'Escape') { calVolDbInput.value = sliderToDb(calState.volume); calVolDbInput.blur(); }
    });
  }

  // Note slider — sync freq and display only, no command sent
  const calNoteSlider = document.getElementById('cal-note');
  const calFreqTextInput = document.getElementById('cal-freq-val');
  calNoteSlider.addEventListener('input', () => {
    calState.semitone = parseInt(calNoteSlider.value);
    calState.freq = semitoneToHz(calState.semitone);
    document.getElementById('cal-note-name').textContent = semitoneToName(calState.semitone);
    const freqSlider = document.getElementById('cal-freq');
    if (freqSlider) freqSlider.value = Math.min(10000, Math.max(200, calState.freq));
    if (calFreqTextInput && document.activeElement !== calFreqTextInput) {
      calFreqTextInput.value = calState.freq;
    }
    sendFreqThrottled();
  });

  // Freq slider — sync note and display only, no command sent
  const calFreqSlider = document.getElementById('cal-freq');
  calFreqSlider.addEventListener('input', () => {
    calState.freq = parseInt(calFreqSlider.value);
    calState.semitone = Math.max(0, Math.min(76, hzToNearestSemitone(calState.freq)));
    if (calFreqTextInput && document.activeElement !== calFreqTextInput) {
      calFreqTextInput.value = calState.freq;
    }
    const noteSlider = document.getElementById('cal-note');
    if (noteSlider) noteSlider.value = calState.semitone;
    document.getElementById('cal-note-name').textContent = semitoneToName(calState.semitone);
    sendFreqThrottled();
  });

  // Freq text input — parse, clamp to nearest 100, sync sliders
  if (calFreqTextInput) {
    const applyCalFreq = () => {
      const val = parseInt(calFreqTextInput.value);
      if (isNaN(val) || val < 200 || val > 10000) { calFreqTextInput.value = calState.freq; return; }
      calState.freq = Math.round(val / 100) * 100;
      calFreqTextInput.value = calState.freq;
      calState.semitone = Math.max(0, Math.min(76, hzToNearestSemitone(calState.freq)));
      const freqSlider = document.getElementById('cal-freq');
      const noteSlider = document.getElementById('cal-note');
      if (freqSlider) freqSlider.value = calState.freq;
      if (noteSlider) noteSlider.value = calState.semitone;
      document.getElementById('cal-note-name').textContent = semitoneToName(calState.semitone);
      sendFreqThrottled();
    };
    calFreqTextInput.addEventListener('blur', applyCalFreq);
    calFreqTextInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') calFreqTextInput.blur();
      else if (e.key === 'Escape') { calFreqTextInput.value = calState.freq; calFreqTextInput.blur(); }
    });
  }

  // Tone / Pink / Sweep buttons — only these trigger playback
  document.querySelectorAll('[data-cal-type]').forEach(btn => {
    btn.addEventListener('click', () => {
      const typeMap = { 'tone': 'tone', 'pink_noise': 'pink', 'sweep': 'sweep' };
      const signal = typeMap[btn.dataset.calType] || btn.dataset.calType;
      sendCommand({
        cmd: 'calibrate',
        signal,
        frequency: calState.freq,
        volume: roundGain(sliderToGain(calState.volume)),
        ...getDestination(),
      });
    });
  });

  // Stop button
  document.getElementById('cal-stop-btn').addEventListener('click', () => {
    sendCommand({ cmd: 'stop', ...getDestination() });
    clearPresetHighlight();
  });

  // Store volume target radio
  document.getElementById('store-target-group').addEventListener('click', (e) => {
    const option = e.target.closest('.radio-option');
    if (!option) return;
    storeTarget = option.dataset.value;
    document.querySelectorAll('#store-target-group .radio-option').forEach(o => {
      o.classList.toggle('selected', o.dataset.value === storeTarget);
    });
  });

  // Node target radio
  document.getElementById('node-target-group').addEventListener('click', (e) => {
    const option = e.target.closest('.radio-option');
    if (!option) return;
    nodeTarget = option.dataset.value;
    document.querySelectorAll('#node-target-group .radio-option').forEach(o => {
      o.classList.toggle('selected', o.dataset.value === nodeTarget);
    });
    updateStoreSection();
  });

  // Store volume button
  document.getElementById('store-volume-btn').addEventListener('click', () => {
    let dest;
    if (storeTarget === 'all') {
      dest = { destination: 'broadcast', target: null };
    } else {
      dest = getDestination();
    }
    const volume = (window.appState && window.appState.defaultVolume) ?? 0.8;
    sendCommand({ cmd: 'storeVolume', volume: roundGain(volume), ...dest });
    showToast('Storing volume…');
  });

  // Pull file
  document.getElementById('settings-file-btn').addEventListener('click', () => {
    const filename = document.getElementById('settings-file-input').value.trim();
    if (!filename) {
      showToast('Enter a filename', 'warn');
      return;
    }
    const dest = getDestination();
    sendCommand({ cmd: 'pullFile', file: filename, ...dest });
    showToast('Pull file sent');
  });

  // Set node
  document.getElementById('settings-node-btn').addEventListener('click', () => {
    const val = document.getElementById('settings-node-input').value.trim().toLowerCase();
    if (!val) {
      showToast('Enter a node path', 'warn');
      return;
    }
    if (!NODE_REGEX.test(val)) {
      showToast('Invalid node path (use lowercase letters, numbers, / and -)', 'error');
      return;
    }
    let targetMacs = [];
    if (nodeTarget === 'all') {
      const scouts = (window.appState && window.appState.scouts) || [];
      targetMacs = scouts.map(s => s.mac).filter(Boolean);
      if (targetMacs.length === 0) {
        showToast('No devices available', 'warn');
        return;
      }
    } else {
      const dest = getDestination();
      if (dest.type !== 'selected' || !dest.target || dest.target.length === 0) {
        showToast('Select devices first', 'warn');
        return;
      }
      targetMacs = dest.target;
    }

    targetMacs.forEach(mac => {
      sendCommand({ cmd: 'setNode', mac, node: val });
    });
    showToast(`Node set to "${val}" for ${targetMacs.length} device(s)`);
  });

  // Preset list delegation (edit + delete)
  document.getElementById('settings-preset-list').addEventListener('click', async (e) => {
    const deleteBtn = e.target.closest('.preset-delete');
    if (deleteBtn) {
      const name = deleteBtn.dataset.name;
      try {
        await deletePreset(name);
        if (window.appState) {
          window.appState.presets = window.appState.presets.filter(p => p.name !== name);
        }
        renderPresetList();
        showToast('Preset deleted');
      } catch (err) {
        showToast('Failed to delete preset', 'error');
      }
      return;
    }

    const editBtn = e.target.closest('.preset-edit');
    if (editBtn) {
      const oldName = editBtn.dataset.name;
      const item = editBtn.closest('.preset-item');
      if (!item) return;
      const nameEl = item.querySelector('.preset-name');
      if (!nameEl) return;

      // Replace name span with inline input
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'preset-rename-input';
      input.value = oldName;
      nameEl.replaceWith(input);
      input.focus();
      input.select();

      // Hide edit/delete while renaming
      editBtn.style.display = 'none';
      const delBtn = item.querySelector('.preset-delete');
      if (delBtn) delBtn.style.display = 'none';

      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'preset-edit';
      confirmBtn.textContent = '✓';
      confirmBtn.style.color = 'var(--accent-bright)';
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'preset-edit';
      cancelBtn.textContent = '✕';

      item.appendChild(confirmBtn);
      item.appendChild(cancelBtn);

      const cancelRename = () => {
        renderPresetList();
      };

      const commitRename = async () => {
        const newName = input.value.trim();
        if (!newName || newName === oldName) { cancelRename(); return; }
        const preset = (window.appState && window.appState.presets || []).find(p => p.name === oldName);
        if (!preset) { cancelRename(); return; }
        try {
          await savePreset({ ...preset, name: newName });
          await deletePreset(oldName);
          if (window.appState) {
            window.appState.presets = window.appState.presets.map(p =>
              p.name === oldName ? { ...p, name: newName } : p
            );
          }
          renderPresetList();
          showToast('Preset renamed');
        } catch (err) {
          showToast('Failed to rename preset', 'error');
          renderPresetList();
        }
      };

      confirmBtn.addEventListener('click', commitRename);
      cancelBtn.addEventListener('click', cancelRename);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') commitRename();
        else if (e.key === 'Escape') cancelRename();
      });
    }
  });
}

export function updateStoreSection() {
  const valEl = document.getElementById('store-volume-value');
  if (valEl) {
    const vol = (window.appState && window.appState.defaultVolume) ?? 0.8;
    valEl.textContent = `${gainToDb(vol)} dB`;
  }
  const countEl = document.getElementById('store-device-count');
  if (countEl) {
    const sel = window.selectionState;
    if (!sel) return;
    if (sel.broadcastMode) {
      countEl.textContent = 'All Devices';
    } else {
      const n = sel.selectedMacs.size;
      countEl.textContent = n > 0 ? `${n} selected` : '';
    }
  }

  const nodeCountEl = document.getElementById('node-device-count');
  if (nodeCountEl) {
    const sel = window.selectionState;
    if (!sel) return;
    if (sel.broadcastMode) {
      nodeCountEl.textContent = 'All Devices';
    } else {
      const n = sel.selectedMacs.size;
      nodeCountEl.textContent = n > 0 ? `${n} selected` : '';
    }
  }
}

export function renderSettings() {
  renderPresetList();
  updateStoreSection();
}

export function initTheme() {
  applyTheme(getTheme());
}

export function initSettingsView() {
  buildSettingsView();
  wireSettingsEvents();
}
