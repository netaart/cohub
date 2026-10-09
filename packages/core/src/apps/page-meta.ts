import { parseAppFileHandlers } from "@cohub/protocol";
import type { AppSurfaceRole, HtmlPageMeta } from "./html-meta.js";

export type AppExtractedPageMeta = HtmlPageMeta & {
  sourcePath?: string;
  extractedAt?: string;
};

/** Raw page fields returned by the publish-asset worker before CDN materialization. */
export type AppPublishExtractedPageMeta = {
  title: string | null;
  description: string | null;
  icon: string | null;
  image: string | null;
  lang: string | null;
  themeColor: string | null;
  surface: AppSurfaceRole | null;
  /** Absent from workers that predate file handlers. */
  fileHandlers?: string[];
  sourcePath: string;
};

/** Effective presentation fields stored on work / version meta. */
export type AppPageFields = {
  title?: string;
  description?: string;
  icon?: string;
  image?: string;
  lang?: string;
  themeColor?: string;
};

export type AppPageMetaInput = Record<string, unknown> | null | undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const cleanAppMetaText = (value: unknown, max = 500): string | null => {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};

export function appTitleFromMeta(meta: AppPageMetaInput, fallback: string): string {
  if (!isRecord(meta)) return fallback;
  return (
    cleanAppMetaText(meta.title) ??
    cleanAppMetaText(meta.name) ??
    fallback
  );
}

export function readAppPageFields(meta: AppPageMetaInput): {
  title: string | null;
  description: string | null;
  icon: string | null;
  image: string | null;
  lang: string | null;
  themeColor: string | null;
} {
  if (!isRecord(meta)) {
    return {
      title: null,
      description: null,
      icon: null,
      image: null,
      lang: null,
      themeColor: null,
    };
  }
  return {
    title: cleanAppMetaText(meta.title) ?? cleanAppMetaText(meta.name),
    description: cleanAppMetaText(meta.description, 300),
    icon: cleanAppMetaText(meta.icon, 2048),
    image: cleanAppMetaText(meta.image, 2048),
    lang: cleanAppMetaText(meta.lang, 32),
    themeColor: cleanAppMetaText(meta.themeColor, 64),
  };
}

function isBlockedAbsoluteHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "::" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }
  if (/^127\.\d+\.\d+\.\d+$/.test(host)) return true;
  if (/^10\.\d+\.\d+\.\d+$/.test(host)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(host)) return true;
  if (/^169\.254\.\d+\.\d+$/.test(host)) return true;
  // 172.16.0.0 – 172.31.255.255
  const m172 = host.match(/^172\.(\d+)\.\d+\.\d+$/);
  if (m172) {
    const second = Number(m172[1]);
    if (second >= 16 && second <= 31) return true;
  }
  // Unique local IPv6 fc00::/7 and link-local fe80::/10 (prefix check).
  if (host.includes(":")) {
    if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe8") || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb")) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve a page asset reference to a public URL.
 * Relative paths are joined under the published asset directory.
 * Absolute https URLs are kept when host looks public.
 */
/** True for inline image data URLs that are safe to expose as icon/image. */
export function isSafeImageDataUrl(value: string): boolean {
  return /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon)[;,]/i.test(
    value,
  );
}

/**
 * Resolve a page asset reference to a public URL.
 * - https / safe data:image URLs are kept
 * - relative / root-relative paths join under the published asset directory
 */
