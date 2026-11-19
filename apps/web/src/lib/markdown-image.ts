import { imageVariantUrl } from "@neta-art/cohub/media";

/** Wider than any message column, so a variant renders at the original's size. */
export const MARKDOWN_IMAGE_WIDTH = 1536;
const MARKDOWN_IMAGE_WIDTHS = [384, 768, MARKDOWN_IMAGE_WIDTH] as const;

export function markdownImageVariants(url: string) {
	const src = imageVariantUrl(url, MARKDOWN_IMAGE_WIDTH, "width");
	if (!src) return null;
	const srcset = MARKDOWN_IMAGE_WIDTHS.map(
		(width) => `${imageVariantUrl(url, width, "width")} ${width}w`,
	).join(", ");
	return { src, srcset };
}
