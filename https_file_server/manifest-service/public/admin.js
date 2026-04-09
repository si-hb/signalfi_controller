'use strict';

// ── Auth ──────────────────────────────────────────────────────────────────────

localStorage.removeItem('signalfi-admin-token'); // remove legacy bearer token key
localStorage.removeItem('signalfi-admin-session'); // remove any persisted session
const STORAGE_KEY  = 'signalfi-admin-session';
let authToken    = sessionStorage.getItem(STORAGE_KEY) || '';
let _pendingPhone  = ''; // carries phone from step 1 → step 2

// On load: validate any stored token; show phone dialog if missing or expired.
(async () => {
  if (!authToken) { showPhoneDialog(); return; }
  try {
    const res = await fetch('/ota/admin/auth/check', {
      headers: { 'Authorization': `Bearer ${authToken}` },
    });
    if (!res.ok) {
      authToken = '';
      sessionStorage.removeItem(STORAGE_KEY);
      showPhoneDialog();
    }
  } catch (_) { showPhoneDialog(); }
})();

function setAuthState(ok) {
  document.getElementById('auth-dot').className    = ok ? 'ok' : 'fail';
  document.getElementById('auth-label').textContent = ok ? 'authenticated' : 'not authenticated';
}

async function apiFetch(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) { authToken = ''; sessionStorage.removeItem(STORAGE_KEY); setAuthState(false); showPhoneDialog(); throw new Error('Unauthorized'); }
  setAuthState(true);
  return res;
}

function showPhoneDialog() {
  document.getElementById('auth-dialog').classList.remove('hidden');
  document.getElementById('auth-code-dialog').classList.add('hidden');
  document.getElementById('auth-phone').focus();
}
function hidePhoneDialog() { document.getElementById('auth-dialog').classList.add('hidden'); }
function showCodeDialog()  {
  document.getElementById('auth-code-dialog').classList.remove('hidden');
  document.getElementById('auth-code').value = '';
  document.getElementById('auth-code').focus();
}
function hideCodeDialog()  { document.getElementById('auth-code-dialog').classList.add('hidden'); }

// Step 1 — phone entry
async function submitPhone() {
  const phone = document.getElementById('auth-phone').value.trim();
  if (!phone) return;
  const btn = document.getElementById('auth-phone-submit');
  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    const res  = await fetch('/ota/admin/auth/request', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone }),
    });
    const data = await res.json();
    if (data.accepted) {
      _pendingPhone = phone;
      hidePhoneDialog();
      showCodeDialog();
    }
    // Not accepted: silent — no error shown, no feedback. Bots get nothing to key on.
  } catch (_) { /* network error — also silent */ }
  finally { btn.disabled = false; btn.textContent = 'Send Code'; }
}
document.getElementById('auth-phone-submit').addEventListener('click', submitPhone);
document.getElementById('auth-phone').addEventListener('keydown', e => { if (e.key === 'Enter') submitPhone(); });

