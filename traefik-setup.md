# Traefik Migration Plan

## Overview
Migrate from jwilder/nginx-proxy to Traefik with automated SSL via Let's Encrypt.

## Routing
- `weather.apis.symphonyinteractive.ca` → node-red (port 1880)
- `signalfi.apis.symphonyinteractive.ca` → signalfi-web (port 3000)

## Changes Required
1. Update `/root/docker-compose.yml` with Traefik service and let's encrypt
2. Add Traefik labels to node-red service
3. Update `/opt/signalfi_controller/compose.yml` with Traefik labels for signalfi-web
4. Configure Traefik config files

## Notes
- Certificates stored in `/root/acme.json` (persistent across container restarts)
- HTTP → HTTPS auto-redirect enabled
- Both services on root_default network for Traefik discovery
