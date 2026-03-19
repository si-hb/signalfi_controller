/**
 * Sound sheet — audio file selection, volume, loops
 */

import { sendCommand } from '../ws.js';
import { getDestination, closeSheet } from '../app.js';
import { sliderToGain, gainToSlider, roundGain, throttle } from '../utils.js';
import { clearPresetHighlight } from './presets.js';

const state = {
  selectedFile: null,
  volume: 0.8,
  loops: 1,
};

export function getSoundState() {
  return { ...state };
}

export function setSoundState(newState) {
  Object.assign(state, newState);
  renderSoundSheet();
}

function buildSheet() {
  const el = document.getElementById('sheet-sound');
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
  title.textContent = 'Sound';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'sheet-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', closeSheet);
  header.appendChild(title);
  header.appendChild(closeBtn);
  el.appendChild(header);

  // Body
  const body = document.createElement('div');
  body.className = 'sheet-body';

  // Audio file list
  const audioSection = document.createElement('div');
  audioSection.className = 'sheet-section';
  const audioLabel = document.createElement('div');
  audioLabel.className = 'sheet-section-label';
  audioLabel.textContent = 'Audio File';
  const audioList = document.createElement('ul');
  audioList.className = 'audio-list';
  audioList.id = 'sound-audio-list';
  audioSection.appendChild(audioLabel);
  audioSection.appendChild(audioList);
  body.appendChild(audioSection);

  // Volume slider
  const volumeSection = document.createElement('div');
  volumeSection.className = 'sheet-section';
  volumeSection.id = 'sound-volume-section';
  const volumeLabel = document.createElement('div');
  volumeLabel.className = 'sheet-section-label';
  volumeLabel.textContent = 'Volume';
  const sliderRow = document.createElement('div');
  sliderRow.className = 'slider-row';
  const sLabel = document.createElement('label');
  sLabel.textContent = 'Level';
  const volSlider = document.createElement('input');
  volSlider.type = 'range';
  volSlider.id = 'sound-volume';
  volSlider.min = '0';
  volSlider.max = '100';
  const volValue = document.createElement('span');
  volValue.className = 'slider-value';
  volValue.id = 'sound-volume-value';
  sliderRow.appendChild(sLabel);
  sliderRow.appendChild(volSlider);
  sliderRow.appendChild(volValue);
  volumeSection.appendChild(volumeLabel);
  volumeSection.appendChild(sliderRow);
  body.appendChild(volumeSection);

  // Loops stepper
  const loopsSection = document.createElement('div');
  loopsSection.className = 'sheet-section';
  loopsSection.id = 'sound-loops-section';
  const loopsLabel = document.createElement('div');
  loopsLabel.className = 'sheet-section-label';
  loopsLabel.textContent = 'Loops';
  const stepper = document.createElement('div');
  stepper.className = 'stepper';
  const minusBtn = document.createElement('button');
  minusBtn.className = 'stepper-btn';
  minusBtn.id = 'sound-loops-minus';
  minusBtn.setAttribute('aria-label', 'Decrease loops');
  minusBtn.textContent = '−';
  const loopsValue = document.createElement('span');
  loopsValue.className = 'stepper-value';
  loopsValue.id = 'sound-loops-value';
  const plusBtn = document.createElement('button');
  plusBtn.className = 'stepper-btn';
  plusBtn.id = 'sound-loops-plus';
  plusBtn.setAttribute('aria-label', 'Increase loops');
  plusBtn.textContent = '+';
  stepper.appendChild(minusBtn);
  stepper.appendChild(loopsValue);
  stepper.appendChild(plusBtn);
  loopsSection.appendChild(loopsLabel);
  loopsSection.appendChild(stepper);
  body.appendChild(loopsSection);

  el.appendChild(body);

  // Footer
  const footer = document.createElement('div');
  footer.className = 'sheet-footer';
  const announceBtn = document.createElement('button');
  announceBtn.className = 'sheet-announce-btn cmd-btn';
  announceBtn.id = 'sound-announce-btn';
  announceBtn.textContent = 'Announce';
  const stopBtn = document.createElement('button');
  stopBtn.className = 'sheet-stop-btn cmd-btn';
  stopBtn.id = 'sound-stop-btn';
  stopBtn.textContent = 'Stop';
  footer.appendChild(announceBtn);
  footer.appendChild(stopBtn);
  el.appendChild(footer);
}

