'use strict';

// ── Auth ──────────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'signalfi-admin-token';
let authToken = localStorage.getItem(STORAGE_KEY) || '';

function setAuthState(ok) {
  document.getElementById('auth-dot').className   = ok ? 'ok' : 'fail';
  document.getElementById('auth-label').textContent = ok ? 'authenticated' : 'not authenticated';
}

async function apiFetch(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) { setAuthState(false); showAuthDialog(); throw new Error('Unauthorized'); }
  setAuthState(true);
  return res;
}

function showAuthDialog() {
  document.getElementById('auth-dialog').classList.remove('hidden');
  document.getElementById('auth-input').focus();
}
function hideAuthDialog() { document.getElementById('auth-dialog').classList.add('hidden'); }

document.getElementById('auth-submit').addEventListener('click', () => {
  const val = document.getElementById('auth-input').value.trim();
  if (!val) return;
  authToken = val;
  localStorage.setItem(STORAGE_KEY, val);
  hideAuthDialog();
  loadAll();
});
document.getElementById('auth-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('auth-submit').click();
});

// ── Toast ─────────────────────────────────────────────────────────────────────

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast${type ? ' toast-' + type : ''}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtSize(bytes) {
  if (bytes < 1024)        return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}
function fmtDate(ms) {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function badge(text, cls) { return `<span class="badge badge-${cls}">${text}</span>`; }

// ── Upload helper ─────────────────────────────────────────────────────────────

function uploadFile(file, endpoint, progressBar, progressWrap, onDone) {
  const formData = new FormData();
  formData.append('file', file);
  const xhr = new XMLHttpRequest();
  xhr.open('POST', endpoint);
  if (authToken) xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);
  progressWrap.style.display = 'block';
  progressBar.style.width = '0%';
  xhr.upload.onprogress = e => {
    if (e.lengthComputable) progressBar.style.width = Math.round(e.loaded / e.total * 100) + '%';
  };
  xhr.onload = () => {
    progressWrap.style.display = 'none';
    progressBar.style.width = '0%';
    if (xhr.status === 200 || xhr.status === 201) {
      const data = JSON.parse(xhr.responseText);
      toast(`Uploaded ${data.name}`, 'success');
      onDone(data);
    } else if (xhr.status === 401) {
      setAuthState(false); showAuthDialog();
    } else {
      toast(`Upload failed: ${xhr.status}`, 'error');
    }
  };
  xhr.onerror = () => { progressWrap.style.display = 'none'; toast('Upload error', 'error'); };
  xhr.send(formData);
}

// ── Confirm-inline helper ─────────────────────────────────────────────────────

function makeDeleteBtn(label, onConfirm) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;align-items:flex-end;gap:4px';
  const btn = document.createElement('button');
  btn.className = 'btn btn-danger btn-sm';
  btn.textContent = 'Delete';
  const row = document.createElement('div');
  row.className = 'confirm-inline';
  const lbl = document.createElement('span');
  lbl.className = 'confirm-label';
  lbl.textContent = `Delete ${label}?`;
  const yes = document.createElement('button');
  yes.className = 'btn btn-danger btn-sm';
  yes.textContent = 'Yes';
  const no = document.createElement('button');
  no.className = 'btn btn-secondary btn-sm';
  no.textContent = 'Cancel';
  row.append(lbl, yes, no);
  btn.addEventListener('click', () => row.classList.add('visible'));
  no.addEventListener('click',  () => row.classList.remove('visible'));
  yes.addEventListener('click', () => { row.classList.remove('visible'); onConfirm(); });
  wrap.append(btn, row);
  return wrap;
}

// ── Generic file table renderer ───────────────────────────────────────────────

function renderFileTable(tbodyId, files, colCount, endpoint, onRefresh) {
  const tbody = document.getElementById(tbodyId);
  if (!files.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="${colCount}">No files uploaded yet</td></tr>`;
    return;
  }
  tbody.innerHTML = '';
  for (const f of files) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="file-name">${f.name}</td>
      <td class="file-size">${fmtSize(f.size)}</td>
      <td class="file-hash" title="${f.crc32 || ''}">${f.crc32 || '—'}</td>
      <td class="file-date">${fmtDate(f.mtime)}</td>
      <td></td>
    `;
    tr.querySelector('td:last-child').appendChild(
      makeDeleteBtn(f.name, async () => {
        try {
          await apiFetch(`${endpoint}/${encodeURIComponent(f.name)}`, { method: 'DELETE' });
          toast(`Deleted ${f.name}`, 'success');
          onRefresh();
        } catch (_) { toast('Delete failed', 'error'); }
      })
    );
    tbody.appendChild(tr);
  }
}

