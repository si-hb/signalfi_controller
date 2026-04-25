'use strict';

// User database — persisted to AUTH_ROOT/users.json (mode 600).
//
// Schema (version 1):
//   { version: 1, users: { <username>: <UserRecord> } }
//
// UserRecord shape:
//   {
//     salt:               <hex-encoded random bytes, length = 2*saltBytes>
//     iterations:         210000   (PBKDF2 iters; tuned per OWASP 2023 guidance)
//     keylen:             32       (derived-key bytes)
//     digest:             "sha512"
//     hash:               <hex pbkdf2 output>
//     permissions:        { administrator, webAccess, manifestAccess }
//     mustChangePassword: true|false
//     createdAt:          ISO-8601
//     lastLoginAt:        ISO-8601 | null
//     passwordChangedAt:  ISO-8601
//   }
//
// All writes go through atomicWrite() — write-to-tmp + rename — so a
// crash mid-save can't leave a half-written users.json that would
// brick login on the next start.

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const AUTH_ROOT = process.env.AUTH_ROOT || '/opt/signalfi/auth';
const USERS_PATH = path.join(AUTH_ROOT, 'users.json');

const SCHEMA_VERSION = 1;
const PBKDF2_ITERATIONS = 210000;
const PBKDF2_KEYLEN     = 32;
const PBKDF2_DIGEST     = 'sha512';
const SALT_BYTES        = 32;

const PERMISSION_KEYS = ['administrator', 'webAccess', 'manifestAccess'];

const DEFAULT_ADMIN_USERNAME = 'admin';
const DEFAULT_ADMIN_PASSWORD = 'admin';

function ensureAuthRoot() {
  if (!fs.existsSync(AUTH_ROOT)) {
    fs.mkdirSync(AUTH_ROOT, { recursive: true, mode: 0o700 });
  }
}

function atomicWrite(filePath, contents) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, contents, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function nowIso() { return new Date().toISOString(); }

function normalizePermissions(input) {
  // Accept partial input; fill missing keys with false; reject unknown keys
  // silently rather than 400 — admins shouldn't be tripped by client typos.
  const out = {};
  for (const key of PERMISSION_KEYS) {
    out[key] = !!(input && input[key]);
  }
  return out;
}

function hashPassword(password) {
  // pbkdf2Sync is acceptable here: only runs at user creation and
  // password change, both rare events on the timeline of an admin tool.
  // Keeps the API synchronous so userStore stays simple to call.
  const salt = crypto.randomBytes(SALT_BYTES).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST).toString('hex');
  return {
    salt,
    iterations: PBKDF2_ITERATIONS,
    keylen:     PBKDF2_KEYLEN,
    digest:     PBKDF2_DIGEST,
    hash,
  };
}

