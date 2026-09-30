'use strict';
// remote-linux-tailscale/net-guard.js
//
// Address-based access control for server.js, mirroring the Windows engine's protections
// (LoopbackServer.cs's IsPrivateAddress/AllowedHost) but extended to also accept Tailscale's
// CGNAT address range (100.64.0.0/10), since Tailscale is the whole point of this deployment:
// a phone reaching this box's Tailscale IP directly, without being on the same LAN, without
// needing the Kiwi extension's same-Wi-Fi-only pairing.
//
// Security note: Tailscale already authenticates and encrypts at the network layer (WireGuard
// + tailnet ACLs), so trusting "this looks like a private/Tailscale address" here is a
// second, coarser layer - the real trust boundary is Tailscale's own ACLs/device auth, same as
// how the Windows engine treats classic RFC1918 addresses as "on your own LAN, already
// somewhat trusted" rather than as a complete security model by itself.

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === 'localhost';
}

function parseIPv4(address) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (!m) return null;
  const octets = m.slice(1, 5).map(Number);
  if (octets.some((o) => o < 0 || o > 255)) return null;
  return octets;
}

// RFC1918 private ranges, same three blocks Test-PrivateIPv4 (Start-YtSummary.ps1) and
// IsPrivateAddress (LoopbackServer.cs) already check on the Windows side.
function isRfc1918(octets) {
  return octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
}

// Tailscale's CGNAT allocation range: 100.64.0.0 - 100.127.255.255 (100.64.0.0/10).
function isTailscaleRange(octets) {
  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

// Returns true if `address` should be allowed to reach this server: loopback, classic
// same-LAN private ranges (kept for parity/local testing), or a Tailscale tailnet address.
function isAllowedAddress(address) {
  if (isLoopback(address)) return true;
  const octets = parseIPv4(address);
  if (!octets) return false;
  return isRfc1918(octets) || isTailscaleRange(octets);
}

module.exports = { isLoopback, parseIPv4, isRfc1918, isTailscaleRange, isAllowedAddress };