// ── Firmware ──────────────────────────────────────────────────────────────────

async function loadFirmware() {
  try {
    const res = await apiFetch('/ota/admin/api/files/firmware');
    const files = await res.json();
    renderFileTable('firmware-tbody', files, 5, '/ota/admin/api/files/firmware', loadFirmware);
    populateFirmwareSelect(files);
  } catch (_) {}
}

function populateFirmwareSelect(files) {
  const sel = document.getElementById('m-firmware');
  const current = sel.value;
  sel.innerHTML = '<option value="">— select uploaded firmware —</option>';
  for (const f of files) {
    const opt = document.createElement('option');
    opt.value = f.name;
    opt.textContent = f.name;
    if (f.name === current) opt.selected = true;
    sel.appendChild(opt);
  }
  checkUploadReady();
}

(function () {
  const zone = document.getElementById('firmware-zone');
  const inp  = document.getElementById('firmware-file-input');
  const prog = document.getElementById('firmware-progress');
  const bar  = document.getElementById('firmware-progress-bar');
  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault(); zone.classList.remove('drag-over');
    const f = e.dataTransfer.files[0];
    if (f && f.name.toLowerCase().endsWith('.hex'))
      uploadFile(f, '/ota/admin/api/files/firmware', bar, prog, () => loadFirmware());
    else toast('Only .hex files allowed', 'error');
  });
  inp.addEventListener('change', () => {
    if (inp.files[0]) uploadFile(inp.files[0], '/ota/admin/api/files/firmware', bar, prog, () => loadFirmware());
    inp.value = '';
  });
})();

// ── Audio ─────────────────────────────────────────────────────────────────────

async function loadAudio() {
  try {
    const res = await apiFetch('/ota/admin/api/files/audio');
    const files = await res.json();
    renderFileTable('audio-tbody', files, 5, '/ota/admin/api/files/audio', loadAudio);
    populateAudioChecklist(files);
  } catch (_) {}
}

function populateAudioChecklist(files) {
  const list = document.getElementById('m-audio-list');
  if (!files.length) {
    list.innerHTML = '<div style="padding:10px;font-size:13px;color:var(--text-muted)">No audio files uploaded</div>';
    return;
  }
  const checked = new Set([...list.querySelectorAll('input:checked')].map(el => el.value));
  list.innerHTML = '';
  for (const f of files) {
    const label = document.createElement('label');
    label.className = 'audio-check-item';
    const inp = document.createElement('input');
    inp.type = 'checkbox'; inp.value = f.name;
    if (checked.has(f.name)) inp.checked = true;
    label.appendChild(inp);
    label.appendChild(document.createTextNode(f.name));
    list.appendChild(label);
  }
}

(function () {
  const zone = document.getElementById('audio-zone');
  const inp  = document.getElementById('audio-file-input');
  const prog = document.getElementById('audio-progress');
  const bar  = document.getElementById('audio-progress-bar');
  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault(); zone.classList.remove('drag-over');
    const f = e.dataTransfer.files[0];
    if (f && f.name.toLowerCase().endsWith('.wav'))
      uploadFile(f, '/ota/admin/api/files/audio', bar, prog, () => loadAudio());
    else toast('Only .wav files allowed', 'error');
  });
  inp.addEventListener('change', () => {
    if (inp.files[0]) uploadFile(inp.files[0], '/ota/admin/api/files/audio', bar, prog, () => loadAudio());
    inp.value = '';
  });
})();

// ── General Files ─────────────────────────────────────────────────────────────

// Combined list for file-op dropdowns (audio + general)
let availableFiles = [];

async function loadFiles() {
  try {
    const res = await apiFetch('/ota/admin/api/files/general');
    const files = await res.json();
    renderFileTable('files-tbody', files, 5, '/ota/admin/api/files/general', loadFiles);
    rebuildAvailableFiles();
  } catch (_) {}
}