export function resolveAppPageAssetRef(
  ref: string | null | undefined,
  assetKey: string | null | undefined,
  toPublicUrl: (objectKey: string) => string,
): string | null {
  const value = cleanAppMetaText(ref, 8192);
  if (!value) return null;
  if (isSafeImageDataUrl(value)) return value;
  if (/^data:/i.test(value)) return null;
  if (/^https:\/\//i.test(value) || value.startsWith("//")) {
    try {
      const url = new URL(value.startsWith("//") ? `https:${value}` : value);
      if (url.protocol !== "https:") return null;
      if (isBlockedAbsoluteHost(url.hostname)) return null;
      return url.toString();
    } catch {
      return null;
    }
  }
  if (/^http:\/\//i.test(value)) return null;
  if (!assetKey) return null;

  const baseDir = assetKey.replace(/\/[^/]*$/, "");
  if (!baseDir || baseDir === assetKey) return null;

  const normalized = value
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0")) return null;
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;

  return toPublicUrl(`${baseDir}/${parts.join("/")}`);
}

/**
 * Resolve media for display when only the published content URL is known
 * (read path / SSR — no need to re-publish old relative meta).
 */
export function resolveAppPageMediaAgainstContentUrl(
  ref: string | null | undefined,
  contentUrl: string | null | undefined,
): string | null {
  const value = cleanAppMetaText(ref, 8192);
  if (!value) return null;
  if (isSafeImageDataUrl(value)) return value;
  if (/^data:/i.test(value)) return null;
  if (/^https:\/\//i.test(value) || value.startsWith("//")) {
    try {
      const url = new URL(value.startsWith("//") ? `https:${value}` : value);
      if (url.protocol !== "https:") return null;
      if (isBlockedAbsoluteHost(url.hostname)) return null;
      return url.toString();
    } catch {
      return null;
    }
  }
  if (/^http:\/\//i.test(value)) return null;
  if (!contentUrl) return null;
  try {
    const base = new URL(contentUrl);
    // Treat root-relative paths as siblings of the published entry (…/index.html),
    // not as host-root paths. HTML `/favicon.svg` means site root of the app package.
    const relative = value.replace(/^\.\//, "").replace(/^\/+/, "");
    if (!relative || relative.includes("\0")) return null;
    const parts = relative.split("/");
    if (parts.some((part) => !part || part === "." || part === "..")) return null;
    const dir = base.pathname.replace(/\/[^/]*$/, "/");
    const resolved = new URL(parts.join("/"), `${base.origin}${dir}`);
    if (resolved.protocol !== "https:") return null;
    if (isBlockedAbsoluteHost(resolved.hostname)) return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

/** Prefer absolute CDN / data icons over bare site-root paths that leak host branding. */
export function isWeakAppPageMediaRef(ref: string | null | undefined): boolean {
  const value = cleanAppMetaText(ref, 2048);
  if (!value) return true;
  if (isSafeImageDataUrl(value)) return false;
  if (/^https:\/\//i.test(value)) return false;
  // Root-relative or relative without host — not usable in shell OG until resolved.
  return true;
}

export function materializeHtmlPageMeta(
  page: Omit<HtmlPageMeta, "fileHandlers"> & { fileHandlers?: string[]; sourcePath?: string },
  assetKey: string | null | undefined,
  toPublicUrl: (objectKey: string) => string,
  extractedAt = new Date().toISOString(),
): AppExtractedPageMeta {
  return {
    title: cleanAppMetaText(page.title),
    description: cleanAppMetaText(page.description, 300),
    icon: resolveAppPageAssetRef(page.icon, assetKey, toPublicUrl),
    image: resolveAppPageAssetRef(page.image, assetKey, toPublicUrl),
    lang: cleanAppMetaText(page.lang, 32),
    themeColor: cleanAppMetaText(page.themeColor, 64),
    surface: page.surface,
    fileHandlers: parseAppFileHandlers(page.fileHandlers),
    sourcePath: page.sourcePath,
    extractedAt,
  };
}

type ExtractedField = "title" | "description" | "icon" | "image" | "lang" | "themeColor";

const EXTRACTED_FIELD_MAX: Record<ExtractedField, number> = {
  title: 500,
  description: 300,
  icon: 8192,
  image: 8192,
  lang: 32,
  themeColor: 64,
};

/**
 * Whether the effective value of a field is one extraction wrote on an earlier
 * publish (and may therefore update or remove) rather than one the publisher
 * set by hand. Weak relative media refs from before extraction recorded its
 * snapshot also count as ours, so an old `/favicon.svg` still gets upgraded.
 */
function ownedByExtraction(
  current: string | null,
  previouslyExtracted: string | null,
  field: ExtractedField,
): boolean {
  if (current === null) return true;
  if (previouslyExtracted !== null && current === previouslyExtracted) return true;
  return (field === "icon" || field === "image") && isWeakAppPageMediaRef(current);
}

/**
 * Merge extracted page fields into App / version meta.
 *
 * - `extracted` is always refreshed: it is the raw provenance snapshot.
 * - An effective field follows the page while its value is what extraction
 *   last wrote (or is empty). A value that differs from the last snapshot is
 *   taken to be the publisher's and is kept.
 * - `presentation.surface` follows the same rule, with `window` (the default)
 *   kept implicit.
 *
 * Ownership is inferred from values, not recorded, so a publisher who types in
 * exactly what extraction already produced has not pinned anything: the field
 * keeps following the page. Pinning is done by editing the page itself, or by
 * setting a value that differs from it.
 */
const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

export function mergeAppPageMeta(
  current: AppPageMetaInput,
  extracted: AppExtractedPageMeta | null | undefined,
): Record<string, unknown> | null {
  const meta: Record<string, unknown> = isRecord(current) ? { ...current } : {};
  if (!extracted) return Object.keys(meta).length ? meta : null;

  const previous = isRecord(meta.extracted) ? meta.extracted : null;
  meta.extracted = {
    title: extracted.title,
    description: extracted.description,
    icon: extracted.icon,
    image: extracted.image,
    lang: extracted.lang ?? null,
    themeColor: extracted.themeColor ?? null,
    surface: extracted.surface ?? null,
    fileHandlers: parseAppFileHandlers(extracted.fileHandlers),
    sourcePath: extracted.sourcePath ?? null,
    extractedAt: extracted.extractedAt ?? new Date().toISOString(),
  };

  // Legacy `name` counts as a hand-set title; promote it once and drop the duplicate.
  if (meta.title === undefined && meta.name !== undefined) meta.title = meta.name;
  delete meta.name;

  for (const field of Object.keys(EXTRACTED_FIELD_MAX) as ExtractedField[]) {
    const max = EXTRACTED_FIELD_MAX[field];
    const value = cleanAppMetaText(meta[field], max);
    const owned = ownedByExtraction(value, cleanAppMetaText(previous?.[field], max), field);
    // A weak media ref we own is still better than nothing when the page stops declaring one.
    const fallback = owned && (field === "icon" || field === "image") ? value : null;
    const next = owned ? (cleanAppMetaText(extracted[field], max) ?? fallback) : value;
    if (next) meta[field] = next;
    else delete meta[field];
  }

  const presentation = isRecord(meta.presentation) ? { ...meta.presentation } : {};
  const surface = typeof presentation.surface === "string" ? presentation.surface : null;
  const previousSurface = typeof previous?.surface === "string" ? previous.surface : null;
  if (surface === null || surface === previousSurface) {
    if (extracted.surface && extracted.surface !== "window") presentation.surface = extracted.surface;
    else delete presentation.surface;
  }
  if (Object.keys(presentation).length) meta.presentation = presentation;
  else delete meta.presentation;

  // File handlers follow the page like surface does; a hand-set list wins.
  const handlers = meta.fileHandlers === undefined ? null : parseAppFileHandlers(meta.fileHandlers);
  const previousHandlers = previous ? parseAppFileHandlers(previous.fileHandlers) : [];
  if (handlers === null || sameList(handlers, previousHandlers)) {
    const next = parseAppFileHandlers(extracted.fileHandlers);
    if (next.length) meta.fileHandlers = next;
    else delete meta.fileHandlers;
  } else {
    meta.fileHandlers = handlers;
  }

  return Object.keys(meta).length ? meta : null;
}
