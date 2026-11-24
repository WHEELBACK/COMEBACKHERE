/**
 * Webhook URL validation and DNS resolution with SSRF protection.
 *
 * parseWebhookUrl – parses and validates a webhook endpoint URL.
 *   Returns a URL object when the input is a well-formed HTTPS URL with no
 *   embedded credentials, or null when the URL is invalid or disallowed.
 *
 * resolvePublicAddress – resolves a hostname to an IP address and returns it
 *   only when it is a globally-routable unicast address. Returns null when the
 *   resolved address is private, loopback, link-local, or unspecified so that
 *   callers can block SSRF attempts.
 */

import dns from "node:dns/promises"
import net from "node:net"

/**
 * Parse and perform static validation on a webhook endpoint URL.
 *
 * Returns the parsed URL when:
 *  – the input is a syntactically valid URL
 *  – the scheme is https:
 *  – there are no embedded username or password components
 *
 * Returns null for any other input.
 */
export function parseWebhookUrl(raw: unknown): URL | null {
  if (typeof raw !== "string" || raw.length === 0) return null
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol !== "https:") return null
  if (parsed.username || parsed.password) return null
  return parsed
}

/**
 * Ranges that are off-limits for outbound webhook delivery (SSRF protection).
 *
 * Covers:
 *  – 127.0.0.0/8  loopback
 *  – 10.0.0.0/8   private
 *  – 172.16.0.0/12 private
 *  – 192.168.0.0/16 private
 *  – 169.254.0.0/16 link-local (AWS IMDS, etc.)
 *  – 0.0.0.0        unspecified
 *  – ::1            IPv6 loopback
 *  – fc00::/7       IPv6 unique-local
 *  – fe80::/10      IPv6 link-local
 */
function isPrivateOrLoopback(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const octets = ip.split(".").map(Number)
    const [a, b] = octets
    if (a === 127) return true // loopback
    if (a === 10) return true // private class A
    if (a === 172 && b >= 16 && b <= 31) return true // private class B
    if (a === 192 && b === 168) return true // private class C
    if (a === 169 && b === 254) return true // link-local
    if (a === 0 && b === 0 && octets[2] === 0 && octets[3] === 0) return true // unspecified
    return false
  }

  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase()
    if (normalized === "::1") return true // loopback
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true // unique-local
    if (normalized.startsWith("fe8") || normalized.startsWith("fe9") ||
        normalized.startsWith("fea") || normalized.startsWith("feb")) return true // link-local
    return false
  }

  // Not a recognized IP format — treat as private to be safe.
  return true
}

/**
 * Resolve `hostname` via DNS and return the first globally-routable address.
 * Returns null when:
 *  – DNS resolution fails
 *  – every resolved address is private, loopback, or link-local
 */
export async function resolvePublicAddress(hostname: string): Promise<string | null> {
  if (!hostname) return null

  // If the hostname is already a raw IP address, validate it without DNS.
  if (net.isIP(hostname) !== 0) {
    return isPrivateOrLoopback(hostname) ? null : hostname
  }

  let addresses: dns.LookupAddress[]
  try {
    addresses = await dns.lookup(hostname, { all: true })
  } catch {
    return null
  }

  for (const { address } of addresses) {
    if (!isPrivateOrLoopback(address)) {
      return address
    }
  }

  return null
}