async function rebuildAvailableFiles() {
  try {
    const [rAudio, rGen] = await Promise.all([
      apiFetch('/ota/admin/api/files/audio'),
      apiFetch('/ota/admin/api/files/general'),
    ]);
    const audio = await rAudio.json();
    const gen   = await rGen.json();
    availableFiles = [
      ...audio.map(f => ({ ...f, bucket: 'audio' })),
      ...gen.map(f =>   ({ ...f, bucket: 'files' })),
    ];
    // Refresh all file-op selects
    document.querySelectorAll('.file-op-select').forEach(sel => {
      const cur = sel.value;
      sel.innerHTML = '<option value="">— select file —</option>';
      for (const f of availableFiles) {
        const opt = document.createElement('option');
        opt.value = f.name;
        opt.textContent = f.name;
        if (f.name === cur) opt.selected = true;
        sel.appendChild(opt);
      }
    });
  } catch (_) {}
}

(function () {
  const zone = document.getElementById('files-zone');
  const inp  = document.getElementById('files-file-input');
  const prog = document.getElementById('files-progress');
  const bar  = document.getElementById('files-progress-bar');
  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault(); zone.classList.remove('drag-over');
    const f = e.dataTransfer.files[0];
    if (f) uploadFile(f, '/ota/admin/api/files/general', bar, prog, () => loadFiles());
    else toast('No file detected', 'error');
  });
  inp.addEventListener('change', () => {
    if (inp.files[0]) uploadFile(inp.files[0], '/ota/admin/api/files/general', bar, prog, () => loadFiles());
    inp.value = '';
  });
})();

// ── Manifest Builder ──────────────────────────────────────────────────────────

// Type switching
function getManifestType() {
  return document.querySelector('input[name="m-type"]:checked')?.value || 'firmware';
}

// Fields shown for firmware only: version, firmware select, compat, audio checklist
// Fields shown for files only: file operations list
// Token days, delay, reason, model are always shown
function applyTypeVisibility() {
  const isFirmware = getManifestType() === 'firmware';
  // Firmware-only fields
  document.getElementById('m-version-field').style.display  = isFirmware ? '' : 'none';
  document.getElementById('m-firmware-field').style.display = isFirmware ? '' : 'none';
  document.getElementById('m-compat-field').style.display   = isFirmware ? '' : 'none';
  document.getElementById('m-audio-field').style.display    = isFirmware ? '' : 'none';
  // Files-only fields
  document.getElementById('m-files-field').style.display    = isFirmware ? 'none' : '';
  checkUploadReady();
}

document.querySelectorAll('input[name="m-type"]').forEach(r =>
  r.addEventListener('change', applyTypeVisibility));

// Upload-ready check
function checkUploadReady() {
  const type     = getManifestType();
  const model    = document.getElementById('m-model').value.trim();
  const ready    = type === 'firmware'
    ? !!(model && document.getElementById('m-version').value.trim() && document.getElementById('m-firmware').value)
    : !!(model && document.querySelectorAll('#m-file-ops .file-op-row').length > 0);
  document.getElementById('generate-btn').disabled = !ready;
  document.getElementById('generate-hint').style.display = ready ? 'none' : '';
}

// m-model is a select — only 'change'; m-version is text — both input+change
document.getElementById('m-model').addEventListener('change', checkUploadReady);
['m-version'].forEach(id => {
  document.getElementById(id).addEventListener('input',  checkUploadReady);
  document.getElementById(id).addEventListener('change', checkUploadReady);
});

// Firmware select: auto-populate version from filename (fw-x.y.z.hex)
document.getElementById('m-firmware').addEventListener('change', () => {
  const filename = document.getElementById('m-firmware').value;
  const m = filename.match(/fw-(\d+\.\d+\.\d+)\.hex$/i);
  if (m) {
    document.getElementById('m-version').value = m[1];
  }
  checkUploadReady();
});

