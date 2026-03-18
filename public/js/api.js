/**
 * REST API calls for SignalFi Control
 */

async function apiFetch(path, options = {}) {
  const resp = await fetch(path, options);
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    throw new Error(`API error ${resp.status}: ${text}`);
  }
  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    return resp.json();
  }
  return resp.text();
}

export function fetchState() {
  return apiFetch('/api/state');
}

export function fetchAudio() {
  return apiFetch('/api/audio');
}

export function savePreset(preset) {
  return apiFetch('/api/presets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(preset),
  });
}

export function deletePreset(name) {
  return apiFetch(`/api/presets/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
}

export function resetNodes() {
  return apiFetch('/api/scouts/reset-nodes', {
    method: 'POST',
  });
}

export function flushOffline() {
  return apiFetch('/api/scouts/flush-offline', {
    method: 'POST',
  });
}
