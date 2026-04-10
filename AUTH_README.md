# Signalfi SMS OTP Authentication — Implementation Guide

This document describes how to add the Signalfi SMS OTP authentication system to a new Node.js/Express app running on the same server (`apis.symphonyinteractive.ca`). The Node-RED flows and SMS dispatch infrastructure are already in place — you only need to implement the server-side session logic and client-side UI described here.

---

## How It Works

1. User enters their phone number in a dialog.
2. Your server POSTs the number to the Node-RED `signalfi-auth` endpoint.
3. Node-RED checks a whitelist and, if accepted, sends an SMS with a 6-digit code. Your server gets back a `200 OK` (optionally with a `ttl` field).
4. Your server responds to the browser with `{ accepted: true }` — only if Node-RED returned 200. Otherwise it responds with `{ accepted: false }` (or stays silent). **Never tell the browser why a number was rejected.**
5. If accepted, a code entry dialog appears. The user enters the 6-digit code.
6. Your server validates the code and issues a session token. The browser stores it in `sessionStorage`.
7. On subsequent page loads the browser sends the token to a `/auth/check` endpoint; if valid, the session is restored silently.

---

## Node-RED Endpoint

**URL (internal Docker network):** `http://node-red:1880/signalfi-auth`  
**Method:** `POST`  
**Content-Type:** `application/json`

### Request body

```json
{
  "phone": "+16045550100",
  "code": "123456",
  "origin": "your-app-name"
}
```

| Field | Description |
| --- | --- |
| `phone` | E.164-normalised phone number (e.g. `+16045550100`) |
| `code` | The 6-digit OTP your server generated (Node-RED echoes this back in the SMS) |
| `origin` | Identifies which app is requesting auth — use a short string like `"signalfi-admin"` or `"signalfi-control"`. Appears in Node-RED logs for auditing. |

### Response

| HTTP status | Meaning |
| --- | --- |
| `200 OK` | Phone number is on the whitelist. SMS has been (or will be) sent. |
| Any non-2xx | Phone number not accepted. Do not show a code entry dialog. |

The `200` response body may optionally include:

```json
{ "ttl": 86400 }
```

`ttl` (seconds) overrides the default server-side session lifetime for this phone number. If absent, use your default TTL.

---

## Server Implementation

### Dependencies

Standard Node.js built-ins only: `crypto`, `http`, `https`. No extra packages required.

### Constants

```js
const NODERED_AUTH_URL = process.env.NODERED_AUTH_URL || 'http://node-red:1880/signalfi-auth';
const OTP_TTL_MS       = 5  * 60 * 1000;   // OTP valid for 5 minutes
const SESSION_TTL_MS   = 365 * 24 * 60 * 60 * 1000; // default session lifetime
const OTP_MAX_ATTEMPTS = 5;                 // lock out after N wrong guesses
```

### In-memory stores

```js
// phone → { code, expiresAt, attempts, sessionTtl? }
const otpStore     = new Map();

// token → { phone, expiresAt }
const sessionStore = new Map();
```

Both stores are in-memory. Sessions are lost on server restart (by design — users re-authenticate on next page load anyway since `sessionStorage` is cleared on tab close).

### Phone normalisation helper

```js
function normalisePhone(raw) {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;           // North American shorthand
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return '+' + digits;
}
```

### Session token generator

```js
const crypto = require('crypto');

function genSession() {
  return crypto.randomBytes(32).toString('hex');
}
```

### POST /auth/request

Unguarded (no auth middleware). Call Node-RED asynchronously — respond to the browser immediately.

```js
app.post('/auth/request', express.json(), async (req, res) => {
  const phone = normalisePhone(req.body.phone || '');
  if (!phone) return res.status(400).json({ error: 'phone required' });

  const code = String(Math.floor(100000 + Math.random() * 900000));
  otpStore.set(phone, { code, expiresAt: Date.now() + OTP_TTL_MS, attempts: 0 });

  // Fire-and-forget — do NOT await before responding to the browser
  (async () => {
    try {
      const nr = await fetch(NODERED_AUTH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, code, origin: 'your-app-name' }),
      });
      if (nr.ok) {
        const body = await nr.json().catch(() => ({}));
        if (body.ttl) {
          const entry = otpStore.get(phone);
          if (entry) entry.sessionTtl = body.ttl * 1000;
        }
        console.log(`[auth] Node-RED accepted ${phone}`);
      } else {
        otpStore.delete(phone);   // remove OTP — number not on whitelist
        console.log(`[auth] Node-RED rejected ${phone}: ${nr.status}`);
      }
    } catch (e) {
      otpStore.delete(phone);
      console.error('[auth] Node-RED unreachable:', e.message);
    }
  })();

  // Always respond accepted:true immediately — the client will get a
  // silent failure when it tries to verify if the number was rejected.
  // This prevents timing-based enumeration of valid phone numbers.
  res.json({ accepted: true });
});
```

> **Security note:** Responding `{ accepted: true }` unconditionally before Node-RED replies prevents an attacker from inferring which numbers are on the whitelist via response timing. The OTP entry is deleted from `otpStore` if Node-RED rejects the number, so a subsequent `/auth/verify` call will simply fail.

### POST /auth/verify