// File operations list (for "files" type manifest)
function addFileOpRow(defaultFile = '', defaultOp = 'put') {
  const list  = document.getElementById('m-file-ops');
  const empty = document.getElementById('m-file-ops-empty');
  if (empty) empty.style.display = 'none';

  const row = document.createElement('div');
  row.className = 'file-op-row';

  const opSel = document.createElement('select');
  opSel.className = 'file-op-op-select';
  opSel.innerHTML = '<option value="put">put</option><option value="delete">delete</option>';
  opSel.value = defaultOp;

  const fileSel = document.createElement('select');
  fileSel.className = 'file-op-select';
  fileSel.innerHTML = '<option value="">— select file —</option>';
  for (const f of availableFiles) {
    const opt = document.createElement('option');
    opt.value = f.name; opt.textContent = f.name;
    if (f.name === defaultFile) opt.selected = true;
    fileSel.appendChild(opt);
  }

  // For 'delete' op, allow typing a filename that might not exist on server
  const manualInp = document.createElement('input');
  manualInp.type = 'text';
  manualInp.placeholder = 'filename on device';
  manualInp.style.display = 'none';
  if (defaultOp === 'delete' && defaultFile) manualInp.value = defaultFile;

  opSel.addEventListener('change', () => {
    const isDelete = opSel.value === 'delete';
    fileSel.style.display   = isDelete ? 'none' : '';
    manualInp.style.display = isDelete ? '' : 'none';
    checkUploadReady();
  });

  // Initialize visibility
  if (defaultOp === 'delete') {
    fileSel.style.display   = 'none';
    manualInp.style.display = '';
  }

  fileSel.addEventListener('change', checkUploadReady);
  manualInp.addEventListener('input', checkUploadReady);

  const rmBtn = document.createElement('button');
  rmBtn.className = 'btn btn-danger btn-sm';
  rmBtn.textContent = '✕';
  rmBtn.addEventListener('click', () => {
    row.remove();
    if (!document.querySelectorAll('#m-file-ops .file-op-row').length) {
      if (empty) empty.style.display = '';
    }
    checkUploadReady();
  });

  row.append(opSel, fileSel, manualInp, rmBtn);
  list.appendChild(row);
  checkUploadReady();
}

document.getElementById('m-add-file-op').addEventListener('click', () => addFileOpRow());

