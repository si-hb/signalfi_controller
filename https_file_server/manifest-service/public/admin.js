'use strict';

// ── Auth ──────────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'signalfi-admin-token';
let authToken = localStorage.getItem(STORAGE_KEY) || '';

function setAuthState(ok) {
  const dot   = document.getElementById('auth-dot');
  const label = document.getElementById('auth-label');
  dot.className   = ok ? 'ok' : 'fail';
  label.textContent = ok ? 'authenticated' : 'not authenticated';
}

async function apiFetch(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) {
    setAuthState(false);
    showAuthDialog();
    throw new Error('Unauthorized');
  }
  setAuthState(true);
  return res;
}

function showAuthDialog() {
  document.getElementById('auth-dialog').classList.remove('hidden');
  document.getElementById('auth-input').focus();
}

function hideAuthDialog() {
  document.getElementById('auth-dialog').classList.add('hidden');
}

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
  if (bytes < 1024)       return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function fmtDate(ms) {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function truncHash(h) {
  if (!h) return '—';
  return h.slice(0, 10) + '…' + h.slice(-6);
}

function badge(text, cls) {
  return `<span class="badge badge-${cls}">${text}</span>`;
}

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
    if (e.lengthComputable) {
      progressBar.style.width = Math.round(e.loaded / e.total * 100) + '%';
    }
  };

  xhr.onload = () => {
    progressWrap.style.display = 'none';
    progressBar.style.width = '0%';
    if (xhr.status === 200 || xhr.status === 201) {
      const data = JSON.parse(xhr.responseText);
      toast(`Uploaded ${data.name}`, 'success');
      onDone(data);
    } else if (xhr.status === 401) {
      setAuthState(false);
      showAuthDialog();
    } else {
      toast(`Upload failed: ${xhr.status}`, 'error');
    }
  };

  xhr.onerror = () => {
    progressWrap.style.display = 'none';
    toast('Upload error', 'error');
  };

  xhr.send(formData);
}

// ── Confirm-inline helper ─────────────────────────────────────────────────────

function makeDeleteBtn(label, onConfirm) {
  const wrap = document.createElement('div');
  wrap.style.display = 'flex';
  wrap.style.flexDirection = 'column';
  wrap.style.alignItems = 'flex-end';
  wrap.style.gap = '4px';

  const btn = document.createElement('button');
  btn.className = 'btn btn-danger btn-sm';
  btn.textContent = 'Delete';

  const confirmRow = document.createElement('div');
  confirmRow.className = 'confirm-inline';
  const confirmLabel = document.createElement('span');
  confirmLabel.className = 'confirm-label';
  confirmLabel.textContent = `Delete ${label}?`;
  const yesBtn = document.createElement('button');
  yesBtn.className = 'btn btn-danger btn-sm';
  yesBtn.textContent = 'Yes';
  const noBtn = document.createElement('button');
  noBtn.className = 'btn btn-secondary btn-sm';
  noBtn.textContent = 'Cancel';

  confirmRow.appendChild(confirmLabel);
  confirmRow.appendChild(yesBtn);
  confirmRow.appendChild(noBtn);

  btn.addEventListener('click', () => confirmRow.classList.add('visible'));
  noBtn.addEventListener('click', () => confirmRow.classList.remove('visible'));
  yesBtn.addEventListener('click', () => {
    confirmRow.classList.remove('visible');
    onConfirm();
  });

  wrap.appendChild(btn);
  wrap.appendChild(confirmRow);
  return wrap;
}

// ── Firmware ──────────────────────────────────────────────────────────────────

async function loadFirmware() {
  try {
    const res = await apiFetch('/ota/admin/api/files/firmware');
    const files = await res.json();
    renderFirmware(files);
    populateFirmwareSelect(files);
  } catch (_) {}
}

