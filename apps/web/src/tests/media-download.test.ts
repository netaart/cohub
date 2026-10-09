import assert from "node:assert/strict";
import test from "node:test";
import { mediaFilename } from "$lib/media-download";

test("keeps an explicit filename that already has an extension", () => {
	assert.equal(
		mediaFilename({ src: "blob:x", type: "image", filename: "cat.webp" }),
		"cat.webp",
	);
});

test("takes the name from the URL path", () => {
	assert.equal(
		mediaFilename({
			src: "https://cdn.example.com/a/b/Sunset%20v2.png?sig=1",
			type: "image",
		}),
		"Sunset v2.png",
	);
});

test("adds an extension from the MIME type, data URL, or media type", () => {
	assert.equal(
		mediaFilename({
			src: "https://cdn.example.com/files/7f3a",
			type: "audio",
			mimeType: "audio/wav",
		}),
		"7f3a.wav",
	);
	assert.equal(
		mediaFilename({ src: "data:image/jpeg;base64,AAAA", type: "image" }),
		"image.jpg",
	);
	assert.equal(mediaFilename({ src: "blob:x", type: "video" }), "video.mp4");
});

test("strips path separators and reserved characters", () => {
	assert.equal(
		mediaFilename({ src: "blob:x", type: "image", filename: "a/b:c?.png" }),
		"a-b-c-.png",
	);
});
