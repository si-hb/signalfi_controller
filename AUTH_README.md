# Signalfi authentication

Account-based auth across the stack. `signalfi-manifest` is the auth
authority; `signalfi-web` validates tokens against it.

## Architecture

```
                  ┌────────────────┐
                  │ users.json     │  /opt/signalfi/auth/
                  │ (passwords)    │
                  └────────┬───────┘
                           │
                  ┌────────▼─────────┐
                  │ signalfi-manifest│  ← issues sessions, owns CRUD
                  │  /ota/auth/*     │
                  └────────▲─────────┘
                           │ HTTP (60s cache)
                  ┌────────┴─────────┐
                  │ signalfi-web     │  ← validates incoming tokens
                  │  /auth/* (proxy) │
                  └──────────────────┘
                           ▲
                           │
                       browser
                       sessionStorage:
                       signalfi-admin-session
                       signalfi-control-session
```

## User database

Lives at `/opt/signalfi/auth/users.json` on the manifest host
(mode 600, atomic writes via rename). Schema:

```json
{
  "version": 1,
  "users": {
    "<username>": {
      "salt":               "<hex32>",
      "iterations":         210000,
      "keylen":             32,
      "digest":             "sha512",
      "hash":               "<hex64>",
      "permissions": {
        "administrator":  true,
        "webAccess":      true,
        "manifestAccess": true
      },
      "mustChangePassword": false,
      "createdAt":          "ISO-8601",
      "lastLoginAt":        "ISO-8601 | null",
      "passwordChangedAt":  "ISO-8601"
    }
  }
}
```

Hashing: PBKDF2 / sha512 / 210 000 iterations / 32-byte salt / 32-byte
key. `crypto.timingSafeEqual` for compare.

## Permissions

Three flags, any combination, object-of-booleans:

| Flag             | Grants                                           |
|------------------|--------------------------------------------------|
| `administrator`  | Manage user accounts (CRUD via `/ota/auth/users`)|
| `webAccess`      | Sign in to `signalfi-web`                        |
| `manifestAccess` | Sign in to `signalfi-manifest` admin UI          |

The default `admin` user has all three flags.

**Last-admin protection.** Deleting a user, or clearing their
`administrator` flag, is refused (`409 last-admin`) if doing so would
leave zero administrators in the system.

## Bootstrap

On first start, if `users.json` is missing or has no users, manifest
creates `admin` / `admin` with all three flags + `mustChangePassword:
true` and logs:

```
[auth] BOOTSTRAP: default admin/admin created — must be changed on first login
```

The first login forces a password change before any protected route is
accessible.

## Login flow (browser)

1. Browser GETs `/ota/admin` (manifest UI) or `/` (web UI).
2. JS calls `/.../auth/check` with the cached session token (if any).
3. **No token / 401** → login dialog (username + password).
4. Login POST returns `{token, expiresAt, permissions, mustChangePassword}`.
5. **mustChangePassword: true** → forced change-password dialog;
   protected routes return `403 password-change-required` until the
   change succeeds.
6. **!permissions.webAccess** on the web UI → "Access denied" screen.
7. **!permissions.manifestAccess** on the admin UI → 403 from
   `/ota/admin/api/*`; the UI surfaces this as a sign-out prompt.
8. Token cached in `sessionStorage` (cleared on tab close).
   Bearer goes on every REST call; WebSocket sends it as `?token=…`.

## Endpoints (manifest)

Public:

- `POST /ota/auth/login` `{username, password}` → `{token, expiresAt, mustChangePassword, permissions, username}` / 401 / 423 locked

Authenticated (bearer):

- `POST /ota/auth/change-password` `{currentPassword, newPassword}` → `{ok}`
- `POST /ota/auth/logout` → `{ok}`
- `GET  /ota/auth/check` → `{valid, username, permissions, expiresAt, mustChangePassword}`

Administrator-only:

