import { LRUCache } from "lru-cache";
import type { ImageContent } from "@earendil-works/pi-ai";

type ImageKey = { url: string; session: Map<string, ImageKey> };

/** One process budget; entries are isolated by session and never retain the session owner. */
export class RemoteImageCache {
  private readonly sessions = new WeakMap<object, Map<string, ImageKey>>();
  private readonly images: LRUCache<ImageKey, ImageContent>;

  constructor(options: { maxBytes?: number; ttlMs?: number } = {}) {
    this.images = new LRUCache({
      max: 256,
      maxSize: options.maxBytes ?? 64 * 1024 * 1024,
      ttl: options.ttlMs ?? 5 * 60_000,
      ttlAutopurge: true,
      updateAgeOnGet: true,
      // Budget the encoded strings conservatively as UTF-16, rather than decoded image bytes.
      sizeCalculation: (image, key) => 2 * (image.data.length + image.mimeType.length + key.url.length),
      dispose: (_image, key) => { key.session.delete(key.url); },
    });
  }

  get retainedBytes() { return this.images.calculatedSize; }

  get(owner: object, url: string): ImageContent | undefined {
    const key = this.sessions.get(owner)?.get(url);
    return key ? this.images.get(key) : undefined;
  }

  set(owner: object, url: string, image: ImageContent): void {
    const session = this.sessions.get(owner) ?? new Map<string, ImageKey>();
    this.sessions.set(owner, session);
    const previous = session.get(url);
    if (previous) this.images.delete(previous);
    const key = { url, session };
    this.images.set(key, image);
    // Oversized entries are still usable by the current request, but are not retained.
    if (this.images.has(key)) session.set(url, key);
  }

  retain(owner: object, urls: ReadonlySet<string>): void {
    const session = this.sessions.get(owner);
    if (!session) return;
    for (const [url, key] of session) {
      if (!urls.has(url)) this.images.delete(key);
    }
  }
}
