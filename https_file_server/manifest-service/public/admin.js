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
// makeActionBtns(f) → optional array of HTMLElement prepended before the delete button

function renderFileTable(tbodyId, files, colCount, endpoint, onRefresh, makeActionBtns) {
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
    const cell = tr.querySelector('td:last-child');
    cell.style.cssText = 'display:flex;gap:6px;align-items:center;justify-content:flex-end;flex-wrap:wrap';
    if (makeActionBtns) {
      for (const btn of makeActionBtns(f)) cell.appendChild(btn);
    }
    cell.appendChild(
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

// ── Push target dialog (shared) ───────────────────────────────────────────────

function showPushTargetDialog(title, confirmLabel, onConfirm) {
  const existing = document.getElementById('push-target-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'push-target-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:150';

  const box = document.createElement('div');
  box.style.cssText = 'background:var(--bg-panel);border:1px solid var(--border);border-radius:12px;padding:24px 28px;max-width:480px;width:calc(100% - 48px);display:flex;flex-direction:column;gap:14px';
  box.innerHTML = `
    <h3 style="font-size:14px;margin:0">${title}</h3>
    <div class="radio-group">
      <label class="radio-item"><input type="radio" name="pt-radio" value="group" checked> Group — node path</label>
      <label class="radio-item"><input type="radio" name="pt-radio" value="broadcast"> Broadcast — all devices</label>
    </div>
    <div id="pt-node-wrap">
      <label style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:6px">Node Path</label>
      <input type="text" id="pt-node-path" placeholder="e.g. buildingA/1stfloor/cafeteria"
        style="width:100%;box-sizing:border-box;background:var(--bg-raised);border:1px solid var(--border);border-radius:6px;padding:8px 10px;color:var(--text-primary);font-family:var(--font-mono);font-size:13px;outline:none">
    </div>
    <div id="pt-topic-preview" style="font-size:12px;color:var(--text-muted);font-family:var(--font-mono);padding:6px 10px;background:var(--bg-raised);border-radius:4px">
      Topic: scout/$group/…/$action
    </div>
    <p id="pt-broadcast-warn" style="display:none;font-size:13px;color:var(--warn);margin:0">⚠ This will trigger all online devices.</p>
    <div style="display:flex;gap:10px;justify-content:flex-end">
      <button class="btn btn-secondary btn-sm" id="pt-cancel">Cancel</button>
      <button class="btn btn-primary btn-sm" id="pt-confirm" disabled>${confirmLabel}</button>
    </div>
  `;
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  const nodeWrap   = box.querySelector('#pt-node-wrap');
  const nodeInput  = box.querySelector('#pt-node-path');
  const topicPrev  = box.querySelector('#pt-topic-preview');
  const bcWarn     = box.querySelector('#pt-broadcast-warn');
  const confirmBtn = box.querySelector('#pt-confirm');

  function update() {
    const isBc = box.querySelector('input[name="pt-radio"]:checked')?.value === 'broadcast';
    nodeWrap.style.display = isBc ? 'none' : '';
    bcWarn.style.display   = isBc ? '' : 'none';
    const nodePath = nodeInput.value.trim();
    topicPrev.textContent  = isBc
      ? 'Topic: scout/$broadcast/$action'
      : (nodePath ? `Topic: scout/$group/${nodePath}/$action` : 'Topic: scout/$group/…/$action');
    confirmBtn.disabled = !isBc && !nodePath;
  }

  box.querySelectorAll('input[name="pt-radio"]').forEach(r => r.addEventListener('change', update));
  nodeInput.addEventListener('input', update);
  nodeInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !confirmBtn.disabled) confirmBtn.click(); });
  update();

  box.querySelector('#pt-cancel').addEventListener('click', () => overlay.remove());
  confirmBtn.addEventListener('click', () => {
    const isBc = box.querySelector('input[name="pt-radio"]:checked')?.value === 'broadcast';
    overlay.remove();
    onConfirm({ broadcast: isBc, nodePath: isBc ? undefined : nodeInput.value.trim() });
  });
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

// ── Firmware ──────────────────────────────────────────────────────────────────

function makeFirmwarePushBtn(f) {
  const btn = document.createElement('button');
  btn.className = 'btn btn-primary btn-sm';
  btn.textContent = 'Push to Devices';
  btn.addEventListener('click', () => {
    showPushTargetDialog(`Push ${f.name}`, 'Push', async ({ broadcast, nodePath }) => {
      try {
        const res = await apiFetch('/ota/admin/api/ota/push-firmware', {
          method: 'POST',
          body: JSON.stringify({ firmwareFile: f.name, nodePath, broadcast: broadcast || undefined }),
        });
        if (res.ok) {
          const data = await res.json();
          toast(`Pushed ${f.name} → ${data.topic}`, 'success');
        } else {
          const e = await res.json().catch(() => ({}));
          toast(`Push failed: ${e.error || res.status}`, 'error');
        }
      } catch (_) { toast('Push failed', 'error'); }
    });
  });
  return [btn];
}

async function loadFirmware() {
  try {
    const res = await apiFetch('/ota/admin/api/files/firmware');
    const files = await res.json();
    renderFileTable('firmware-tbody', files, 5, '/ota/admin/api/files/firmware', loadFirmware, makeFirmwarePushBtn);
  } catch (_) {}
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

// ── Audio / Files — push helpers ──────────────────────────────────────────────

function makeFilePushBtns(f) {
  const sendBtn = document.createElement('button');
  sendBtn.className = 'btn btn-primary btn-sm';
  sendBtn.textContent = 'Send to Devices';
  sendBtn.addEventListener('click', () => {
    showPushTargetDialog(`Send ${f.name} to Devices`, 'Send', async ({ broadcast, nodePath }) => {
      try {
        const res = await apiFetch('/ota/admin/api/ota/push-files', {
          method: 'POST',
          body: JSON.stringify({ files: [{ op: 'put', id: f.name }], nodePath, broadcast: broadcast || undefined }),
        });
        if (res.ok) {
          const data = await res.json();
          toast(`Sent ${f.name} → ${data.topic}`, 'success');
        } else {
          const e = await res.json().catch(() => ({}));
          toast(`Send failed: ${e.error || res.status}`, 'error');
        }
      } catch (_) { toast('Send failed', 'error'); }
    });
  });

  const removeBtn = document.createElement('button');
  removeBtn.className = 'btn btn-warn btn-sm';
  removeBtn.textContent = 'Remove from Devices';
  removeBtn.addEventListener('click', () => {
    showPushTargetDialog(`Remove ${f.name} from Devices`, 'Remove', async ({ broadcast, nodePath }) => {
      try {
        const res = await apiFetch('/ota/admin/api/ota/push-files', {
          method: 'POST',
          body: JSON.stringify({ files: [{ op: 'delete', id: f.name }], nodePath, broadcast: broadcast || undefined }),
        });
        if (res.ok) {
          const data = await res.json();
          toast(`Remove command sent → ${data.topic}`, 'success');
        } else {
          const e = await res.json().catch(() => ({}));
          toast(`Failed: ${e.error || res.status}`, 'error');
        }
      } catch (_) { toast('Remove failed', 'error'); }
    });
  });

  return [sendBtn, removeBtn];
}

// ── Audio ─────────────────────────────────────────────────────────────────────

let _audioFiles = [];

function _audioSelectedNames() {
  return [...document.querySelectorAll('.audio-row-check:checked')].map(cb => cb.dataset.name);
}

function _updateAudioToolbar() {
  const checks  = [...document.querySelectorAll('.audio-row-check')];
  const checked = checks.filter(c => c.checked);
  const selAll  = document.getElementById('audio-select-all');
  const count   = document.getElementById('audio-sel-count');
  const sendBtn = document.getElementById('audio-send-btn');
  const remBtn  = document.getElementById('audio-remove-btn');
  selAll.checked       = checks.length > 0 && checked.length === checks.length;
  selAll.indeterminate = checked.length > 0 && checked.length < checks.length;
  count.textContent    = `${checked.length} selected`;
  sendBtn.disabled     = checked.length === 0;
  remBtn.disabled      = checked.length === 0;
}

function renderAudioTable(files) {
  _audioFiles = files;
  const tbody = document.getElementById('audio-tbody');
  if (!files.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="6">No files uploaded yet</td></tr>';
    _updateAudioToolbar();
    return;
  }
  tbody.innerHTML = '';
  for (const f of files) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="col-check"><input type="checkbox" class="audio-row-check" data-name="${f.name}"></td>
      <td class="file-name">${f.name}</td>
      <td class="file-size">${fmtSize(f.size)}</td>
      <td class="file-hash" title="${f.crc32 || ''}">${f.crc32 || '—'}</td>
      <td class="file-date">${fmtDate(f.mtime)}</td>
      <td></td>
    `;
    tr.querySelector('.audio-row-check').addEventListener('change', _updateAudioToolbar);
    const cell = tr.querySelector('td:last-child');
    cell.style.cssText = 'display:flex;gap:6px;align-items:center;justify-content:flex-end';
    cell.appendChild(
      makeDeleteBtn(f.name, async () => {
        try {
          await apiFetch(`/ota/admin/api/files/audio/${encodeURIComponent(f.name)}`, { method: 'DELETE' });
          toast(`Deleted ${f.name}`, 'success');
          loadAudio();
        } catch (_) { toast('Delete failed', 'error'); }
      })
    );
    tbody.appendChild(tr);
  }
  _updateAudioToolbar();
}

document.getElementById('audio-select-all').addEventListener('change', e => {
  document.querySelectorAll('.audio-row-check').forEach(cb => { cb.checked = e.target.checked; });
  _updateAudioToolbar();
});

function _pushAudioSelected(op) {
  const names = _audioSelectedNames();
  if (!names.length) return;
  const verb = op === 'put' ? 'Send' : 'Remove';
  showPushTargetDialog(
    `${verb} ${names.length} file${names.length > 1 ? 's' : ''} ${op === 'put' ? 'to' : 'from'} Devices`,
    verb,
    async ({ broadcast, nodePath }) => {
      try {
        const res = await apiFetch('/ota/admin/api/ota/push-files', {
          method: 'POST',
          body: JSON.stringify({
            files: names.map(n => ({ op, id: n })),
            nodePath,
            broadcast: broadcast || undefined,
          }),
        });
        if (res.ok) {
          const data = await res.json();
          toast(`${verb} command sent (${names.length} file${names.length > 1 ? 's' : ''}) → ${data.topic}`, 'success');
        } else {
          const e = await res.json().catch(() => ({}));
          toast(`${verb} failed: ${e.error || res.status}`, 'error');
        }
      } catch (_) { toast(`${verb} failed`, 'error'); }
    }
  );
}

document.getElementById('audio-send-btn').addEventListener('click',   () => _pushAudioSelected('put'));
document.getElementById('audio-remove-btn').addEventListener('click',  () => _pushAudioSelected('delete'));

document.getElementById('audio-sync-btn').addEventListener('click', () => {
  if (!_audioFiles.length) { toast('No audio files to sync', 'error'); return; }
  showPushTargetDialog(
    `Sync all ${_audioFiles.length} audio file${_audioFiles.length > 1 ? 's' : ''} to Devices`,
    'Sync',
    async ({ broadcast, nodePath }) => {
      try {
        const res = await apiFetch('/ota/admin/api/ota/push-files', {
          method: 'POST',
          body: JSON.stringify({
            files: _audioFiles.map(f => ({ op: 'put', id: f.name })),
            sync: true,
            nodePath,
            broadcast: broadcast || undefined,
          }),
        });
        if (res.ok) {
          const data = await res.json();
          toast(`Sync pushed (${_audioFiles.length} files) → ${data.topic}`, 'success');
        } else {
          const e = await res.json().catch(() => ({}));
          toast(`Sync failed: ${e.error || res.status}`, 'error');
        }
      } catch (_) { toast('Sync failed', 'error'); }
    }
  );
});

async function loadAudio() {
  try {
    const res = await apiFetch('/ota/admin/api/files/audio');
    const files = await res.json();
    renderAudioTable(files);
  } catch (_) {}
}

(function () {
  const zone = document.getElementById('audio-zone');
  const inp  = document.getElementById('audio-file-input');
  const prog = document.getElementById('audio-progress');
  const bar  = document.getElementById('audio-progress-bar');

  function uploadWav(file) {
    if (!file.name.toLowerCase().endsWith('.wav')) { toast(`Skipped ${file.name} — not a .wav`, 'error'); return; }
    uploadFile(file, '/ota/admin/api/files/audio', bar, prog, () => loadAudio());
  }

  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault(); zone.classList.remove('drag-over');
    [...e.dataTransfer.files].forEach(uploadWav);
  });
  inp.addEventListener('change', () => {
    [...inp.files].forEach(uploadWav);
    inp.value = '';
  });
})();

// ── General Files ─────────────────────────────────────────────────────────────

async function loadFiles() {
  try {
    const res = await apiFetch('/ota/admin/api/files/general');
    const files = await res.json();
    renderFileTable('files-tbody', files, 5, '/ota/admin/api/files/general', loadFiles, makeFilePushBtns);
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

const TAB_IDS = ['firmware', 'audio', 'files', 'reports'];

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
  loadReports();
}

async function init() {
  updateDeviceCount();
  setInterval(updateDeviceCount, 30000);

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
