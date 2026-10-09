/**
 * Payload handoff for the image viewer route.
 *
 * Image URIs can be base64 data URIs, which must not travel through serializable
 * route params (they would bloat the navigation state and deep links). The gallery
 * writes the payload here and the route reads it once on mount.
 */
export type ImageViewerPayload = { uris: string[]; index: number };

let payload: ImageViewerPayload | null = null;

export function setImageViewerPayload(next: ImageViewerPayload) {
  payload = next;
}

export function getImageViewerPayload() {
  return payload;
}

export function clearImageViewerPayload() {
  payload = null;
}

/**
 * Nearest page for a paginated gallery. A native scroll handler must not turn an absent
 * page width into a NaN index, and a rubber-band offset must not point past the loaded
 * pages; an unusable offset leaves the current page alone.
 */
export function imageViewerPageIndex(offsetX: number, pageWidth: number, pageCount: number): number | null {
  if (!Number.isFinite(offsetX) || !Number.isFinite(pageWidth) || pageWidth <= 0 || pageCount <= 0) return null;
  return Math.min(Math.max(Math.round(offsetX / pageWidth), 0), pageCount - 1);
}