// Step 2 — code entry
async function submitCode() {
  const code = document.getElementById('auth-code').value.trim();
  if (code.length !== 6) return;
  const btn = document.getElementById('auth-code-submit');
  btn.disabled = true; btn.textContent = 'Verifying…';
  try {
    const res = await fetch('/ota/admin/auth/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: _pendingPhone, code }),
    });
    if (res.ok) {
      const data = await res.json();
      authToken = data.token;
      sessionStorage.setItem(STORAGE_KEY, authToken);
      hideCodeDialog();
      loadAll();
    } else if (res.status === 429) {
      hideCodeDialog();
      showPhoneDialog();
      toast('Too many attempts — request a new code', 'error');
    } else {
      document.getElementById('auth-code').value = '';
      document.getElementById('auth-code').focus();
      toast('Incorrect code', 'error');
    }
  } catch (_) { toast('Verification failed', 'error'); }
  finally { btn.disabled = false; btn.textContent = 'Verify'; }
}
document.getElementById('auth-code-submit').addEventListener('click', submitCode);
document.getElementById('auth-code').addEventListener('keydown', e => { if (e.key === 'Enter') submitCode(); });
// Auto-submit on 6th digit
document.getElementById('auth-code').addEventListener('input', e => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
  if (e.target.value.length === 6) submitCode();
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

// Options: { showBackup, showForce }
// onConfirm receives { broadcast, nodePath, backup, force }
// Node path and broadcast/group selection are persisted in localStorage so the
// last-used value is pre-filled on every popup regardless of which section
// (firmware / audio / files) opened it.
const _PT_STORAGE_PATH = 'push-node-path';
const _PT_STORAGE_MODE = 'push-node-mode';

function showPushTargetDialog(title, confirmLabel, onConfirm, { showBackup = false, showForce = false } = {}) {
  const existing = document.getElementById('push-target-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'push-target-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:150';

  const savedMode = localStorage.getItem(_PT_STORAGE_MODE) || 'group';

  const backupHtml = showBackup ? `
    <div>
      <label style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:6px">Firmware Backup</label>
      <select id="pt-backup" style="width:100%;box-sizing:border-box;background:var(--bg-raised);border:1px solid var(--border);border-radius:6px;padding:8px 10px;color:var(--text-primary);font-size:13px;outline:none">
        <option value="">None — keep existing backup</option>
        <option value="program">program — snapshot running firmware before flashing</option>
        <option value="file">file — use incoming firmware as backup before flashing</option>
      </select>
    </div>` : '';

  const forceHtml = showForce ? `
    <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;user-select:none">
      <input type="checkbox" id="pt-force" style="width:14px;height:14px;cursor:pointer">
      Force reflash — skip version check on device
    </label>` : '';

  const box = document.createElement('div');
  box.style.cssText = 'background:var(--bg-panel);border:1px solid var(--border);border-radius:12px;padding:24px 28px;max-width:480px;width:calc(100% - 48px);display:flex;flex-direction:column;gap:14px';
  box.innerHTML = `
    <h3 style="font-size:14px;margin:0">${title}</h3>
    <div class="radio-group">
      <label class="radio-item"><input type="radio" name="pt-radio" value="group"${savedMode === 'group' ? ' checked' : ''}> Group — node path</label>
      <label class="radio-item"><input type="radio" name="pt-radio" value="broadcast"${savedMode === 'broadcast' ? ' checked' : ''}> Broadcast — all devices</label>
    </div>
    <div id="pt-node-wrap">
      <label style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:6px">Node Path</label>
      <input type="text" id="pt-node-path" placeholder="e.g. buildingA/1stfloor/cafeteria"
        style="width:100%;box-sizing:border-box;background:var(--bg-raised);border:1px solid var(--border);border-radius:6px;padding:8px 10px;color:var(--text-primary);font-family:var(--font-mono);font-size:13px;outline:none">
    </div>
    ${backupHtml}
    ${forceHtml}
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

  // Restore saved node path
  nodeInput.value = localStorage.getItem(_PT_STORAGE_PATH) || '';

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
    const isBc   = box.querySelector('input[name="pt-radio"]:checked')?.value === 'broadcast';
    const backup = box.querySelector('#pt-backup')?.value || undefined;
    const force  = box.querySelector('#pt-force')?.checked || false;
    // Persist for next popup
    localStorage.setItem(_PT_STORAGE_MODE, isBc ? 'broadcast' : 'group');
    if (!isBc) localStorage.setItem(_PT_STORAGE_PATH, nodeInput.value.trim());
    overlay.remove();
    onConfirm({ broadcast: isBc, nodePath: isBc ? undefined : nodeInput.value.trim(), backup, force });
  });
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

// ── Firmware ──────────────────────────────────────────────────────────────────

function makeFirmwarePushBtn(f) {
  const btn = document.createElement('button');
  btn.className = 'btn btn-primary btn-sm';
  btn.textContent = 'Push to Devices';
  btn.addEventListener('click', () => {
    showPushTargetDialog(`Push ${f.name}`, 'Push', async ({ broadcast, nodePath, backup, force }) => {
      try {
        const ledProgress = document.getElementById('firmware-led-progress')?.checked ?? true;
        const res = await apiFetch('/ota/admin/api/ota/push-firmware', {
          method: 'POST',
          body: JSON.stringify({ firmwareFile: f.name, nodePath, broadcast: broadcast || undefined, backup: backup || undefined, progress: ledProgress || undefined, force: force || undefined }),
        });
        if (res.ok) {
          const data = await res.json();
          toast(`Pushed ${f.name} → ${data.topic}`, 'success');
        } else {
          const e = await res.json().catch(() => ({}));
          toast(`Push failed: ${e.error || res.status}`, 'error');
        }
      } catch (_) { toast('Push failed', 'error'); }
    }, { showBackup: true, showForce: true });
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

// ── Audio preview player ──────────────────────────────────────────────────────

let _previewAudio = null;   // current HTMLAudioElement
let _previewBtn   = null;   // button that triggered it

function _stopPreview() {
  if (_previewAudio) {
    _previewAudio.pause();
    _previewAudio.src = '';
    _previewAudio = null;
  }
  if (_previewBtn) {
    _previewBtn.textContent = '▶ Preview';
    _previewBtn.classList.replace('btn-warn', 'btn-secondary');
    _previewBtn = null;
  }
}

function _togglePreview(filename, btn) {
  // If this button is already playing, just stop
  if (_previewBtn === btn) { _stopPreview(); return; }

  // Stop whatever was playing before
  _stopPreview();

  // Use a direct src URL with the token as a query param so the browser can
  // stream via range requests immediately without downloading the whole file first
  const src = `/ota/admin/api/files/audio/${encodeURIComponent(filename)}${authToken ? `?t=${encodeURIComponent(authToken)}` : ''}`;
  _previewAudio = new Audio(src);
  _previewBtn   = btn;
  btn.textContent = '■ Stop';
  btn.classList.replace('btn-secondary', 'btn-warn');

  _previewAudio.addEventListener('ended', _stopPreview);
  _previewAudio.addEventListener('error', () => {
    toast(`Preview failed: ${filename}`, 'error');
    _stopPreview();
  });
  _previewAudio.play();
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

// ── Audio filename sanitization (mirrors server logic) ────────────────────────

function sanitizeAudioBase(raw) {
  return raw.replace(/\s+/g, '_').replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 8);
}

function _startRename(filename, tr) {
  const base     = filename.replace(/\.wav$/i, '');
  const nameCell = tr.querySelector('.file-name');
  const actCell  = tr.querySelector('td:last-child');

  nameCell.dataset.orig = nameCell.textContent;
  nameCell.textContent  = '';

  const inp = document.createElement('input');
  inp.type        = 'text';
  inp.className   = 'rename-input';
  inp.value       = base;
  inp.maxLength   = 8;
  inp.spellcheck  = false;
  nameCell.appendChild(inp);

  const hint = document.createElement('span');
  hint.className = 'rename-hint';
  nameCell.appendChild(hint);

  inp.addEventListener('input', () => {
    const s = sanitizeAudioBase(inp.value);
    hint.textContent = s ? ` → ${s}.wav` : '';
    hint.className   = s ? 'rename-hint rename-hint--ok' : 'rename-hint rename-hint--warn';
  });
  inp.dispatchEvent(new Event('input'));

  actCell.dataset.origHtml = actCell.innerHTML;
  actCell.innerHTML        = '';
  actCell.style.cssText    = 'display:flex;gap:6px;align-items:center;justify-content:flex-end';

  const cancelBtn = document.createElement('button');
  cancelBtn.className   = 'btn btn-secondary btn-sm';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => renderAudioTable(_audioFiles));

  const saveBtn = document.createElement('button');
  saveBtn.className   = 'btn btn-primary btn-sm';
  saveBtn.textContent = 'Save';

  const doSave = async () => {
    const newBase = sanitizeAudioBase(inp.value);
    if (!newBase) { toast('Name cannot be empty', 'error'); return; }
    const newName = newBase + '.wav';
    try {
      const r = await apiFetch(`/ota/admin/api/files/audio/${encodeURIComponent(filename)}`, {
        method: 'PATCH',
        body: JSON.stringify({ newName: newBase }),
      });
      if (r.ok) {
        toast(`Renamed to ${newName}`, 'success');
        loadAudio();
      } else {
        const e = await r.json().catch(() => ({}));
        toast(`Rename failed: ${e.error || r.status}`, 'error');
      }
    } catch (_) { toast('Rename failed', 'error'); }
  };

  saveBtn.addEventListener('click', doSave);
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter')  doSave();
    if (e.key === 'Escape') renderAudioTable(_audioFiles);
  });

  actCell.appendChild(cancelBtn);
  actCell.appendChild(saveBtn);
  inp.focus();
  inp.select();
}

function renderAudioTable(files) {
  _audioFiles = files;
  _stopPreview();
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

    const prevBtn = document.createElement('button');
    prevBtn.className = 'btn btn-secondary btn-sm';
    prevBtn.textContent = '▶ Preview';
    prevBtn.addEventListener('click', () => _togglePreview(f.name, prevBtn));
    cell.appendChild(prevBtn);

    const renameBtn = document.createElement('button');
    renameBtn.className   = 'btn btn-secondary btn-sm';
    renameBtn.textContent = 'Rename';
    renameBtn.addEventListener('click', () => _startRename(f.name, tr));
    cell.appendChild(renameBtn);

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
      const ledProgress = document.getElementById('audio-led-progress')?.checked ?? true;
      try {
        const res = await apiFetch('/ota/admin/api/ota/push-files', {
          method: 'POST',
          body: JSON.stringify({
            files: names.map(n => ({ op, id: n })),
            nodePath,
            broadcast: broadcast || undefined,
            progress: ledProgress || undefined,
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
      const ledProgress = document.getElementById('audio-led-progress')?.checked ?? true;
      try {
        const res = await apiFetch('/ota/admin/api/ota/push-files', {
          method: 'POST',
          body: JSON.stringify({
            files: _audioFiles.map(f => ({ op: 'put', id: f.name })),
            sync: true,
            nodePath,
            broadcast: broadcast || undefined,
            progress: ledProgress || undefined,
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
  const zone       = document.getElementById('audio-zone');
  const inp        = document.getElementById('audio-file-input');
  const prog       = document.getElementById('audio-progress');
  const bar        = document.getElementById('audio-progress-bar');
  const statusPanel = document.getElementById('audio-upload-status');

  function addStatusRow(name) {
    const row = document.createElement('div');
    row.className = 'upload-status-row uploading';
    row.innerHTML = `
      <span class="upload-status-icon">⟳</span>
      <span class="upload-status-text">Uploading <strong>${name}</strong>…</span>
    `;
    statusPanel.appendChild(row);
    // Keep at most 20 rows
    while (statusPanel.children.length > 20) statusPanel.removeChild(statusPanel.firstChild);
    return row;
  }

  function setRowConverting(row, name) {
    row.className = 'upload-status-row converting';
    row.querySelector('.upload-status-icon').textContent = '⟳';
    row.querySelector('.upload-status-text').innerHTML = `Converting <strong>${name}</strong>…`;
  }

  function setRowSuccess(row, data) {
    row.className = 'upload-status-row success';
    row.querySelector('.upload-status-icon').textContent = '✓';
    if (data.converted) {
      row.querySelector('.upload-status-text').innerHTML =
        `<strong>${data.name}</strong> — converted from <em>${data.originalName}</em>`;
    } else {
      row.querySelector('.upload-status-text').innerHTML =
        `<strong>${data.name}</strong> — already correct format`;
    }
  }

  function setRowError(row, name, msg) {
    row.className = 'upload-status-row error';
    row.querySelector('.upload-status-icon').textContent = '✗';
    row.querySelector('.upload-status-text').innerHTML =
      `<strong>${name}</strong> — ${msg}`;
  }

  function uploadAudio(file) {
    const row = addStatusRow(file.name);
    const formData = new FormData();
    formData.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/ota/admin/api/files/audio');
    if (authToken) xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);

    prog.style.display = 'block';
    bar.style.width = '0%';

    xhr.upload.onprogress = e => {
      if (e.lengthComputable) bar.style.width = Math.round(e.loaded / e.total * 100) + '%';
    };
    // File bytes sent — server is now converting
    xhr.upload.onload = () => {
      bar.style.width = '100%';
      setRowConverting(row, file.name);
    };
    xhr.onload = () => {
      prog.style.display = 'none';
      bar.style.width = '0%';
      if (xhr.status === 200 || xhr.status === 201) {
        const data = JSON.parse(xhr.responseText);
        setRowSuccess(row, data);
        loadAudio();
      } else if (xhr.status === 401) {
        setAuthState(false); showAuthDialog();
        setRowError(row, file.name, 'Not authorized');
      } else {
        let msg = `Server error ${xhr.status}`;
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch (_) {}
        setRowError(row, file.name, msg);
      }
    };
    xhr.onerror = () => {
      prog.style.display = 'none';
      setRowError(row, file.name, 'Network error');
    };
    xhr.send(formData);
  }

  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault(); zone.classList.remove('drag-over');
    [...e.dataTransfer.files].forEach(uploadAudio);
  });
  inp.addEventListener('change', () => {
    [...inp.files].forEach(uploadAudio);
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

// ── Live activity table ────────────────────────────────────────────────────────

const activityRows = new Map(); // sessionId → <tr>

function _categoryBadge(cat) {
  return `<span class="activity-cat activity-cat--${cat}">${cat}</span>`;
}

function _fmtBytes(n) {
  if (n < 1024)       return `${n} B`;
  if (n < 1024*1024)  return `${(n/1024).toFixed(1)} KB`;
  return `${(n/1024/1024).toFixed(2)} MB`;
}

function _updateCount() {
  const n = activityRows.size;
  document.getElementById('activity-count').textContent = `${n} active`;
  const empty = document.getElementById('activity-empty-row');
  if (empty) empty.style.display = n === 0 ? '' : 'none';
}

function onDeviceConnect(d) {
  // Multi-file transfer: if a row already exists for this device, evict it from
  // the DOM immediately so the old row doesn't linger while the new file runs.
  // The old row's pending setTimeout (from onDeviceDone) checks TR identity before
  // touching activityRows, so evicting the DOM node here is safe.
  const existing = activityRows.get(d.sessionId);
  if (existing) existing.remove();

  const tbody = document.getElementById('activity-tbody');
  const tr = document.createElement('tr');
  tr.id = `dl-${d.sessionId}`;
  tr.innerHTML = `
    <td class="activity-ip">${d.ip}</td>
    <td class="activity-file" title="${d.file}">${d.file}</td>
    <td>${_categoryBadge(d.category)}</td>
    <td class="activity-progress-cell">
      <div class="activity-bar-wrap">
        <div class="activity-bar" id="bar-${d.sessionId}" style="width:0%"></div>
      </div>
      <span class="activity-pct" id="pct-${d.sessionId}">0%</span>
      <span class="activity-size" id="sz-${d.sessionId}">0 / ${_fmtBytes(d.total)}</span>
    </td>
    <td class="activity-speed" id="spd-${d.sessionId}">—</td>
    <td><span class="activity-status activity-status--active">●&nbsp;active</span></td>
  `;
  activityRows.set(d.sessionId, tr);
  tbody.appendChild(tr);
  _updateCount();
}

function onDeviceProgress(d) {
  const tr = activityRows.get(d.sessionId);
  if (!tr) return;
  const bar  = document.getElementById(`bar-${d.sessionId}`);
  const pct  = document.getElementById(`pct-${d.sessionId}`);
  const sz   = document.getElementById(`sz-${d.sessionId}`);
  const spd  = document.getElementById(`spd-${d.sessionId}`);
  if (bar)  bar.style.width  = `${d.pct}%`;
  if (pct)  pct.textContent  = `${d.pct}%`;
  if (sz)   sz.textContent   = `${_fmtBytes(d.sent)} / ${_fmtBytes(d.total)}`;
  if (spd)  spd.textContent  = `${d.kbps} KB/s`;
}

function onDeviceDone(d, aborted) {
  const tr = activityRows.get(d.sessionId);
  if (!tr) return;
  const bar = document.getElementById(`bar-${d.sessionId}`);
  if (bar && !aborted) bar.style.width = '100%';
  const statusCell = tr.querySelector('.activity-status');
  const durationS  = (d.durationMs / 1000).toFixed(1);
  if (aborted) {
    statusCell.className   = 'activity-status activity-status--aborted';
    statusCell.textContent = `✕ aborted (${durationS}s)`;
  } else {
    statusCell.className   = 'activity-status activity-status--done';
    statusCell.textContent = `✓ done (${durationS}s)`;
  }
  setTimeout(() => {
    tr.remove();
    // Only remove the map entry if it still points to this exact TR — a new file
    // for the same device may have already replaced it with a fresh row.
    if (activityRows.get(d.sessionId) === tr) {
      activityRows.delete(d.sessionId);
      _updateCount();
    }
  }, aborted ? 5000 : 8000);
}

function onDeviceError(d) {
  const tr = activityRows.get(d.sessionId);
  if (!tr) return;
  const statusCell = tr.querySelector('.activity-status');
  statusCell.className   = 'activity-status activity-status--error';
  statusCell.textContent = `✕ error`;
  tr.title = d.error || '';
  setTimeout(() => {
    tr.remove();
    if (activityRows.get(d.sessionId) === tr) {
      activityRows.delete(d.sessionId);
      _updateCount();
    }
  }, 8000);
}

// Seed table with any in-progress downloads that started before the page loaded
(function seedActiveDownloads() {
  const url = '/ota/admin/api/active-downloads' + (authToken ? `?t=${encodeURIComponent(authToken)}` : '');
  const xhr = new XMLHttpRequest();
  xhr.open('GET', url);
  if (authToken) xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);
  xhr.onload = () => {
    if (xhr.status !== 200) return;
    try {
      const list = JSON.parse(xhr.responseText);
      for (const dl of list) {
        onDeviceConnect(dl);
        onDeviceProgress({ ...dl, pct: Math.round(dl.sent / dl.total * 100), kbps: 0 });
      }
    } catch (_) {}
  };
  xhr.send();
})();

// ── SSE — live file-update notifications ──────────────────────────────────────

(function connectSSE() {
  const url = '/ota/admin/api/events' + (authToken ? `?t=${encodeURIComponent(authToken)}` : '');
  const es  = new EventSource(url);
  es.onmessage = (e) => {
    try {
      const d = JSON.parse(e.data);
      if      (d.type === 'firmware-updated')  loadFirmware();
      else if (d.type === 'audio-updated')     loadAudio();
      else if (d.type === 'general-updated')   loadFiles();
      else if (d.type === 'device-connect')    onDeviceConnect(d);
      else if (d.type === 'device-progress')   onDeviceProgress(d);
      else if (d.type === 'device-done')       onDeviceDone(d, false);
      else if (d.type === 'device-aborted')    onDeviceDone(d, true);
      else if (d.type === 'device-error')      onDeviceError(d);
    } catch (_) {}
  };
  es.onerror = () => { es.close(); setTimeout(connectSSE, 5000); };
})();
