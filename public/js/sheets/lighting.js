/**
 * Lighting sheet — colour, patterns, timeout
 */

import { sendCommand } from '../ws.js';
import { getDestination, closeSheet, showToast } from '../app.js';

function throttle(fn, ms) {
  let last = 0;
  return (...args) => { const now = Date.now(); if (now - last >= ms) { last = now; fn(...args); } };
}

// Module-level state for current lighting settings
const state = {
  colour: '#ffffff',
  brightness: 255,
  pattern: 1,
  timeout: 30,
};

export function getLightingState() {
  return { ...state };
}

export function setLightingState(newState) {
  Object.assign(state, newState);
  renderLightingSheet();
}

const SWATCHES = [
  { name: 'white', hex: '#ffffff', label: 'White' },
  { name: 'red', hex: '#e53935', label: 'Red' },
  { name: 'orange', hex: '#fb8c00', label: 'Orange' },
  { name: 'green', hex: '#43a047', label: 'Green' },
  { name: 'blue', hex: '#1e88e5', label: 'Blue' },
  { name: 'cyan', hex: '#0eb8c0', label: 'Cyan' },
];

const PATTERNS = [
  { id: 0, name: 'Off', icon: '○' },
  { id: 1, name: 'Solid', icon: '●' },
  { id: 2, name: 'Blink', icon: '◉' },
  { id: 3, name: 'Rotate', icon: '↻' },
  { id: 4, name: 'Pulse', icon: '◎' },
  { id: 5, name: 'Flash', icon: '✦' },
  { id: 6, name: 'Wave Out', icon: '≫' },
  { id: 7, name: 'Wave In', icon: '≪' },
  { id: 8, name: 'Audio', icon: '♪' },
  { id: 9, name: 'Left', icon: '←' },
  { id: 10, name: 'Right', icon: '→' },
  { id: 11, name: 'Up', icon: '↑' },
  { id: 12, name: 'Down', icon: '↓' },
];

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return { r, g, b };
}

function isValidHex(str) {
  return /^#?[0-9a-fA-F]{6}$/.test(str);
}

function normalizeHex(str) {
  str = str.trim();
  if (!str.startsWith('#')) str = '#' + str;
  return str.toLowerCase();
}

