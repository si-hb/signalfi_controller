# Deploying a New App to apis.symphonyinteractive.ca

This document explains how to add a new containerised service to the existing production server. It is written for an agent implementing a new app that needs to sit alongside the existing Signalfi stack.

**Do not modify the root compose or Traefik config directly** unless you are adding a service to `/root/docker-compose.yml`. Read the entire document first to decide which deployment path applies to your app.

---

## Server Overview

**Host:** `apis.symphonyinteractive.ca`  
**OS:** Linux (Debian/Ubuntu), accessible via SSH as `root`  
**Reverse proxy:** Traefik v3, ports 80/443  
**Docker network (shared):** `root_default`

### Running services

| Container name | Image | Internal port | Public URL |
| --- | --- | --- | --- |
| `root-traefik-1` | `traefik:v3` | 80, 443 | — (the proxy itself) |
| `node-red` | `nodered/node-red` | 1880 | `weather.apis.symphonyinteractive.ca` |
| `root-mosquitto-1` | `eclipse-mosquitto:2` | 1883, 9001 | public ports 1883/9001 |
| `signalfi-manifest` | custom Node.js | 3001 | `admin.apis.symphonyinteractive.ca` + `apis.symphonyinteractive.ca/ota` |
| `signalfi-files` | `nginx:alpine` | 80 | `apis.symphonyinteractive.ca/ota/v1/firmware`, `/audio`, `/config` |
| `sftpgo` | `drakkan/sftpgo` | 2022 | public port 2222 (SFTP) |
| `signalfi_controller-signalfi-web-1` | custom Node.js | 3000 | `signalfi.apis.symphonyinteractive.ca` |

### Compose files

There are two compose files on the server — do not confuse them:

| Path | Project name | Purpose |
| --- | --- | --- |
| `/root/docker-compose.yml` | `root` | Main infra: Traefik, Node-RED, Mosquitto, signalfi-manifest, signalfi-files, sftpgo |
| `/opt/signalfi_controller/compose.yml` | `signalfi_controller` | signalfi-web (control panel) — separate repo, attaches to `root_default` |

New apps follow the same pattern as `signalfi_controller`: **create your own compose file in your own directory, attach to `root_default`**. Do not add your service to `/root/docker-compose.yml` unless it is core infrastructure.

---

## Docker Networking

All services that need to be reached by Traefik or by other services must join `root_default`. This network is defined as external — it already exists and you just reference it.

```yaml
# In your compose file
networks:
  root_default:
    external: true
```

Then add it to your service:

```yaml
services:
  my-app:
    ...
    networks:
      - root_default
```

If your app has internal services that only need to talk to each other (e.g. an app + sidecar database), you can also define a private `default` network and add the public-facing container to both:

```yaml
services:
  my-app:
    networks:
      - default       # private, for internal service-to-service
      - root_default  # shared, for Traefik + inter-service calls

networks:
  default: {}
  root_default:
    external: true
```

This is exactly how `signalfi_controller` is set up — `signalfi-web` is on both `signalfi_controller_default` (private) and `root_default` (shared).

### Reaching other services from inside your container

Once on `root_default`, containers resolve each other by container name:

| What you want to reach | Internal URL |
| --- | --- |
| Node-RED auth endpoint | `http://node-red:1880/signalfi-auth` |
| Mosquitto MQTT broker | `mqtt://mosquitto:1883` |
| signalfi-manifest (OTA/admin API) | `http://signalfi-manifest:3001` |
| signalfi-web (control server) | `http://signalfi_controller-signalfi-web-1:3000` |

> **Container name format:** Docker Compose names containers `<project>-<service>-<N>`. The `root` project uses explicit `container_name:` overrides (e.g. `container_name: node-red`) which is why those names are short. If your compose file does not set `container_name:`, your service will be named `<yourproject>-<servicename>-1`.

---

## Traefik Configuration

Traefik discovers services via Docker labels. You do not edit any Traefik config files — everything is in your container's labels.

### How Traefik is configured