// Save to Server button — saves draft (no token, no MQTT); Push OTA tab handles the actual push
document.getElementById('generate-btn').addEventListener('click', async () => {
  const type        = getManifestType();
  const modelId     = document.getElementById('m-model').value.trim();
  const tokenDays   = parseInt(document.getElementById('m-token-days').value, 10) || 30;
  const delay       = parseInt(document.getElementById('m-delay').value, 10) || 0;
  const reason      = document.getElementById('m-reason').value.trim();

  let body = { type, modelId, tokenDays, reason, delaySeconds: delay };

  if (type === 'firmware') {
    const version      = document.getElementById('m-version').value.trim();
    const firmwareFile = document.getElementById('m-firmware').value;
    const compatRaw    = document.getElementById('m-compat').value.trim();
    const audioFiles   = [...document.querySelectorAll('#m-audio-list input:checked')].map(el => el.value);
    const compatibleFrom = compatRaw === '*'
      ? ['*']
      : compatRaw.split(',').map(s => s.trim()).filter(Boolean);
    Object.assign(body, { version, firmwareFile, audioFiles, compatibleFrom });
  } else {
    const files = [];
    for (const row of document.querySelectorAll('#m-file-ops .file-op-row')) {
      const op  = row.querySelector('.file-op-op-select').value;
      const id  = op === 'delete'
        ? row.querySelector('input[type="text"]').value.trim()
        : row.querySelector('.file-op-select').value;
      if (id) files.push({ op, id });
    }
    body.files = files;
  }

  const btn = document.getElementById('generate-btn');
  btn.disabled = true; btn.textContent = 'Saving…';

  try {
    const res = await apiFetch('/ota/admin/api/manifests/save', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json();
      const detail = err.details ? '\n' + err.details.join('\n') : '';
      toast(`Error: ${err.error}${detail}`, 'error');
      return;
    }
    const manifest = await res.json();
    document.getElementById('manifest-json').textContent = JSON.stringify(manifest, null, 2);
    document.getElementById('manifest-result').classList.add('visible');
    toast(`Manifest saved for ${modelId} — go to Push OTA to deploy`, 'success');
    loadManifests();
  } catch (_) {
    toast('Save failed', 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Save to Server';
    checkUploadReady();
  }
});

document.getElementById('copy-manifest-btn').addEventListener('click', () => {
  navigator.clipboard.writeText(document.getElementById('manifest-json').textContent)
    .then(() => toast('Copied to clipboard', 'success'));
});

// ── Save / Load drafts ────────────────────────────────────────────────────────

function getDraftKey(name) { return `signalfi-draft-${name}`; }

function collectFormState() {
  const type = getManifestType();
  const base = {
    type,
    modelId:    document.getElementById('m-model').value.trim(),
    tokenDays:  parseInt(document.getElementById('m-token-days').value, 10) || 30,
    delaySeconds: parseInt(document.getElementById('m-delay').value, 10) || 0,
    reason:     document.getElementById('m-reason').value.trim(),
  };
  if (type === 'firmware') {
    base.version      = document.getElementById('m-version').value.trim();
    base.firmwareFile = document.getElementById('m-firmware').value;
    base.compatibleFrom = document.getElementById('m-compat').value.trim();
    base.audioFiles   = [...document.querySelectorAll('#m-audio-list input:checked')].map(el => el.value);
  } else {
    base.files = [];
    for (const row of document.querySelectorAll('#m-file-ops .file-op-row')) {
      const op = row.querySelector('.file-op-op-select').value;
      const id = op === 'delete'
        ? row.querySelector('input[type="text"]').value.trim()
        : row.querySelector('.file-op-select').value;
      if (id) base.files.push({ op, id });
    }
  }
  return base;
}

function populateFormState(state) {
  if (!state) return;
  // Set type radio
  const typeRadio = document.querySelector(`input[name="m-type"][value="${state.type || 'firmware'}"]`);
  if (typeRadio) { typeRadio.checked = true; applyTypeVisibility(); }

  document.getElementById('m-model').value      = state.modelId     || '';
  document.getElementById('m-token-days').value  = state.tokenDays   || 30;
  document.getElementById('m-delay').value        = state.delaySeconds || 0;
  document.getElementById('m-reason').value       = state.reason      || '';

  if (state.type === 'firmware' || !state.type) {
    document.getElementById('m-version').value   = state.version      || '';
    document.getElementById('m-firmware').value  = state.firmwareFile || '';
    document.getElementById('m-compat').value    = state.compatibleFrom || '*';
    // Audio checkboxes — will be applied on next audio load
    if (Array.isArray(state.audioFiles)) {
      for (const inp of document.querySelectorAll('#m-audio-list input')) {
        inp.checked = state.audioFiles.includes(inp.value);
      }
    }
  } else if (state.type === 'files' && Array.isArray(state.files)) {
    // Clear existing file ops
    for (const row of [...document.querySelectorAll('#m-file-ops .file-op-row')]) row.remove();
    const empty = document.getElementById('m-file-ops-empty');
    if (empty) empty.style.display = state.files.length ? 'none' : '';
    for (const f of state.files) addFileOpRow(f.id, f.op);
  }
  checkUploadReady();
}

document.getElementById('save-draft-btn').addEventListener('click', () => {
  const state = collectFormState();
  if (!state.modelId) { toast('Enter a Model ID before saving', 'error'); return; }
  const key = getDraftKey(`${state.modelId}-${state.type}`);
  localStorage.setItem(key, JSON.stringify(state));
  toast('Draft saved', 'success');
});

document.getElementById('load-draft-btn').addEventListener('click', () => showLoadModal());

async function showLoadModal() {
  const modal = document.getElementById('load-modal');
  const body  = document.getElementById('load-modal-body');
  body.innerHTML = '<div style="padding:16px;color:var(--text-muted);font-size:13px">Loading…</div>';
  modal.classList.remove('hidden');

  // Gather local drafts
  const drafts = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key.startsWith('signalfi-draft-')) continue;
    try {
      const data = JSON.parse(localStorage.getItem(key));
      drafts.push({ source: 'local', key, label: key.replace('signalfi-draft-', ''), data });
    } catch (_) {}
  }

  // Gather server manifests
  let serverManifests = [];
  try {
    const res = await apiFetch('/ota/admin/api/manifests');
    serverManifests = await res.json();
  } catch (_) {}

  body.innerHTML = '';

  if (drafts.length) {
    const hdr = document.createElement('div');
    hdr.className = 'load-section-header';
    hdr.textContent = 'Saved Drafts';
    body.appendChild(hdr);
    for (const d of drafts) {
      const row = document.createElement('div');
      row.className = 'load-item';
      row.innerHTML = `<span>${d.label}</span><div class="load-item-actions"></div>`;
      const actions = row.querySelector('.load-item-actions');
      const loadBtn = document.createElement('button');
      loadBtn.className = 'btn btn-secondary btn-sm';
      loadBtn.textContent = 'Load';
      loadBtn.addEventListener('click', () => {
        populateFormState(d.data);
        closeLoadModal();
        toast(`Draft "${d.label}" loaded`, 'success');
      });
      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-danger btn-sm';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', () => {
        localStorage.removeItem(d.key);
        row.remove();
        toast('Draft deleted', 'success');
      });
      actions.append(loadBtn, delBtn);
      body.appendChild(row);
    }
  }

  if (serverManifests.length) {
    const hdr = document.createElement('div');
    hdr.className = 'load-section-header';
    hdr.textContent = 'Server Manifests';
    body.appendChild(hdr);
    for (const m of serverManifests) {
      const row = document.createElement('div');
      row.className = 'load-item';
      row.innerHTML = `<span>${m.modelId} <span class="muted">${m.type || ''} ${m.version || ''}</span></span><div class="load-item-actions"></div>`;
      const actions = row.querySelector('.load-item-actions');
      const loadBtn = document.createElement('button');
      loadBtn.className = 'btn btn-secondary btn-sm';
      loadBtn.textContent = 'Edit';
      loadBtn.addEventListener('click', async () => {
        try {
          const res  = await apiFetch(`/ota/admin/api/manifests/${encodeURIComponent(m.modelId)}`);
          const data = await res.json();
          // Map manifest JSON back to form fields
          const state = {
            type:         data.type || 'firmware',
            modelId:      data.modelId || m.modelId,
            tokenDays:    30,
            delaySeconds: data.delaySeconds || 0,
            reason:       data.reason || '',
            target:       'group',
          };
          if (state.type === 'firmware') {
            state.version       = data.version || data.firmware?.version || '';
            state.firmwareFile  = data.firmware?.url
              ? decodeURIComponent(data.firmware.url.split('/').pop())
              : '';
            state.compatibleFrom = (data.compatibleFrom || ['*']).join(',');
            state.audioFiles    = (data.audio || []).map(a => a.id);
          } else {
            state.files = (data.files || []).map(f => ({ op: f.op, id: f.id }));
          }
          populateFormState(state);
          closeLoadModal();
          toast(`Manifest for ${m.modelId} loaded for editing`, 'success');
        } catch (_) { toast('Failed to load manifest', 'error'); }
      });
      actions.appendChild(loadBtn);
      body.appendChild(row);
    }
  }

  if (!drafts.length && !serverManifests.length) {
    body.innerHTML = '<div style="padding:16px;color:var(--text-muted);font-size:13px">No drafts or manifests found</div>';
  }
}

