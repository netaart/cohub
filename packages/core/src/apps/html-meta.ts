/** Lightweight HTML head parsing for App page presentation fields. */

import { APP_FILE_HANDLERS_META_NAME, parseAppFileHandlers } from "@cohub/protocol";

export type HtmlPageMeta = {
  title: string | null;
  description: string | null;
  /** Site-relative path, root-absolute path, or absolute URL. */
  icon: string | null;
  image: string | null;
  /** BCP 47 language tag from <html lang> or og:locale. */
  lang: string | null;
    /** CSS color from meta theme-color. */
  themeColor: string | null;
  /** Preferred desktop surface from `<meta name="cohub:surface">`. */
  surface: AppSurfaceRole | null;
  /** File extensions the App opens, from `<meta name="cohub:file-handlers">`. */
  fileHandlers: string[];
};

export type AppSurfaceRole = "window" | "overlay";

const SURFACE_ROLES: readonly AppSurfaceRole[] = ["window", "overlay"];

const MAX_HTML_SCAN = 200_000;
const MAX_FIELD = 500;
/** Inline icons (data:image/svg+xml,...) need more room than plain titles. */
const MAX_HREF_FIELD = 8_192;

const cleanText = (value: string | null | undefined, max = MAX_FIELD): string | null => {
  if (!value) return null;
  // Keep data URLs intact (no entity decode / whitespace collapse that would break them).
  if (/^data:/i.test(value.trim())) {
    const data = value.trim();
    return data.length > MAX_HREF_FIELD ? null : data;
  }
  const text = value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => {
      const n = Number(code);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      const n = Number.parseInt(hex, 16);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
    })
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};

const headSection = (html: string): string => {
  const slice = html.length > MAX_HTML_SCAN ? html.slice(0, MAX_HTML_SCAN) : html;
  const match = slice.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i);
  // Some tiny/hand-written pages omit <head>; fall back to the scanned prefix so
  // bare <title>/<meta> still work. Body tags may match, which is acceptable.
  return match?.[1] ?? slice;
};

const attr = (tag: string, name: string): string | null => {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const match = tag.match(re);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
};

const metaContent = (head: string, keys: string[]): string | null => {
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  const re = /<meta\b[^>]*>/gi;
  for (const match of head.matchAll(re)) {
    const tag = match[0];
    const key = (attr(tag, "property") ?? attr(tag, "name") ?? "").trim().toLowerCase();
    if (!wanted.has(key)) continue;
    const content = cleanText(attr(tag, "content"));
    if (content) return content;
  }
  return null;
};

const firstTitle = (head: string): string | null => {
  const match = head.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return cleanText(match?.[1]?.replace(/<[^>]+>/g, " ") ?? null);
};

const iconHref = (head: string): string | null => {
  const re = /<link\b[^>]*>/gi;
  const ranked: Array<{ rank: number; href: string }> = [];
  for (const match of head.matchAll(re)) {
    const tag = match[0];
    const rel = (attr(tag, "rel") ?? "").toLowerCase();
    if (!rel) continue;
    const relTokens = new Set(rel.split(/\s+/).filter(Boolean));
    const isIcon =
      relTokens.has("icon") ||
      relTokens.has("shortcut") ||
      relTokens.has("apple-touch-icon") ||
      relTokens.has("apple-touch-icon-precomposed") ||
      relTokens.has("mask-icon");
    if (!isIcon) continue;
    const href = cleanText(attr(tag, "href"), MAX_HREF_FIELD);
    if (!href) continue;
    let rank = 50;
    if (relTokens.has("apple-touch-icon") || relTokens.has("apple-touch-icon-precomposed")) rank = 10;
    else if (relTokens.has("mask-icon")) rank = 30;
    else if (relTokens.has("icon") || relTokens.has("shortcut")) rank = 20;
    const sizes = (attr(tag, "sizes") ?? "").toLowerCase();
    if (sizes.includes("512")) rank -= 3;
    else if (sizes.includes("192") || sizes.includes("180")) rank -= 2;
    ranked.push({ rank, href });
  }
  ranked.sort((a, b) => a.rank - b.rank);
  return ranked[0]?.href ?? null;
};

/** Normalize free-form lang / og:locale into a short BCP 47-ish tag (e.g. zh-CN). */
export function normalizeHtmlLang(value: string | null | undefined): string | null {
  const raw = cleanText(value, 32);
  if (!raw) return null;
  // og:locale uses underscore; HTML lang uses hyphen.
  const tag = raw.replace(/_/g, "-").replace(/\s+/g, "");
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(tag)) return null;
  const parts = tag.split("-");
  const normalized = parts
    .map((part, index) => {
      if (index === 0) return part.toLowerCase();
      if (part.length === 4) return `${part[0]?.toUpperCase() ?? ""}${part.slice(1).toLowerCase()}`;
      if (part.length === 2 || part.length === 3) return part.toUpperCase();
      return part;
    })
    .join("-");
  return normalized;
}