```
providers.docker.network    = root_default
providers.docker.exposedbydefault = false   ← must set traefik.enable=true
entrypoints.web             = :80
entrypoints.websecure       = :443
certificatesresolvers.letsencrypt  (HTTP-01 challenge via :80)
providers.file.directory    = /etc/traefik/dynamic  → /root/traefik-dynamic/
```

The file provider watches `/root/traefik-dynamic/` and reloads on change without a Traefik restart. Currently it only contains `tls.yml` (the custom Signalfi PKI cert). You should not need to touch this.

### Minimum required labels

Every service exposed via Traefik needs at minimum:

```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.<name>-https.rule=Host(`yourapp.apis.symphonyinteractive.ca`)"
  - "traefik.http.routers.<name>-https.entrypoints=websecure"
  - "traefik.http.routers.<name>-https.tls.certresolver=letsencrypt"
  - "traefik.http.routers.<name>-https.service=<name>"
  - "traefik.http.services.<name>.loadbalancer.server.port=<port>"
```

Replace `<name>` with a short unique identifier (e.g. `myapp`) — it must not collide with any existing router or service name on the server. See the existing names in use below.

### Existing router/service names (do not reuse)

| Name | Owned by |
| --- | --- |
| `signalfi-http`, `signalfi-https`, `signalfi` | signalfi-web |
| `signalfi-manifest-http`, `signalfi-manifest-https`, `signalfi-manifest` | signalfi-manifest (OTA paths) |
| `signalfi-admin-http`, `signalfi-admin-https` | signalfi-manifest (admin subdomain) |
| `signalfi-files-http`, `signalfi-files` | signalfi-files (nginx) |
| `nodered-http`, `nodered-https`, `nodered-apis-http`, `nodered` | node-red |
| `redirect-https` | defined in signalfi-web labels — shared middleware |
| `signalfi-ratelimit` | signalfi-web rate limiter |
| `admin-ratelimit` | signalfi-manifest rate limiter |

---

## Complete Label Template (HTTPS + redirect + rate limit)

This is the full pattern used by all existing apps on this server. Copy it and replace the three placeholders:

- `<name>` — short unique identifier for your app (e.g. `myapp`)
- `<subdomain>` — desired hostname (e.g. `myapp.apis.symphonyinteractive.ca`)
- `<port>` — the port your app listens on inside the container

```yaml
labels:
  - "traefik.enable=true"

  # ── HTTPS router (primary) ─────────────────────────────────────────────
  - "traefik.http.routers.<name>-https.rule=Host(`<subdomain>`)"
  - "traefik.http.routers.<name>-https.entrypoints=websecure"
  - "traefik.http.routers.<name>-https.tls.certresolver=letsencrypt"
  - "traefik.http.routers.<name>-https.middlewares=<name>-ratelimit"
  - "traefik.http.routers.<name>-https.service=<name>"

  # ── HTTP router — redirects to HTTPS ──────────────────────────────────
  - "traefik.http.routers.<name>-http.rule=Host(`<subdomain>`)"
  - "traefik.http.routers.<name>-http.entrypoints=web"
  - "traefik.http.routers.<name>-http.middlewares=redirect-https"

  # ── Service ────────────────────────────────────────────────────────────
  - "traefik.http.services.<name>.loadbalancer.server.port=<port>"

  # ── Rate limiter (adjust values to suit your threat model) ────────────
  - "traefik.http.middlewares.<name>-ratelimit.ratelimit.average=20"
  - "traefik.http.middlewares.<name>-ratelimit.ratelimit.burst=40"
  - "traefik.http.middlewares.<name>-ratelimit.ratelimit.period=1s"
```

**Rate limit guidance:**
- `20 req/s avg, burst 40` — signalfi-web (control panel, real-time WebSocket traffic)
- `5 req/s avg, burst 10` — signalfi-manifest admin (auth-protected, brute-force risk)
- For a new human-facing app, `10/20` is a reasonable starting point; for an API that devices poll, match to expected device count × poll interval

**The `redirect-https` middleware** (`redirect-https@docker`) is already defined in the signalfi-web container's labels and is therefore available server-wide as `redirect-https@docker`. You can use it directly in your HTTP router — you do not need to redefine it. The `@docker` suffix tells Traefik to look up the middleware by its Docker label origin.

