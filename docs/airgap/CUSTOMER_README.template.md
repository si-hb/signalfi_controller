# Signalfi Air-Gap Install — Customer Runbook

This bundle contains everything needed to deploy Signalfi on a single
self-hosted server. Two install modes are supported; pick the one that
matches your site.

> **Bundle placeholders** — this README is generated per customer and has
> real values substituted at package time. If you see a `${VARIABLE}` below
> the templating wasn't run; contact support.

---

## What's in the box

- CM4 RPi server (pre-flashed)
- Power supply
- Ethernet cables
- Signalfi devices + SD cards
- *(Mode A only)* PoE switch
- This README
- `signalfi-airgap-bundle-<version>.tar.gz` on a USB stick (or pre-loaded)

---

## Choose your mode

```
Q1: Do the Signalfi devices need to live on your corporate network,
    share a VLAN with other devices, or route to the internet?

    NO  →  Run them on an isolated PoE switch with just the CM4.
           ─▶ Mode A (Signalfi-served)

    YES →  Devices sit on a customer-managed subnet.
           ─▶ Mode B (Customer-served)

Q2: Does your IT policy require all DHCP/DNS to go through existing
    infrastructure?

    YES →  Mode B regardless of Q1.
```

### Side-by-side

| What the customer provides           | Mode A (Signalfi-served) | Mode B (Customer-served) |
|---------------------------------------|---------------------------|---------------------------|
| DHCP for devices                     | Signalfi does it          | **Your DHCP server**      |
| DNS resolving `apis.*`               | Signalfi does it          | **Your DNS server**       |
| NTP for devices                      | Signalfi does it          | **Your NTP server** (optional) |
| PoE switch                           | Supplied by Signalfi      | Your existing switching   |
| Static IP for the CM4                | Not needed                | **Reserve one on your DHCP** |
| Firewall rule to let devices reach CM4 | Not needed               | **Required**              |

> **Recommendation**: if you don't know, pick Mode A.

---

## Mode A — Signalfi-served install

This is the isolated-island install. The CM4 runs DHCP, DNS, and NTP on the
device LAN. Nothing touches your corporate network.

### Install

1. Rack the CM4 somewhere with power.
2. Plug **eth0** on the CM4 into the supplied PoE switch.
3. *(Optional)* Plug **eth1** on the CM4 into your office LAN for SSH access.
4. Power the CM4 on. Wait ~60s for first boot.
5. SSH in (via eth1) or attach keyboard + HDMI:
   ```bash
   ssh admin@<eth1 IP>
   ```
6. Configure the install:
   ```bash
   cd /opt/signalfi_controller
   sudo cp .env.airgap.example .env
   sudo nano .env
   # Set AIRGAP_NETWORK_MODE=served
   # Fill in MQTT_USERS
   # Defaults for AIRGAP_HOST_IP / AIRGAP_DHCP_RANGE are fine
   ```
7. Run setup and bring the stack up:
   ```bash
   sudo ./setup.sh --airgap
   sudo ./deploy.sh airgap
   ```
8. Plug the Signalfi devices into the PoE switch. They'll auto-discover
   within ~30s per device.

### Verify

```bash
sudo ./tools/signalfi-smoketest.sh ${AIRGAP_HOST_IP}
```

Every check should pass. If MQTT or NTP fails, re-check `/etc/systemd/resolved.conf.d/airgap.conf` and that no host-level `chronyd` / `ntpd` is still running.

---

## Mode B — Customer-served install

This mode relies on your existing DHCP, DNS, and (optionally) NTP
infrastructure. Your network admin has to apply three changes before
you plug anything in.

### Before the CM4 arrives: three admin tasks

Substitute `${SIGNALFI_SERVER_IP}` with the static IP you've reserved for
the CM4. All three records point to that same IP.

#### 1. DNS — three A-records in your internal zone

Copy-paste snippets for common platforms live in `docs/snippets/`:

| Platform              | File                             |
|-----------------------|----------------------------------|
| BIND9                 | `snippets/bind9.zone.txt`        |
| dnsmasq               | `snippets/dnsmasq.conf.txt`      |
| Unbound               | `snippets/unbound.conf.txt`      |
| Windows Server (DNS)  | `snippets/windows-server-dns.ps1`|
| pfSense / OPNsense    | `snippets/pfsense-dns.md`        |

The records to add:

```
apis.symphonyinteractive.ca.         IN  A  ${SIGNALFI_SERVER_IP}
admin.apis.symphonyinteractive.ca.   IN  A  ${SIGNALFI_SERVER_IP}
pool.ntp.org.                        IN  A  <your internal NTP server IP>
```

The `pool.ntp.org` record hijacks the device firmware's default NTP server
so devices pick up your NTP instead of trying to reach the internet.