function verifyPassword(record, password) {
  if (!record || !record.salt || !record.hash) return false;
  const candidate = crypto.pbkdf2Sync(
    password,
    record.salt,
    record.iterations || PBKDF2_ITERATIONS,
    record.keylen     || PBKDF2_KEYLEN,
    record.digest     || PBKDF2_DIGEST,
  );
  const expected = Buffer.from(record.hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

let cache = null; // { version, users: { username: record } }

function loadUsers() {
  if (cache) return cache;
  ensureAuthRoot();
  if (!fs.existsSync(USERS_PATH)) {
    cache = { version: SCHEMA_VERSION, users: {} };
    return cache;
  }
  const raw = fs.readFileSync(USERS_PATH, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.users) {
      throw new Error('users.json missing "users" object');
    }
    cache = parsed;
    return cache;
  } catch (err) {
    // Refuse to silently bootstrap a second admin on top of a corrupt
    // file — operator should look at it before we overwrite.
    throw new Error(`[auth] users.json is unreadable (${err.message}); refusing to overwrite`);
  }
}

function saveUsers() {
  if (!cache) throw new Error('saveUsers() before loadUsers()');
  ensureAuthRoot();
  atomicWrite(USERS_PATH, JSON.stringify(cache, null, 2));
}

// True if calling apply() on the in-memory users would still leave
// at least one administrator.  Used to refuse last-admin demotion or
// deletion before mutating disk.
function wouldLeaveAdmin(apply) {
  const snapshot = JSON.parse(JSON.stringify(cache));
  apply(snapshot);
  return Object.values(snapshot.users).some(u => u.permissions && u.permissions.administrator);
}

function listUsers() {
  loadUsers();
  return Object.entries(cache.users).map(([username, u]) => ({
    username,
    permissions:        normalizePermissions(u.permissions),
    mustChangePassword: !!u.mustChangePassword,
    createdAt:          u.createdAt   || null,
    lastLoginAt:        u.lastLoginAt || null,
    passwordChangedAt:  u.passwordChangedAt || null,
  }));
}

function getUser(username) {
  loadUsers();
  if (!username || typeof username !== 'string') return null;
  return cache.users[username] || null;
}

function recordLogin(username) {
  const u = getUser(username);
  if (!u) return;
  u.lastLoginAt = nowIso();
  saveUsers();
}

function createUser({ username, password, permissions, mustChangePassword = false }) {
  loadUsers();
  if (!username || typeof username !== 'string' || !/^[a-zA-Z0-9._-]{1,64}$/.test(username)) {
    throw Object.assign(new Error('invalid username'), { code: 'invalid-username' });
  }
  if (cache.users[username]) {
    throw Object.assign(new Error('username already exists'), { code: 'exists' });
  }
  const policyErr = passwordPolicyError(username, password);
  if (policyErr) throw Object.assign(new Error(policyErr), { code: 'weak' });

  cache.users[username] = {
    ...hashPassword(password),
    permissions:        normalizePermissions(permissions),
    mustChangePassword: !!mustChangePassword,
    createdAt:          nowIso(),
    lastLoginAt:        null,
    passwordChangedAt:  nowIso(),
  };
  saveUsers();
}

function updateUser(username, { password, permissions } = {}) {
  loadUsers();
  const u = cache.users[username];
  if (!u) throw Object.assign(new Error('not found'), { code: 'not-found' });

  if (permissions !== undefined) {
    const next = normalizePermissions(permissions);
    if (u.permissions && u.permissions.administrator && !next.administrator) {
      // Refuse to drop the last administrator.
      const ok = wouldLeaveAdmin(s => { s.users[username].permissions = next; });
      if (!ok) throw Object.assign(new Error('cannot remove last administrator'), { code: 'last-admin' });
    }
    u.permissions = next;
  }

  if (password !== undefined) {
    const policyErr = passwordPolicyError(username, password);
    if (policyErr) throw Object.assign(new Error(policyErr), { code: 'weak' });
    Object.assign(u, hashPassword(password));
    u.mustChangePassword = false;
    u.passwordChangedAt  = nowIso();
  }

  saveUsers();
}

function deleteUser(username) {
  loadUsers();
  if (!cache.users[username]) {
    throw Object.assign(new Error('not found'), { code: 'not-found' });
  }
  if (cache.users[username].permissions && cache.users[username].permissions.administrator) {
    const ok = wouldLeaveAdmin(s => { delete s.users[username]; });
    if (!ok) throw Object.assign(new Error('cannot delete last administrator'), { code: 'last-admin' });
  }
  delete cache.users[username];
  saveUsers();
}

// LAN admin tool — minimum 8 chars, must differ from username.  Anything
// stricter just trains operators to write passwords on sticky notes.
function passwordPolicyError(username, password) {
  if (typeof password !== 'string' || password.length < 8) return 'password must be at least 8 characters';
  if (password === username)                                return 'password must differ from username';
  return null;
}

// Bootstrap: called from server.js on startup.  Creates the default
// admin/admin user on a fresh install (or when AIRGAP_BOOTSTRAP_RESET
// is true, wholesale resets users.json to that single user).  Logs
// loudly so the boot output makes the credentials visible to ops.
function bootstrapIfNeeded({ forceReset = false } = {}) {
  ensureAuthRoot();

  if (forceReset) {
    cache = { version: SCHEMA_VERSION, users: {} };
    cache.users[DEFAULT_ADMIN_USERNAME] = {
      ...hashPassword(DEFAULT_ADMIN_PASSWORD),
      permissions:        normalizePermissions({ administrator: true, webAccess: true, manifestAccess: true }),
      mustChangePassword: true,
      createdAt:          nowIso(),
      lastLoginAt:        null,
      passwordChangedAt:  nowIso(),
    };
    saveUsers();
    console.log('[auth] AIRGAP_BOOTSTRAP_RESET=true — users.json wiped and reseeded with default admin/admin (must change on first login)');
    return { reset: true };
  }

  loadUsers();
  if (Object.keys(cache.users).length === 0) {
    cache.users[DEFAULT_ADMIN_USERNAME] = {
      ...hashPassword(DEFAULT_ADMIN_PASSWORD),
      permissions:        normalizePermissions({ administrator: true, webAccess: true, manifestAccess: true }),
      mustChangePassword: true,
      createdAt:          nowIso(),
      lastLoginAt:        null,
      passwordChangedAt:  nowIso(),
    };
    saveUsers();
    console.log('[auth] BOOTSTRAP: default admin/admin created — must be changed on first login');
    return { bootstrapped: true };
  }
  return { existing: true };
}

module.exports = {
  PERMISSION_KEYS,
  bootstrapIfNeeded,
  loadUsers,
  listUsers,
  getUser,
  recordLogin,
  createUser,
  updateUser,
  deleteUser,
  hashPassword,
  verifyPassword,
  passwordPolicyError,
  normalizePermissions,
};