function renderFirmware(files) {
  const tbody = document.getElementById('firmware-tbody');
  if (!files.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="5">No firmware files uploaded yet</td></tr>';
    return;
  }
  tbody.innerHTML = '';
  for (const f of files) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="file-name">${f.name}</td>
      <td class="file-size">${fmtSize(f.size)}</td>
      <td class="file-hash" title="${f.sha256 || ''}">${truncHash(f.sha256)}</td>
      <td class="file-date">${fmtDate(f.mtime)}</td>
      <td></td>
    `;
    const delCell = tr.querySelector('td:last-child');
    delCell.appendChild(makeDeleteBtn(f.name, async () => {
      try {
        await apiFetch(`/ota/admin/api/files/firmware/${encodeURIComponent(f.name)}`, { method: 'DELETE' });
        toast(`Deleted ${f.name}`, 'success');
        loadFirmware();
      } catch (_) { toast('Delete failed', 'error'); }
    }));
    tbody.appendChild(tr);
  }
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
  checkGenerateReady();
}

// Drag-and-drop + file input for firmware
(function () {
  const zone     = document.getElementById('firmware-zone');
  const input    = document.getElementById('firmware-file-input');
  const progress = document.getElementById('firmware-progress');
  const bar      = document.getElementById('firmware-progress-bar');

  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file && file.name.toLowerCase().endsWith('.bin')) {
      uploadFile(file, '/ota/admin/api/files/firmware', bar, progress, () => loadFirmware());
    } else {
      toast('Only .bin files allowed', 'error');
    }
  });

  input.addEventListener('change', () => {
    const file = input.files[0];
    if (file) uploadFile(file, '/ota/admin/api/files/firmware', bar, progress, () => loadFirmware());
    input.value = '';
  });
})();

// ── Audio ─────────────────────────────────────────────────────────────────────

async function loadAudio() {
  try {
    const res = await apiFetch('/ota/admin/api/files/audio');
    const files = await res.json();
    renderAudio(files);
    populateAudioChecklist(files);
  } catch (_) {}
}

function renderAudio(files) {
  const tbody = document.getElementById('audio-tbody');
  if (!files.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="4">No audio files uploaded yet</td></tr>';
    return;
  }
  tbody.innerHTML = '';
  for (const f of files) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="file-name">${f.name}</td>
      <td class="file-size">${fmtSize(f.size)}</td>
      <td class="file-date">${fmtDate(f.mtime)}</td>
      <td></td>
    `;
    const delCell = tr.querySelector('td:last-child');
    delCell.appendChild(makeDeleteBtn(f.name, async () => {
      try {
        await apiFetch(`/ota/admin/api/files/audio/${encodeURIComponent(f.name)}`, { method: 'DELETE' });
        toast(`Deleted ${f.name}`, 'success');
        loadAudio();
      } catch (_) { toast('Delete failed', 'error'); }
    }));
    tbody.appendChild(tr);
  }
}

function populateAudioChecklist(files) {
  const list = document.getElementById('m-audio-list');
  if (!files.length) {
    list.innerHTML = '<div style="padding:10px;font-size:13px;color:var(--text-muted)">No audio files uploaded</div>';
    return;
  }
  // Preserve checked state
  const checked = new Set(
    [...list.querySelectorAll('input:checked')].map(el => el.value)
  );
  list.innerHTML = '';
  for (const f of files) {
    const label = document.createElement('label');
    label.className = 'audio-check-item';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = f.name;
    if (checked.has(f.name)) input.checked = true;
    label.appendChild(input);
    label.appendChild(document.createTextNode(f.name));
    list.appendChild(label);
  }
}

// Drag-and-drop + file input for audio
(function () {
  const zone     = document.getElementById('audio-zone');
  const input    = document.getElementById('audio-file-input');
  const progress = document.getElementById('audio-progress');
  const bar      = document.getElementById('audio-progress-bar');

  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file && file.name.toLowerCase().endsWith('.wav')) {
      uploadFile(file, '/ota/admin/api/files/audio', bar, progress, () => loadAudio());
    } else {
      toast('Only .wav files allowed', 'error');
    }
  });

  input.addEventListener('change', () => {
    const file = input.files[0];
    if (file) uploadFile(file, '/ota/admin/api/files/audio', bar, progress, () => loadAudio());
    input.value = '';
  });
})();

// ── Manifest Builder ──────────────────────────────────────────────────────────

function checkGenerateReady() {
  const model    = document.getElementById('m-model').value.trim();
  const version  = document.getElementById('m-version').value.trim();
  const firmware = document.getElementById('m-firmware').value;
  const ready    = model && version && firmware;
  document.getElementById('generate-btn').disabled = !ready;
  document.getElementById('generate-hint').style.display = ready ? 'none' : '';
}

['m-model', 'm-version', 'm-firmware'].forEach(id => {
  document.getElementById(id).addEventListener('input', checkGenerateReady);
  document.getElementById(id).addEventListener('change', checkGenerateReady);
});

