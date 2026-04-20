# Signalfi air-gap — pfSense / OPNsense DNS Resolver

pfSense uses **Unbound** as its DNS resolver. Three host overrides need to
be added so Signalfi devices resolve the Signalfi hostnames to your
Signalfi server, and the firmware's default NTP pool to your internal NTP.

## pfSense

1. **Services → DNS Resolver → General Settings**. Make sure the resolver
   is enabled and listening on the device-LAN interface.
2. **Services → DNS Resolver → Host Overrides**. Click **Add** three times:

| Host       | Domain                            | IP Address                           |
|------------|-----------------------------------|--------------------------------------|
| `apis`     | `symphonyinteractive.ca`          | `${SIGNALFI_SERVER_IP}`             |
| `admin.apis` | `symphonyinteractive.ca`        | `${SIGNALFI_SERVER_IP}`             |
| *(empty)*  | `pool.ntp.org`                    | `${CUSTOMER_NTP_SERVER_IP}`         |

3. Click **Save**, then **Apply Changes**.

## OPNsense

1. **Services → Unbound DNS → Overrides**.
2. **Host Overrides** tab → **+ Add** three times with the table above.
3. **Apply**.

## Verify from a device-subnet client

```bash
dig @<pfsense-LAN-IP> +short apis.symphonyinteractive.ca
# expected: ${SIGNALFI_SERVER_IP}
```