```js
app.post('/auth/verify', express.json(), (req, res) => {
  const phone = normalisePhone(req.body.phone || '');
  const code  = (req.body.code || '').trim();

  const entry = otpStore.get(phone);
  if (!entry)                           return res.status(401).json({ error: 'no pending code' });
  if (Date.now() > entry.expiresAt)     { otpStore.delete(phone); return res.status(401).json({ error: 'code expired' }); }
  if (entry.attempts >= OTP_MAX_ATTEMPTS) { otpStore.delete(phone); return res.status(429).json({ error: 'too many attempts' }); }

  entry.attempts++;
  if (entry.code !== code)              return res.status(401).json({ error: 'invalid code' });

  otpStore.delete(phone);

  const token = genSession();
  const ttl   = entry.sessionTtl ?? SESSION_TTL_MS;
  sessionStore.set(token, { phone, expiresAt: Date.now() + ttl });

  res.json({ token, expiresAt: new Date(Date.now() + ttl).toISOString() });
});
```

### GET /auth/check

Called on page load to validate a stored token.

```js
app.get('/auth/check', (req, res) => {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const session = sessionStore.get(bearer);
  if (!session || Date.now() > session.expiresAt)
    return res.status(401).json({ valid: false });
  res.json({ valid: true, expiresAt: new Date(session.expiresAt).toISOString() });
});
```

### Auth middleware

Apply to all protected routes.

```js
function requireAuth(req, res, next) {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const session = sessionStore.get(bearer);
  if (!session || Date.now() > session.expiresAt)
    return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Usage:
app.get('/api/something', requireAuth, (req, res) => { ... });
```

---

## Client Implementation

### Storage

Use `sessionStorage` — this clears automatically when the tab is closed or the page is refreshed, which gives "permanent until refresh" UX without any explicit logout mechanism.

```js
const SESSION_KEY = 'your-app-session';   // choose a unique key

function getToken()        { return sessionStorage.getItem(SESSION_KEY); }
function setToken(t)       { sessionStorage.setItem(SESSION_KEY, t); }
function clearToken()      { sessionStorage.removeItem(SESSION_KEY); }
```

Remove any legacy `localStorage` tokens on load to avoid stale auth state:

```js
localStorage.removeItem('your-app-old-token');  // if migrating from a previous auth system
```

### On page load

```js
async function setupAuth() {
  const token = getToken();
  if (token) {
    const res = await fetch('/auth/check', {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (res.ok) {
      const data = await res.json();
      if (data.valid) {
        scheduleExpiry(data.expiresAt);
        initApp();   // proceed to load the app
        return;
      }
    }
    clearToken();
  }
  showPhoneDialog();
}
```

### Expiry timer

```js
let expiryTimer = null;

function scheduleExpiry(isoString) {
  clearTimeout(expiryTimer);
  const ms = new Date(isoString) - Date.now();
  if (ms > 0) {
    expiryTimer = setTimeout(() => {
      clearToken();
      showPhoneDialog();
    }, ms);
  }
}
```

### Phone dialog

```js
async function submitPhone(phone) {
  const res = await fetch('/auth/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone })
  });
  if (!res.ok) return;   // silent failure
  const data = await res.json();
  if (data.accepted) showCodeDialog();
  // else: stay on phone dialog, no error message
}
```

### Code dialog

```js
async function submitCode(phone, code) {
  const res = await fetch('/auth/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, code })
  });
  if (!res.ok) {
    showError('Invalid code. Please try again.');
    return;
  }
  const data = await res.json();
  setToken(data.token);
  scheduleExpiry(data.expiresAt);
  hideDialogs();
  initApp();
}
```

Auto-submit when the 6th digit is typed:

```js
codeInput.addEventListener('input', () => {
  const digits = codeInput.value.replace(/\D/g, '');
  codeInput.value = digits;
  if (digits.length === 6) submitCode(currentPhone, digits);
});
```

### Authenticated fetch helper

```js
async function apiFetch(url, options = {}) {
  const token = getToken();
  const headers = { ...(options.headers || {}) };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    clearToken();
    showPhoneDialog();
  }
  return res;
}
```

---

## Terminate Sessions (optional)

If you want a "log out all users" button:

### Server — DELETE /auth/sessions

```js
app.delete('/auth/sessions', requireAuth, (req, res) => {
  sessionStore.clear();
  // Notify all connected clients via your push channel (SSE or WebSocket)
  broadcastSessionTerminated();
  res.json({ ok: true });
});
```

### Client — handle forced logout

On the admin panel the push channel is SSE. On the control app it is WebSocket. In either case, when you receive a `session-terminated` event:

```js
// SSE example
evtSource.addEventListener('session-terminated', () => {
  setTimeout(() => {        // small delay so the DELETE response lands first
    clearToken();
    showPhoneDialog();
  }, 300);
});

// WebSocket example
case 'session-terminated':
  clearToken();
  clearTimeout(expiryTimer);
  showPhoneDialog();
  break;
```

---

## Docker Compose Environment Variables

Add these to your service in `docker-compose.yml`:

```yaml
environment:
  - NODERED_AUTH_URL=http://node-red:1880/signalfi-auth
```

Your service must be on the same Docker network as the `node-red` container. On the production server the shared network is `root_default`.

---

## Security Notes

- **No enumeration**: the browser always receives `{ accepted: true }` from `/auth/request` regardless of whether Node-RED accepted the number. An attacker cannot determine which numbers are valid by observing responses.
- **Rate limiting**: Traefik applies a rate limit (5 req/s average, burst 10) to the admin panel router. Add equivalent limits to your Traefik labels if your app is publicly accessible.
- **OTP lockout**: after `OTP_MAX_ATTEMPTS` (5) wrong code entries the OTP entry is deleted. The user must re-request a code.
- **Short OTP lifetime**: codes expire after 5 minutes.
- **sessionStorage**: tokens are not persisted across page refreshes, reducing the window of exposure for stolen tokens.