/** Convert HTML lang (zh-CN) to Open Graph locale (zh_CN). */
export function htmlLangToOgLocale(lang: string | null | undefined): string | null {
  const normalized = normalizeHtmlLang(lang);
  if (!normalized) return null;
  return normalized.replace(/-/g, "_");
}

const documentLang = (html: string): string | null => {
  const slice = html.length > MAX_HTML_SCAN ? html.slice(0, MAX_HTML_SCAN) : html;
  const match = slice.match(/<html\b[^>]*\blang\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  return normalizeHtmlLang(match?.[1] ?? match?.[2] ?? match?.[3] ?? null);
};

const themeColorValue = (head: string): string | null => {
  const content = metaContent(head, ["theme-color"]);
  if (!content) return null;
  // Keep common CSS color tokens only (hex / rgb / named-ish).
  if (content.length > 64) return null;
  if (/[<>"']/.test(content)) return null;
  return content;
};

const surfaceValue = (head: string): AppSurfaceRole | null => {
  const content = metaContent(head, ["cohub:surface"])?.toLowerCase();
  return SURFACE_ROLES.includes(content as AppSurfaceRole) ? (content as AppSurfaceRole) : null;
};

const fileHandlersValue = (head: string): string[] =>
  parseAppFileHandlers(metaContent(head, [APP_FILE_HANDLERS_META_NAME]));

/**
 * Extract title / description / icon / image / lang / theme-color / surface / file handlers from HTML without executing it.
 * Prefers document title and standard meta / link tags.
 */
export function extractHtmlPageMeta(html: string): HtmlPageMeta {
  const head = headSection(html);
  const lang =
    documentLang(html) ??
    normalizeHtmlLang(metaContent(head, ["og:locale", "language"]));
  return {
    title: firstTitle(head) ?? metaContent(head, ["og:title", "twitter:title"]),
    description: metaContent(head, [
      "description",
      "og:description",
      "twitter:description",
    ]),
    icon: iconHref(head),
    image: metaContent(head, ["og:image", "twitter:image", "og:image:url"]),
    lang,
    themeColor: themeColorValue(head),
    surface: surfaceValue(head),
    fileHandlers: fileHandlersValue(head),
  };
}

export const DEFAULT_PAGE_ICON_CANDIDATES = [
  "favicon.ico",
  "favicon.svg",
  "favicon.png",
  "apple-touch-icon.png",
  "apple-touch-icon-precomposed.png",
  "icon.svg",
  "icon.png",
] as const;

/**
 * Normalize a head asset ref into a site-relative path suitable for publish packing.
 * Absolute http(s) / protocol-relative / data / blob refs return null.
 */
export function normalizeLocalPageAssetRef(ref: string | null | undefined): string | null {
  if (typeof ref !== "string") return null;
  const value = ref.replace(/\\/g, "/").trim();
  if (!value) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//")) return null;
  const cleaned = value.replace(/^\.\//, "").replace(/^\/+/, "");
  if (!cleaned || cleaned.includes("\0")) return null;
  const parts = cleaned.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return parts.join("/");
}

/** Local asset refs we should try to pack next to a published HTML entry. */
export function collectLocalPageAssetRefs(meta: HtmlPageMeta): string[] {
  const refs = new Set<string>();
  const icon = normalizeLocalPageAssetRef(meta.icon);
  const image = normalizeLocalPageAssetRef(meta.image);
  if (icon) refs.add(icon);
  if (image) refs.add(image);
  if (!icon) {
    for (const candidate of DEFAULT_PAGE_ICON_CANDIDATES) refs.add(candidate);
  }
  return Array.from(refs);
}

/** Fill missing icon from common static filenames present in a site. */
export function fillIconFromSiteFiles(
  meta: HtmlPageMeta,
  relativePaths: Iterable<string>,
): HtmlPageMeta {
  if (meta.icon) return meta;
  const available = new Set(
    Array.from(relativePaths, (path) => path.replace(/^\/+/, "").toLowerCase()),
  );
  for (const candidate of DEFAULT_PAGE_ICON_CANDIDATES) {
    if (available.has(candidate)) {
      return { ...meta, icon: candidate };
    }
  }
  return meta;
}

export function emptyHtmlPageMeta(): HtmlPageMeta {
  return {
    title: null,
    description: null,
    icon: null,
    image: null,
       lang: null,
    themeColor: null,
    surface: null,
    fileHandlers: [],
  };
}
