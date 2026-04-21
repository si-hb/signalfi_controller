'use strict';

// ── Auth ──────────────────────────────────────────────────────────────────────

localStorage.removeItem('signalfi-admin-token'); // remove legacy bearer token key
localStorage.removeItem('signalfi-admin-session'); // remove any persisted session
const STORAGE_KEY  = 'signalfi-admin-session';
let authToken    = sessionStorage.getItem(STORAGE_KEY) || '';
let _pendingPhone  = '';
let _expireTimer   = null;

function scheduleExpiry(expiresAt) {
  if (_expireTimer) clearTimeout(_expireTimer);
  if (!expiresAt) return;
  const ms = expiresAt - Date.now();
  if (ms <= 0) { showPhoneDialog(); return; }
  _expireTimer = setTimeout(() => {
    authToken = '';
    sessionStorage.removeItem(STORAGE_KEY);
    showPhoneDialog();
  }, ms);
}

// On load: hit /auth/check with whatever we've got (including nothing).  The
// server replies 200 when either (a) it's in DISABLE_OTP=true mode, (b) a
// static ADMIN_TOKEN matches, or (c) the session token is still valid.
// Only fall back to the phone dialog when the server explicitly 401s.
(async () => {
  try {
    const headers = authToken ? { 'Authorization': `Bearer ${authToken}` } : {};
    const res = await fetch('/ota/admin/auth/check', { headers });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      if (!data.otpDisabled && data.expiresAt) scheduleExpiry(data.expiresAt);
      return;
    }
    authToken = '';
    sessionStorage.removeItem(STORAGE_KEY);
    showPhoneDialog();
  } catch (_) { showPhoneDialog(); }
})();

document.getElementById('btn-terminate-sessions').addEventListener('click', async () => {
  const btn = document.getElementById('btn-terminate-sessions');
  btn.disabled = true; btn.textContent = 'Terminating…';
  try {
    const res  = await apiFetch('/ota/admin/auth/sessions', { method: 'DELETE' });
    const data = await res.json();
    toast(`All sessions terminated (${data.cleared} cleared)`, 'success');
  } catch (e) {
    if (!String(e.message).includes('Unauthorized')) toast('Failed to terminate sessions', 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Terminate Sessions';
  }
});

function setAuthState(ok) {
  document.getElementById('auth-dot').className    = ok ? 'ok' : 'fail';
  document.getElementById('auth-label').textContent = ok ? 'authenticated' : 'not authenticated';
}

// Transparent 429 retry with server-hinted Retry-After or capped exponential
// backoff.  Without this a single upstream throttle during the page-load burst
// left tabs silently empty until a full browser refresh.
async function apiFetch(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

  const backoffMs = [300, 800, 1800]; // up to 3 retries on 429
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(path, { ...opts, headers });
    if (res.status === 401) {
      authToken = '';
      sessionStorage.removeItem(STORAGE_KEY);
      setAuthState(false);
      showPhoneDialog();
      throw new Error('Unauthorized');
    }
    if (res.status === 429 && attempt < backoffMs.length) {
      const retryAfter = parseInt(res.headers.get('Retry-After'), 10);
      const wait = Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, 5000) : backoffMs[attempt];
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    setAuthState(true);
    // Non-2xx (other than 401 handled above) — throw so callers' catch blocks
    // fire instead of silently feeding a 4xx/5xx body into res.json().
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const b = await res.clone().json(); if (b && b.error) msg = b.error; } catch (_) {}
      const err = new Error(msg);
      err.status   = res.status;
      err.response = res;
      throw err;
    }
    return res;
  }
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
      scheduleExpiry(data.expiresAt);
      hideCodeDialog();
      bootstrap();
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

// Mirror of server-side cleanNodePath: strip MQTT topic wrappers that the firmware
// sometimes sends in nod fields (e.g. "scout/$broadcast/$action" → "").
// Provides a client-side safety net so raw MQTT topics never appear in the UI.
function sanitizeNode(raw) {
  if (!raw) return '';
  const m = raw.match(/^[^/]+\/(.+?)\/\$action$/);
  if (m) {
    const g = m[1].match(/^\$group\/(.+)$/);
    return g ? g[1] : '';
  }
  return raw.replace(/^\/+/, '').replace(/\/+$/, '');
}

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
      setAuthState(false); showPhoneDialog();
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
// formatName(f)     → optional function returning an HTML string for the name cell

