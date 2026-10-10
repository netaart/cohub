/**
 * File-card snapshot derivation — pure, renderer-agnostic, dependency-free.
 *
 * Whoever holds the file content calls `buildFileSnapshot`; today that is the
 * web client, for cards near its viewport. Nothing here ever writes back to the
 * workspace file. The file on disk stays the single source of truth, and the
 * snapshot is a cache keyed by mtime so a stale card is detectable.
 */

/** Hard cap on a stored excerpt. Board cards show a few lines at most. */
export const FILE_EXCERPT_MAX_CHARS = 480;

/** Files above this size are shown as `blank`; we never pull them for a preview. */
export const FILE_EXCERPT_MAX_BYTES = 256 * 1024;

export type FileCategory = "doc" | "code" | "data" | "media" | "other";

export type BoardFileSnapshotFacts = {
	title?: string;
	mimeType?: string;
	size?: number;
	mtimeMs?: number;
	/** Cleaned leading prose, capped at FILE_EXCERPT_MAX_CHARS. */
	excerpt?: string;
	/** Cover declared as a path inside the space, resolved against the file's dir. */
	coverPath?: string;
	/** Cover declared as an absolute `https:` URL. */
	coverUrl?: string;
};

export type BuildSnapshotInput = {
	path: string;
	/** File text, when it could be read as text. Omit for binary/oversized. */
	content?: string | null;
	title?: string;
	mimeType?: string | null;
	size?: number;
	mtimeMs?: number;
};

const TITLE_KEYS = ["title", "name", "label", "heading"] as const;
const COVER_KEYS = [
	"cover",
	"coverImage",
	"cover_image",
	"image",
	"banner",
	"thumbnail",
	"ogImage",
	"og:image",
	"hero",
	"poster",
	"featured_image",
	"header_image",
	"icon",
	"avatar",
] as const;
const COVER_FALLBACK_KEYS = new Set(["icon", "avatar"]);
const NESTED_COVER_KEYS = ["src", "url", "path"] as const;
const DESCRIPTION_KEYS = ["description", "summary", "abstract"] as const;

const DOC_EXTENSIONS = new Set([
	"md",
	"mdx",
	"markdown",
	"txt",
	"rst",
	"adoc",
	"org",
]);
const DATA_EXTENSIONS = new Set([
	"json",
	"jsonc",
	"jsonl",
	"yaml",
	"yml",
	"toml",
	"csv",
	"tsv",
	"xml",
	"ndjson",
]);
const CODE_EXTENSIONS = new Set([
	"ts",
	"tsx",
	"js",
	"jsx",
	"mjs",
	"cjs",
	"py",
	"go",
	"rs",
	"java",
	"kt",
	"swift",
	"rb",
	"php",
	"c",
	"h",
	"hh",
	"hpp",
	"cpp",
	"cc",
	"cs",
	"scala",
	"lua",
	"sh",
	"bash",
	"zsh",
	"fish",
	"vue",
	"svelte",
	"css",
	"scss",
	"less",
	"html",
	"htm",
	"sql",
	"graphql",
	"proto",
	"zig",
	"dart",
	"r",
]);
const MEDIA_EXTENSIONS = new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"avif",
	"svg",
	"bmp",
	"ico",
	"mp4",
	"webm",
	"mov",
	"m4v",
	"mp3",
	"wav",
	"ogg",
	"m4a",
	"flac",
	"aac",
	"pdf",
	"zip",
	"gz",
	"tgz",
]);