function renderAudioList() {
  const list = document.getElementById('sound-audio-list');
  if (!list) return;
  list.innerHTML = '';

  // "None" option
  const noneItem = document.createElement('li');
  noneItem.className = 'audio-item' + (state.selectedFile === null ? ' selected' : '');
  noneItem.dataset.file = '';
  const noneRadio = document.createElement('div');
  noneRadio.className = 'audio-radio' + (state.selectedFile === null ? ' checked' : '');
  const noneName = document.createElement('span');
  noneName.className = 'audio-name';
  noneName.textContent = 'None (LEDs only)';
  noneItem.appendChild(noneRadio);
  noneItem.appendChild(noneName);
  list.appendChild(noneItem);

  // Files from appState
  const files = (window.appState && window.appState.audioFiles) || [];
  files.forEach(file => {
    const item = document.createElement('li');
    item.className = 'audio-item' + (state.selectedFile === file ? ' selected' : '');
    item.dataset.file = file;
    const radio = document.createElement('div');
    radio.className = 'audio-radio' + (state.selectedFile === file ? ' checked' : '');
    const name = document.createElement('span');
    name.className = 'audio-name';
    name.textContent = file;
    item.appendChild(radio);
    item.appendChild(name);
    list.appendChild(item);
  });
}

function updateControlsDisabled() {
  const noAudio = state.selectedFile === null;
  const volSection = document.getElementById('sound-volume-section');
  const loopsSection = document.getElementById('sound-loops-section');
  if (volSection) volSection.style.opacity = noAudio ? '0.4' : '1';
  if (loopsSection) loopsSection.style.opacity = noAudio ? '0.4' : '1';
  const volSlider = document.getElementById('sound-volume');
  const minusBtn = document.getElementById('sound-loops-minus');
  const plusBtn = document.getElementById('sound-loops-plus');
  if (volSlider) volSlider.disabled = noAudio;
  if (minusBtn) minusBtn.disabled = noAudio;
  if (plusBtn) plusBtn.disabled = noAudio;
}

export function renderSoundSheet() {
  renderAudioList();

  const volSlider = document.getElementById('sound-volume');
  const volValue = document.getElementById('sound-volume-value');
  if (volSlider) volSlider.value = gainToSlider(state.volume);
  if (volValue) volValue.textContent = gainToSlider(state.volume) + '%';

  const loopsValue = document.getElementById('sound-loops-value');
  if (loopsValue) loopsValue.textContent = state.loops;

  updateControlsDisabled();
}

function wireEvents() {
  // Audio list selection (event delegation)
  const audioList = document.getElementById('sound-audio-list');
  audioList.addEventListener('click', (e) => {
    const item = e.target.closest('.audio-item');
    if (!item) return;
    state.selectedFile = item.dataset.file || null;
    renderSoundSheet();
  });

  // Volume slider — live throttled send
  const volSlider = document.getElementById('sound-volume');
  const sendVolume = throttle(() => {
    sendCommand({ cmd: 'setVolume', volume: roundGain(state.volume), ...getDestination() });
  }, 100);
  volSlider.addEventListener('input', () => {
    state.volume = sliderToGain(parseInt(volSlider.value));
    document.getElementById('sound-volume-value').textContent = volSlider.value + '%';
    if (window.appState) window.appState.defaultVolume = state.volume;
    const volEl = document.getElementById('store-vol-display');
    if (volEl) volEl.textContent = volSlider.value + '%';
    sendVolume();
  });

  // Loops stepper
  document.getElementById('sound-loops-minus').addEventListener('click', () => {
    if (state.loops > 0) {
      state.loops--;
      document.getElementById('sound-loops-value').textContent = state.loops;
    }
  });

  document.getElementById('sound-loops-plus').addEventListener('click', () => {
    if (state.loops < 10) {
      state.loops++;
      document.getElementById('sound-loops-value').textContent = state.loops;
    }
  });

  // Announce button
  document.getElementById('sound-announce-btn').addEventListener('click', () => {
    import('./lighting.js').then(({ getLightingState }) => {
      const light = getLightingState();
      const dest = getDestination();
      sendCommand({
        cmd: 'announce',
        colour: light.colour,
        brightness: light.brightness,
        pattern: light.pattern,
        timeout: light.timeout,
        audio: state.selectedFile,
        volume: roundGain(state.volume),
        loops: state.loops,
        ...dest,
      });
    });
  });

  // Stop button
  document.getElementById('sound-stop-btn').addEventListener('click', () => {
    sendCommand({ cmd: 'stop', ...getDestination() });
    clearPresetHighlight();
  });
}

export function initSoundSheet() {
  buildSheet();
  wireEvents();
}

export function openSoundSheet() {
  const settings = window.appState && window.appState.settings;
  if (settings) {
    if (settings.audio !== undefined) state.selectedFile = settings.audio;
    if (settings.volume !== undefined) state.volume = settings.volume;
    if (settings.loops !== undefined) state.loops = settings.loops;
  }
  renderSoundSheet();

  // Scroll the selected audio item into view
  const selected = document.querySelector('#sound-audio-list .audio-item.selected');
  if (selected) selected.scrollIntoView({ block: 'nearest' });
}