document.getElementById('generate-btn').addEventListener('click', async () => {
  const modelId      = document.getElementById('m-model').value.trim();
  const version      = document.getElementById('m-version').value.trim();
  const firmwareFile = document.getElementById('m-firmware').value;
  const compatRaw    = document.getElementById('m-compat').value.trim();
  const tokenDays    = parseInt(document.getElementById('m-token-days').value, 10) || 30;
  const delay        = parseInt(document.getElementById('m-delay').value, 10) || 0;
  const reason       = document.getElementById('m-reason').value.trim();

  const compatibleFrom = compatRaw === '*'
    ? ['*']
    : compatRaw.split(',').map(s => s.trim()).filter(Boolean);

  const audioFiles = [...document.querySelectorAll('#m-audio-list input:checked')].map(el => el.value);

  const btn = document.getElementById('generate-btn');
  btn.disabled = true;
  btn.textContent = 'Generating…';

  try {
    const res = await apiFetch('/ota/admin/api/manifests/generate', {
      method: 'POST',
      body: JSON.stringify({ modelId, version, firmwareFile, audioFiles, compatibleFrom, tokenDays, reason, delaySeconds: delay }),
    });
    if (!res.ok) {
      const err = await res.json();
      toast(`Error: ${err.error}`, 'error');
      return;
    }
    const manifest = await res.json();
    document.getElementById('manifest-json').textContent = JSON.stringify(manifest, null, 2);
    document.getElementById('manifest-result').classList.add('visible');
    toast(`Manifest generated for ${modelId} v${version}`, 'success');
    loadManifests();
    loadTokens();
  } catch (err) {
    toast('Generate failed', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate Manifest';
    checkGenerateReady();
  }
});

document.getElementById('copy-manifest-btn').addEventListener('click', () => {
  const text = document.getElementById('manifest-json').textContent;
  navigator.clipboard.writeText(text).then(() => toast('Copied to clipboard', 'success'));
});

// ── Push OTA ──────────────────────────────────────────────────────────────────

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
    tbody.innerHTML = '<tr class="empty-row"><td colspan="4">No manifests found</td></tr>';
    return;
  }
  tbody.innerHTML = '';
  for (const m of manifests) {
    const tr = document.createElement('tr');
    const updateBadge = m.update ? badge('yes', 'yes') : badge('no', 'no');
    tr.innerHTML = `
      <td class="mono">${m.modelId}</td>
      <td class="mono">${m.version || '—'}</td>
      <td>${updateBadge}</td>
      <td></td>
    `;
    const actCell = tr.querySelector('td:last-child');
    actCell.style.cssText = 'display:flex;gap:8px;align-items:center;justify-content:flex-end';

    // View button
    const viewBtn = document.createElement('button');
    viewBtn.className = 'btn btn-secondary btn-sm';
    viewBtn.textContent = 'View';
    viewBtn.addEventListener('click', async () => {
      try {
        const res = await apiFetch(`/ota/admin/api/manifests/${encodeURIComponent(m.modelId)}`);
        const data = await res.json();
        document.getElementById('manifest-json').textContent = JSON.stringify(data, null, 2);
        document.getElementById('manifest-result').classList.add('visible');
        document.getElementById('manifest').scrollIntoView({ behavior: 'smooth' });
      } catch (_) { toast('Failed to load manifest', 'error'); }
    });

    // Push button
    const pushBtn = document.createElement('button');
    pushBtn.className = 'btn btn-warn btn-sm';
    pushBtn.textContent = 'Push OTA';
    pushBtn.addEventListener('click', () => showPushConfirm(m.modelId, pushBtn));

    actCell.appendChild(viewBtn);
    actCell.appendChild(pushBtn);
    tbody.appendChild(tr);
  }
}

