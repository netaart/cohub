export type MediaHost = {
  transform: "oss" | "cloudflare";
  metaHeaders?: boolean;
};

const MEDIA_HOSTS: ReadonlyMap<string, MediaHost> = new Map([
  ["router-files.neta.art", { transform: "oss", metaHeaders: true }],
  ["public.cohub.live", { transform: "oss" }],
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
