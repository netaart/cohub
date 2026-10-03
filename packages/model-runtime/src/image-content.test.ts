import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isUrlMarkerImage,
  restoreRemoteImageUrls,
  urlToPiImage,
} from "./image-content.js";

const sampleUrl = "https://public.cohub.run/spaces/x/chat/a.webp";

// pi-ai models images as base64 only, so an Anthropic request built from a marker image looks
// like an ordinary base64 source that happens to carry the marker mime.
function anthropicPayloadFromMarker(url: string) {
  const image = urlToPiImage(url);
  return {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          {
            type: "image",
            source: { type: "base64", media_type: image.mimeType, data: image.data },
          },
        ],
      },
    ],
  };
}

test("urlToPiImage round-trips to an Anthropic remote URL source", () => {
  const image = urlToPiImage(sampleUrl);
  assert.equal(image.mimeType, "application/x-cohub-image-url");

  const restored = restoreRemoteImageUrls(anthropicPayloadFromMarker(sampleUrl)) as {
    messages: Array<{ content: Array<Record<string, unknown>> }>;
  };
  assert.deepEqual(restored.messages[0]?.content[1], {
    type: "image",
    source: { type: "url", url: sampleUrl },
  });
  assert.deepEqual(restored.messages[0]?.content[0], { type: "text", text: "what is this?" });
});

test("urlToPiImage round-trips through restoreRemoteImageUrls for OpenAI payloads", () => {
  const image = urlToPiImage(sampleUrl);
  const payload = {
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: `data:${image.mimeType};base64,${image.data}` },
          },
        ],
      },
    ],
  };
  const restored = restoreRemoteImageUrls(payload) as typeof payload;
  assert.deepEqual(restored.messages[0]?.content[0], {
    type: "image_url",
    image_url: { url: sampleUrl },
  });
});

test("isUrlMarkerImage recognizes only the marker mime", () => {
  assert.equal(isUrlMarkerImage("application/x-cohub-image-url"), true);
  assert.equal(isUrlMarkerImage("image/webp"), false);
  assert.equal(isUrlMarkerImage(null), false);
  assert.equal(isUrlMarkerImage(undefined), false);
});

test("restoreRemoteImageUrls leaves real base64 images untouched", () => {
  const payload = {
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/webp", data: "AAAA" } },
        ],
      },
    ],
  };
  assert.deepEqual(restoreRemoteImageUrls(payload), payload);
});

test("Responses image URLs remain strings, including nested tool outputs, and retain detail", () => {
  const marker = urlToPiImage(sampleUrl);
  const remote = { type: "input_image", image_url: `data:${marker.mimeType};base64,${marker.data}`, detail: "auto" };
  const payload = { input: [
    { role: "user", content: [remote] },
    { type: "function_call_output", call_id: "tool", output: [remote] },
    { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "high" }] },
  ] };
  const original = structuredClone(payload);
  assert.deepEqual(restoreRemoteImageUrls(payload), { input: [
    { role: "user", content: [{ ...remote, image_url: sampleUrl }] },
    { type: "function_call_output", call_id: "tool", output: [{ ...remote, image_url: sampleUrl }] },
    payload.input[2],
  ] });
  assert.deepEqual(payload, original);
});
