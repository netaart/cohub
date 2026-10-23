/**
 * Remote media delivery. Previews and metadata resolve through ordered
 * strategies — the cheapest trustworthy source first, each later one only
 * filling what the earlier ones left — so every consumer degrades the same way.
 *
 * URL rewrites happen locally without a request, so they apply only to hosts
 * known to serve Aliyun OSS processing; any other URL is used as is.
 */

import { type MediaInfo, mediaHost, ossProcessUrl } from "@cohub/protocol/core";

export {
	type MediaInfo,
	mediaInfoFromHeaders,
	mergeMediaInfo,
	ossProcessUrl,
	probeMediaInfo,
	probeMediaSize,
	probeVideoFrameSize,
} from "@cohub/protocol/core";

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


/** Snapshots render at the requested width, upscaling small videos; cap it. */
const VIDEO_FRAME_MAX_WIDTH = 768;

/** Fixed variant widths keep CDN cache hits high; pick with `mediaVariantSize`. */
export const MEDIA_VARIANT_SIZES = [192, 384, 768, 1536] as const;
export const MEDIA_VARIANT_MAX = 1536;
export type MediaVariantSize = (typeof MEDIA_VARIANT_SIZES)[number];

/** Smallest variant covering `pixels` device pixels, capped at the largest. */
export function mediaVariantSize(pixels: number): MediaVariantSize {
	return MEDIA_VARIANT_SIZES.find((size) => size >= pixels) ?? MEDIA_VARIANT_MAX;
}

function ossHost(url: string) {
	const host = mediaHost(url);
	return host?.transform === "oss" ? host : undefined;
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
	if (!ossHost(url) || /\.gif$/i.test(new URL(url).pathname)) return null;
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
	if (!ossHost(url)) return null;
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