function closeLoadModal() {
  document.getElementById('load-modal').classList.add('hidden');
}

document.getElementById('load-modal-close').addEventListener('click', closeLoadModal);
document.getElementById('load-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('load-modal')) closeLoadModal();
});

// ── Push OTA tab ──────────────────────────────────────────────────────────────

async function loadManifests() {
  try {
    const res = await apiFetch('/ota/admin/api/manifests');
    const manifests = await res.json();
    renderPushTable(manifests);
  } catch (_) {}
}

function renderPushTable(manifests) {
  const tbody = document.getElementById('push-tbody');
  if (!manifests.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="5">No manifests found</td></tr>';
    return;
  }
  tbody.innerHTML = '';
  for (const m of manifests) {
    const tr = document.createElement('tr');
    const activeBadge = m.update ? badge('yes', 'yes') : badge('no', 'no');
    const typeBadge   = m.type === 'files'
      ? badge('files', 'started')
      : badge('firmware', 'no');
    tr.innerHTML = `
      <td class="mono">${m.modelId}</td>
      <td>${typeBadge}</td>
      <td class="mono">${m.version || '—'}</td>
      <td>${activeBadge}</td>
      <td></td>
    `;
    const cell = tr.querySelector('td:last-child');
    cell.style.cssText = 'display:flex;gap:8px;align-items:center;justify-content:flex-end';

    const viewBtn = document.createElement('button');
    viewBtn.className = 'btn btn-secondary btn-sm';
    viewBtn.textContent = 'View';
    viewBtn.addEventListener('click', async () => {
      try {
        const res  = await apiFetch(`/ota/admin/api/manifests/${encodeURIComponent(m.modelId)}`);
        const data = await res.json();
        document.getElementById('manifest-json').textContent = JSON.stringify(data, null, 2);
        document.getElementById('manifest-result').classList.add('visible');
        showTab('manifest');
      } catch (_) { toast('Failed to load manifest', 'error'); }
    });

    const pushBtn = document.createElement('button');
    pushBtn.className = 'btn btn-warn btn-sm';
    pushBtn.textContent = 'Push';
    pushBtn.addEventListener('click', () => showPushConfirm(m.modelId));

    cell.append(viewBtn, pushBtn);
    tbody.appendChild(tr);
  }
}