function buildSheet() {
  const el = document.getElementById('sheet-lighting');
  el.innerHTML = '';

  // Handle
  const handle = document.createElement('div');
  handle.className = 'sheet-handle';
  el.appendChild(handle);

  // Header
  const header = document.createElement('div');
  header.className = 'sheet-header';
  const title = document.createElement('span');
  title.className = 'sheet-title';
  title.textContent = 'Lighting';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'sheet-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', closeSheet);
  header.appendChild(title);
  header.appendChild(closeBtn);
  el.appendChild(header);

  // Tabs
  const tabBar = document.createElement('div');
  tabBar.className = 'sheet-tabs';
  ['Color', 'Patterns'].forEach((label, i) => {
    const tab = document.createElement('button');
    tab.className = 'sheet-tab' + (i === 0 ? ' active' : '');
    tab.textContent = label;
    tab.dataset.tab = label.toLowerCase();
    tabBar.appendChild(tab);
  });
  el.appendChild(tabBar);

  // Color panel
  const colorPanel = document.createElement('div');
  colorPanel.className = 'sheet-tab-panel active';
  colorPanel.dataset.panel = 'color';
  colorPanel.innerHTML = '<div class="sheet-body"></div>';
  const colorBody = colorPanel.querySelector('.sheet-body');

  // Swatches
  const swatchSection = document.createElement('div');
  swatchSection.className = 'sheet-section';
  const swatchLabel = document.createElement('div');
  swatchLabel.className = 'sheet-section-label';
  swatchLabel.textContent = 'Colour Preset';
  const swatchRow = document.createElement('div');
  swatchRow.className = 'swatch-row';
  SWATCHES.forEach(s => {
    const sw = document.createElement('button');
    sw.className = 'swatch ' + s.name;
    sw.setAttribute('aria-label', s.label);
    sw.dataset.hex = s.hex;
    swatchRow.appendChild(sw);
  });
  swatchSection.appendChild(swatchLabel);
  swatchSection.appendChild(swatchRow);
  colorBody.appendChild(swatchSection);

  // Custom colour input
  const customSection = document.createElement('div');
  customSection.className = 'sheet-section';
  const customLabel = document.createElement('div');
  customLabel.className = 'sheet-section-label';
  customLabel.textContent = 'Custom Colour';
  const colorInputRow = document.createElement('div');
  colorInputRow.className = 'color-input-row';
  const colorPicker = document.createElement('input');
  colorPicker.type = 'color';
  colorPicker.id = 'lighting-color-picker';
  colorPicker.setAttribute('aria-label', 'Pick colour');
  const hexInput = document.createElement('input');
  hexInput.type = 'text';
  hexInput.id = 'lighting-hex-input';
  hexInput.placeholder = '#FFFFFF';
  hexInput.maxLength = 7;
  hexInput.setAttribute('aria-label', 'Hex colour value');
  colorInputRow.appendChild(colorPicker);
  colorInputRow.appendChild(hexInput);
  customSection.appendChild(customLabel);
  customSection.appendChild(colorInputRow);
  colorBody.appendChild(customSection);

  // Brightness slider
  const brightnessSection = document.createElement('div');
  brightnessSection.className = 'sheet-section';
  const brightnessLabel = document.createElement('div');
  brightnessLabel.className = 'sheet-section-label';
  brightnessLabel.textContent = 'Brightness';
  const sliderRow = document.createElement('div');
  sliderRow.className = 'slider-row';
  const sliderLabel = document.createElement('label');
  sliderLabel.textContent = 'Level';
  const brightnessSlider = document.createElement('input');
  brightnessSlider.type = 'range';
  brightnessSlider.id = 'lighting-brightness';
  brightnessSlider.min = '0';
  brightnessSlider.max = '255';
  const brightnessValue = document.createElement('span');
  brightnessValue.className = 'slider-value';
  brightnessValue.id = 'lighting-brightness-value';
  sliderRow.appendChild(sliderLabel);
  sliderRow.appendChild(brightnessSlider);
  sliderRow.appendChild(brightnessValue);
  brightnessSection.appendChild(brightnessLabel);
  brightnessSection.appendChild(sliderRow);
  colorBody.appendChild(brightnessSection);

  el.appendChild(colorPanel);

  // Patterns panel
  const patternsPanel = document.createElement('div');
  patternsPanel.className = 'sheet-tab-panel';
  patternsPanel.dataset.panel = 'patterns';
  const patternsBody = document.createElement('div');
  patternsBody.className = 'sheet-body';
  const patternGrid = document.createElement('div');
  patternGrid.className = 'pattern-grid';
  PATTERNS.forEach(p => {
    const btn = document.createElement('button');
    btn.className = 'pattern-btn';
    btn.dataset.pattern = p.id;
    const icon = document.createElement('span');
    icon.className = 'pattern-icon';
    icon.textContent = p.icon;
    const name = document.createElement('span');
    name.textContent = p.name;
    btn.appendChild(icon);
    btn.appendChild(name);
    patternGrid.appendChild(btn);
  });
  patternsBody.appendChild(patternGrid);
  patternsPanel.appendChild(patternsBody);
  el.appendChild(patternsPanel);

  // Timeout section
  const timeoutRow = document.createElement('div');
  timeoutRow.className = 'timeout-row';
  const timeoutLabel = document.createElement('div');
  timeoutLabel.className = 'sheet-section-label';
  timeoutLabel.textContent = 'Timeout';
  const timeoutSlider = document.createElement('div');
  timeoutSlider.className = 'slider-row';
  const tLabel = document.createElement('label');
  tLabel.textContent = 'Seconds';
  const tRange = document.createElement('input');
  tRange.type = 'range';
  tRange.id = 'lighting-timeout';
  tRange.min = '0';
  tRange.max = '300';
  const tValue = document.createElement('span');
  tValue.className = 'slider-value';
  tValue.id = 'lighting-timeout-value';
  timeoutSlider.appendChild(tLabel);
  timeoutSlider.appendChild(tRange);
  timeoutSlider.appendChild(tValue);
  timeoutRow.appendChild(timeoutLabel);
  timeoutRow.appendChild(timeoutSlider);
  el.appendChild(timeoutRow);

  // Footer
  const footer = document.createElement('div');
  footer.className = 'sheet-footer';
  const announceBtn = document.createElement('button');
  announceBtn.className = 'sheet-announce-btn cmd-btn';
  announceBtn.id = 'lighting-announce-btn';
  announceBtn.textContent = 'Announce';
  const stopBtn = document.createElement('button');
  stopBtn.className = 'sheet-stop-btn cmd-btn';
  stopBtn.id = 'lighting-stop-btn';
  stopBtn.textContent = 'Stop';
  footer.appendChild(announceBtn);
  footer.appendChild(stopBtn);
  el.appendChild(footer);
}

