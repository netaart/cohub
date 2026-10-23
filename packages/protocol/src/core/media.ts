export type MediaHost = {
  transform: "oss" | "cloudflare";
  metaHeaders?: boolean;
};

const MEDIA_HOSTS: ReadonlyMap<string, MediaHost> = new Map([
  ["router-files.neta.art", { transform: "oss", metaHeaders: true }],
  ["oss.talesofai.com", { transform: "oss" }],
  ["public.cohub.live", { transform: "oss" }],
  ["public.cohub.run", { transform: "oss" }],
  ["sessions.cohub.live", { transform: "oss" }],
  ["works.cohub.live", { transform: "oss" }],
  ["works.cohub.run", { transform: "oss" }],
  ["cca.neta.art", { transform: "cloudflare" }],
]);

const parseHttpsUrl = (url: string) => {
  if (!/^https:\/\//i.test(url)) return null;
  try {
    return new URL(url);
  } catch {
    return null;
  }
};

export function mediaHost(url: string): MediaHost | undefined {
  const parsed = parseHttpsUrl(url);
  return parsed ? MEDIA_HOSTS.get(parsed.hostname) : undefined;
}

export const OSS_PROCESS_PATTERN = /[?&]x-oss-process=/;

/** Append an OSS process to `url`, keeping its query and hash. */
export function ossProcessUrl(url: string, process: string): string {
  if (/^(data|blob):/i.test(url) || OSS_PROCESS_PATTERN.test(url)) return url;
  const hashIndex = url.indexOf("#");
  const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : "";
  return `${base}${base.includes("?") ? "&" : "?"}x-oss-process=${process}${hash}`;
}

export const MODEL_IMAGE = { maxEdge: 1280, quality: 75 } as const;

const { maxEdge, quality } = MODEL_IMAGE;
const OSS_MODEL_IMAGE = `image/resize,m_lfit,w_${maxEdge},h_${maxEdge}/quality,q_${quality}/format,webp`;
const CLOUDFLARE_MODEL_IMAGE = `width=${maxEdge},height=${maxEdge},fit=scale-down,quality=${quality},format=webp,onerror=redirect`;

export function modelImageUrl(url: string): string {
  const parsed = parseHttpsUrl(url);
  const host = parsed && MEDIA_HOSTS.get(parsed.hostname);
  if (!parsed || !host || /\.gif$/i.test(parsed.pathname)) return url;
  if (host.transform === "oss") return ossProcessUrl(url, OSS_MODEL_IMAGE);
  if (parsed.pathname.startsWith("/cdn-cgi/")) return url;
  return `${parsed.origin}/cdn-cgi/image/${CLOUDFLARE_MODEL_IMAGE}${parsed.pathname}${parsed.search}`;
}

export type MediaInfo = {
  width?: number;
  height?: number;
  durationMs?: number;
  frameCount?: number;
  firstFrameUrl?: string;
  lastFrameUrl?: string;
  mimeType?: string;
  bytes?: number;
};

function positive(value: unknown): number | undefined {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number > 0
    ? number
    : undefined;
}

function sameOriginUrl(value: string | null, origin: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === origin ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function compact(info: MediaInfo): MediaInfo {
  return Object.fromEntries(
    Object.entries(info).filter(([, value]) => value !== undefined),
  ) as MediaInfo;
}

/** Media facts from response headers; `x-oss-meta-*` need CORS exposure in browsers. */
export function mediaInfoFromHeaders(headers: Headers, url: string): MediaInfo {
  const origin = new URL(url).origin;
  const meta = (name: string) => headers.get(`x-oss-meta-${name}`);
  const seconds = positive(meta("duration"));
  const frameCount = positive(meta("nb-frames"));
  return compact({
    width: positive(meta("width")),
    height: positive(meta("height")),
    durationMs: seconds ? Math.round(seconds * 1000) : undefined,
    frameCount: frameCount ? Math.round(frameCount) : undefined,
    firstFrameUrl: sameOriginUrl(meta("first-frame"), origin),
    lastFrameUrl: sameOriginUrl(meta("last-frame"), origin),
    mimeType: headers.get("content-type")?.split(";")[0]?.trim() || undefined,
    bytes: positive(headers.get("content-length")),
  });
}

export function mergeMediaInfo(primary: MediaInfo, fallback: MediaInfo): MediaInfo {
  return compact({ ...fallback, ...compact(primary) });
}

function hasDimensions(info: MediaInfo) {
  return info.width !== undefined && info.height !== undefined;
}

type ProbeOptions = {
  type: "image" | "video" | "audio";
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
};

async function probeHeaders(url: string, options: ProbeOptions) {
  const fetcher = options.fetch ?? globalThis.fetch;
  const response = await fetcher(url, { method: "HEAD", signal: options.signal });
  return response.ok ? mediaInfoFromHeaders(response.headers, url) : {};
}

async function probeImageInfo(url: string, options: ProbeOptions): Promise<MediaInfo> {
  // A processed URL cannot take `image/info`; fetching it would download the image.
  if (OSS_PROCESS_PATTERN.test(url)) return {};
  const fetcher = options.fetch ?? globalThis.fetch;
  const response = await fetcher(ossProcessUrl(url, "image/info"), {
    signal: options.signal,
  });
  if (!response.ok) return {};
  const body = (await response.json()) as Record<string, { value?: unknown } | undefined>;
  return compact({
    width: positive(body.ImageWidth?.value),
    height: positive(body.ImageHeight?.value),
    bytes: positive(body.FileSize?.value),
  });
}

export async function probeMediaInfo(
  url: string,
  options: ProbeOptions,
): Promise<MediaInfo> {
  const host = mediaHost(url);
  if (host?.transform !== "oss") return {};
  let info: MediaInfo = {};
  const attempt = async (strategy: () => Promise<MediaInfo>) => {
    try {
      info = mergeMediaInfo(info, await strategy());
    } catch {
      // Best effort: keep what earlier strategies found.
    }
  };
  if (host.metaHeaders) await attempt(() => probeHeaders(url, options));
  if (options.type === "image" && !hasDimensions(info)) {
    await attempt(() => probeImageInfo(url, options));
  }
  return info;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * A video's dimensions, read from the header of its first frame rendered as a
 * full-size PNG by OSS; only the first 24 bytes are read. Throws on failure.
 */
export async function probeVideoFrameSize(
  url: string,
  options: { fetch?: typeof globalThis.fetch; signal?: AbortSignal } = {},
): Promise<Pick<MediaInfo, "width" | "height">> {
  if (mediaHost(url)?.transform !== "oss" || OSS_PROCESS_PATTERN.test(url)) return {};
  const fetcher = options.fetch ?? globalThis.fetch;
  const response = await fetcher(ossProcessUrl(url, "video/snapshot,t_0,f_png,w_0,h_0,m_fast"), {
    headers: { Range: "bytes=0-23" },
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const header = new Uint8Array(24);
  let length = 0;
  const reader = response.body?.getReader();
  while (reader && length < header.length) {
    const { done, value } = await reader.read();
    if (done) break;
    header.set(value.subarray(0, header.length - length), length);
    length += Math.min(value.length, header.length - length);
  }
  await reader?.cancel().catch(() => undefined);
  if (length < header.length || PNG_SIGNATURE.some((byte, index) => header[index] !== byte)) return {};
  const view = new DataView(header.buffer);
  return compact({ width: positive(view.getUint32(16)), height: positive(view.getUint32(20)) });
}

export async function probeMediaSize(
  url: string,
  type: "image" | "video",
  options: { fetch?: typeof globalThis.fetch; signal?: AbortSignal } = {},
): Promise<{ width: number; height: number } | null> {
  const info = await probeMediaInfo(url, { ...options, type });
  const { width, height } = info.width || type !== "video" ? info : await probeVideoFrameSize(url, options).catch(() => info);
  return width && height ? { width, height } : null;
}
