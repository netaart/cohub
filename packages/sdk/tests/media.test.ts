import assert from "node:assert/strict";
import test from "node:test";
import {
	imageVariantUrl,
	mediaInfoFromHeaders,
	mediaPreviewCandidates,
	mediaVariantSize,
	ossProcessUrl,
	probeMediaInfo,
	variantSource,
	videoFrameUrl,
} from "../src/media.js";

const OSS = "https://router-files.neta.art/files/a";
const video = `${OSS}/clip.mp4`;

test("rewrites only known OSS hosts and keeps query and hash", () => {
	assert.equal(imageVariantUrl("https://cdn.example.com/a.png", 192), null);
	assert.equal(imageVariantUrl("http://router-files.neta.art/a.png", 192), null);
	assert.equal(videoFrameUrl("data:video/mp4;base64,AAAA", 384), null);
	assert.equal(
		imageVariantUrl(`${OSS}/a.png`, 192, "cover"),
		`${OSS}/a.png?x-oss-process=image/resize,m_mfit,w_192,h_192/quality,q_82/format,webp`,
	);
	assert.equal(
		ossProcessUrl("https://public.cohub.live/a.png?v=1#top", "image/info"),
		"https://public.cohub.live/a.png?v=1&x-oss-process=image/info#top",
	);
	assert.equal(ossProcessUrl(`${OSS}/a.png?x-oss-process=x`, "y"), `${OSS}/a.png?x-oss-process=x`);
});

test("keeps GIFs original and traces variants back to their source", () => {
	assert.equal(imageVariantUrl(`${OSS}/loop.GIF`, 384), null);
	const frame = videoFrameUrl(`${video}?v=2`, 384) as string;
	assert.deepEqual(variantSource(frame), { url: `${video}?v=2`, type: "video" });
	assert.deepEqual(variantSource(imageVariantUrl(`${OSS}/a.png`, 192) as string), {
		url: `${OSS}/a.png`,
		type: "image",
	});
	assert.equal(variantSource(`${OSS}/a.png`), null);
	// Only the process parameter goes; everything else stays byte-for-byte.
	assert.deepEqual(variantSource(`${OSS}/a.png?x-oss-process=image/info&sig=a%2Cb#h`), {
		url: `${OSS}/a.png?sig=a%2Cb#h`,
		type: "image",
	});
	assert.deepEqual(variantSource(`${OSS}/a.png?sig=a%2Cb&x-oss-process=image/info#h`), {
		url: `${OSS}/a.png?sig=a%2Cb#h`,
		type: "image",
	});
});

test("picks the smallest covering variant size", () => {
	assert.equal(mediaVariantSize(100), 192);
	assert.equal(mediaVariantSize(192), 192);
	assert.equal(mediaVariantSize(500), 768);
	assert.equal(mediaVariantSize(9000), 1536);
});

test("orders previews: cover, video snapshot, then probed first frame", () => {
	assert.deepEqual(
		mediaPreviewCandidates(
			{ type: "video", url: video, previewUrl: `${OSS}/cover.jpg` },
			{ size: 192, fit: "cover" },
			{ firstFrameUrl: `${OSS}/first.webp` },
		),
		[
			imageVariantUrl(`${OSS}/cover.jpg`, 192, "cover"),
			`${OSS}/cover.jpg`,
			videoFrameUrl(video, 384),
			imageVariantUrl(`${OSS}/first.webp`, 192, "cover"),
			`${OSS}/first.webp`,
		],
	);
	assert.deepEqual(
		mediaPreviewCandidates({ type: "video", url: "https://cdn.example.com/v.mp4" }, { size: 384 }),
		[],
	);
	assert.deepEqual(
		mediaPreviewCandidates({ type: "image", url: "https://cdn.example.com/a.png" }, { size: 384 }),
		["https://cdn.example.com/a.png"],
	);
});

test("reads validated OSS meta headers", () => {
	const info = mediaInfoFromHeaders(
		new Headers({
			"content-type": "video/mp4",
			"content-length": "15152743",
			"x-oss-meta-width": "720",
			"x-oss-meta-height": "1280",
			"x-oss-meta-duration": "11.041667",
			"x-oss-meta-nb-frames": "265",
			"x-oss-meta-first-frame": `${OSS}/first.webp`,
			"x-oss-meta-last-frame": "https://evil.example.com/last.webp",
		}),
		video,
	);
	assert.deepEqual(info, {
		width: 720,
		height: 1280,
		durationMs: 11_042,
		frameCount: 265,
		firstFrameUrl: `${OSS}/first.webp`,
		mimeType: "video/mp4",
		bytes: 15_152_743,
	});
});

test("probes headers first and falls back to image info for dimensions", async () => {
	const requests: string[] = [];
	const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		requests.push(`${init?.method ?? "GET"} ${url}`);
		if (init?.method === "HEAD") return new Response(null, { headers: { "content-length": "2534723" } });
		return Response.json({ ImageWidth: { value: "940" }, ImageHeight: { value: "1672" } });
	}) as typeof globalThis.fetch;

	assert.deepEqual(await probeMediaInfo(`${OSS}/a.png`, { type: "image", fetch }), {
		width: 940,
		height: 1672,
		bytes: 2_534_723,
	});
	assert.deepEqual(requests, [`HEAD ${OSS}/a.png`, `GET ${OSS}/a.png?x-oss-process=image/info`]);
	assert.deepEqual(await probeMediaInfo("https://cdn.example.com/a.png", { type: "image", fetch }), {});

	const failing = (async () => {
		throw new Error("offline");
	}) as typeof globalThis.fetch;
	assert.deepEqual(await probeMediaInfo(video, { type: "video", fetch: failing }), {});
});
