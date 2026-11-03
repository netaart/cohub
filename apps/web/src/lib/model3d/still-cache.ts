const CACHE = "cohub-model-stills-v1";
const LIMIT = 64;

const request = (key: string) =>
	`https://cohub.invalid/model-still/${encodeURIComponent(key)}`;

const storage = () =>
	typeof caches === "undefined" ? null : caches.open(CACHE);

export async function readModelStill(key: string): Promise<ImageBitmap | null> {
	try {
		const response = await (await storage())?.match(request(key));
		return response ? await createImageBitmap(await response.blob()) : null;
	} catch {
		return null;
	}
}

export function saveModelStill(key: string, still: ImageBitmap): void {
	if (typeof caches === "undefined" || typeof OffscreenCanvas === "undefined")
		return;
	const canvas = new OffscreenCanvas(still.width, still.height);
	canvas.getContext("2d")?.drawImage(still, 0, 0);
	void (async () => {
		const blob = await canvas.convertToBlob({
			type: "image/webp",
			quality: 0.85,
		});
		const cache = await caches.open(CACHE);
		await cache.put(
			request(key),
			new Response(blob, { headers: { "Content-Type": blob.type } }),
		);
		const keys = await cache.keys();
		for (const stale of keys.slice(0, Math.max(0, keys.length - LIMIT)))
			await cache.delete(stale);
	})().catch(() => {});
}

export async function clearModelStills(): Promise<void> {
	if (typeof caches !== "undefined") await caches.delete(CACHE);
}
