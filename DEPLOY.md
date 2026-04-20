# Signalfi — Deployment

Everything needed to stand up a fresh Signalfi remote server lives in this
repo. Two scripts drive it:

- [setup.sh](setup.sh) — idempotent first-time init, run once on the remote
  itself. Creates directories, Docker network, ACME store, and syncs infra
  configs into `/root/`. Safe to re-run to repair drift.
- [deploy.sh](deploy.sh) — run from your workstation. Wraps `setup.sh` and
  handles day-to-day updates to app services and infra configs.

## Layout

```
workstation (this repo)                   →  remote server
────────────────────────────────────────────────────────────────────────
compose.yml                               →  /opt/signalfi_controller/compose.yml
.env.example                              →  /opt/signalfi_controller/.env  (created by you)
setup.sh                                  →  /opt/signalfi_controller/setup.sh
https_file_server/docker-compose.yml      →  /root/docker-compose.yml
https_file_server/config/mosquitto.conf   →  /root/config/mosquitto.conf
https_file_server/traefik-dynamic/tls.yml →  /root/traefik-dynamic/tls.yml
https_file_server/nginx.conf              →  /root/nginx-ota.conf
https_file_server/sftpgo/init-data.json   →  /root/sftpgo-init.json
https_file_server/certs/signalfi-web.*    →  /root/certs/
```

Data volumes on the remote (created by `setup.sh` if missing):

- `/opt/signalfi/files/{firmware,audio,general}` — upload storage
- `/opt/signalfi/manifests/{models,devices}` — per-device OTA manifests
- `/opt/signalfi/tokens` — per-device bearer tokens
- `/opt/signalfi/reports/updates.log` — OTA outcome log
- `/opt/signalfi/configs/{models,devices}` — device config snapshots
- Docker named: `mqtt-broker-data`, `node_red_data`, `sftpgo-state`
- `/root/acme.json` — Let's Encrypt cert store (chmod 600)

## Fresh server

```bash
# One-time: populate .env (at minimum MQTT_USERS — used to generate pass.txt)
cp .env.example .env && $EDITOR .env

REMOTE_TARGET=new.example.com ./deploy.sh stack
```

`stack` runs, in order:

1. `git clone` the repo to `/opt/signalfi_controller`
2. `scp` your local `.env`
3. `setup.sh` on the remote: creates dirs, network, acme.json, generates
   Mosquitto `pass.txt` from `MQTT_USERS`, copies all infra configs to `/root`
4. `docker compose up -d --build` in `/root` (infra stack)
5. `docker compose up -d --build` in `/opt/signalfi_controller` (app stack)

## Day-to-day deploys

```bash
./deploy.sh web        # rebuild signalfi-web
./deploy.sh manifest   # sync infra configs + rebuild signalfi-manifest
./deploy.sh app        # both app services
./deploy.sh infra      # apply Traefik / Mosquitto / nginx changes
```

Every target that touches infra (`manifest`, `app`, `infra`, `stack`) rsyncs
the `INFRA_FILES` listed at the top of `deploy.sh` to `/root` before
restarting containers — this is what prevents the silent drift between local
`https_file_server/docker-compose.yml` and the remote `/root/docker-compose.yml`
that caused earlier deploys to "not apply" config changes.

## Publishing images for air-gap installs

The separate [`signalfi-airgap`][airgap] project (runs on a customer Linux
host, no internet) pulls `duckminster/signalfi-web` and
`duckminster/signalfi-manifest` from Docker Hub instead of building them
locally. `publish.sh` at the root of this repo is what puts them there.

### One-time setup (once per workstation)

1. **Docker Hub login** — use a Personal Access Token, not your account
   password:

   ```bash
   docker login -u duckminster
   ```

2. **Create the two repos on Docker Hub** at
   [hub.docker.com/repository/create](https://hub.docker.com/repository/create):
   `signalfi-web` and `signalfi-manifest`. Auto-creation on first push
   works if it's enabled on the account; otherwise create them manually.

3. **QEMU binfmt** — required on an x86_64 workstation so `buildx` can
   cross-build `linux/arm64`. One-time host setup:

   ```bash
   docker run --privileged --rm tonistiigi/binfmt --install all
   ```

### Publish

```bash
./publish.sh both         # both images, multi-arch (linux/amd64 + linux/arm64)
./publish.sh web          # just signalfi-web
./publish.sh manifest     # just signalfi-manifest
```

Every push tags with the current `git describe` output **and** `latest`.
A dirty working tree prompts for confirmation before pushing.

Takes ~2–5 min for both images on a warm cache. First-time uncached
build is longer because the `npm ci` layer gets built twice (amd64 and
arm64).

### When to re-publish

- After any code change in `server/`, `public/` (signalfi-web), or
  `https_file_server/manifest-service/` that customer airgap sites
  should pick up. Remote production deploys go through `./deploy.sh app`
  and don't touch Docker Hub.
- Airgap targets pick up new `:latest` on `./deploy.sh update`. Pin
  `IMAGE_TAG=v1.2.3` in their `.env` for reproducibility.

### Pull-access-denied on the airgap target

If `signalfi-airgap`'s `./deploy.sh up` fails with

```text
pull access denied for duckminster/signalfi-web, repository does not
exist or may require 'docker login': denied
```

it usually means either the images have never been published (run
`./publish.sh both` here), or the Docker Hub repos are private and the
airgap host needs `docker login -u duckminster` once.

[airgap]: ../signalfi-airgap/

## Secrets

- `.env` — not tracked. `.env.example` is the template.
- `/root/config/pass.txt` — Mosquitto password file, generated by
  `setup.sh` from `MQTT_USERS` in `.env`. Not tracked.
- `/root/acme.json` — Traefik ACME store. Not tracked.
- `https_file_server/certs/*.key` — **tracked intentionally** because they
  belong to the private Signalfi PKI used only between deployed services.
  Rotate via the cert-issuing scripts in `Certificates/` before untracking.

## Adding a new infra config file

One edit, two places:

1. Drop the file in the repo (e.g. `https_file_server/config/acl.txt`).
2. Add a line to `INFRA_FILES` in `deploy.sh`:
   ```
   "https_file_server/config/acl.txt|$REMOTE_INFRA_PATH/config/acl.txt|644"
   ```

Next `./deploy.sh infra` will sync it and reload the stack.