#### 2. DHCP — scope options for the device subnet

| Option      | Value                                              |
|-------------|----------------------------------------------------|
| 6 (DNS)     | Your DNS resolver (the one serving the A-records above) |
| 42 (NTP)    | Your NTP server *(optional — DNS override handles this too)* |
| Reservation | CM4's MAC → `${SIGNALFI_SERVER_IP}`                |

Snippets: `snippets/windows-server-dhcp.ps1`, `snippets/isc-kea.json.txt`,
`snippets/pfsense-dhcp.md`.

#### 3. Firewall — inbound to the CM4

From the device subnet to `${SIGNALFI_SERVER_IP}`:

| Port       | Service                     |
|-----------|------------------------------|
| TCP 1883  | MQTT                         |
| TCP 80    | OTA (fallback + redirects)   |
| TCP 443   | OTA + Admin UI               |
| TCP 2022  | SFTP (admin-only)            |

The CM4 does **not** need any outbound internet access during runtime.

### Install

1. Rack the CM4 somewhere with power.
2. Plug **eth0** into your customer LAN (the switch that the device subnet
   also reaches).
3. Power on. The CM4 boots with DHCP on eth0 and picks up your reserved
   IP.
4. SSH in:
   ```bash
   ssh admin@${SIGNALFI_SERVER_IP}
   ```
5. Configure:
   ```bash
   cd /opt/signalfi_controller
   sudo cp .env.airgap.example .env
   sudo nano .env
   # Set AIRGAP_NETWORK_MODE=byo
   # Fill in MQTT_USERS
   ```
6. Run setup and bring the stack up:
   ```bash
   sudo ./setup.sh --airgap
   sudo ./deploy.sh airgap
   ```
7. Plug the Signalfi devices into your switch. They'll lease IPs from your
   DHCP and resolve `apis.symphonyinteractive.ca` via your DNS.

### Verify

From any machine on the device subnet:

```bash
sudo ./tools/signalfi-smoketest.sh ${SIGNALFI_SERVER_IP}
```

---

## TLS trust

Devices already trust the Signalfi private CA (baked into firmware). You
do **not** need to install any certificate on the devices.

If administrators want to access `https://admin.apis.symphonyinteractive.ca`
without a browser warning, install `signalfi_root_ca.crt` (bundled at the
repo root) into the administrator's browser/OS trust store. This is
optional — the admin UI works fine with a one-time "Accept risk" click if
you'd rather not distribute a CA.

---

## Updating

When a new bundle arrives:

```bash
cd /opt/signalfi_controller
sudo tar xzf /path/to/signalfi-airgap-bundle-<new version>.tar.gz --strip-components=1
sudo ${CONTAINER_RUNTIME:-docker} load -i images/signalfi-airgap-images.tar
sudo ./deploy.sh airgap
```

Data volumes (`mqtt-broker-data`, `node_red_data`, `sftpgo-state`,
`/opt/signalfi/*`) persist across upgrades.

---

## Troubleshooting

| Symptom                                | Likely cause                                 | Fix                                                                    |
|----------------------------------------|----------------------------------------------|------------------------------------------------------------------------|
| Device never gets an IP                | DHCP not reaching the subnet                 | Mode A: check `AIRGAP_DEVICE_INTERFACE` matches the cable; Mode B: verify DHCP scope covers this VLAN |
| Device gets IP but MQTT fails          | DNS not resolving `apis.*`                   | Mode B: confirm A-record was added and TTL has expired                 |
| Admin UI shows "Not secure" warning    | Admin browser missing Signalfi Root CA       | Install `signalfi_root_ca.crt` or accept one-time warning              |
| Smoketest: NTP fails (Mode A)          | Host `chronyd` / `ntpd` still running        | `sudo systemctl stop chronyd && sudo systemctl disable chronyd`        |
| Smoketest: DNS fails (Mode A)          | systemd-resolved stub listener still on :53  | Check `/etc/systemd/resolved.conf.d/airgap.conf` has `DNSStubListener=no` + restart resolved |
| Device OTA downloads fail              | Firewall blocks 443 from device subnet → CM4 | Open TCP 443; verify cert chain with `openssl s_client`                |
| Containers won't start after reboot    | Runtime not enabled on boot                  | `sudo systemctl enable docker` or `sudo systemctl enable podman`       |

---

## Support

| Channel        | Where                                      |
|----------------|---------------------------------------------|
| Email          | admin@symphonyinteractive.ca                |
| Logs (on CM4)  | `sudo ${CONTAINER_RUNTIME:-docker} logs signalfi-manifest` etc. |
| Version        | `git -C /opt/signalfi_controller describe --always --dirty` |
