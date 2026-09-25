/**
 * Remote media delivery. Previews and metadata resolve through ordered
 * strategies — the cheapest trustworthy source first, each later one only
 * filling what the earlier ones left — so every consumer degrades the same way.
 *
 * URL rewrites happen locally without a request, so they apply only to hosts
 * known to serve Aliyun OSS processing; any other URL is used as is.
 */

export type MediaType = "image" | "video" | "audio";
/**
 * `cover` guarantees the short edge (square tiles), `contain` bounds the long
 * edge (viewers, textures), `width` bounds only the width, so flowing layouts
 * keep the original's rendered size.
 */
export type MediaFit = "cover" | "contain" | "width";

const RESIZE: Record<MediaFit, (size: number) => string> = {
	cover: (size) => `m_mfit,w_${size},h_${size}`,
	contain: (size) => `m_lfit,w_${size},h_${size}`,
	width: (size) => `w_${size}`,
};

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

type HostCapabilities = {
	/** Serves `x-oss-process` image resize and video snapshot. */
	process: true;
	/** Writes `x-oss-meta-*` media headers (dimensions, duration, frames). */
	metaHeaders: boolean;
};

const MEDIA_HOSTS: ReadonlyMap<string, HostCapabilities> = new Map([
	["router-files.neta.art", { process: true, metaHeaders: true }],
	["public.cohub.live", { process: true, metaHeaders: false }],
]);

/** Snapshots render at the requested width, upscaling small videos; cap it. */
const VIDEO_FRAME_MAX_WIDTH = 768;

/** Fixed variant widths keep CDN cache hits high; pick with `mediaVariantSize`. */
export const MEDIA_VARIANT_SIZES = [192, 384, 768, 1536] as const;
export type MediaVariantSize = (typeof MEDIA_VARIANT_SIZES)[number];

/** Smallest variant covering `pixels` device pixels, capped at the largest. */
export function mediaVariantSize(pixels: number): MediaVariantSize {
	return MEDIA_VARIANT_SIZES.find((size) => size >= pixels) ?? 1536;
}

function capabilities(url: string): HostCapabilities | undefined {
	if (!/^https:\/\//i.test(url)) return undefined;
	try {
		return MEDIA_HOSTS.get(new URL(url).hostname);
	} catch {
		return undefined;
	}
}

const OSS_PROCESS = /[?&]x-oss-process=/;

/** Append an OSS process to `url`, keeping its query and hash. */
export function ossProcessUrl(url: string, process: string): string {
	if (/^(data|blob):/i.test(url) || OSS_PROCESS.test(url)) return url;
	const hashIndex = url.indexOf("#");
	const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
	const hash = hashIndex >= 0 ? url.slice(hashIndex) : "";
	return `${base}${base.includes("?") ? "&" : "?"}x-oss-process=${process}${hash}`;
}

/**
 * A resized WebP of an image, fitted per `MediaFit`. Never enlarges. GIFs keep
 * their original, since a converted variant may lose the animation.
 */
export function imageVariantUrl(
	url: string,
	size: MediaVariantSize,
	fit: MediaFit = "contain",
): string | null {
	if (!capabilities(url) || /\.gif$/i.test(new URL(url).pathname)) return null;
	return ossProcessUrl(
		url,
		`image/resize,${RESIZE[fit](size)}/quality,q_82/format,webp`,
	);
}

/** A still JPEG of a video's first frame, `width` wide. */
export function videoFrameUrl(
	url: string,
	width: MediaVariantSize,
): string | null {
	if (!capabilities(url)) return null;
	return ossProcessUrl(url, `video/snapshot,t_0,f_jpg,w_${width},m_fast`);
}

/**
 * The media a CDN variant was derived from, to fall back to when processing
 * fails. Only the process parameter is cut, so the rest of the URL (signed
 * queries included) stays byte-for-byte.
 */
export function variantSource(url: string): { url: string; type: "image" | "video" } | null {
	const match = /([?&])x-oss-process=([^&#]*)/.exec(url);
	if (!match) return null;
	const [segment, separator, process = ""] = match;
	const head = url.slice(0, match.index);
	const tail = url.slice(match.index + segment.length);
	// A leading `?` passes to the next parameter, if any.
	const source = separator === "?" && tail.startsWith("&") ? `${head}?${tail.slice(1)}` : head + tail;
	return { url: source, type: process.startsWith("video/") ? "video" : "image" };
}

export type MediaPreviewSource = {
	type: MediaType;
	url?: string | null;
	/** Provider cover or poster: art chosen for the work, so it ranks first. */
	previewUrl?: string | null;
};

/**
 * Preview images to try in order: the provider cover (resized, then as is),
 * then a snapshot of the video itself, then the probed first frame.
 * An empty list means only the media element itself can render a frame.
 */
export function mediaPreviewCandidates(
	media: MediaPreviewSource,
	options: { size: MediaVariantSize; fit?: MediaFit },
	info?: Pick<MediaInfo, "firstFrameUrl">,
): string[] {
	const candidates: string[] = [];
	const add = (url: string | null | undefined) => {
		if (url && !candidates.includes(url)) candidates.push(url);
	};
	const addImage = (url: string | null | undefined) => {
		if (!url) return;
		add(imageVariantUrl(url, options.size, options.fit));
		add(url);
	};
	addImage(media.type === "image" ? media.url : media.previewUrl);
	if (media.type === "video" && media.url) {
		// A frame's width must cover a square tile for landscape video too.
		const width = options.fit === "cover" ? options.size * 2 : options.size;
		add(videoFrameUrl(media.url, mediaVariantSize(Math.min(width, VIDEO_FRAME_MAX_WIDTH))));
		addImage(info?.firstFrameUrl);
	}
	return candidates;
}

function positive(value: unknown): number | undefined {
	const number = typeof value === "string" ? Number(value) : value;
	return typeof number === "number" && Number.isFinite(number) && number > 0
		? number
		: undefined;
}

/** Frame URLs must stay on the media's own origin. */
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

/** Fields of `primary` win; `fallback` fills the rest. */
export function mergeMediaInfo(primary: MediaInfo, fallback: MediaInfo): MediaInfo {
	return compact({ ...fallback, ...compact(primary) });
}

function hasDimensions(info: MediaInfo) {
	return info.width !== undefined && info.height !== undefined;
}

type ProbeOptions = {
	type: MediaType;
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
	if (OSS_PROCESS.test(url)) return {};
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

/**
 * Probe remote media: OSS meta headers (one HEAD, the only source of video
 * duration and frames), then OSS `image/info` for image dimensions. Unknown
 * hosts and failed steps resolve to what was learned so far; never throws.
 */
export async function probeMediaInfo(
	url: string,
	options: ProbeOptions,
): Promise<MediaInfo> {
	const host = capabilities(url);
	if (!host) return {};
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