const IMAGE_REF_RE = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)(\?|#|$)/i;

function extensionOf(path: string): string {
	const name = path.split("/").filter(Boolean).pop() ?? path;
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return "";
	return name.slice(dot + 1).toLowerCase();
}

function normalizeMime(mimeType: string | null | undefined): string {
	if (!mimeType) return "";
	return mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
}

/** Classify a file so excerpt, title and colour can vary without a second source of truth. */
export function fileCategory(
	path: string,
	mimeType?: string | null,
): FileCategory {
	const mime = normalizeMime(mimeType);
	if (mime) {
		if (
			mime === "text/markdown" ||
			mime === "text/x-markdown" ||
			mime === "text/plain" ||
			mime === "text/x-rst"
		)
			return "doc";
		if (
			mime === "application/json" ||
			mime === "application/yaml" ||
			mime === "application/x-yaml" ||
			mime === "application/toml" ||
			mime === "application/csv" ||
			mime === "application/xml" ||
			mime === "text/csv" ||
			mime === "text/xml" ||
			mime === "text/yaml" ||
			mime === "application/x-ndjson"
		)
			return "data";
		if (
			mime.startsWith("image/") ||
			mime.startsWith("video/") ||
			mime.startsWith("audio/") ||
			mime === "application/pdf" ||
			mime === "application/zip" ||
			mime === "application/gzip"
		)
			return "media";
		if (
			mime.startsWith("text/x-") ||
			mime === "application/javascript" ||
			mime === "application/typescript" ||
			mime === "text/javascript" ||
			mime === "text/css" ||
			mime === "text/html" ||
			mime === "application/sql"
		)
			return "code";
	}
	const ext = extensionOf(path);
	if (DOC_EXTENSIONS.has(ext)) return "doc";
	if (DATA_EXTENSIONS.has(ext)) return "data";
	if (CODE_EXTENSIONS.has(ext)) return "code";
	if (MEDIA_EXTENSIONS.has(ext)) return "media";
	if (mime.startsWith("text/")) return "doc";
	return "other";
}

/** Basename of a path, used as a last-resort card title. */
export function fileBaseName(path: string): string {
	return path.split("/").filter(Boolean).pop() ?? path;
}

/** Basename with a trailing extension stripped. Dotfiles keep their full name. */
export function fileStem(path: string): string {
	const name = fileBaseName(path);
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return name;
	return name.slice(0, dot);
}

// ─── Cover resolution ───────────────────────────────────────────────

export type ResolvedCover =
	| { kind: "url"; url: string }
	| { kind: "path"; path: string }
	| null;

/** Normalise a space-relative path: resolve `.`/`..` against the file's dir. */
export function resolveSpacePath(fromFilePath: string, ref: string): string {
	const base = ref.startsWith("/")
		? []
		: fromFilePath.split("/").slice(0, -1).filter(Boolean);
	const segments = ref.replace(/^\//, "").split("/");
	const out = [...base];
	for (const segment of segments) {
		if (!segment || segment === ".") continue;
		if (segment === "..") {
			out.pop();
			continue;
		}
		out.push(segment);
	}
	return out.join("/");
}

function looksLikeCoverRef(value: string): boolean {
	const trimmed = value.trim();
	if (!trimmed) return false;
	if (
		trimmed.startsWith("/") ||
		trimmed.startsWith("./") ||
		trimmed.startsWith("../") ||
		trimmed.startsWith("http://") ||
		trimmed.startsWith("https://") ||
		trimmed.startsWith("//")
	)
		return true;
	if (trimmed.includes("/")) return true;
	return IMAGE_REF_RE.test(trimmed);
}

/**
 * Classify a raw cover reference from frontmatter.
 *
 * Remote covers are allowed on purpose — a lot of real markdown points at a CDN.
 * `http:` / `data:` / `blob:` are rejected so a board never downgrades the page
 * or embeds opaque bytes.
 */
export function resolveCoverRef(
	fromFilePath: string,
	raw: string | undefined | null,
): ResolvedCover {
	const value = (raw ?? "").trim();
	if (!value) return null;
	if (value.startsWith("//")) return { kind: "url", url: `https:${value}` };
	const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
	if (scheme) {
		if (scheme === "https") return { kind: "url", url: value };
		return null;
	}
	const path = resolveSpacePath(fromFilePath, value);
	return path ? { kind: "path", path } : null;
}

// ─── Frontmatter ────────────────────────────────────────────────────

type SplitSource = { frontmatter: string | null; body: string };

function stripBom(source: string): string {
	return source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
}

function isFenceLine(line: string, fence: string): boolean {
	const trimmed = line.trim();
	if (trimmed === fence) return true;
	return fence === "---" && trimmed === "...";
}

/**
 * Split leading YAML (`---`) or TOML (`+++`) frontmatter from a source.
 *
 * BOM and leading blank lines are ignored. The closing fence may carry trailing
 * whitespace; YAML also accepts `...`. An unterminated block is treated as body.
 */
export function splitFrontmatter(source: string): SplitSource {
	const text = stripBom(source);
	const lines = text.split(/\r?\n/);
	let start = 0;
	while (start < lines.length && !(lines[start] ?? "").trim()) start += 1;
	const opener = (lines[start] ?? "").trim();
	if (opener !== "---" && opener !== "+++")
		return { frontmatter: null, body: text };
	for (let index = start + 1; index < lines.length; index += 1) {
		if (!isFenceLine(lines[index] ?? "", opener)) continue;
		return {
			frontmatter: lines.slice(start + 1, index).join("\n"),
			body: lines.slice(index + 1).join("\n"),
		};
	}
	return { frontmatter: null, body: text };
}

function unquote(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length < 2) return trimmed;
	const first = trimmed[0];
	const last = trimmed[trimmed.length - 1];
	if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function isBlockScalar(value: string): boolean {
	const trimmed = value.trim();
	return trimmed === ">" || trimmed === "|" || trimmed === ">-" || trimmed === "|-";
}

function scalarKeyValue(line: string): { key: string; value: string } | null {
	if (!line.trim() || /^\s/.test(line) || line.trimStart().startsWith("#"))
		return null;
	const match = /^([A-Za-z0-9_:.-]+)\s*[:=]\s*(.*)$/.exec(line);
	if (!match) return null;
	const key = match[1];
	if (!key) return null;
	return { key, value: unquote(match[2] ?? "") };
}

function readIndentedScalars(
	lines: string[],
	from: number,
): Map<string, string> {
	const found = new Map<string, string>();
	for (let index = from; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (!line.trim()) continue;
		if (!/^\s/.test(line)) break;
		const match = /^\s+([A-Za-z0-9_:.-]+)\s*[:=]\s*(.*)$/.exec(line);
		if (!match?.[1]) continue;
		const value = unquote(match[2] ?? "");
		if (value && !isBlockScalar(value) && !found.has(match[1])) {
			found.set(match[1], value);
		}
	}
	return found;
}

/** Read non-empty top-level scalar values from a frontmatter / YAML / TOML block. */
export function readFrontmatterScalars(
	frontmatter: string | null,
): Map<string, string> {
	const found = new Map<string, string>();
	if (!frontmatter) return found;
	const lines = frontmatter.split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		const parsed = scalarKeyValue(lines[index] ?? "");
		if (!parsed) continue;
		if (parsed.value && !isBlockScalar(parsed.value) && !found.has(parsed.key)) {
			found.set(parsed.key, parsed.value);
			continue;
		}
		if (!parsed.value && !found.has(parsed.key)) {
			const nested = readIndentedScalars(lines, index + 1);
			for (const nestedKey of NESTED_COVER_KEYS) {
				const nestedValue = nested.get(nestedKey);
				if (nestedValue) {
					found.set(parsed.key, nestedValue);
					break;
				}
			}
		}
	}
	return found;
}

export function readTitleFromFrontmatter(
	frontmatter: string | null,
): string | null {
	const found = readFrontmatterScalars(frontmatter);
	for (const key of TITLE_KEYS) {
		const value = found.get(key);
		if (value) return value;
	}
	return null;
}

export function readCoverFromFrontmatter(
	frontmatter: string | null,
): string | null {
	const found = readFrontmatterScalars(frontmatter);
	let fallback: string | null = null;
	for (const key of COVER_KEYS) {
		const value = found.get(key);
		if (!value) continue;
		if (COVER_FALLBACK_KEYS.has(key)) {
			fallback ??= value;
			continue;
		}
		if (key === "image" && !looksLikeCoverRef(value)) continue;
		return value;
	}
	return fallback;
}

function readDescriptionFromScalars(found: Map<string, string>): string | null {
	for (const key of DESCRIPTION_KEYS) {
		const value = found.get(key);
		if (value) return value;
	}
	return null;
}

// ─── Title ──────────────────────────────────────────────────────────

const ATX_H1 = /^(?:[ \t]*#[ \t]+)(.+?)\s*#*\s*$/;
const SETEXT_H1_UNDERLINE = /^[ \t]*=+[ \t]*$/;

function firstHeading(body: string): { title: string; body: string } | null {
	const lines = body.split(/\r?\n/);
	let index = 0;
	while (index < lines.length && !(lines[index] ?? "").trim()) index += 1;
	if (index >= lines.length) return null;
	const atx = ATX_H1.exec(lines[index] ?? "");
	if (atx?.[1]) {
		return {
			title: atx[1].trim(),
			body: [...lines.slice(0, index), ...lines.slice(index + 1)].join("\n"),
		};
	}
	const next = lines[index + 1] ?? "";
	if (SETEXT_H1_UNDERLINE.test(next) && (lines[index] ?? "").trim()) {
		return {
			title: (lines[index] ?? "").trim(),
			body: [...lines.slice(0, index), ...lines.slice(index + 2)].join("\n"),
		};
	}
	return null;
}

export function resolveFileTitle(input: {
	path: string;
	frontmatter: string | null;
	body: string;
	fallback?: string;
}): { title: string; body: string } {
	const fromFrontmatter = readTitleFromFrontmatter(input.frontmatter);
	if (fromFrontmatter) return { title: fromFrontmatter, body: input.body };
	const heading = firstHeading(input.body);
	if (heading) return heading;
	const fallback = input.fallback?.trim();
	return { title: fallback || fileStem(input.path), body: input.body };
}

// ─── Excerpt ────────────────────────────────────────────────────────

function collapseWhitespace(value: string, limit: number): string {
	const cleaned = value
		.replace(/\r\n?/g, "\n")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{2,}/g, "\n")
		.replace(/[ \t]*\n[ \t]*/g, "\n")
		.trim();
	if (cleaned.length <= limit) return cleaned;
	const slice = cleaned.slice(0, limit);
	const lastSpace = slice.lastIndexOf(" ");
	const cut = lastSpace > limit * 0.6 ? slice.slice(0, lastSpace) : slice;
	return `${cut.trimEnd()}…`;
}

/**
 * Reduce markdown to a short, readable excerpt.
 *
 * Decoration is flattened rather than rendered: fenced code is dropped, headings
 * and list markers go, links keep their text. Emphasis markers are only removed
 * when they wrap a span, so a stray `*` does not punch holes in the prose.
 */
export function buildFileExcerpt(
	source: string,
	limit = FILE_EXCERPT_MAX_CHARS,
): string {
	if (!source) return "";
	const withoutFences = source.replace(/```[\s\S]*?(?:```|$)/g, " ");
	const cleaned = withoutFences
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<\/?[a-z][^>]*>/gi, " ")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
		.replace(/^[ \t]*>[ \t]?/gm, "")
		.replace(/^[ \t]*[-*+][ \t]+/gm, "")
		.replace(/^[ \t]*\d+\.[ \t]+/gm, "")
		.replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, " ")
		.replace(/\|/g, " ")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/__([^_]+)__/g, "$1")
		.replace(/\*([^*\n]+)\*/g, "$1")
		.replace(/_([^_\n]+)_/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/~~([^~]+)~~/g, "$1");
	return collapseWhitespace(cleaned, limit);
}

