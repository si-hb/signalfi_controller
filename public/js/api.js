/**
 * REST API calls for SignalFi Control
 */

let authToken = null;

export function setAuthToken(token) {
  authToken = token;
  // sessionStorage: cleared on tab close/refresh; localStorage key removed on upgrade
  if (token) {
    sessionStorage.setItem('signalfi-control-session', token);
  } else {
    sessionStorage.removeItem('signalfi-control-session');
  }
}

export function loadAuthToken() {
  localStorage.removeItem('signalfi-auth-token'); // remove legacy key
  authToken = sessionStorage.getItem('signalfi-control-session') || null;
  return authToken;
}

async function apiFetch(path, options = {}) {
  // Add Authorization header if token is set
  if (authToken) {
    options.headers = options.headers || {};
    options.headers.Authorization = `Bearer ${authToken}`;
  }

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

export function fetchLogEntries(queryString) {
  const suffix = queryString ? `?${queryString}` : '';
  return apiFetch(`/api/log${suffix}`, {
    cache: 'no-store',
  });
}

// Initialize auth token from localStorage on module load
loadAuthToken();
