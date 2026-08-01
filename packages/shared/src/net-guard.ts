/**
 * SSRF guard for operator-supplied URLs.
 *
 * Node registration is deliberately open — anyone can generate an Algorand keypair, so the
 * signature proves only "the same party that picked this payout address picked this
 * endpoint", not that the party is trusted. The gateway then makes an outbound HTTP request
 * to that endpoint on every routed request, which turns an unvalidated URL into a
 * server-side request forgery primitive: a registrant can aim the gateway at cloud metadata
 * (169.254.169.254), at loopback services, or anywhere inside the deployment's VPC.
 *
 * This module rejects URLs that resolve into address space a public inference node has no
 * business occupying. It is applied twice on purpose:
 *
 *   1. at registration, so a bad endpoint never enters the registry, and
 *   2. immediately before the outbound fetch, because a hostname that resolved to a public
 *      address at registration can be re-pointed at a private one afterwards (DNS
 *      rebinding). Only a check at connect time closes that window.
 */

import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

import { ValidationError } from "./errors.js";

/** How long a successful host validation is trusted before DNS is consulted again. */
const RESOLUTION_CACHE_TTL_MS = 30_000;

/** Bounds the cache so a hostile registrant cannot grow it without limit. */
const RESOLUTION_CACHE_MAX_ENTRIES = 1_024;

const resolutionCache = new Map<string, number>();

/**
 * IPv4 ranges that are never a legitimate public inference endpoint.
 *
 * Each entry is `[networkAddress, prefixLength]`. Chosen from the IANA special-purpose
 * registry, with the operationally important ones called out:
 * `169.254.0.0/16` is cloud instance metadata, `127.0.0.0/8` is anything co-located with
 * the gateway process, and the RFC1918 blocks are the rest of a typical VPC.
 */
const BLOCKED_IPV4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // RFC1918 private
  ["100.64.0.0", 10], // RFC6598 carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local — cloud metadata lives here
  ["172.16.0.0", 12], // RFC1918 private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.168.0.0", 16], // RFC1918 private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, includes 255.255.255.255
];

/**
 * Converts dotted-quad IPv4 to a 32-bit unsigned integer.
 *
 * @param ip - Dotted-quad address, already known to be syntactically valid IPv4.
 * @returns The address as an unsigned 32-bit number, or null if it is malformed.
 */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

/**
 * Tests an IPv4 address against the blocked ranges.
 *
 * @param ip - Dotted-quad IPv4 address.
 * @returns True when the address falls inside a non-routable or reserved block.
 */
function isBlockedIPv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return true; // unparseable => refuse rather than guess
  for (const entry of BLOCKED_IPV4) {
    const base = ipv4ToInt(entry[0]);
    if (base === null) continue;
    // A /0 mask would shift by 32, which is a no-op in JS; no entry uses /0 so this is safe.
    const mask = (0xffffffff << (32 - entry[1])) >>> 0;
    if ((value & mask) === (base & mask)) return true;
  }
  return false;
}

/**
 * Tests an IPv6 address against loopback, unspecified, unique-local, link-local and
 * multicast ranges, transparently unwrapping IPv4-mapped forms such as
 * `::ffff:169.254.169.254` so they cannot be used to slip past the IPv4 checks.
 *
 * @param ip - IPv6 address in any standard textual form.
 * @returns True when the address is not a legitimate public destination.
 */
function isBlockedIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase().split("%")[0] ?? "";

  // IPv4-mapped (::ffff:1.2.3.4) and IPv4-compatible (::1.2.3.4) embed a v4 address.
  const embedded = normalized.match(/(?:^::ffff:|^::)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (embedded?.[1] !== undefined) return isBlockedIPv4(embedded[1]);

  if (normalized === "::" || normalized === "::1") return true;

  const head = normalized.split(":")[0] ?? "";
  if (head.length === 0) return false; // "::something" — not a range we block by prefix

  const group = Number.parseInt(head.padEnd(4, "0").slice(0, 4), 16);
  if (Number.isNaN(group)) return true;

  if ((group & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((group & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((group & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/**
 * Classifies a literal IP address.
 *
 * @param ip - An IPv4 or IPv6 address literal.
 * @returns True when the gateway must not connect to it.
 */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isBlockedIPv4(ip);
  if (family === 6) return isBlockedIPv6(ip);
  return true; // not an IP literal at all => caller must resolve first
}

/**
 * Validates the syntactic shape of a node endpoint without touching DNS.
 *
 * Kept separate from {@link assertRoutableEndpoint} so callers on a hot path, or in a unit
 * test with no resolver, can apply the cheap checks alone.
 *
 * @param raw - The candidate URL.
 * @returns The parsed URL.
 * @throws {ValidationError} If it is not an absolute http(s) URL, or carries credentials.
 */
export function assertHttpUrlShape(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError("endpoint must be an absolute URL", { endpoint: raw });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ValidationError("endpoint must use http or https", { protocol: url.protocol });
  }
  // Credentials in the URL would be replayed by the gateway on every routed request.
  if (url.username !== "" || url.password !== "") {
    throw new ValidationError("endpoint must not embed credentials", { endpoint: url.host });
  }
  return url;
}

/** Options for {@link assertRoutableEndpoint}. */
export interface RoutableEndpointOptions {
  /**
   * Permit private, loopback and link-local destinations.
   *
   * Required for local development and the docker-compose demo, where nodes legitimately
   * live at `http://ollama:11434` or `http://127.0.0.1:...`. Defaults to false so a
   * deployed gateway is safe without needing to opt in to safety.
   */
  allowPrivate?: boolean;
  /** Injectable resolver, so tests can exercise rebinding without real DNS. */
  resolve?: (hostname: string) => Promise<string[]>;
  /** Injectable clock for cache expiry in tests. */
  now?: () => number;
}

/**
 * Resolves a hostname to every address it maps to.
 *
 * @param hostname - The host portion of the endpoint URL.
 * @returns All resolved addresses.
 */
async function defaultResolve(hostname: string): Promise<string[]> {
  const results = await lookup(hostname, { all: true });
  return results.map((r) => r.address);
}

/**
 * Fully validates that an endpoint is safe for the gateway to call.
 *
 * Resolves the hostname and rejects if *any* returned address is non-public — a host with
 * one public and one private address is still an SSRF vector, since which one gets used is
 * outside our control.
 *
 * @param raw - The candidate endpoint URL.
 * @param options - Behaviour overrides; see {@link RoutableEndpointOptions}.
 * @returns The validated URL.
 * @throws {ValidationError} If the URL is malformed or resolves into blocked address space.
 */
export async function assertRoutableEndpoint(
  raw: string,
  options: RoutableEndpointOptions = {},
): Promise<URL> {
  const url = assertHttpUrlShape(raw);
  if (options.allowPrivate === true) return url;

  const now = options.now ?? Date.now;
  const cached = resolutionCache.get(url.host);
  if (cached !== undefined && cached > now()) return url;

  const hostname = url.hostname.replace(/^\[|\]$/g, "");

  // A literal IP needs no resolution — check it directly.
  if (isIP(hostname) !== 0) {
    if (isBlockedAddress(hostname)) {
      throw new ValidationError("endpoint resolves to a non-public address", {
        endpoint: url.host,
        address: hostname,
      });
    }
    rememberHost(url.host, now());
    return url;
  }

  let addresses: string[];
  try {
    addresses = await (options.resolve ?? defaultResolve)(hostname);
  } catch {
    throw new ValidationError("endpoint hostname could not be resolved", { endpoint: url.host });
  }
  if (addresses.length === 0) {
    throw new ValidationError("endpoint hostname could not be resolved", { endpoint: url.host });
  }
  for (const address of addresses) {
    if (isBlockedAddress(address)) {
      throw new ValidationError("endpoint resolves to a non-public address", {
        endpoint: url.host,
        address,
      });
    }
  }
  rememberHost(url.host, now());
  return url;
}

/**
 * Records a host as validated, evicting the oldest entry when the cache is full.
 *
 * @param host - The `host` component that was validated.
 * @param at - Current epoch milliseconds.
 */
function rememberHost(host: string, at: number): void {
  if (resolutionCache.size >= RESOLUTION_CACHE_MAX_ENTRIES) {
    const oldest = resolutionCache.keys().next();
    if (!oldest.done) resolutionCache.delete(oldest.value);
  }
  resolutionCache.set(host, at + RESOLUTION_CACHE_TTL_MS);
}

/** Clears the validation cache. Exposed for tests. */
export function resetEndpointValidationCache(): void {
  resolutionCache.clear();
}
