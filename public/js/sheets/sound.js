/**
 * Sound state — audio file selection, volume, loops.
 * DOM is built and wired inside the Configure sheet (lighting.js).
 */

import { gainToSlider, sliderToDb } from '../utils.js';

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

function renderAudioList() {
  const list = document.getElementById('sound-audio-list');
  if (!list) return;
  list.innerHTML = '';

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
  const sliderPos = gainToSlider(state.volume);
  if (volSlider) volSlider.value = sliderPos;
  if (volValue && document.activeElement !== volValue) {
    volValue.value = sliderToDb(sliderPos);
  }
  const loopsValue = document.getElementById('sound-loops-value');
  if (loopsValue) loopsValue.textContent = state.loops === 0 ? '∞' : state.loops;
  updateControlsDisabled();
}
