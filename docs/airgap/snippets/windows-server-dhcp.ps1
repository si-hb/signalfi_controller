# Signalfi air-gap — Windows Server DHCP cmdlets (Mode B).
# Run in an elevated PowerShell on the DHCP server for the device subnet.
# Replace the scope ID and values as needed.

$scopeId   = "10.20.30.0"                   # device subnet / scope
$dnsServer = "10.20.30.5"                   # internal DNS resolver
$ntpServer = "${CUSTOMER_NTP_SERVER_IP}"   # internal NTP server (optional)
$cmMac     = "DC-A6-32-XX-XX-XX"            # CM4 MAC — get from `ip link show eth0`
$cmIp      = "${SIGNALFI_SERVER_IP}"

# Option 6 — DNS resolver visible to devices
Set-DhcpServerv4OptionValue -ScopeId $scopeId -OptionId 6 -Value $dnsServer

# Option 42 — NTP server (optional; the pool.ntp.org DNS override handles it too)
Set-DhcpServerv4OptionValue -ScopeId $scopeId -OptionId 42 -Value $ntpServer

# Reservation for the CM4 so it always lands on a predictable IP
Add-DhcpServerv4Reservation -ScopeId $scopeId `
    -IPAddress   $cmIp `
    -ClientId    $cmMac `
    -Name        "signalfi-cm4"
