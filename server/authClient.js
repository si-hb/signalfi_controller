'use strict';

// authClient — signalfi-web's verifier of session tokens issued by
// signalfi-manifest.  Web does not store user records; on every
// authenticated request it asks manifest "is this token still valid,
// and does its user have webAccess?" and caches the answer.
//
// Cache:
//   - LRU-ish: in-memory Map; entries dropped on TTL expiry by a 60s sweep
//   - TTL 60s — short enough that role/password changes propagate, long
//     enough that a tight WS reconnect loop doesn't hammer manifest.
//   - Manifest pushes invalidate(token) on logout/role-change for
//     near-instant revocation; the cache is the slow path.
//
// AIRGAP_NO_AUTH_WEB_FALLBACK=true:
//   - If manifest is unreachable for >30s, already-cached entries can
//     extend past their normal TTL (kept until manifest comes back).
//   - Never creates new sessions, never lets in unauthenticated users.
//   - Useful for LAN deployments where the manifest container may
//     restart while the web container keeps serving.

const MANIFEST_URL = process.env.MANIFEST_URL || 'http://signalfi-manifest:3001';
const VALIDATE_PATH = '/ota/auth/check';
const CACHE_TTL_MS  = 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 2000;
const FALLBACK_GRACE_MS   = 30 * 1000;

const AIRGAP_NO_AUTH_WEB_FALLBACK =
  process.env.AIRGAP_NO_AUTH_WEB_FALLBACK === 'true' ||
  process.env.AIRGAP_NO_AUTH_WEB_FALLBACK === '1';

// token -> { result:{valid, username, permissions, ...}, cachedUntil, lastSeen }
const cache = new Map();

let lastUpstreamOkAt = Date.now();

function ts() { return new Date().toISOString(); }

setInterval(() => {
  const now = Date.now();
  for (const [tok, entry] of cache.entries()) {
    // Hard expiry: 5 * TTL — keeps fallback entries from living forever.
    if (entry.cachedUntil + 4 * CACHE_TTL_MS < now) cache.delete(tok);
  }
}, CACHE_TTL_MS).unref();

async function callUpstream(token) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(`${MANIFEST_URL}${VALIDATE_PATH}`, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal:  ctrl.signal,
    });
    if (res.status === 401) {
      lastUpstreamOkAt = Date.now();
      return { valid: false, status: 401 };
    }
    if (!res.ok) {
      // 5xx etc — treat as upstream failure for fallback purposes.
      return { valid: false, status: res.status, upstreamError: true };
    }
    const data = await res.json();
    lastUpstreamOkAt = Date.now();
    return { ...data, valid: true };
  } catch (err) {
    return { valid: false, upstreamError: true, error: err.message };
  } finally {
    clearTimeout(t);
  }
}

// checkToken(bearer) → { valid:true, username, permissions, ... }
//                    | { valid:false, status, upstreamError? }
async function checkToken(token) {
  if (!token) return { valid: false, status: 401 };

  const cached = cache.get(token);
  const now = Date.now();
  if (cached && cached.cachedUntil > now) {
    return cached.result;
  }

  const result = await callUpstream(token);

  if (result.upstreamError) {
    // If we have a stale cache entry and fallback is enabled (and we
    // were last successful within the grace window), keep using the
    // stale entry.  Otherwise, fail closed with 503.
    if (AIRGAP_NO_AUTH_WEB_FALLBACK && cached && (now - lastUpstreamOkAt) < FALLBACK_GRACE_MS) {
      console.warn(`[${ts()}] [authClient] manifest unreachable; using stale cache for token`);
      return cached.result;
    }
    if (cached && cached.result.valid) {
      // Slightly more permissive within the grace window even without
      // the fallback flag: a 2 s blip shouldn't kill in-flight requests.
      if ((now - lastUpstreamOkAt) < 5000) return cached.result;
    }
    return { valid: false, status: 503, upstreamError: true };
  }

  cache.set(token, { result, cachedUntil: now + CACHE_TTL_MS, lastSeen: now });
  return result;
}

function invalidate(token) {
  if (!token) return;
  cache.delete(token);
}

function invalidateAll() {
  cache.clear();
}

module.exports = {
  checkToken,
  invalidate,
  invalidateAll,
  MANIFEST_URL,
};