function stripCommentDecor(block: string): string {
	return block
		.replace(/^\/\*+/, "")
		.replace(/\*+\/$/, "")
		.replace(/^#!.*$/m, "")
		.replace(/^[ \t]*(\/\/+|#|--|\*)[ \t]?/gm, "")
		.trim();
}

export function buildCodeExcerpt(
	source: string,
	limit = FILE_EXCERPT_MAX_CHARS,
): string {
	if (!source) return "";
	const text = stripBom(source);
	const leading = text.match(/^[ \t\r\n]*/)?.[0] ?? "";
	const rest = text.slice(leading.length);
	const block =
		rest.match(/^\/\*\*[\s\S]*?\*\//)?.[0] ??
		rest.match(/^\/\*[\s\S]*?\*\//)?.[0] ??
		rest.match(/^(?:[ \t]*\/\/[^\n]*(?:\n|$)){1,12}/)?.[0] ??
		rest.match(/^(?:[ \t]*#[^\n]*(?:\n|$)){1,12}/)?.[0] ??
		rest.match(/^(?:[ \t]*--[^\n]*(?:\n|$)){1,12}/)?.[0];
	if (!block) return "";
	return collapseWhitespace(stripCommentDecor(block), limit);
}

function readJsonScalars(source: string): Map<string, string> {
	const found = new Map<string, string>();
	const trimmed = source.trim();
	if (!trimmed.startsWith("{")) return found;
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			return found;
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof value === "string" && value.trim()) found.set(key, value.trim());
		}
	} catch {
		return found;
	}
	return found;
}

function dataScalars(path: string, source: string): Map<string, string> {
	const ext = extensionOf(path);
	if (ext === "json" || ext === "jsonc") return readJsonScalars(source);
	return readFrontmatterScalars(source);
}

function coverFromScalars(found: Map<string, string>): string | null {
	let fallback: string | null = null;
	for (const key of COVER_KEYS) {
		const value = found.get(key);
		if (!value) continue;
		if (COVER_FALLBACK_KEYS.has(key)) {
			fallback ??= value;
			continue;
		}
		if (key === "image" && !looksLikeCoverRef(value)) continue;
		return value;
	}
	return fallback;
}

function applyCover(
	snapshot: BoardFileSnapshotFacts,
	fromPath: string,
	raw: string | null,
) {
	const cover = resolveCoverRef(fromPath, raw);
	if (cover?.kind === "url") snapshot.coverUrl = cover.url;
	else if (cover?.kind === "path") snapshot.coverPath = cover.path;
}

/**
 * Build the cached display facts for a file node.
 *
 * Content is optional: a snapshot built without it still produces a usable
 * `blank` card, so a node can be created the instant a file is dropped and
 * enriched later without blocking on a read.
 */
export function buildFileSnapshot(
	input: BuildSnapshotInput,
): BoardFileSnapshotFacts {
	const category = fileCategory(input.path, input.mimeType);
	const snapshot: BoardFileSnapshotFacts = {
		title: input.title?.trim() || fileStem(input.path),
	};
	if (input.mimeType) snapshot.mimeType = input.mimeType;
	if (typeof input.size === "number" && Number.isFinite(input.size))
		snapshot.size = input.size;
	if (typeof input.mtimeMs === "number" && Number.isFinite(input.mtimeMs))
		snapshot.mtimeMs = input.mtimeMs;

	const content = input.content;
	if (typeof content !== "string" || content.length === 0) return snapshot;

	if (category === "data") {
		const found = dataScalars(input.path, content);
		const title =
			found.get("title") ?? found.get("name") ?? found.get("label");
		if (title) snapshot.title = title;
		applyCover(snapshot, input.path, coverFromScalars(found));
		const description = readDescriptionFromScalars(found);
		if (description) snapshot.excerpt = collapseWhitespace(description, FILE_EXCERPT_MAX_CHARS);
		return snapshot;
	}

	if (category === "code") {
		const excerpt = buildCodeExcerpt(content);
		if (excerpt) snapshot.excerpt = excerpt;
		return snapshot;
	}

	if (category === "doc") {
		const { frontmatter, body } = splitFrontmatter(content);
		const resolved = resolveFileTitle({
			path: input.path,
			frontmatter,
			body,
			fallback: input.title,
		});
		snapshot.title = resolved.title;
		applyCover(snapshot, input.path, readCoverFromFrontmatter(frontmatter));
		const excerpt = buildFileExcerpt(resolved.body);
		if (excerpt) snapshot.excerpt = excerpt;
		return snapshot;
	}

	const excerpt = collapseWhitespace(stripBom(content), FILE_EXCERPT_MAX_CHARS);
	if (excerpt) snapshot.excerpt = excerpt;
	return snapshot;
}

/** Whether a file is small enough that fetching a text preview is worthwhile. */
export function shouldFetchFileExcerpt(input: {
	mimeType?: string | null;
	size?: number;
}): boolean {
	if (input.size !== undefined && input.size > FILE_EXCERPT_MAX_BYTES)
		return false;
	return true;
}
