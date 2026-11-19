import type { MediaItem } from "#lib/components/media-lightbox.svelte.ts";
import { durableMediaUrl, type MediaRef } from "./media-ask.svelte.ts";

type GalleryMedia = HTMLImageElement | HTMLVideoElement;

function videoSrc(video: HTMLVideoElement) {
	return (
		video.currentSrc ||
		video.getAttribute("src") ||
		video.querySelector("source")?.getAttribute("src") ||
		""
	);
}

function isGalleryMedia(media: GalleryMedia) {
	if (media.hidden || media.closest("a")) return false;
	if (media instanceof HTMLVideoElement) return Boolean(videoSrc(media));
	return Boolean(media.dataset.originalSrc || media.getAttribute("src"));
}

function videoItem(video: HTMLVideoElement): MediaItem {
	const caption = video
		.closest("figure")
		?.querySelector("figcaption")
		?.textContent?.trim();
	return {
		type: "video",
		src: videoSrc(video),
		poster: video.poster || undefined,
		title: caption || undefined,
		...(video.videoWidth
			? { width: video.videoWidth, height: video.videoHeight }
			: {}),
	};
}

function imageItem(img: HTMLImageElement): MediaItem {
	// Rendered images may be CDN variants; view and download the original.
	const src = img.dataset.originalSrc ?? img.src;
	const title = img.alt.trim() || undefined;
	const path = img.dataset.workspaceAssetSrc;
	const url = path ? undefined : durableMediaUrl(src);
	const ref: MediaRef | undefined =
		path || url
			? {
					...(path ? { path } : {}),
					...(url ? { url } : {}),
					...(title ? { title } : {}),
				}
			: undefined;
	return {
		type: "image",
		src,
		alt: img.alt,
		title,
		...(img.naturalWidth
			? { width: img.naturalWidth, height: img.naturalHeight }
			: {}),
		...(ref ? { ref } : {}),
	};
}

const mediaItem = (media: GalleryMedia) =>
	media instanceof HTMLVideoElement ? videoItem(media) : imageItem(media);

export function markdownGallery(media: GalleryMedia) {
	const scope =
		media.closest("[data-media-scope]") ?? media.closest(".markdown-content");
	const all = Array.from(
		(scope ?? media).querySelectorAll<GalleryMedia>(
			".markdown-content :is(img, video)",
		),
	).filter(isGalleryMedia);
	const index = all.indexOf(media);
	return index < 0
		? { items: [mediaItem(media)], index: 0 }
		: { items: all.map(mediaItem), index };
}
