import dns from "node:dns/promises";
import net from "node:net";

const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 15_000;

function parseIpv4(ip: string) {
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts as [number, number, number, number];
}

function isBlockedIpv4(ip: string) {
  const parts = parseIpv4(ip);
  if (!parts) return true;
  const [a, b] = parts;

  // This host / loopback / CGNAT / link-local / private / benchmark / multicast / reserved
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // RFC 6598 shared address space
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 + 192.0.2.0/24 documentation-ish reserved
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0) return true; // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function expandIpv6(ip: string) {
  const lower = ip.toLowerCase().split("%")[0] ?? ip.toLowerCase();
  const [head, tail] = lower.split("::");
  const headParts = head ? head.split(":").filter(Boolean) : [];
  const tailParts = tail ? tail.split(":").filter(Boolean) : [];
  if (headParts.length + tailParts.length > 8) return null;
  const missing = 8 - headParts.length - tailParts.length;
  const parts = [...headParts, ...Array.from({ length: Math.max(missing, 0) }, () => "0"), ...tailParts];
  if (parts.length !== 8) return null;
  return parts.map((part) => part.padStart(4, "0"));
}

function isBlockedIpv6(ip: string) {
  const normalized = ip.toLowerCase().split("%")[0] ?? ip.toLowerCase();

  // IPv4-mapped / IPv4-compatible forms: ::ffff:a.b.c.d or ::ffff:x:y
  const mappedDotted = normalized.match(/^:{1,2}ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mappedDotted?.[1]) return isBlockedIpv4(mappedDotted[1]);

  const parts = expandIpv6(normalized);
  if (!parts) return true;

  const mappedHex = normalized.startsWith("::ffff:") || parts.slice(0, 5).every((part) => part === "0000") && parts[5] === "ffff";
  if (mappedHex) {
    const hi = Number.parseInt(parts[6] ?? "0", 16);
    const lo = Number.parseInt(parts[7] ?? "0", 16);
    const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isBlockedIpv4(dotted);
  }

  // unspecified / loopback
  if (parts.every((part) => part === "0000")) return true;
  if (parts.slice(0, 7).every((part) => part === "0000") && parts[7] === "0001") return true;

  const first = Number.parseInt(parts[0] ?? "0", 16);
  // Unique local (fc00::/7), link-local (fe80::/10), multicast (ff00::/8)
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xff00) === 0xff00) return true;
  // IPv4-embedded deprecated 0000::/8 leftovers already handled; block documentation 2001:db8::/32
  if (parts[0] === "2001" && parts[1] === "0db8") return true;
  return false;
}

function isBlockedIp(ip: string) {
  const family = net.isIP(ip);
  if (family === 4) return isBlockedIpv4(ip);
  if (family === 6) return isBlockedIpv6(ip);
  return true;
}

function isAllowedHost(hostname: string, allowedHosts?: string[]) {
  if (!allowedHosts?.length) return true;
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return allowedHosts.some((host) => {
    const allowed = host.toLowerCase().replace(/^\[|\]$/g, "");
    return normalized === allowed || normalized.endsWith(`.${allowed}`);
  });
}

async function assertSafeUrl(url: URL, options: { allowedHosts?: string[]; allowHttp?: boolean }) {
  if (url.protocol === "https:") {
    // ok
  } else if (url.protocol === "http:") {
    if (!options.allowHttp) throw new Error("URL must use HTTPS");
  } else {
    throw new Error(`unsupported URL protocol: ${url.protocol}`);
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!isAllowedHost(hostname, options.allowedHosts)) throw new Error(`URL host is not allowed: ${hostname}`);

  const literalFamily = net.isIP(hostname);
  if (literalFamily !== 0) {
    if (isBlockedIp(hostname)) throw new Error("URL resolves to a private address");
    return;
  }

  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  if (records.length === 0 || records.some((record) => isBlockedIp(record.address))) {
    throw new Error("URL resolves to a private address");
  }
}

function mergeAbortSignals(signals: Array<AbortSignal | undefined | null>) {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  if (typeof AbortSignal.any === "function") return AbortSignal.any(active);

  const controller = new AbortController();
  for (const signal of active) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

export async function safeFetch(params: {
  url: string;
  label: string;
  allowedHosts?: string[];
  /** Default false: HTTPS only. Set true only for trusted legacy endpoints. */
  allowHttp?: boolean;
  /** Default 15s. Set 0 to disable. */
  timeoutMs?: number;
  init?: RequestInit;
}) {
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let current = new URL(params.url);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    await assertSafeUrl(current, { allowedHosts: params.allowedHosts, allowHttp: params.allowHttp });

    const timeoutController = timeoutMs > 0 ? new AbortController() : null;
    const timer = timeoutController ? setTimeout(() => timeoutController.abort(new Error(`${params.label}: timed out after ${timeoutMs}ms`)), timeoutMs) : null;
    try {
      const response = await fetch(current, {
        ...params.init,
        redirect: "manual",
        signal: mergeAbortSignals([params.init?.signal, timeoutController?.signal]),
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;

      const location = response.headers.get("location");
      if (!location) return response;
      current = new URL(location, current);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw new Error(`${params.label}: too many redirects`);
}

export function allowedHostFromBaseUrl(value: string) {
  return new URL(value).hostname;
}

export async function readResponseBufferLimited(response: Response, maxBytes: number, label: string) {
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`${label} exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

const REMOTE_IMAGE_MAX_BYTES = 32 * 1024 * 1024;

export async function fetchRemoteImage(input: { url: string; maxBytes?: number; timeoutMs?: number; signal?: AbortSignal }) {
  const label = "Remote image";
  const response = await safeFetch({ url: input.url, label, timeoutMs: input.timeoutMs, init: { signal: input.signal, headers: { Accept: "image/webp,image/*" } } });
  if (!response.ok) throw new Error(`${label} download failed ${response.status}`);
  const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || "application/octet-stream";
  if (!mimeType.startsWith("image/") && mimeType !== "application/octet-stream") throw new Error(`${label} is not an image: ${mimeType}`);
  return { data: await readResponseBufferLimited(response, input.maxBytes ?? REMOTE_IMAGE_MAX_BYTES, label), mimeType };
}