function renderFileTable(tbodyId, files, colCount, endpoint, onRefresh, makeActionBtns, formatName) {
  const tbody = document.getElementById(tbodyId);
  if (!files.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="${colCount}">No files uploaded yet</td></tr>`;
    return;
  }
  tbody.innerHTML = '';
  for (const f of files) {
    const nameHtml = formatName ? formatName(f) : f.name;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="file-name">${nameHtml}</td>
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

// Options: { showBackup, showForce, showLedProgress }
// onConfirm receives { broadcast, nodePath, backup, force, ledProgress }
// Node path and broadcast/group selection are persisted in localStorage so the
// last-used value is pre-filled on every popup regardless of which section
// (firmware / audio / files) opened it.
const _PT_STORAGE_PATH        = 'push-node-path';
const _PT_STORAGE_MODE        = 'push-node-mode';
const _PT_STORAGE_LED_PROGRESS = 'push-led-progress';

function showPushTargetDialog(title, confirmLabel, onConfirm, { showBackup = false, showForce = false, showLedProgress = false, defaultTargetModels = '' } = {}) {
  const existing = document.getElementById('push-target-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'push-target-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:150';

  const nSel     = selectedDevices.size;
  const savedMode = nSel > 0 ? 'selected' : (localStorage.getItem(_PT_STORAGE_MODE) || 'group');

  const selHtml = nSel > 0 ? `
      <label class="radio-item"><input type="radio" name="pt-radio" value="selected"${savedMode === 'selected' ? ' checked' : ''}> Selected Devices — ${nSel} device${nSel === 1 ? '' : 's'} chosen in Devices tab</label>` : '';

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
    <div style="border:1px solid rgba(232,124,42,0.35);border-radius:6px;padding:8px 10px">
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;user-select:none">
        <input type="checkbox" id="pt-force" style="width:14px;height:14px;cursor:pointer">
        <span><strong style="color:var(--warn)">Force</strong> — bypass device model check.
        Use only for cross-model migrations where devices should accept firmware for a different model.</span>
      </label>
    </div>` : '';

  const targetModelsHtml = showForce ? `
    <div id="pt-target-models-wrap" style="display:none">
      <label style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:6px">
        Target Model(s)
        <span style="font-weight:400;text-transform:none;letter-spacing:0;margin-left:4px">— comma-separated, e.g. <code>SSH-100, SF-100</code></span>
      </label>
      <input type="text" id="pt-target-models" value="${defaultTargetModels}"
        placeholder="SSH-100"
        style="width:100%;box-sizing:border-box;background:var(--bg-raised);border:1px solid var(--border);border-radius:6px;padding:8px 10px;color:var(--text-primary);font-family:var(--font-mono);font-size:13px;outline:none">
      <p style="font-size:11px;color:var(--text-muted);margin:4px 0 0">
        Add <code>SF-100</code> alongside <code>SSH-100</code> to reach devices still running old firmware.
      </p>
    </div>` : '';

  const ledProgressChecked = localStorage.getItem(_PT_STORAGE_LED_PROGRESS) !== 'false';
  const ledProgressHtml = showLedProgress ? `
    <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;user-select:none">
      <input type="checkbox" id="pt-led-progress" style="width:14px;height:14px;cursor:pointer"${ledProgressChecked ? ' checked' : ''}>
      LED Progress — show transfer progress on device LEDs
    </label>` : '';

  const box = document.createElement('div');
  box.style.cssText = 'background:var(--bg-panel);border:1px solid var(--border);border-radius:12px;padding:24px 28px;max-width:480px;width:calc(100% - 48px);display:flex;flex-direction:column;gap:14px';
  box.innerHTML = `
    <h3 style="font-size:14px;margin:0">${title}</h3>
    <div class="radio-group">
      ${selHtml}
      <label class="radio-item"><input type="radio" name="pt-radio" value="group"${savedMode === 'group' ? ' checked' : ''}> Group — node</label>
      <label class="radio-item"><input type="radio" name="pt-radio" value="broadcast"${savedMode === 'broadcast' ? ' checked' : ''}> Broadcast — all devices</label>
    </div>
    <div id="pt-node-wrap">
      <label style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:6px">Node</label>
      <input type="text" id="pt-node-path" placeholder="e.g. buildingA/1stfloor/cafeteria"
        style="width:100%;box-sizing:border-box;background:var(--bg-raised);border:1px solid var(--border);border-radius:6px;padding:8px 10px;color:var(--text-primary);font-family:var(--font-mono);font-size:13px;outline:none">
    </div>
    ${backupHtml}
    ${targetModelsHtml}
    ${forceHtml}
    ${ledProgressHtml}
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
    const mode = box.querySelector('input[name="pt-radio"]:checked')?.value;
    const isBc  = mode === 'broadcast';
    const isSel = mode === 'selected';
    nodeWrap.style.display = (isBc || isSel) ? 'none' : '';
    bcWarn.style.display   = isBc ? '' : 'none';
    const nodePath = nodeInput.value.trim();
    topicPrev.textContent = isBc  ? 'Topic: scout/$broadcast/$action'
      : isSel ? `Targeting ${selectedDevices.size} selected device(s)`
      : (nodePath ? `Topic: scout/$group/${nodePath}/$action` : 'Topic: scout/$group/…/$action');
    confirmBtn.disabled = !isBc && !isSel && !nodePath;
  }

  box.querySelectorAll('input[name="pt-radio"]').forEach(r => r.addEventListener('change', update));
  nodeInput.addEventListener('input', update);
  nodeInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !confirmBtn.disabled) confirmBtn.click(); });
  update();

  // Show target models field only when force is enabled
  const forceChk       = box.querySelector('#pt-force');
  const targetWrap     = box.querySelector('#pt-target-models-wrap');
  if (forceChk && targetWrap) {
    forceChk.addEventListener('change', () => {
      targetWrap.style.display = forceChk.checked ? '' : 'none';
    });
  }

  box.querySelector('#pt-cancel').addEventListener('click', () => overlay.remove());
  confirmBtn.addEventListener('click', () => {
    const mode        = box.querySelector('input[name="pt-radio"]:checked')?.value;
    const isBc        = mode === 'broadcast';
    const isSel       = mode === 'selected';
    const backup        = box.querySelector('#pt-backup')?.value || undefined;
    const force         = box.querySelector('#pt-force')?.checked || false;
    const ledProgress   = box.querySelector('#pt-led-progress')?.checked ?? true;
    const targetModels  = force
      ? (box.querySelector('#pt-target-models')?.value.split(',').map(s => s.trim()).filter(Boolean) || undefined)
      : undefined;
    // Persist for next popup (don't persist 'selected' — it's contextual)
    if (!isSel) {
      localStorage.setItem(_PT_STORAGE_MODE, isBc ? 'broadcast' : 'group');
      if (!isBc) localStorage.setItem(_PT_STORAGE_PATH, nodeInput.value.trim());
    }
    if (showLedProgress) localStorage.setItem(_PT_STORAGE_LED_PROGRESS, String(ledProgress));
    overlay.remove();
    onConfirm({
      broadcast:       isBc,
      selectedDevices: isSel ? Array.from(selectedDevices) : undefined,
      nodePath:        (!isBc && !isSel) ? nodeInput.value.trim() : undefined,
      backup,
      force,
      ledProgress,
      targetModels,
    });
  });
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

// ── Firmware ──────────────────────────────────────────────────────────────────

function makeFirmwarePushBtn(f) {
  const btn = document.createElement('button');
  btn.className = 'btn btn-primary btn-sm';
  btn.textContent = 'Push to Devices';
  btn.addEventListener('click', () => {
    const defaultModels = Array.isArray(f.targetModels) && f.targetModels.length
      ? f.targetModels.join(', ')
      : '';
    showPushTargetDialog(`Push ${f.name}`, 'Push', async ({ broadcast, nodePath, selectedDevices: devs, backup, force, ledProgress, targetModels }) => {
      try {
        const res = await apiFetch('/ota/admin/api/ota/push-firmware', {
          method: 'POST',
          body: JSON.stringify({
            firmwareFile: f.name,
            nodePath,
            broadcast:    broadcast    || undefined,
            deviceIds:    devs         || undefined,
            backup:       backup       || undefined,
            progress:     ledProgress  || undefined,
            force:        force        || undefined,
            targetModels: targetModels?.length ? targetModels : undefined,
          }),
        });
        const data = await res.json();
        toast(`Pushed ${f.name} → ${data.topic}`, 'success');
      } catch (err) { toast(`Push failed: ${err.message || 'unknown error'}`, 'error'); }
    }, { showBackup: true, showForce: true, showLedProgress: true, defaultTargetModels: defaultModels });
  });
  return [btn];
}

function fmtFirmwareName(f) {
  const models = Array.isArray(f.targetModels) ? f.targetModels : [];
  const badges = models.length
    ? models.map(m => `<span class="model-badge">${m}</span>`).join('')
    : `<span class="model-badge model-badge-untagged">⚠ untagged</span>`;
  return `${f.name} ${badges}`;
}

async function loadFirmware() {
  try {
    const res = await apiFetch('/ota/admin/api/files/firmware');
    const files = await res.json();
    renderFirmware(files);
  } catch (err) {
    if (String(err.message) !== 'Unauthorized') toast(`Firmware: ${err.message}`, 'error');
  }
}

function renderFirmware(files) {
  renderFileTable('firmware-tbody', files, 5, '/ota/admin/api/files/firmware', loadFirmware, makeFirmwarePushBtn, fmtFirmwareName);
  _tabLoadedAt.firmware = Date.now();
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
    showPushTargetDialog(`Send ${f.name} to Devices`, 'Send', async ({ broadcast, nodePath, selectedDevices: devs, ledProgress }) => {
      try {
        const res = await apiFetch('/ota/admin/api/ota/push-files', {
          method: 'POST',
          body: JSON.stringify({ files: [{ op: 'put', id: f.name }], nodePath, broadcast: broadcast || undefined, deviceIds: devs || undefined, progress: ledProgress || undefined }),
        });
        const data = await res.json();
        toast(`Sent ${f.name} → ${data.topic}`, 'success');
      } catch (err) { toast(`Send failed: ${err.message || 'unknown error'}`, 'error'); }
    }, { showLedProgress: true });
  });

  const removeBtn = document.createElement('button');
  removeBtn.className = 'btn btn-warn btn-sm';
  removeBtn.textContent = 'Remove from Devices';
  removeBtn.addEventListener('click', () => {
    showPushTargetDialog(`Remove ${f.name} from Devices`, 'Remove', async ({ broadcast, nodePath, selectedDevices: devs }) => {
      try {
        const res = await apiFetch('/ota/admin/api/ota/push-files', {
          method: 'POST',
          body: JSON.stringify({ files: [{ op: 'delete', id: f.name }], nodePath, broadcast: broadcast || undefined, deviceIds: devs || undefined }),
        });
        const data = await res.json();
        toast(`Remove command sent → ${data.topic}`, 'success');
      } catch (err) { toast(`Remove failed: ${err.message || 'unknown error'}`, 'error'); }
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
      toast(`Renamed to ${newName}`, 'success');
      loadAudio();
    } catch (err) {
      toast(`Rename failed: ${err.message || 'unknown error'}`, 'error');
    }
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
    async ({ broadcast, nodePath, selectedDevices: devs, ledProgress }) => {
      try {
        const res = await apiFetch('/ota/admin/api/ota/push-files', {
          method: 'POST',
          body: JSON.stringify({
            files: names.map(n => ({ op, id: n })),
            nodePath,
            broadcast: broadcast || undefined,
            deviceIds: devs || undefined,
            progress: ledProgress || undefined,
          }),
        });
        const data = await res.json();
        toast(`${verb} command sent (${names.length} file${names.length > 1 ? 's' : ''}) → ${data.topic}`, 'success');
      } catch (err) { toast(`${verb} failed: ${err.message || 'unknown error'}`, 'error'); }
    },
    op === 'put' ? { showLedProgress: true } : {}
  );
}

document.getElementById('audio-send-btn').addEventListener('click',   () => _pushAudioSelected('put'));
document.getElementById('audio-remove-btn').addEventListener('click',  () => _pushAudioSelected('delete'));

document.getElementById('audio-sync-btn').addEventListener('click', () => {
  if (!_audioFiles.length) { toast('No audio files to sync', 'error'); return; }
  showPushTargetDialog(
    `Sync all ${_audioFiles.length} audio file${_audioFiles.length > 1 ? 's' : ''} to Devices`,
    'Sync',
    async ({ broadcast, nodePath, selectedDevices: devs, ledProgress }) => {
      try {
        const res = await apiFetch('/ota/admin/api/ota/push-files', {
          method: 'POST',
          body: JSON.stringify({
            files: _audioFiles.map(f => ({ op: 'put', id: f.name })),
            sync: true,
            nodePath,
            broadcast: broadcast || undefined,
            deviceIds: devs || undefined,
            progress: ledProgress || undefined,
          }),
        });
        const data = await res.json();
        toast(`Sync pushed (${_audioFiles.length} files) → ${data.topic}`, 'success');
      } catch (err) { toast(`Sync failed: ${err.message || 'unknown error'}`, 'error'); }
    },
    { showLedProgress: true }
  );
});

async function loadAudio() {
  try {
    const res = await apiFetch('/ota/admin/api/files/audio');
    const files = await res.json();
    renderAudioTable(files);
    _tabLoadedAt.audio = Date.now();
  } catch (err) {
    if (String(err.message) !== 'Unauthorized') toast(`Audio: ${err.message}`, 'error');
  }
}

// ── Audio upload validation dialogs ──────────────────────────────────────────

// Shown when the filename would be changed by sanitization (illegal chars, spaces,
// truncation) or is entirely invalid.  Returns the accepted base string (no ext),
// or null if the user cancels.
function showAudioRenameDialog(originalName, proposedBase, reason) {
  return new Promise(resolve => {
    const existing = document.getElementById('audio-rename-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'audio-rename-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);display:flex;align-items:center;justify-content:center;z-index:160';

    const isInvalid = !proposedBase;
    const titleText = isInvalid ? 'Filename is not valid' : 'Filename will be renamed';
    const reasonHtml = reason
      ? `<p style="font-size:12px;color:var(--text-muted);margin:0">Reason: ${reason}</p>`
      : '';

    const box = document.createElement('div');
    box.style.cssText = 'background:var(--bg-panel);border:1px solid var(--border);border-radius:12px;padding:24px 28px;max-width:440px;width:calc(100% - 48px);display:flex;flex-direction:column;gap:14px';
    box.innerHTML = `
      <h3 style="font-size:14px;margin:0">${titleText}</h3>
      <p style="font-size:13px;margin:0;color:var(--text-muted)">
        Original: <code style="color:var(--text-secondary)">${originalName}</code>
      </p>
      ${reasonHtml}
      <div>
        <label style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:6px">
          New name <span style="font-weight:400;text-transform:none;letter-spacing:0">(base only, max 8 chars — <code>.wav</code> added automatically)</span>
        </label>
        <input id="arn-input" type="text" maxlength="20" spellcheck="false"
          value="${proposedBase}"
          style="width:100%;box-sizing:border-box;background:var(--bg-raised);border:1px solid var(--border);border-radius:6px;padding:8px 10px;color:var(--text-primary);font-family:var(--font-mono);font-size:13px;outline:none">
        <div id="arn-preview" style="font-size:12px;margin-top:6px;font-family:var(--font-mono)"></div>
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end">
        <button class="btn btn-secondary btn-sm" id="arn-cancel">Cancel</button>
        <button class="btn btn-primary btn-sm" id="arn-confirm" disabled>Use This Name</button>
      </div>
    `;
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const input   = box.querySelector('#arn-input');
    const preview = box.querySelector('#arn-preview');
    const confirm = box.querySelector('#arn-confirm');

    function update() {
      const clean = sanitizeAudioBase(input.value);
      if (!clean) {
        preview.innerHTML = '<span style="color:var(--error,#e55)">No valid characters — enter a name using letters, numbers, underscores, or hyphens</span>';
        confirm.disabled = true;
      } else {
        const truncated = input.value.replace(/\s+/g, '_').replace(/[^A-Za-z0-9_\-]/g, '').length > 8;
        preview.innerHTML = `<span style="color:var(--success,#4c4)">Will be stored as: <strong>${clean}.wav</strong></span>`
          + (truncated ? ' <span style="color:var(--text-muted)">(truncated)</span>' : '');
        confirm.disabled = false;
      }
    }

    input.addEventListener('input', update);
    update();

    const doConfirm = () => {
      const clean = sanitizeAudioBase(input.value);
      if (!clean) return;
      overlay.remove();
      resolve(clean);
    };

    box.querySelector('#arn-cancel').addEventListener('click', () => { overlay.remove(); resolve(null); });
    confirm.addEventListener('click', doConfirm);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !confirm.disabled) doConfirm();
      if (e.key === 'Escape') { overlay.remove(); resolve(null); }
    });
    overlay.addEventListener('click', e => { if (e.target === overlay) { overlay.remove(); resolve(null); } });

    input.focus();
    input.select();
  });
}

// Shown when a file with the same sanitized name already exists on the server.
// Returns true (replace) or false (cancel).
function showAudioReplaceDialog(filename) {
  return new Promise(resolve => {
    const existing = document.getElementById('audio-replace-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'audio-replace-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);display:flex;align-items:center;justify-content:center;z-index:160';

    const box = document.createElement('div');
    box.style.cssText = 'background:var(--bg-panel);border:1px solid var(--border);border-radius:12px;padding:24px 28px;max-width:400px;width:calc(100% - 48px);display:flex;flex-direction:column;gap:14px';
    box.innerHTML = `
      <h3 style="font-size:14px;margin:0">File already exists</h3>
      <p style="font-size:13px;margin:0">
        <code style="color:var(--text-secondary)">${filename}</code> is already on the server.
        Do you want to replace it?
      </p>
      <div style="display:flex;gap:10px;justify-content:flex-end">
        <button class="btn btn-secondary btn-sm" id="arr-cancel">Cancel</button>
        <button class="btn btn-danger btn-sm"    id="arr-replace">Replace</button>
      </div>
    `;
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    box.querySelector('#arr-cancel').addEventListener('click',  () => { overlay.remove(); resolve(false); });
    box.querySelector('#arr-replace').addEventListener('click', () => { overlay.remove(); resolve(true);  });
    overlay.addEventListener('keydown', e => { if (e.key === 'Escape') { overlay.remove(); resolve(false); } });
    overlay.addEventListener('click',   e => { if (e.target === overlay) { overlay.remove(); resolve(false); } });

    box.querySelector('#arr-replace').focus();
  });
}

// Validate a filename via the server, then optionally prompt for rename / replace,
// then upload.  Returns after the upload completes (or is cancelled).
async function _validateAndUploadAudio(file, uploadFn) {
  // Ask the server what it will store this file as, and if that name exists already.
  let sanitized, exists, changed, reason;
  try {
    const r = await apiFetch(`/ota/admin/api/files/audio/validate-name?name=${encodeURIComponent(file.name)}`);
    if (!r.ok) throw new Error('validate failed');
    ({ sanitized, exists, changed, reason } = await r.json());
  } catch (_) {
    // If validation endpoint unreachable, fall through and let the upload fail normally.
    await uploadFn(file);
    return;
  }

  let finalBase = sanitized.replace(/\.wav$/i, '');

  // Show rename dialog if the name would change or is entirely invalid.
  if (changed || !finalBase) {
    const chosen = await showAudioRenameDialog(file.name, finalBase, reason);
    if (chosen === null) return; // user cancelled
    finalBase = chosen;
    // Re-check existence with the user-chosen name.
    try {
      const r2 = await apiFetch(`/ota/admin/api/files/audio/validate-name?name=${encodeURIComponent(chosen + '.wav')}`);
      if (r2.ok) ({ exists } = await r2.json());
    } catch (_) {}
  }

  const finalName = finalBase + '.wav';

  // Show replace dialog if a file by this name already exists.
  if (exists) {
    const replace = await showAudioReplaceDialog(finalName);
    if (!replace) return; // user cancelled
  }

  // Upload — if the name changed, wrap the bytes in a new File with the accepted name
  // so the server's sanitizeAudioName() produces exactly finalName.  Original extension
  // is preserved so the server can detect the format (WAV check / ffmpeg conversion).
  const origExt   = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')).toLowerCase() : '';
  const uploadAs  = finalBase + origExt;
  const fileToSend = uploadAs === file.name ? file : new File([file], uploadAs, { type: file.type });
  await uploadFn(fileToSend);
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

  // Returns a Promise that resolves when the upload completes (success or error).
  // Must return a promise so the caller can await it and uploads stay sequential —
  // concurrent uploads trip Traefik's rate-limit and cause 502 errors.
  function uploadAudio(file) {
    return new Promise(resolve => {
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
      // File bytes sent — server is now converting (or storing)
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
          setAuthState(false); showPhoneDialog();
          setRowError(row, file.name, 'Not authorized');
        } else {
          let msg = `Server error ${xhr.status}`;
          try { msg = JSON.parse(xhr.responseText).error || msg; } catch (_) {}
          setRowError(row, file.name, msg);
        }
        resolve();
      };
      xhr.onerror = () => {
        prog.style.display = 'none';
        setRowError(row, file.name, 'Network error');
        resolve();
      };
      xhr.send(formData);
    });
  }

  // Process files strictly one at a time: validate → dialog (if needed) → upload → next.
  // Sequential execution avoids concurrent POSTs that trip Traefik's rate-limit.
  async function handleAudioFiles(files) {
    for (const file of files) {
      await _validateAndUploadAudio(file, uploadAudio);
    }
  }

  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault(); zone.classList.remove('drag-over');
    handleAudioFiles([...e.dataTransfer.files]);
  });
  inp.addEventListener('change', () => {
    handleAudioFiles([...inp.files]);
    inp.value = '';
  });
})();

// ── General Files ─────────────────────────────────────────────────────────────

async function loadFiles() {
  try {
    const res = await apiFetch('/ota/admin/api/files/general');
    const files = await res.json();
    renderGeneralFiles(files);
  } catch (err) {
    if (String(err.message) !== 'Unauthorized') toast(`Files: ${err.message}`, 'error');
  }
}

function renderGeneralFiles(files) {
  renderFileTable('files-tbody', files, 5, '/ota/admin/api/files/general', loadFiles, makeFilePushBtns);
  _tabLoadedAt.files = Date.now();
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

let reportsPage = 0, reportsTotal = 0, reportsLimit = 50;
let reportsFilterStatus = '', reportsFilterDevice = '';

async function loadReportsStats() {
  try {
    const res  = await apiFetch('/ota/admin/api/reports/stats');
    const s    = await res.json();
    renderReportsStats(s);
  } catch (err) {
    if (String(err.message) !== 'Unauthorized') toast(`Report stats: ${err.message}`, 'error');
  }
}

function renderReportsStats(s) {
  document.getElementById('stat-total').textContent   = s.total ?? '—';
  document.getElementById('stat-success').textContent = s.success ?? '—';
  document.getElementById('stat-failed').textContent  = s.failed ?? '—';
  document.getElementById('stat-devices').textContent = s.devices ?? '—';
  document.getElementById('stat-last').textContent    = s.last ? new Date(s.last).toLocaleString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '—';
}

async function loadReports() {
  try {
    const params = new URLSearchParams({ page: reportsPage, limit: reportsLimit });
    if (reportsFilterStatus) params.set('status', reportsFilterStatus);
    if (reportsFilterDevice) params.set('device', reportsFilterDevice);
    const res  = await apiFetch(`/ota/admin/api/reports?${params}`);
    const data = await res.json();
    renderReportsPage(data);
  } catch (err) {
    if (String(err.message) !== 'Unauthorized') toast(`Reports: ${err.message}`, 'error');
  }
}

function renderReportsPage(data) {
  reportsTotal = data.total || 0;
  renderReports(data.entries || []);
  const start = reportsPage * reportsLimit + 1;
  const end   = Math.min(start + reportsLimit - 1, reportsTotal);
  document.getElementById('reports-info').textContent = reportsTotal ? `${start}–${end} of ${reportsTotal}` : 'No reports yet';
  document.getElementById('reports-prev').disabled = reportsPage === 0;
  document.getElementById('reports-next').disabled = end >= reportsTotal;
  _tabLoadedAt.reports = Date.now();
}

function reportStatusBadge(status) {
  if (status === 'applied')  return badge('applied',  'success');
  if (status === 'failed')   return badge('failed',   'failed');
  if (status === 'deleted')  return badge('deleted',  'warn');
  if (status === 'skipped')  return badge('skipped',  'no');
  if (status === 'pushed')   return badge('pushed',   'started');
  return badge(status || '—', 'started');
}

function _pushStatusBadge(devices) {
  if (!devices || devices.length === 0) return badge('pushed', 'started');
  const nApplied = devices.filter(d => d.status === 'applied').length;
  const nFailed  = devices.filter(d => d.status === 'failed').length;
  if (nFailed > 0) return badge(`${nApplied}/${devices.length} applied`, 'failed');
  return badge(`${nApplied} applied`, 'success');
}

function _fmtTopicShort(topics) {
  if (!topics || !topics.length) return '—';
  if (topics.length === 1) return topics[0].replace('scout/', '').replace('/$action', '');
  return `${topics.length} topics`;
}

function makeReportRow(e) {
  const tr = document.createElement('tr');
  tr.style.cursor = 'pointer';
  tr.title = 'Click for details';

  if (e.type === 'push') {
    const n = (e.devices || []).length;
    tr.innerHTML = `
      <td>${e.timestamp ? new Date(e.timestamp).toLocaleString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit' }) : '—'}</td>
      <td class="mono" style="font-size:11px">${_fmtTopicShort(e.topics)}</td>
      <td>${e.manifest?.modelId || '—'}</td>
      <td class="mono">${e.version || (e.category === 'files' ? 'files' : '—')}</td>
      <td>${_pushStatusBadge(e.devices)}</td>
      <td class="mono text-muted">${n ? `${n} device${n > 1 ? 's' : ''}` : '—'}</td>
    `;
  } else {
    tr.innerHTML = `
      <td>${e.timestamp ? new Date(e.timestamp).toLocaleString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit' }) : '—'}</td>
      <td>${e.deviceId || '—'}</td>
      <td>${e.modelId || '—'}</td>
      <td class="mono">${e.firmwareVersion || e.version || '—'}</td>
      <td>${reportStatusBadge(e.status)}</td>
      <td class="mono text-muted">${e.ip || '—'}</td>
    `;
  }
  tr.addEventListener('click', () => showReportDetail(e));
  return tr;
}

function showReportDetail(e) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;z-index:200;padding:24px;overflow:auto';

  const box = document.createElement('div');
  box.style.cssText = 'background:var(--bg-panel);border:1px solid var(--border);border-radius:12px;width:min(800px,100%);max-height:80vh;display:flex;flex-direction:column;overflow:hidden';

  const fmtTs = ts => ts ? new Date(ts).toLocaleString(undefined, { month:'short', day:'numeric', year:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit' }) : '—';
  const fmtDur = ms => ms ? (ms / 1000).toFixed(1) + 's' : '—';

  if (e.type === 'push') {
    const fw      = e.manifest?.firmware;
    const fFiles  = fw ? [fw] : (e.manifest?.files || []);
    const fileRows = fFiles.map(f => {
      const name = f.url ? f.url.split('/').pop() : (f.id || '—');
      const op   = f.op === 'delete' ? ' <span style="color:var(--warn);font-size:10px">DELETE</span>' : '';
      return `<tr>
        <td class="mono" style="font-size:11px">${name}${op}</td>
        <td style="font-size:11px;color:var(--text-muted)">${f.size ? fmtSize(f.size) : '—'}</td>
        <td class="mono" style="font-size:11px;color:var(--text-muted)">${f.crc32 || '—'}</td>
        <td class="mono" style="font-size:11px;color:var(--text-muted)">${f.sha256 ? f.sha256.slice(0,16) + '…' : '—'}</td>
      </tr>`;
    }).join('') || `<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:12px;font-style:italic">—</td></tr>`;

    const deviceRows = (e.devices || []).map(d => `<tr>
      <td class="mono" style="font-size:11px">${d.deviceId || '—'}</td>
      <td class="mono" style="font-size:11px;color:var(--text-muted)">${d.ip || '—'}</td>
      <td style="font-size:11px;color:var(--text-muted)">${d.node || '—'}</td>
      <td class="mono" style="font-size:11px">${d.file || '—'}</td>
      <td>${reportStatusBadge(d.status)}</td>
      <td style="font-size:11px;color:var(--text-muted)">${fmtDur(d.durationMs)}</td>
      <td style="font-size:11px;color:var(--text-muted)">${fmtTs(d.timestamp)}</td>
    </tr>`).join('') || `<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:16px;font-style:italic">No device reports yet — devices may still be downloading</td></tr>`;

    const topicsHtml = (e.topics || []).map(t =>
      `<span class="mono" style="font-size:11px;color:var(--accent-bright);display:block">${t}</span>`
    ).join('') || '<span style="color:var(--text-muted)">—</span>';

    box.innerHTML = `
      <div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-shrink:0">
        <div style="display:flex;align-items:center;gap:12px">
          <span style="font-size:13px;font-weight:700">${e.category === 'firmware' ? 'Firmware Push' : 'File Push'}</span>
          ${e.version ? `<span class="mono" style="font-size:12px;color:var(--accent-bright)">v${e.version}</span>` : ''}
          <span style="font-size:11px;color:var(--text-muted)">${fmtTs(e.timestamp)}</span>
        </div>
        <button id="rpt-close" class="btn btn-secondary btn-sm">Close</button>
      </div>
      <div style="overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:20px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div style="background:var(--bg-raised);border:1px solid var(--border);border-radius:8px;padding:14px">
            <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--text-muted);margin-bottom:10px">Push Details</div>
            <table style="width:100%;font-size:12px;border-collapse:collapse">
              <tr><td style="color:var(--text-muted);padding:3px 0;width:90px">Push ID</td><td class="mono" style="font-size:10px;word-break:break-all">${e.pushId || '—'}</td></tr>
              <tr><td style="color:var(--text-muted);padding:3px 0">Model</td><td>${e.manifest?.modelId || '—'}</td></tr>
              <tr><td style="color:var(--text-muted);padding:3px 0">Type</td><td>${e.manifest?.type || e.category || '—'}${e.manifest?.sync ? ' (sync)' : ''}</td></tr>
            </table>
          </div>
          <div style="background:var(--bg-raised);border:1px solid var(--border);border-radius:8px;padding:14px">
            <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--text-muted);margin-bottom:10px">Targets</div>
            ${topicsHtml}
          </div>
        </div>
        <div>
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--text-muted);margin-bottom:8px">Files</div>
          <table style="width:100%;border-collapse:collapse">
            <thead><tr>
              ${['Filename','Size','CRC32','SHA256'].map(h => `<th style="text-align:left;padding:5px 10px;color:var(--text-muted);border-bottom:1px solid var(--border);font-size:10px;text-transform:uppercase;letter-spacing:.05em">${h}</th>`).join('')}
            </tr></thead>
            <tbody>${fileRows}</tbody>
          </table>
        </div>
        <div>
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--text-muted);margin-bottom:8px">Device Outcomes <span style="font-weight:400;text-transform:none;letter-spacing:0">(${(e.devices||[]).length} reported)</span></div>
          <table style="width:100%;border-collapse:collapse">
            <thead><tr>
              ${['MAC','IP','Node','File','Status','Duration','Time'].map(h => `<th style="text-align:left;padding:5px 10px;color:var(--text-muted);border-bottom:1px solid var(--border);font-size:10px;text-transform:uppercase;letter-spacing:.05em">${h}</th>`).join('')}
            </tr></thead>
            <tbody>${deviceRows}</tbody>
          </table>
        </div>
      </div>`;
  } else {
    // Legacy / standalone device report
    box.innerHTML = `
      <div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-shrink:0">
        <span style="font-size:13px;font-weight:700">Device Report</span>
        <button id="rpt-close" class="btn btn-secondary btn-sm">Close</button>
      </div>
      <div style="padding:20px">
        <table style="width:100%;font-size:13px;border-collapse:collapse">
          <tr><td style="color:var(--text-muted);padding:7px 0;width:140px">Timestamp</td><td>${fmtTs(e.timestamp)}</td></tr>
          <tr><td style="color:var(--text-muted);padding:7px 0">Device ID</td><td class="mono">${e.deviceId || '—'}</td></tr>
          <tr><td style="color:var(--text-muted);padding:7px 0">IP</td><td class="mono">${e.ip || '—'}</td></tr>
          <tr><td style="color:var(--text-muted);padding:7px 0">Node</td><td>${e.node || '—'}</td></tr>
          <tr><td style="color:var(--text-muted);padding:7px 0">Model</td><td>${e.modelId || '—'}</td></tr>
          <tr><td style="color:var(--text-muted);padding:7px 0">Version</td><td class="mono">${e.firmwareVersion || e.version || '—'}</td></tr>
          <tr><td style="color:var(--text-muted);padding:7px 0">File</td><td class="mono">${e.file || '—'}</td></tr>
          <tr><td style="color:var(--text-muted);padding:7px 0">Duration</td><td>${fmtDur(e.durationMs)}</td></tr>
          <tr><td style="color:var(--text-muted);padding:7px 0">Status</td><td>${reportStatusBadge(e.status)}</td></tr>
        </table>
      </div>`;
  }

  overlay.appendChild(box);
  document.body.appendChild(overlay);
  box.querySelector('#rpt-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', ev => { if (ev.target === overlay) overlay.remove(); });
}

function renderReports(entries) {
  const tbody = document.getElementById('reports-tbody');
  if (!entries.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="6">No reports yet</td></tr>';
    return;
  }
  tbody.innerHTML = '';
  entries.forEach(e => tbody.appendChild(makeReportRow(e)));
}

// Live update: reload reports on any new event so push rows show updated device counts
function prependReport(entry) {
  loadReportsStats();
  if (reportsPage === 0 && !reportsFilterStatus && !reportsFilterDevice) loadReports();
}

document.getElementById('reports-prev').addEventListener('click', () => { if (reportsPage > 0) { reportsPage--; loadReports(); } });
document.getElementById('reports-next').addEventListener('click', () => { if ((reportsPage + 1) * reportsLimit < reportsTotal) { reportsPage++; loadReports(); } });
document.getElementById('reports-limit').addEventListener('change', e => { reportsLimit = parseInt(e.target.value, 10); reportsPage = 0; loadReports(); });
document.getElementById('reports-filter-status').addEventListener('change', e => { reportsFilterStatus = e.target.value; reportsPage = 0; loadReports(); });
let _deviceFilterTimer;
document.getElementById('reports-filter-device').addEventListener('input', e => {
  clearTimeout(_deviceFilterTimer);
  _deviceFilterTimer = setTimeout(() => { reportsFilterDevice = e.target.value.trim(); reportsPage = 0; loadReports(); }, 300);
});
document.getElementById('reports-export-btn').addEventListener('click', () => {
  window.location.href = '/ota/admin/api/reports/export?t=' + encodeURIComponent(authToken);
});

// ── Device count ──────────────────────────────────────────────────────────────
// Count is derived from SSE device-state events + bootstrap's initial list.
// No polling — the 30s interval used to hammer the admin host and contribute
// to the rate-limit tripping during burst loads.

const _onlineDeviceIds = new Set();

function renderDeviceCount() {
  const n = _onlineDeviceIds.size;
  document.getElementById('device-count-label').textContent = `${n} online`;
  document.getElementById('device-count-dot').className = `device-count-dot${n > 0 ? ' ok' : ''}`;
}

function seedDeviceCount(list) {
  _onlineDeviceIds.clear();
  for (const d of list || []) if (d.id) _onlineDeviceIds.add(d.id);
  renderDeviceCount();
}

function bumpDeviceCount(id, online) {
  if (!id) return;
  if (online === false) _onlineDeviceIds.delete(id);
  else                  _onlineDeviceIds.add(id);
  renderDeviceCount();
}

// ── Devices tab ───────────────────────────────────────────────────────────────

const selectedDevices = new Set(); // Set of device IDs (MACs) currently checked

function _updateSelectionBadges() {
  const n    = selectedDevices.size;
  const text = n === 0 ? '' : `${n} device${n === 1 ? '' : 's'} selected`;
  ['firmware', 'audio', 'files'].forEach(tab => {
    const el = document.getElementById(`${tab}-selected-hint`);
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('hidden', n === 0);
  });
  const countEl = document.getElementById('devices-sel-count');
  if (countEl) countEl.textContent = `${n} selected`;
}

function _formatDeviceTemp(temp) {
  // Render inline next to the status dot.  Null / undefined → em-dash in
  // muted text so rows never collapse width.  Values colour-coded: green
  // under 60 °C, amber 60–75, red above 75 (Teensy 4.1 thermal limits).
  if (typeof temp !== 'number' || !isFinite(temp)) {
    return '<span class="device-temp device-temp--na" title="no temperature reported">—</span>';
  }
  const cls = temp >= 75 ? 'device-temp--hot'
            : temp >= 60 ? 'device-temp--warm'
            : 'device-temp--ok';
  return `<span class="device-temp ${cls}" title="CPU temperature">${temp.toFixed(1)}°C</span>`;
}

function _renderDevices(list) {
  const tbody  = document.getElementById('devices-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (!list || list.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="7">No devices seen yet</td></tr>';
    return;
  }

  list.forEach(dev => {
    const tr = document.createElement('tr');
    tr.dataset.devId = dev.id;
    tr.className = dev.online ? '' : 'device-offline';

    const checked = selectedDevices.has(dev.id) ? ' checked' : '';
    const dot     = dev.online
      ? '<span class="device-dot device-dot--online" title="Online"></span>'
      : '<span class="device-dot device-dot--offline" title="Offline"></span>';
    const temp    = _formatDeviceTemp(dev.temp);
    const nodeStr = sanitizeNode(dev.node);
    const node    = nodeStr || '<span class="text-muted">—</span>';
    const model   = dev.model   ? `<span class="model-badge">${dev.model}</span>` : '<span class="text-muted">—</span>';
    const version = dev.version || '<span class="text-muted">—</span>';

    tr.innerHTML = `
      <td class="col-check"><input type="checkbox" class="device-check"${checked}></td>
      <td class="device-status">${dot}${temp}</td>
      <td class="device-model">${model}</td>
      <td class="device-version">${version}</td>
      <td class="device-mac">${dev.id}</td>
      <td class="device-ip">${dev.ip || '—'}</td>
      <td class="device-node">${node}</td>
    `;

    tr.querySelector('.device-check').addEventListener('change', e => {
      if (e.target.checked) selectedDevices.add(dev.id);
      else                  selectedDevices.delete(dev.id);
      _syncSelectAll();
      _updateSelectionBadges();
    });

    tbody.appendChild(tr);
  });
}

function _syncSelectAll() {
  const all   = document.querySelectorAll('#devices-tbody .device-check');
  const chked = document.querySelectorAll('#devices-tbody .device-check:checked');
  const sa    = document.getElementById('devices-select-all');
  if (!sa) return;
  sa.indeterminate = chked.length > 0 && chked.length < all.length;
  sa.checked       = all.length > 0 && chked.length === all.length;
}

async function loadDevices({ broadcast = false } = {}) {
  // broadcast=true → append ?refresh=1 so the server broadcasts {act:"get"}
  // on MQTT, waits for device $state replies, evicts anything that didn't
  // answer, and then returns a fresh list.  Used by the Refresh button —
  // without the broadcast, a stale cache would come back unchanged (e.g.
  // after an OTA push when devices are still rebooting).
  const path = broadcast
    ? '/ota/admin/api/devices?refresh=1'
    : '/ota/admin/api/devices';
  try {
    const res  = await apiFetch(path);
    const list = await res.json();
    _renderDevices(list);
    _syncSelectAll();
    _updateSelectionBadges();
    seedDeviceCount(list);
  } catch (err) {
    if (String(err.message) !== 'Unauthorized') toast(`Devices: ${err.message}`, 'error');
  }
}

// Insert a single device row from SSE data — used when a new device appears without
// reloading the full list, to avoid hammering the API on multi-device state bursts.
function _insertDeviceRow(d) {
  const tbody = document.getElementById('devices-tbody');
  if (!tbody) return;
  // Remove the "no devices" empty row if present
  const emptyRow = tbody.querySelector('.empty-row');
  if (emptyRow) emptyRow.remove();

  const tr = document.createElement('tr');
  tr.dataset.devId = d.id;
  const dot     = '<span class="device-dot device-dot--online" title="Online"></span>';
  const temp    = _formatDeviceTemp(d.temp);
  const model   = d.model   ? `<span class="model-badge">${d.model}</span>` : '<span class="text-muted">—</span>';
  const version = d.version || '<span class="text-muted">—</span>';
  const nodeStr = sanitizeNode(d.node);
  const node    = nodeStr    || '<span class="text-muted">—</span>';
  tr.innerHTML = `
    <td class="col-check"><input type="checkbox" class="device-check"></td>
    <td class="device-status">${dot}${temp}</td>
    <td class="device-model">${model}</td>
    <td class="device-version">${version}</td>
    <td class="device-mac">${d.id}</td>
    <td class="device-ip">${d.ip || '—'}</td>
    <td class="device-node">${node}</td>
  `;
  tr.querySelector('.device-check').addEventListener('change', e => {
    if (e.target.checked) selectedDevices.add(d.id);
    else                  selectedDevices.delete(d.id);
    _syncSelectAll();
    _updateSelectionBadges();
  });
  tbody.appendChild(tr);
}

// Live update: refresh a single device row in-place from a device-state SSE event.
// Never calls loadDevices() — inserting rows directly avoids request-rate cascades
// when many devices respond to the broadcast at once.
function onDeviceState(d) {
  bumpDeviceCount(d.id, d.online);
  const existing = document.querySelector(`#devices-tbody tr[data-dev-id="${d.id}"]`);
  if (existing) {
    if (d.online === false) {
      // Device evicted by the server's offline-detection sweep — remove its row
      existing.remove();
      _syncSelectAll();
      _updateSelectionBadges();
      return;
    }
    // Update in-place — preserves checkbox state
    const dot     = '<span class="device-dot device-dot--online" title="Online"></span>';
    const dotCell = existing.cells[1];
    // Cell layout: [check, status+temp, model, version, mac, ip, node].
    // Rewrite the status cell so the temp inside also refreshes on each
    // $state; d.temp may be undefined if the firmware hasn't yet reported.
    if (dotCell) dotCell.innerHTML = `${dot}${_formatDeviceTemp(d.temp)}`;
    if (existing.cells[2] && d.model)   existing.cells[2].innerHTML   = `<span class="model-badge">${d.model}</span>`;
    if (existing.cells[3] && d.version) existing.cells[3].textContent = d.version;
    if (existing.cells[5] && d.ip)      existing.cells[5].textContent = d.ip;
    const cleanNode = sanitizeNode(d.node);
    if (existing.cells[6] && cleanNode) existing.cells[6].textContent = cleanNode;
    existing.className = '';
  } else {
    if (d.online === false) return; // evicted device not in table — nothing to do
    // New device seen via SSE — insert row directly; do NOT call loadDevices() here
    // because many devices respond to the broadcast simultaneously and each would
    // trigger a separate API request, easily exceeding the Traefik rate limit.
    _insertDeviceRow(d);
    _syncSelectAll();
    _updateSelectionBadges();
  }
}

document.getElementById('devices-select-all')?.addEventListener('change', e => {
  document.querySelectorAll('#devices-tbody .device-check').forEach(cb => {
    cb.checked = e.target.checked;
    const id   = cb.closest('tr')?.dataset.devId;
    if (!id) return;
    if (e.target.checked) selectedDevices.add(id);
    else                  selectedDevices.delete(id);
  });
  _updateSelectionBadges();
});

document.getElementById('devices-refresh-btn')?.addEventListener('click', async (e) => {
  // Refresh with broadcast — takes ~1.5s for devices to respond, so disable
  // the button and show progress text.  Without this the click looks like a
  // no-op when the server has a stale view after an OTA push.
  const btn = e.currentTarget;
  const prev = btn.textContent;
  btn.disabled    = true;
  btn.textContent = 'Refreshing…';
  try {
    await loadDevices({ broadcast: true });
  } finally {
    btn.disabled    = false;
    btn.textContent = prev;
  }
});

// ── Tab navigation ────────────────────────────────────────────────────────────

const TAB_IDS = ['devices', 'firmware', 'audio', 'files', 'reports'];

// Per-tab freshness timestamps — each loadX sets these, showTab() uses them to
// skip redundant fetches when toggling between tabs quickly.
const _tabLoadedAt = {};
const TAB_TTL_MS   = 5000;

const _tabLoaders = {
  devices:  loadDevices,
  firmware: loadFirmware,
  audio:    loadAudio,
  files:    loadFiles,
  reports:  () => { loadReports(); loadReportsStats(); },
};

function showTab(id) {
  TAB_IDS.forEach(t => {
    const section = document.getElementById(t);
    if (section) section.hidden = (t !== id);
  });
  document.querySelectorAll('#top-nav a[data-tab]').forEach(a =>
    a.classList.toggle('active', a.dataset.tab === id));
  // Always re-fetch on tab show, unless the tab was loaded in the last TAB_TTL_MS.
  // Previous behaviour skipped re-fetch on firmware/files/reports entirely, which
  // meant any initial load failure left those tabs silently empty forever.
  const loader = _tabLoaders[id];
  if (!loader) return;
  const lastLoaded = _tabLoadedAt[id] || 0;
  if (Date.now() - lastLoaded >= TAB_TTL_MS) loader();
}

document.querySelectorAll('#top-nav a[data-tab]').forEach(a =>
  a.addEventListener('click', e => { e.preventDefault(); showTab(a.dataset.tab); }));

// ── Initial load — one request, hydrate every tab ─────────────────────────────
// Replaces the previous 7-request burst at page load that tripped the per-IP
// rate limit on every browser refresh.

async function bootstrap() {
  try {
    const res  = await apiFetch(`/ota/admin/api/bootstrap?reportsLimit=${reportsLimit}`);
    const data = await res.json();
    if (data.firmware)     { renderFirmware(data.firmware); }
    if (data.audio)        { renderAudioTable(data.audio); _tabLoadedAt.audio = Date.now(); }
    if (data.general)      { renderGeneralFiles(data.general); }
    if (data.reports)      { renderReportsPage(data.reports); }
    if (data.reportsStats) { renderReportsStats(data.reportsStats); }
    if (data.devices)      { _renderDevices(data.devices); _syncSelectAll(); _updateSelectionBadges(); _tabLoadedAt.devices = Date.now(); }
    if (data.deviceCount)  { seedDeviceCount(data.devices || []); }
    return true;
  } catch (err) {
    if (String(err.message) === 'Unauthorized') return false;
    toast(`Load failed: ${err.message}`, 'error');
    return false;
  }
}

async function init() {
  showTab('firmware');
  // Always probe bootstrap first — a DISABLE_OTP=true server accepts
  // unauthenticated requests, in which case the phone dialog never needs
  // to appear.  If the server rejects the probe with 401, apiFetch's
  // 401 handler takes care of showing the dialog, and bootstrap() returns
  // false, so we don't need to re-trigger it here.
  const ok = await bootstrap();
  if (!ok && !authToken) showPhoneDialog();
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
  const modelBadge = d.model ? `<span class="model-badge">${d.model}</span>` : '<span class="text-muted">—</span>';
  tr.innerHTML = `
    <td class="activity-ip">${d.ip}</td>
    <td class="activity-model">${modelBadge}</td>
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

let _sseBackoff = 1000;
(function connectSSE() {
  const url = '/ota/admin/api/events' + (authToken ? `?t=${encodeURIComponent(authToken)}` : '');
  const es  = new EventSource(url);
  es.onopen = () => { _sseBackoff = 1000; }; // reset on successful connect
  es.onmessage = (e) => {
    try {
      const d = JSON.parse(e.data);
      if      (d.type === 'firmware-updated')    loadFirmware();
      else if (d.type === 'audio-updated')       loadAudio();
      else if (d.type === 'general-updated')     loadFiles();
      else if (d.type === 'device-connect')      onDeviceConnect(d);
      else if (d.type === 'device-progress')     onDeviceProgress(d);
      else if (d.type === 'device-done')         onDeviceDone(d, false);
      else if (d.type === 'device-aborted')      onDeviceDone(d, true);
      else if (d.type === 'device-error')        onDeviceError(d);
      else if (d.type === 'device-state')        onDeviceState(d);
      else if (d.type === 'report-created')      prependReport(d.entry);
      else if (d.type === 'session-terminated')  setTimeout(() => {
        authToken = '';
        sessionStorage.removeItem(STORAGE_KEY);
        if (_expireTimer) { clearTimeout(_expireTimer); _expireTimer = null; }
        showPhoneDialog();
      }, 300); // slight delay so the DELETE response reaches the browser first
    } catch (_) {}
  };
  es.onerror = () => {
    es.close();
    setTimeout(connectSSE, _sseBackoff);
    _sseBackoff = Math.min(_sseBackoff * 2, 15000);
  };
})();
