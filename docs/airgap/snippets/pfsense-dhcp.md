# Signalfi air-gap — pfSense / OPNsense DHCP

Three changes on the device-LAN DHCP scope.

## pfSense

1. **Services → DHCP Server → [interface serving the device LAN]**.
2. Under **Servers**:
   - **DNS Servers**: enter the IP of your Unbound resolver (usually the
     same as the pfSense LAN IP).
   - **NTP Server 1** *(optional)*: `${CUSTOMER_NTP_SERVER_IP}`.
3. Scroll to **DHCP Static Mappings for this interface**. Click **Add**:
   - **MAC Address**: the CM4's eth0 MAC (run `ip link show eth0` on the
     CM4).
   - **IP Address**: `${SIGNALFI_SERVER_IP}`.
   - **Hostname**: `signalfi-cm4`.
4. **Save**, then **Apply Changes**.

## OPNsense

1. **Services → ISC DHCPv4 → [interface]**.
2. Set **DNS servers** and **NTP servers** as above.
3. Under **DHCP Static Mappings**, add the CM4 reservation.
4. **Save** and **Apply**.
