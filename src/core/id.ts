import type { Source } from "../types";

/** The default port for each scheme whose port is dropped during canonicalization. */
const DEFAULT_PORTS: Record<string, string> = {
  "http:": "80",
  "https:": "443",
};

/** FNV-1a 32-bit offset basis. */
const FNV_OFFSET_BASIS = 0x811c9dc5;
/** FNV-1a 32-bit prime. */
const FNV_PRIME = 0x01000193;

/**
 * Normalizes a URL so equivalent links (differing only by query string,
 * fragment, default port, scheme/host case, or a trailing slash) produce
 * the same value. Does not collapse duplicate path slashes.
 */
export function canonicalUrl(url: string): string {
  const parsed = new URL(url);
  const protocol = parsed.protocol.toLowerCase();
  const hostname = parsed.hostname.toLowerCase();
  const port = parsed.port !== "" && parsed.port !== DEFAULT_PORTS[protocol]
    ? parsed.port
    : "";
  const host = port === "" ? hostname : `${hostname}:${port}`;
  const path = parsed.pathname.length > 1 && parsed.pathname.endsWith("/")
    ? parsed.pathname.slice(0, -1)
    : parsed.pathname;
  return `${protocol}//${host}${path}`;
}

/** Hashes a string with 32-bit FNV-1a, returning the digest as lowercase hex. */
function fnv1a32Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let hash = FNV_OFFSET_BASIS;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * A stable id for a deal, derived from its source and canonical URL so the
 * same listing always resolves to the same id regardless of URL variant.
 */
export function stableId(source: Source, url: string): string {
  return fnv1a32Hex(`${source}\n${canonicalUrl(url)}`);
}