document.getElementById('refresh-manifests-btn').addEventListener('click', loadManifests);

function showPushConfirm(modelId) {
  const existing = document.getElementById('push-confirm-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'push-confirm-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:150';

  const box = document.createElement('div');
  box.style.cssText = 'background:var(--bg-panel);border:1px solid var(--border);border-radius:12px;padding:24px 28px;max-width:500px;width:calc(100% - 48px);display:flex;flex-direction:column;gap:16px';
  box.innerHTML = `
    <h3 style="font-size:15px;margin:0">Push OTA — ${modelId}</h3>
    <div class="radio-group">
      <label class="radio-item">
        <input type="radio" name="push-target-radio" value="group" checked> Group — specific node path
      </label>
      <label class="radio-item">
        <input type="radio" name="push-target-radio" value="broadcast"> Broadcast — all devices
      </label>
    </div>
    <div id="push-node-wrap">
      <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:6px">NODE PATH</label>
      <input type="text" id="push-node-path" placeholder="e.g. buildingA/1stfloor/cafeteria"
        style="width:100%;box-sizing:border-box;background:var(--bg-raised);border:1px solid var(--border);border-radius:6px;padding:8px 10px;color:var(--text-primary);font-family:var(--font-mono);font-size:13px">
    </div>
    <div id="push-topic-preview" style="font-size:12px;color:var(--text-muted);font-family:var(--font-mono);padding:6px 10px;background:var(--bg-raised);border-radius:4px">
      Topic: scout/$group/…/$action
    </div>
    <p id="push-broadcast-warn" style="display:none;font-size:13px;color:var(--warn);margin:0">
      ⚠ This will trigger all online devices to check for updates.
    </p>
    <div style="display:flex;gap:10px;justify-content:flex-end">
      <button class="btn btn-secondary btn-sm" id="push-cancel">Cancel</button>
      <button class="btn btn-warn btn-sm" id="push-confirm-btn" disabled>Push</button>
    </div>
  `;

  overlay.appendChild(box);
  document.body.appendChild(overlay);

  const nodeWrap   = box.querySelector('#push-node-wrap');
  const nodeInput  = box.querySelector('#push-node-path');
  const topicPrev  = box.querySelector('#push-topic-preview');
  const bcWarn     = box.querySelector('#push-broadcast-warn');
  const confirmBtn = box.querySelector('#push-confirm-btn');

  function updatePushUI() {
    const isBroadcast = box.querySelector('input[name="push-target-radio"]:checked')?.value === 'broadcast';
    nodeWrap.style.display  = isBroadcast ? 'none' : '';
    bcWarn.style.display    = isBroadcast ? '' : 'none';
    if (isBroadcast) {
      topicPrev.textContent  = 'Topic: scout/$broadcast/$action';
      confirmBtn.disabled    = false;
    } else {
      const path = nodeInput.value.trim();
      topicPrev.textContent  = path
        ? `Topic: scout/$group/${path}/$action`
        : 'Topic: scout/$group/…/$action';
      confirmBtn.disabled    = !path;
    }
  }

  box.querySelectorAll('input[name="push-target-radio"]').forEach(r => r.addEventListener('change', updatePushUI));
  nodeInput.addEventListener('input', updatePushUI);
  updatePushUI();

  box.querySelector('#push-cancel').addEventListener('click', () => overlay.remove());

  confirmBtn.addEventListener('click', async () => {
    const isBroadcast = box.querySelector('input[name="push-target-radio"]:checked')?.value === 'broadcast';
    const nodePath = nodeInput.value.trim();
    overlay.remove();
    try {
      const body = isBroadcast
        ? { modelId, broadcast: true }
        : { modelId, nodePath };
      const res = await apiFetch('/ota/admin/api/ota/push', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (res.ok) {
        toast(isBroadcast ? `Broadcast sent for ${modelId}` : `Push sent → scout/$group/${nodePath}`, 'success');
        loadManifests();
      } else {
        const err = await res.json().catch(() => ({}));
        toast(`Push failed: ${err.error || res.status}`, 'error');
      }
    } catch (_) { toast('Push failed', 'error'); }
  });

  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

// ── Reports ───────────────────────────────────────────────────────────────────

let reportsPage = 0, reportsTotal = 0, reportsLimit = 50, autoRefreshTimer = null;

async function loadReports() {
  try {
    const res  = await apiFetch(`/ota/admin/api/reports?page=${reportsPage}&limit=${reportsLimit}`);
    const data = await res.json();
    reportsTotal = data.total || 0;
    renderReports(data.entries || []);
    const start = reportsPage * reportsLimit + 1;
    const end   = Math.min(start + reportsLimit - 1, reportsTotal);
    document.getElementById('reports-info').textContent = reportsTotal ? `${start}–${end} of ${reportsTotal}` : 'No reports yet';
    document.getElementById('reports-prev').disabled = reportsPage === 0;
    document.getElementById('reports-next').disabled = end >= reportsTotal;
  } catch (_) {}
}

function renderReports(entries) {
  const tbody = document.getElementById('reports-tbody');
  if (!entries.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="6">No reports yet</td></tr>';
    return;
  }
  tbody.innerHTML = '';
  for (const e of entries) {
    const tr = document.createElement('tr');
    const statusBadge = e.status === 'applied'
      ? badge(e.status, 'success')
      : e.status === 'failed'
        ? badge(e.status, 'failed')
        : badge(e.status || '—', 'started');
    tr.innerHTML = `
      <td>${e.timestamp ? new Date(e.timestamp).toLocaleString() : '—'}</td>
      <td>${e.deviceId || '—'}</td>
      <td>${e.modelId || '—'}</td>
      <td>${e.firmwareVersion || '—'}</td>
      <td>${statusBadge}</td>
      <td>${e.ip || '—'}</td>
    `;
    tbody.appendChild(tr);
  }
}

document.getElementById('reports-prev').addEventListener('click', () => { if (reportsPage > 0) { reportsPage--; loadReports(); } });
document.getElementById('reports-next').addEventListener('click', () => { if ((reportsPage + 1) * reportsLimit < reportsTotal) { reportsPage++; loadReports(); } });
document.getElementById('reports-limit').addEventListener('change', e => { reportsLimit = parseInt(e.target.value, 10); reportsPage = 0; loadReports(); });
document.getElementById('auto-refresh-chk').addEventListener('change', e => {
  if (e.target.checked) autoRefreshTimer = setInterval(loadReports, 10000);
  else { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
});

// ── Device count ──────────────────────────────────────────────────────────────

async function updateDeviceCount() {
  try {
    const headers = authToken ? { 'Authorization': `Bearer ${authToken}` } : {};
    const res = await fetch('/ota/admin/api/devices/count', { headers });
    if (!res.ok) return;
    const { online } = await res.json();
    document.getElementById('device-count-label').textContent = `${online} online`;
    document.getElementById('device-count-dot').className = `device-count-dot${online > 0 ? ' ok' : ''}`;
  } catch (_) {}
}

// ── Tab navigation ────────────────────────────────────────────────────────────

const TAB_IDS = ['firmware', 'audio', 'files', 'manifest', 'push', 'reports'];

function showTab(id) {
  TAB_IDS.forEach(t => {
    const section = document.getElementById(t);
    if (section) section.hidden = (t !== id);
  });
  document.querySelectorAll('#top-nav a[data-tab]').forEach(a =>
    a.classList.toggle('active', a.dataset.tab === id));
}

document.querySelectorAll('#top-nav a[data-tab]').forEach(a =>
  a.addEventListener('click', e => { e.preventDefault(); showTab(a.dataset.tab); }));

showTab('firmware');

// ── Initial load ──────────────────────────────────────────────────────────────

function loadAll() {
  loadFirmware();
  loadAudio();
  loadFiles();
  loadManifests();
  loadReports();
}

async function init() {
  updateDeviceCount();
  setInterval(updateDeviceCount, 30000);
  applyTypeVisibility();

  if (authToken) {
    try {
      const res = await fetch('/ota/admin/api/files/firmware', {
        headers: { 'Authorization': `Bearer ${authToken}` },
      });
      if (res.status === 401) { setAuthState(false); showAuthDialog(); return; }
      setAuthState(true);
      loadAll();
    } catch (_) { setAuthState(false); showAuthDialog(); }
  } else {
    const res = await fetch('/ota/admin/api/files/firmware').catch(() => null);
    if (!res || res.status === 401) { showAuthDialog(); }
    else { setAuthState(true); loadAll(); }
  }
}

init();