---

## DNS

Before deploying, add a DNS A record for your subdomain pointing to the server's IP. Let's Encrypt will not issue a certificate until the DNS record is live and propagated.

```
<subdomain>.apis.symphonyinteractive.ca  A  <server IP>
```

You can find the server IP with:

```bash
ssh apis.symphonyinteractive.ca "curl -s ifconfig.me"
```

Let's Encrypt issues the certificate automatically on first HTTPS request after the container starts, as long as port 80 is reachable from the public internet (it is — Traefik owns :80).

---

## Full Compose File Example

Save this to `/opt/<yourapp>/compose.yml` on the server. Clone your repo there first, or copy the compose file and build context manually.

```yaml
services:
  my-app:
    build: .
    container_name: my-app
    restart: unless-stopped
    expose:
      - 3000           # internal only — Traefik routes to this
    environment:
      - NODERED_AUTH_URL=http://node-red:1880/signalfi-auth
      - NODE_ENV=production
    volumes:
      - ./data:/app/data
    networks:
      - default
      - root_default
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.myapp-https.rule=Host(`myapp.apis.symphonyinteractive.ca`)"
      - "traefik.http.routers.myapp-https.entrypoints=websecure"
      - "traefik.http.routers.myapp-https.tls.certresolver=letsencrypt"
      - "traefik.http.routers.myapp-https.middlewares=myapp-ratelimit"
      - "traefik.http.routers.myapp-https.service=myapp"
      - "traefik.http.routers.myapp-http.rule=Host(`myapp.apis.symphonyinteractive.ca`)"
      - "traefik.http.routers.myapp-http.entrypoints=web"
      - "traefik.http.routers.myapp-http.middlewares=redirect-https"
      - "traefik.http.services.myapp.loadbalancer.server.port=3000"
      - "traefik.http.middlewares.myapp-ratelimit.ratelimit.average=10"
      - "traefik.http.middlewares.myapp-ratelimit.ratelimit.burst=20"
      - "traefik.http.middlewares.myapp-ratelimit.ratelimit.period=1s"
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s

networks:
  default: {}
  root_default:
    external: true
```

---

## Deployment Steps

1. **Add DNS A record** for your subdomain. Wait for propagation before proceeding.

2. **SSH to the server and create your app directory:**
   ```bash
   ssh apis.symphonyinteractive.ca
   mkdir -p /opt/myapp
   cd /opt/myapp
   git clone <your-repo-url> .   # or copy files another way
   ```

3. **Create `.env` if your app needs secrets:**
   ```bash
   cp .env.example .env
   nano .env
   ```

4. **Start the container:**
   ```bash
   docker compose up -d --build
   ```

5. **Verify Traefik picked it up:**
   ```bash
   # Check the container is running and on root_default
   docker ps | grep my-app
   docker network inspect root_default | grep my-app

   # Traefik logs (shows router registration)
   docker logs root-traefik-1 --tail 30
   ```

6. **Test HTTPS:**
   ```bash
   curl -I https://myapp.apis.symphonyinteractive.ca/health
   ```
   The first request triggers Let's Encrypt issuance — allow up to 30 seconds.

7. **Verify HTTP redirects to HTTPS:**
   ```bash
   curl -I http://myapp.apis.symphonyinteractive.ca/
   # Expect: HTTP/1.1 301 Moved Permanently + Location: https://...
   ```

---

## Redeployment (after code changes)

From your app directory on the server:

```bash
git pull
docker compose up -d --build --no-deps --force-recreate my-app
```

The `--no-deps` flag prevents accidentally recreating other services. `--force-recreate` ensures the new image is used even if the compose config hasn't changed.

To automate this from a local dev machine (same pattern as `deploy.sh` in signalfi_controller):

```bash
ssh apis.symphonyinteractive.ca \
  "cd /opt/myapp && git pull && docker compose up -d --build --no-deps --force-recreate my-app"
```

---

## Accessing Other Services

