'use strict';

// Auth middleware for signalfi-manifest.
//
// Sessions live in an in-memory Map (one per process; restart is the
// universal logout).  Each session carries the username and a snapshot
// of the user's permissions at login time.  Permission changes are
// applied in real-time by sessionsForUser() — see updateSessionsForUser
// — so an admin demotion takes effect on the next request without
// requiring the demoted user to re-log-in.
//
// Web's authClient calls into here over HTTP via the /ota/auth/check
// endpoint (defined in server.js).  When manifest invalidates a token
// (logout, delete user) it calls forwardLogoutToWeb() so the web side
// can purge its 60-second cache entry immediately.

const crypto = require('crypto');
const userStore = require('./userStore');

const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS || String(24 * 60 * 60 * 1000), 10); // 24h
const FAILED_LOGIN_LIMIT  = 5;
const FAILED_LOGIN_LOCKOUT_MS = 15 * 60 * 1000;

// token -> { username, permissions, expiresAt, mustChangePassword }
const sessionStore = new Map();

// username -> { count, until } — failed logins per username
const failedLogins = new Map();

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || null;

const ts = () => new Date().toISOString();

function genToken() {
  return crypto.randomBytes(32).toString('hex');
}

function pruneExpired() {
  const now = Date.now();
  for (const [token, sess] of sessionStore.entries()) {
    if (sess.expiresAt < now) sessionStore.delete(token);
  }
  for (const [user, info] of failedLogins.entries()) {
    if (info.until < now) failedLogins.delete(user);
  }
}
setInterval(pruneExpired, 60 * 1000).unref();

function isLockedOut(username) {
  const info = failedLogins.get(username);
  return info && info.count >= FAILED_LOGIN_LIMIT && info.until > Date.now();
}

function recordFailedLogin(username) {
  const now = Date.now();
  let info = failedLogins.get(username);
  if (!info || info.until < now) info = { count: 0, until: now + FAILED_LOGIN_LOCKOUT_MS };
  info.count++;
  info.until = now + FAILED_LOGIN_LOCKOUT_MS;
  failedLogins.set(username, info);
}

function clearFailedLogins(username) {
  failedLogins.delete(username);
}

function createSession(username) {
  const u = userStore.getUser(username);
  if (!u) throw new Error('createSession: unknown user');
  const token     = genToken();
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessionStore.set(token, {
    username,
    permissions:        userStore.normalizePermissions(u.permissions),
    expiresAt,
    mustChangePassword: !!u.mustChangePassword,
  });
  return { token, expiresAt };
}

function getSession(token) {
  if (!token) return null;
  const sess = sessionStore.get(token);
  if (!sess) return null;
  if (sess.expiresAt < Date.now()) {
    sessionStore.delete(token);
    return null;
  }
  // Refresh permissions snapshot from disk on every lookup so admin
  // demotions take effect without forcing the user to log out.  Cheap
  // — userStore is in-memory once loaded.
  const u = userStore.getUser(sess.username);
  if (!u) {
    sessionStore.delete(token);
    return null;
  }
  sess.permissions        = userStore.normalizePermissions(u.permissions);
  sess.mustChangePassword = !!u.mustChangePassword;
  return sess;
}

function destroySession(token) {
  if (sessionStore.has(token)) {
    sessionStore.delete(token);
    return true;
  }
  return false;
}

function destroyAllSessions() {
  const n = sessionStore.size;
  sessionStore.clear();
  return n;
}

// Clear every session *except* the one identified by `keepToken`.
// Used by "Terminate Other Sessions" so the administrator triggering
// the action stays signed in instead of kicking themselves out along
// with everyone else.
function destroyAllSessionsExcept(keepToken) {
  let cleared = 0;
  for (const token of [...sessionStore.keys()]) {
    if (token === keepToken) continue;
    sessionStore.delete(token);
    cleared++;
  }
  return cleared;
}

function destroySessionsForUser(username) {
  // Only used when a user is deleted — kill any sessions they hold so
  // a stale token can't keep working until its TTL expires.
  const tokens = [];
  for (const [token, sess] of sessionStore.entries()) {
    if (sess.username === username) tokens.push(token);
  }
  for (const token of tokens) sessionStore.delete(token);
  return tokens;
}

function listActiveSessionTokens() {
  return [...sessionStore.keys()];
}

function bearerOf(req) {
  const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/);
  return m ? m[1] : null;
}

// Synthetic admin session for the deprecated ADMIN_TOKEN escape hatch.
// Logs every use so ops know to migrate scripts to a real account.
let warnedAdminToken = false;
function adminTokenSession() {
  if (!warnedAdminToken) {
    console.warn(`[${ts()}] [auth] DEPRECATED: ADMIN_TOKEN bearer used. Migrate to a per-user account; ADMIN_TOKEN will be removed in the next release.`);
    warnedAdminToken = true;
  }
  return {
    username: '__admin_token__',
    permissions:        { administrator: true, webAccess: true, manifestAccess: true },
    expiresAt:          Date.now() + 60 * 1000, // short — caller resolves it again next request
    mustChangePassword: false,
  };
}

// requireAuth — bearer token must resolve to a live session or to the
// deprecated ADMIN_TOKEN.  Attaches req.user.  Does NOT enforce
// mustChangePassword or any permission flag — that's the next layer.
function requireAuth(req, res, next) {
  const bearer = bearerOf(req);
  if (!bearer) return res.status(401).json({ error: 'auth required' });

  if (ADMIN_TOKEN && bearer === ADMIN_TOKEN) {
    req.user = adminTokenSession();
    req.isAdminToken = true;
    return next();
  }

  const sess = getSession(bearer);
  if (!sess) return res.status(401).json({ error: 'invalid token' });
  req.user  = sess;
  req.token = bearer;
  return next();
}

// Caller has logged in but mustChangePassword is set — they're
// allowed to call /ota/auth/change-password and nothing else.
function requireFreshPassword(req, res, next) {
  if (req.user && req.user.mustChangePassword) {
    return res.status(403).json({ error: 'password-change-required' });
  }
  return next();
}

function requirePermission(flag) {
  return (req, res, next) => {
    if (!req.user || !req.user.permissions || !req.user.permissions[flag]) {
      return res.status(403).json({ error: `requires ${flag}` });
    }
    return next();
  };
}

// Manifest tells web "this token just got revoked" so web's 60-second
// validate-cache can drop the entry immediately rather than waiting
// for the next miss.  Best-effort: if web is down, the token still
// becomes useless via the in-memory sessionStore here.
async function forwardLogoutToWeb(token, { all = false } = {}) {
  const url = process.env.CONTROL_SERVER_URL;
  if (!url) return;
  const target = `${url}/auth/invalidate`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(all ? { all: true } : { token }),
      signal:  ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) console.warn(`[${ts()}] [auth] forwardLogoutToWeb ${target} returned ${res.status}`);
  } catch (err) {
    console.warn(`[${ts()}] [auth] forwardLogoutToWeb ${target} failed: ${err.message}`);
  }
}

module.exports = {
  // session lifecycle
  createSession,
  getSession,
  destroySession,
  destroyAllSessions,
  destroyAllSessionsExcept,
  destroySessionsForUser,
  listActiveSessionTokens,

  // login throttling
  isLockedOut,
  recordFailedLogin,
  clearFailedLogins,
  FAILED_LOGIN_LIMIT,
  FAILED_LOGIN_LOCKOUT_MS,
  SESSION_TTL_MS,

  // express middleware
  requireAuth,
  requireFreshPassword,
  requirePermission,

  // helpers
  bearerOf,
  forwardLogoutToWeb,
};