function showPushConfirm(modelId, anchorBtn) {
  // Remove any existing confirm
  const existing = document.getElementById('push-confirm-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'push-confirm-overlay';
  overlay.style.cssText = `
    position:fixed;inset:0;background:rgba(0,0,0,0.6);
    display:flex;align-items:center;justify-content:center;z-index:150
  `;

  const box = document.createElement('div');
  box.style.cssText = `
    background:var(--bg-panel);border:1px solid var(--border);border-radius:12px;
    padding:24px 28px;max-width:440px;display:flex;flex-direction:column;gap:14px
  `;

  box.innerHTML = `
    <h3 style="font-size:15px">Push OTA — ${modelId}</h3>
    <p style="font-size:13px;color:var(--text-muted)">
      This will publish an MQTT message to:<br>
      <code style="font-family:var(--font-mono);color:var(--accent-bright)">
        scout/$group/${modelId}/$action
      </code><br>
      Payload: <code style="font-family:var(--font-mono);color:var(--accent-bright)">{"act":"frm","mdl":"${modelId}"}</code><br><br>
      All online devices of this model will begin checking for an update.
    </p>
    <div style="display:flex;gap:10px;justify-content:flex-end">
      <button class="btn btn-secondary btn-sm" id="push-cancel">Cancel</button>
      <button class="btn btn-warn btn-sm" id="push-confirm">Push</button>
    </div>
  `;

  overlay.appendChild(box);
  document.body.appendChild(overlay);

  document.getElementById('push-cancel').addEventListener('click', () => overlay.remove());
  document.getElementById('push-confirm').addEventListener('click', async () => {
    overlay.remove();
    try {
      const res = await apiFetch('/ota/admin/api/ota/push', {
        method: 'POST',
        body: JSON.stringify({ modelId }),
      });
      if (res.ok) {
        toast(`OTA push sent for ${modelId}`, 'success');
      } else {
        toast('Push failed', 'error');
      }
    } catch (_) { toast('Push failed', 'error'); }
  });

  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

document.getElementById('refresh-manifests-btn').addEventListener('click', loadManifests);

// ── Reports ───────────────────────────────────────────────────────────────────

let reportsPage = 0;
let reportsTotal = 0;
let reportsLimit = 50;
let autoRefreshTimer = null;

async function loadReports() {
  try {
    const res = await apiFetch(`/ota/admin/api/reports?page=${reportsPage}&limit=${reportsLimit}`);
    const data = await res.json();
    reportsTotal = data.total || 0;
    renderReports(data.entries || []);
    const info = document.getElementById('reports-info');
    const start = reportsPage * reportsLimit + 1;
    const end   = Math.min(start + reportsLimit - 1, reportsTotal);
    info.textContent = reportsTotal
      ? `${start}–${end} of ${reportsTotal}`
      : 'No reports yet';
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

document.getElementById('reports-prev').addEventListener('click', () => {
  if (reportsPage > 0) { reportsPage--; loadReports(); }
});
document.getElementById('reports-next').addEventListener('click', () => {
  if ((reportsPage + 1) * reportsLimit < reportsTotal) { reportsPage++; loadReports(); }
});
document.getElementById('reports-limit').addEventListener('change', e => {
  reportsLimit = parseInt(e.target.value, 10);
  reportsPage  = 0;
  loadReports();
});
document.getElementById('auto-refresh-chk').addEventListener('change', e => {
  if (e.target.checked) {
    autoRefreshTimer = setInterval(loadReports, 10000);
  } else {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
});

// ── Tokens ────────────────────────────────────────────────────────────────────

async function loadTokens() {
  try {
    const res = await apiFetch('/ota/admin/api/tokens');
    const tokens = await res.json();
    renderTokens(tokens);
  } catch (_) {}
}

function renderTokens(tokens) {
  const tbody = document.getElementById('token-tbody');
  if (!tokens.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="4">No tokens found</td></tr>';
    return;
  }
  tbody.innerHTML = '';
  for (const t of tokens) {
    const tr = document.createElement('tr');
    const statusBadge = t.expired ? badge('expired', 'failed') : badge('valid', 'success');
    const expiresStr  = t.expires ? new Date(t.expires).toLocaleString() : 'never';
    tr.innerHTML = `
      <td>${t.prefix}</td>
      <td>${t.type || 'firmware'}</td>
      <td>${expiresStr}</td>
      <td>${statusBadge}</td>
    `;
    tbody.appendChild(tr);
  }
}

// ── Initial load ──────────────────────────────────────────────────────────────

function loadAll() {
  loadFirmware();
  loadAudio();
  loadManifests();
  loadReports();
  loadTokens();
}

// Check auth on load — probe a protected endpoint
async function init() {
  if (authToken) {
    try {
      const res = await fetch('/ota/admin/api/files/firmware', {
        headers: { 'Authorization': `Bearer ${authToken}` },
      });
      if (res.status === 401) {
        setAuthState(false);
        showAuthDialog();
        return;
      }
      setAuthState(true);
      loadAll();
    } catch (_) {
      setAuthState(false);
      showAuthDialog();
    }
  } else {
    // No token stored — if admin token is unset (open), still try to load
    const res = await fetch('/ota/admin/api/files/firmware').catch(() => null);
    if (!res || res.status === 401) {
      showAuthDialog();
    } else {
      setAuthState(true);
      loadAll();
    }
  }
}

init();