### Node-RED auth

See `AUTH_README.md` for the full SMS OTP implementation guide. The endpoint from inside your container is:

```
POST http://node-red:1880/signalfi-auth
```

Your container must be on `root_default` for this to resolve.

### MQTT (Mosquitto)

```
mqtt://mosquitto:1883
```

Credentials are required — use the same service account (`signalfi-svc` / `OtaService2024!`) or ask for a new account to be added to the Mosquitto password file. To add one:

```bash
ssh apis.symphonyinteractive.ca \
  "docker exec root-mosquitto-1 mosquitto_passwd /mosquitto/config/pass.txt <username>"
# Enter password when prompted, then restart:
docker compose -f /root/docker-compose.yml restart mosquitto
```

### signalfi-manifest (admin/OTA API)

```
http://signalfi-manifest:3001
```

Requires the `ADMIN_TOKEN` header (`signalfiadmin2026`) for admin endpoints, or a device bearer token for OTA endpoints.

### signalfi-web (control server)

```
http://signalfi_controller-signalfi-web-1:3000
```

This is how `signalfi-manifest` calls the control server's `DELETE /auth/sessions` endpoint for the terminate-sessions flow. Only internal endpoints are reachable this way — Traefik does not expose this path publicly.

---

## Path-Based Routing (if you need it)

If your app should live under a path on an existing hostname (e.g. `apis.symphonyinteractive.ca/mypath`) rather than its own subdomain, use `PathPrefix` in your rule and set a `priority` to avoid ambiguity with existing routes:

```yaml
- "traefik.http.routers.myapp-https.rule=Host(`apis.symphonyinteractive.ca`) && PathPrefix(`/mypath`)"
- "traefik.http.routers.myapp-https.priority=15"
```

Existing path priorities on `apis.symphonyinteractive.ca`:
- `signalfi-manifest` — priority 10 (handles `/ota`)
- `signalfi-files` — priority 20 (handles `/ota/v1/firmware`, `/ota/v1/audio`, `/ota/v1/config`)
- `node-red` — no priority set, matches `/weather`, `/symphony`, `/home/crittercam`, `/voipms`

Choose a priority that does not conflict. Higher number wins when two rules would otherwise match the same request.

For a new path that does not overlap with any of the above, no priority is needed.

---

## TLS Notes

There are two TLS mechanisms on this server:

| Mechanism | Used for | How |
| --- | --- | --- |
| Let's Encrypt (ACME) | Public subdomains accessed by browsers | `tls.certresolver=letsencrypt` in router label |
| Signalfi custom PKI cert | `apis.symphonyinteractive.ca` (OTA paths used by Teensy devices) | Static cert in `/root/certs/` loaded via `/root/traefik-dynamic/tls.yml` |

**Use Let's Encrypt** for any new subdomain. Add `tls.certresolver=letsencrypt` to your HTTPS router label — that is all that is required. Traefik handles renewal automatically.

The custom PKI cert is used only for the `apis.symphonyinteractive.ca` hostname (the OTA endpoints that Teensy devices call, which trust the Signalfi root CA rather than the browser root store). Do not assign the custom cert to a new subdomain — it will not be trusted by browsers.

---

## What Not to Touch

| File / resource | Why |
| --- | --- |
| `/root/docker-compose.yml` | Core infra — Traefik, Node-RED, Mosquitto, sftpgo. Modifying it risks taking down all services. Only add a service here if it truly belongs to the shared infrastructure layer. |
| `/root/traefik-dynamic/tls.yml` | Custom Signalfi PKI cert config. Do not edit unless changing the certificate. |
| `/root/acme.json` | Let's Encrypt certificate storage. Never edit or delete — this file holds all issued certs. |
| `/root/certs/` | Private key for the Signalfi custom cert. Leave alone. |
| `/opt/signalfi/compose/compose.yml` | Legacy infra compose for signalfi-files and signalfi-sftp (separate stack). This file is being superseded by `/root/docker-compose.yml`; do not run `docker compose up` against it. |
| `root_default` network | Do not delete or recreate — all services depend on it. |