function renderLightingSheet() {
  // Update swatches
  document.querySelectorAll('#sheet-lighting .swatch').forEach(sw => {
    const matches = sw.dataset.hex.toLowerCase() === state.colour.toLowerCase();
    sw.classList.toggle('selected', matches);
  });

  // Update color picker and hex input
  const picker = document.getElementById('lighting-color-picker');
  const hexIn = document.getElementById('lighting-hex-input');
  if (picker) picker.value = state.colour;
  if (hexIn && document.activeElement !== hexIn) hexIn.value = state.colour.toUpperCase();

  // Update brightness
  const bSlider = document.getElementById('lighting-brightness');
  const bValue = document.getElementById('lighting-brightness-value');
  if (bSlider) bSlider.value = state.brightness;
  if (bValue) bValue.textContent = state.brightness;

  // Update patterns
  document.querySelectorAll('#sheet-lighting .pattern-btn').forEach(btn => {
    btn.classList.toggle('selected', parseInt(btn.dataset.pattern) === state.pattern);
  });

  // Update timeout
  const tRange = document.getElementById('lighting-timeout');
  const tValue = document.getElementById('lighting-timeout-value');
  if (tRange) tRange.value = state.timeout;
  if (tValue) tValue.textContent = state.timeout + 's';
}

function wireEvents() {
  const el = document.getElementById('sheet-lighting');

  // Tab switching
  el.querySelectorAll('.sheet-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      el.querySelectorAll('.sheet-tab').forEach(t => t.classList.remove('active'));
      el.querySelectorAll('.sheet-tab-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const panel = el.querySelector(`.sheet-tab-panel[data-panel="${tab.dataset.tab}"]`);
      if (panel) panel.classList.add('active');
    });
  });

  // Swatches
  el.querySelectorAll('.swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      state.colour = sw.dataset.hex;
      renderLightingSheet();
      sendCommand({ cmd: 'setColour', colour: state.colour, ...getDestination() });
    });
  });

  // Color picker
  const picker = document.getElementById('lighting-color-picker');
  picker.addEventListener('input', () => {
    state.colour = picker.value;
    renderLightingSheet();
  });
  picker.addEventListener('change', () => {
    state.colour = picker.value;
    renderLightingSheet();
    sendCommand({ cmd: 'setColour', colour: state.colour, ...getDestination() });
  });

  // Hex input
  const hexIn = document.getElementById('lighting-hex-input');
  hexIn.addEventListener('input', () => {
    const val = hexIn.value.trim();
    if (isValidHex(val)) {
      state.colour = normalizeHex(val);
      picker.value = state.colour;
      // Don't trigger commands while typing
    }
  });
  hexIn.addEventListener('blur', () => {
    const val = hexIn.value.trim();
    if (isValidHex(val)) {
      state.colour = normalizeHex(val);
      renderLightingSheet();
      sendCommand({ cmd: 'setColour', colour: state.colour, ...getDestination() });
    } else {
      hexIn.value = state.colour.toUpperCase();
    }
  });
  hexIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') hexIn.blur();
  });

  // Brightness slider — live throttled send
  const bSlider = document.getElementById('lighting-brightness');
  const sendBrightness = throttle(() => {
    sendCommand({ cmd: 'setBrightness', brightness: state.brightness, ...getDestination() });
  }, 100);
  bSlider.addEventListener('input', () => {
    state.brightness = parseInt(bSlider.value);
    document.getElementById('lighting-brightness-value').textContent = state.brightness;
    sendBrightness();
  });

  // Pattern buttons
  el.querySelectorAll('.pattern-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.pattern = parseInt(btn.dataset.pattern);
      el.querySelectorAll('.pattern-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      sendCommand({ cmd: 'setPattern', pattern: state.pattern, ...getDestination() });
    });
  });

  // Timeout slider
  const tRange = document.getElementById('lighting-timeout');
  tRange.addEventListener('input', () => {
    state.timeout = parseInt(tRange.value);
    document.getElementById('lighting-timeout-value').textContent = state.timeout + 's';
  });

  // Announce button
  document.getElementById('lighting-announce-btn').addEventListener('click', () => {
    const dest = getDestination();
    // Import sound state for combined announce
    import('./sound.js').then(({ getSoundState }) => {
      const sound = getSoundState();
      sendCommand({
        cmd: 'announce',
        colour: state.colour,
        brightness: state.brightness,
        pattern: state.pattern,
        timeout: state.timeout,
        audio: sound.selectedFile,
        volume: sound.volume,
        loops: sound.loops,
        ...dest,
      });
    });
  });

  // Stop button
  document.getElementById('lighting-stop-btn').addEventListener('click', () => {
    sendCommand({ cmd: 'stop', ...getDestination() });
  });
}

export function initLightingSheet() {
  buildSheet();
  wireEvents();
}

export function openLightingSheet() {
  // Populate from app state if available
  const settings = window.appState && window.appState.settings;
  if (settings) {
    if (settings.colour) state.colour = settings.colour;
    if (settings.brightness !== undefined) state.brightness = settings.brightness;
    if (settings.pattern !== undefined) state.pattern = settings.pattern;
    if (settings.timeout !== undefined) state.timeout = settings.timeout;
  }
  renderLightingSheet();
}
