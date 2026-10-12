import dns from "node:dns/promises";
import http, { type IncomingHttpHeaders } from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import {
  isPublicBoardRemoteAddress,
  normalizeBoardRemoteUrl,
} from "@neta-art/cohub/board";

export const REMOTE_IMAGE_MAX_BYTES = 16 * 1024 * 1024;
export const REMOTE_IMAGE_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const IMAGE_MIME_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

type ResolvedAddress = { address: string; family: 4 | 6 };
type PinnedAddresses = readonly [ResolvedAddress, ...ResolvedAddress[]];
type Lookup = (hostname: string) => Promise<readonly ResolvedAddress[]>;
type RemoteResponse = {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
};
type Requester = (
  url: URL,
  addresses: PinnedAddresses,
  timeoutMs: number,
  maxBytes: number,
) => Promise<RemoteResponse>;

export type RemoteImageDownloadOptions = {
  lookup?: Lookup;
  requester?: Requester;
  maxBytes?: number;
  timeoutMs?: number;
};

async function defaultLookup(hostname: string): Promise<ResolvedAddress[]> {
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => ({
    address: record.address,
    family: record.family as 4 | 6,
  }));
}

function responseHeaders(input: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(input)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }
  return headers;
}

/** Async like `dns.lookup`: a synchronous answer crashes TLS on an immediate connect failure. */
export function pinnedLookup(addresses: PinnedAddresses): LookupFunction {
  const [first] = addresses;
  return (_hostname, options, callback) => {
    process.nextTick(() =>
      options.all
        ? callback(null, [...addresses])
        : callback(null, first.address, first.family),
    );
  };
}

function requestPinned(
  url: URL,
  addresses: PinnedAddresses,
  timeoutMs: number,
  maxBytes: number,
): Promise<RemoteResponse> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const request = client.request(
      url,
      {
        agent: false,
        headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif" },
        lookup: pinnedLookup(addresses),
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const headers = responseHeaders(response.headers);
        if (REDIRECT_STATUSES.has(status)) {
          response.resume();
          resolve({ status, headers, bytes: new Uint8Array() });
          return;
        }

        const declaredLength = Number(headers.get("content-length") ?? 0);
        if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
          response.destroy();
          reject(new Error(`Image exceeds the ${maxBytes} byte download limit`));
          return;
        }

        const chunks: Uint8Array[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > maxBytes) {
            response.destroy(
              new Error(`Image exceeds the ${maxBytes} byte download limit`),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.once("error", reject);
        response.once("end", () => {
          const bytes = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          resolve({ status, headers, bytes });
        });
      },
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Image download timed out after ${timeoutMs}ms`));
    });
    request.once("error", reject);
    request.end();
  });
}

function remainingMs(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Image download timed out");
  return remaining;
}

async function withDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  const timeoutMs = remainingMs(deadline);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Image download timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function resolvePublicUrl(
  value: string,
  lookup: Lookup,
  deadline: number,
): Promise<{ url: URL; addresses: PinnedAddresses }> {
  const normalized = normalizeBoardRemoteUrl(value);
  if (!normalized) throw new Error("Image URL must be a public HTTP(S) URL");
  const url = new URL(normalized);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) as 4 | 6 }]
    : await withDeadline(lookup(hostname), deadline);
  const [first, ...rest] = addresses;
  if (
    !first ||
    addresses.some((entry) => !isPublicBoardRemoteAddress(entry.address))
  ) {
    throw new Error("Image URL resolves to a private address");
  }
  return { url, addresses: [first, ...rest] };
}

export async function downloadPublicImage(
  input: string,
  options: RemoteImageDownloadOptions = {},
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const lookup = options.lookup ?? defaultLookup;
  const requester = options.requester ?? requestPinned;
  const maxBytes = options.maxBytes ?? REMOTE_IMAGE_MAX_BYTES;
  const deadline = Date.now() + (options.timeoutMs ?? REMOTE_IMAGE_TIMEOUT_MS);
  let current = input;

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const { url, addresses } = await resolvePublicUrl(current, lookup, deadline);
    const response = await withDeadline(
      requester(url, addresses, remainingMs(deadline), maxBytes),
      deadline,
    );
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Image redirect is missing a location");
      if (redirect === MAX_REDIRECTS) throw new Error("Too many image redirects");
      current = new URL(location, url).toString();
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`HTTP ${response.status}`);
    }
    if (response.bytes.byteLength > maxBytes) {
      throw new Error(`Image exceeds the ${maxBytes} byte download limit`);
    }
    const mimeType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (!mimeType || !IMAGE_MIME_TYPES.has(mimeType)) {
      throw new Error("Remote background must be a supported raster image");
    }
    return { bytes: response.bytes, mimeType };
  }
  throw new Error("Too many image redirects");
}