- `DELETE /ota/auth/sessions` → `{cleared:N}`
- `GET    /ota/auth/users` → `{users:[…]}`
- `POST   /ota/auth/users` `{username, password, permissions}` → 201 / 409 exists
- `PATCH  /ota/auth/users/:username` `{password?, permissions?}` → 200 / 409 last-admin
- `DELETE /ota/auth/users/:username` → 200 / 409 last-admin

5 failed logins per username → 15-minute lockout (in-memory, resets on
restart).

## Cross-service validation (web → manifest)

`signalfi-web` does not own user records. On every request:

1. `authClient.checkToken(bearer)` looks up an in-memory cache (60 s TTL).
2. On miss, GETs `${MANIFEST_URL}/ota/auth/check` with the bearer
   forwarded; 2-second timeout.
3. Result cached, gated on `permissions.webAccess`.
4. On manifest logout/role-change, manifest POSTs
   `${CONTROL_SERVER_URL}/auth/invalidate {token}` so the web cache
   evicts the entry within ~2 s rather than waiting for TTL.

If manifest is unreachable, web fails closed (503) — except when
`AIRGAP_NO_AUTH_WEB_FALLBACK=true`, which keeps already-cached entries
alive past TTL until manifest comes back. **Never creates new
sessions.** Recommended only for LAN-only airgap deployments where the
web container needs to keep serving while manifest restarts.

## Environment variables

### Manifest

| Variable                   | Purpose                                              |
|----------------------------|------------------------------------------------------|
| `AUTH_ROOT`                | `/opt/signalfi/auth` (where users.json lives)        |
| `AIRGAP_BOOTSTRAP_RESET`   | `true` → reset users.json to admin/admin on startup  |
| `CONTROL_SERVER_URL`       | URL of signalfi-web for logout fan-out               |
| `SESSION_TTL_MS`           | Default 24 h                                         |
| `ADMIN_TOKEN` (deprecated) | Static bearer that maps to a synthetic admin session |

### Web

| Variable                       | Purpose                                          |
|--------------------------------|--------------------------------------------------|
| `MANIFEST_URL`                 | `http://signalfi-manifest:3001` (auth authority) |
| `AIRGAP_NO_AUTH_WEB_FALLBACK`  | `true` → keep stale cache when manifest is down  |
| `AUTH_TOKEN` (deprecated)      | Static bearer; same role as ADMIN_TOKEN above    |

## Operations

### Recover a lost admin password

`AIRGAP_BOOTSTRAP_RESET=true` (manifest only):

```bash
docker compose stop signalfi-manifest
AIRGAP_BOOTSTRAP_RESET=true docker compose up -d signalfi-manifest
# log line: "AIRGAP_BOOTSTRAP_RESET=true — users.json wiped …"
# log in with admin/admin, change the password, then:
docker compose stop signalfi-manifest
docker compose up -d signalfi-manifest   # without the env var
```

### Audit who has admin

```bash
curl -sH "Authorization: Bearer $TOKEN" \
  https://admin.apis.symphonyinteractive.ca/ota/auth/users | jq
```

### Terminate everyone

Admin UI → "Terminate Sessions", or:

```bash
curl -sX DELETE -H "Authorization: Bearer $TOKEN" \
  https://admin.apis.symphonyinteractive.ca/ota/auth/sessions
```

Both manifest and web caches are cleared; all WS clients receive a
`session-terminated` push.

## Migration from OTP/SMS

Older versions used phone+OTP via a node-red SMS webhook. That flow
has been retired. Existing sessions die at upgrade (in-memory; container
restart already invalidated them). Users hit the new login screen on
their next visit. The `node-red` container is no longer involved in
auth; it remains for unrelated MQTT flows.

`ADMIN_TOKEN` and `AUTH_TOKEN` static-bearer envs remain honoured for
**one release** with a deprecation warning on every use, so existing
`curl -H 'Authorization: Bearer $ADMIN_TOKEN' …` scripts keep working.
Both will be removed in the release after.
