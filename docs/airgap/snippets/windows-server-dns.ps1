# Signalfi air-gap — Windows Server DNS cmdlets (Mode B).
# Run in an elevated PowerShell on the Signalfi DNS zone's primary server.
# Replace $zone with the actual zone name serving your domain.

$zone = "symphonyinteractive.ca"   # or whatever zone contains apis.*

Add-DnsServerResourceRecordA `
    -ZoneName  $zone `
    -Name      "apis" `
    -IPv4Address "${SIGNALFI_SERVER_IP}" `
    -TimeToLive  "00:05:00"

Add-DnsServerResourceRecordA `
    -ZoneName  $zone `
    -Name      "admin.apis" `
    -IPv4Address "${SIGNALFI_SERVER_IP}" `
    -TimeToLive  "00:05:00"

# pool.ntp.org hijack — requires adding the zone if it doesn't exist.
Add-DnsServerPrimaryZone -Name "pool.ntp.org" -ReplicationScope Forest
Add-DnsServerResourceRecordA `
    -ZoneName  "pool.ntp.org" `
    -Name      "@" `
    -IPv4Address "${CUSTOMER_NTP_SERVER_IP}" `
    -TimeToLive  "00:05:00"
