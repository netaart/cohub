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
