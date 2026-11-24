import type { LookupFunction } from "node:dns"
import { lookup as lookupHost } from "node:dns/promises"
import { request as httpsRequest } from "node:https"
import { isIP } from "node:net"

export interface ResolvedAddress {
  address: string
  family: 4 | 6
}

function ipv4ToNumber(address: string): number {
  return address.split(".").reduce((value, part) => (value * 256 + Number(part)) >>> 0, 0)
}

function isBlockedIpv4(address: string): boolean {
  const value = ipv4ToNumber(address)
  const ranges: Array<[number, number]> = [
    [0x00000000, 8],
    [0x0a000000, 8],
    [0x64400000, 10],
    [0x7f000000, 8],
    [0xa9fe0000, 16],
    [0xac100000, 12],
    [0xc0000000, 24],
    [0xc0000200, 24],
    [0xc0586300, 24],
    [0xc0a80000, 16],
    [0xc6120000, 15],
    [0xc6336400, 24],
    [0xcb007100, 24],
    [0xe0000000, 4],
    [0xf0000000, 4],
  ]
  return ranges.some(([network, prefix]) => {
    const mask = (0xffffffff << (32 - prefix)) >>> 0
    return (value & mask) === (network & mask)
  })
}

function ipv6ToBigInt(address: string): bigint {
  let normalized = address.toLowerCase().split("%")[0]
  if (normalized.includes(".")) {
    const splitAt = normalized.lastIndexOf(":")
    const octets = normalized.slice(splitAt + 1).split(".").map(Number)
    const high = ((octets[0] << 8) | octets[1]).toString(16)
    const low = ((octets[2] << 8) | octets[3]).toString(16)
    normalized = `${normalized.slice(0, splitAt + 1)}${high}:${low}`
  }
  const halves = normalized.split("::")
  const left = halves[0] ? halves[0].split(":") : []
  const right = halves[1] ? halves[1].split(":") : []
  const groups = halves.length === 1
    ? left
    : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group || "0"}`), 0n)
}

function isBlockedAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return isBlockedIpv4(address)
  if (family !== 6) return true

  const value = ipv6ToBigInt(address)
  const mappedPrefix = value >> 32n
  if (mappedPrefix === 0xffffn) {
    const mappedIpv4 = [
      Number((value >> 24n) & 255n),
      Number((value >> 16n) & 255n),
      Number((value >> 8n) & 255n),
      Number(value & 255n),
    ].join(".")
    return isBlockedIpv4(mappedIpv4)
  }

  const globalUnicast = value >> 125n === 1n
  const documentation = value >> 96n === 0x20010db8n
  const sixToFour = value >> 112n === 0x2002n
  const special2001 = value >> 105n === 0x100080n
  return !globalUnicast || documentation || sixToFour || special2001
}

function parseWebhookUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("Webhook endpoint must be a valid HTTPS URL")
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "")
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home.arpa")
  ) {
    throw new Error("Webhook endpoint must be a public HTTPS URL")
  }
  if (isIP(hostname) && isBlockedAddress(hostname)) {
    throw new Error("Webhook endpoint resolves to a non-public address")
  }
  return url
}

export async function resolvePublicAddress(hostname: string): Promise<ResolvedAddress> {
  const family = isIP(hostname)
  const addresses: ResolvedAddress[] = family
    ? [{ address: hostname, family: family as 4 | 6 }]
    : await lookupHost(hostname, { all: true, verbatim: true }) as ResolvedAddress[]

  if (addresses.length === 0 || addresses.some(({ address }) => isBlockedAddress(address))) {
    throw new Error("Webhook endpoint resolves to a non-public address")
  }
  return addresses[0]
}

export function createPinnedLookup(resolved: ResolvedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [resolved])
    else callback(null, resolved.address, resolved.family)
  }
}

/** Sends one HTTPS request to a DNS-pinned public address. Redirects are never followed. */
export async function sendWebhookRequest(
  endpoint: string,
  headers: Record<string, string>,
  body: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 10_000,
  signal?: AbortSignal,
): Promise<number> {
  const url = parseWebhookUrl(endpoint)
  const hostname = url.hostname.replace(/^\[|\]$/g, "")
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener("abort", onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const resolved = await resolvePublicAddress(hostname)
    if (controller.signal.aborted) throw new Error("Webhook request aborted or timed out")

    if (fetchFn !== fetch) {
      const response = await fetchFn(endpoint, {
        method: "POST",
        headers,
        body,
        redirect: "manual",
        signal: controller.signal,
      })
      return response.status
    }

    const lookup = createPinnedLookup(resolved)

    return await new Promise<number>((resolve, reject) => {
      const request = httpsRequest({
        hostname,
        port: url.port ? Number(url.port) : 443,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers,
        lookup,
        servername: isIP(hostname) ? undefined : hostname,
        agent: false,
      }, (response) => {
        response.resume()
        resolve(response.statusCode ?? 0)
      })
      const destroyOnAbort = () => request.destroy(new Error("Webhook request aborted or timed out"))
      controller.signal.addEventListener("abort", destroyOnAbort, { once: true })
      request.once("error", reject)
      request.once("close", () => controller.signal.removeEventListener("abort", destroyOnAbort))
      request.end(body)
    })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", onAbort)
  }
}