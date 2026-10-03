import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { getRemoteImageUrl, restoreRemoteImageUrls, urlToPiImage } from "@cohub/model-runtime/image-content";
import { createModelsFromRegistry } from "@cohub/model-runtime/pi-models-adapter";
import { clearRemoteImageCache, prepareRemoteImagesForModel } from "../runtime/image-transport.js";

const url = "https://public.cohub.test/chat-attachments/image.png";
const marker = urlToPiImage(url);
const context: Context = { messages: [
  { role: "user", content: [{ type: "text", text: "Inspect this." }, marker], timestamp: 0 },
  { role: "toolResult", toolCallId: "tool-1", toolName: "read", content: [marker], isError: false, timestamp: 0 },
] };

function modelFor(api: Api): Model<Api> {
  return {
    api, id: "test-model", provider: "test", name: "Test", baseUrl: "https://provider.test/v1",
    input: ["text", "image"], reasoning: false, contextWindow: 32000, maxTokens: 2048,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

test("large Anthropic image batches use uploaded 2000px URLs and keep 2048px history intact", async () => {
  const input: Context = { messages: [{ role: "user", content: Array.from({ length: 21 }, () => marker), timestamp: 0 }] };
  const original = structuredClone(input);
  const data = await sharp({ create: { width: 2048, height: 1024, channels: 3, background: "red" } }).png().toBuffer();
  let reads = 0, uploads = 0;
  const cacheKey = {};
  const options = {
    cacheKey,
    read: async () => { reads++; return { data, mimeType: "image/png" }; },
    writeImage: async (image: { data: Buffer }) => {
      uploads++;
      const metadata = await sharp(image.data).metadata();
      assert.equal(metadata.width, 2000);
      assert.equal(metadata.height, 1000);
      return `${url}?edge=2000`;
    },
  };
  const model = modelFor("anthropic-messages");
  const prepared = await prepareRemoteImagesForModel(input, model, options);
  assert.deepEqual(input, original);
  const content = prepared.messages[0]?.content;
  assert(Array.isArray(content));
  for (const image of content) {
    assert.equal(image.type, "image");
    assert.equal(getRemoteImageUrl(image), `${url}?edge=2000`);
  }
  assert.deepEqual(await prepareRemoteImagesForModel(input, model, options), prepared);
  assert.equal(reads, 1);
  assert.equal(uploads, 1);
  const payload = JSON.stringify(await capturePayload(model, prepared));
  assert(payload.includes(`${url}?edge=2000`));
  assert(!payload.includes("data:image"));
  assert(!payload.includes(marker.mimeType));
  clearRemoteImageCache(cacheKey);
});

async function capturePayload(model: Model<Api>, input: Context): Promise<unknown> {
  const apiKey = model.api === "openai-codex-responses"
    ? `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.test`
    : "test-api-key";
  const models = createModelsFromRegistry({
    getAvailable: () => [model], getApiKey: () => apiKey, getHeaders: () => undefined,
  });
  let payload: unknown;
  const response = await models.completeSimple(model, input, {
    apiKey,
    onPayload: (value) => {
      payload = restoreRemoteImageUrls(value);
      throw new Error("Payload captured before network");
    },
  });
  assert.notEqual(payload, undefined, response.errorMessage ?? "No provider payload");
  assert.match(response.errorMessage ?? "", /Payload captured before network/);
  return payload;
}

for (const api of ["anthropic-messages", "openai-completions", "openai-responses", "openai-codex-responses", "azure-openai-responses", "mistral-conversations"] as const) {
  test(`${api} serializes URL images with the installed pi SDK and never downloads them`, async () => {
    const model = modelFor(api);
    const prepared = await prepareRemoteImagesForModel(context, model, { read: async () => { throw new Error("Unexpected image download"); } });
    assert.equal(prepared, context);
    const payload = await capturePayload(model, prepared);
    const serialized = JSON.stringify(payload);
    assert(serialized.includes(url));
    assert(!serialized.includes(marker.data));
    assert(!serialized.includes(marker.mimeType));
    if (api.endsWith("responses")) assert(serialized.includes(`"image_url":"${url}"`));
    if (api === "anthropic-messages") assert(serialized.includes(`"source":{"type":"url","url":"${url}"}`));
  });
}

for (const api of ["google-generative-ai", "google-vertex", "bedrock-converse-stream"] as const) {
  test(`${api} receives valid image bytes while the history retains URL markers`, async () => {
    const original = structuredClone(context);
    const model = modelFor(api);
    let reads = 0;
    const data = await sharp({ create: { width: 32, height: 24, channels: 3, background: "red" } }).png().toBuffer();
    const cacheKey = {};
    const prepared = await prepareRemoteImagesForModel(context, model, { cacheKey, read: async (requested) => {
      reads++;
      assert.equal(requested, url);
      return { data, mimeType: "image/png" };
    } });
    const nextRound = await prepareRemoteImagesForModel(structuredClone(context), model, { cacheKey, read: async () => { throw new Error("Should use cached image bytes"); } });
    assert.deepEqual(nextRound, prepared);
    assert.equal(reads, 1, "user and tool copies share one download per request");
    assert.deepEqual(context, original);
    const user = prepared.messages[0];
    assert(user?.role === "user" && Array.isArray(user.content));
    const image = user.content[1];
    assert(image?.type === "image");
    const bytes = Buffer.from(image.data, "base64");
    assert.deepEqual(bytes, data);
    assert.equal((await sharp(bytes).metadata()).format, "png");
    const payload = await capturePayload(model, prepared);
    const serialized = JSON.stringify(payload);
    assert(!serialized.includes(marker.mimeType));
    assert(!serialized.includes(marker.data));
    assert(!serialized.includes(url));
    if (api.startsWith("google")) assert(serialized.includes(`"mimeType":"image/png","data":"${image.data}"`));
    else {
      assert(payload && typeof payload === "object" && "messages" in payload && Array.isArray(payload.messages));
      const sent = payload.messages[0].content.find((part: { image?: unknown }) => part.image)?.image;
      assert.equal(sent.format, "png");
      assert.deepEqual(Buffer.from(sent.source.bytes), bytes);
    }
    assert.equal(await prepareRemoteImagesForModel(context, modelFor("anthropic-messages")), context, "switching back keeps the original remote images");
  });
}

test("byte-only APIs omit failed and malformed URL markers instead of sending fake image bytes", async () => {
  const broken: Context = { messages: [{ role: "user", content: [marker, { ...marker, data: "" }], timestamp: 0 }] };
  for (const read of [async () => null, async () => { throw new Error("CDN unavailable"); }]) {
    const result = await prepareRemoteImagesForModel(broken, modelFor("google-generative-ai"), { read });
    const message = result.messages[0];
    assert(message?.role === "user" && Array.isArray(message.content));
    assert(message.content.every((part) => part.type === "text" && part.text.includes("Image omitted")));
  }
});

test("byte-only downloads are bounded across history and preserve block order", async () => {
  const input: Context = { messages: [{ role: "user", content: Array.from({ length: 7 }, (_, index) => urlToPiImage(`${url}?i=${index}`)), timestamp: 0 }] };
  let active = 0, maximum = 0, reads = 0;
  const result = await prepareRemoteImagesForModel(input, modelFor("google-generative-ai"), { read: async () => {
    active++; reads++; maximum = Math.max(active, maximum);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active--;
    return null;
  } });
  assert.equal(reads, 7);
  assert.equal(maximum, 4);
  assert.equal(result.messages[0]?.content.length, 7);
});

test("switching to URL or text-only models releases cached bytes before returning", async () => {
  const data = await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } }).png().toBuffer();
  const google = modelFor("google-generative-ai");
  const textModel: Model<Api> = { ...google, input: ["text"] };
  for (const target of [modelFor("anthropic-messages"), textModel]) {
    const cacheKey = {};
    let reads = 0;
    const options = { cacheKey, read: async () => { reads++; return { data, mimeType: "image/png" }; } };
    await prepareRemoteImagesForModel(context, google, options);
    await prepareRemoteImagesForModel(context, target, options);
    await prepareRemoteImagesForModel(context, google, options);
    assert.equal(reads, 2, "switching back downloads the released image again");
    clearRemoteImageCache(cacheKey);
    await prepareRemoteImagesForModel(context, google, options);
    assert.equal(reads, 3, "session disposal also releases the cache");
    clearRemoteImageCache(cacheKey);
  }
});

test("an already cancelled request neither downloads images nor returns a provider context", async () => {
  const controller = new AbortController();
  const reason = new Error("Turn stopped");
  controller.abort(reason);
  for (const api of ["google-generative-ai", "anthropic-messages"] as const) {
    let reads = 0;
    await assert.rejects(prepareRemoteImagesForModel(context, modelFor(api), {
      signal: controller.signal, read: async () => { reads++; return null; },
    }), (error) => error === reason);
    assert.equal(reads, 0);
  }
});

test("cancellation aborts active downloads, stops queued images, and never caches failure placeholders", async () => {
  const input: Context = { messages: [{ role: "user", content: Array.from({ length: 7 }, (_, index) => urlToPiImage(`${url}?i=${index}`)), timestamp: 0 }] };
  const controller = new AbortController();
  const cacheKey = {};
  let started = 0, stopped = 0;
  let markStarted: (() => void) | undefined;
  const allStarted = new Promise<void>((resolve) => { markStarted = resolve; });
  const running = prepareRemoteImagesForModel(input, modelFor("google-generative-ai"), {
    cacheKey, signal: controller.signal,
    read: async (_url, signal) => {
      assert.equal(signal, controller.signal);
      if (++started === 4) markStarted?.();
      return new Promise((_, reject) => signal?.addEventListener("abort", () => { stopped++; reject(signal.reason); }, { once: true }));
    },
  });
  await allStarted;
  const reason = new Error("Turn stopped");
  controller.abort(reason);
  await assert.rejects(running, (error) => error === reason);
  assert.equal(started, 4, "queued images must not start");
  assert.equal(stopped, 4);
  let retried = 0;
  await prepareRemoteImagesForModel(input, modelFor("google-generative-ai"), {
    cacheKey, read: async () => { retried++; return null; },
  });
  assert.equal(retried, 7, "a later turn can retry every cancelled image");
});

test("cancellation after a reader returns prevents normalization and caching", async () => {
  const controller = new AbortController();
  const cacheKey = {};
  const reason = new Error("Turn stopped during download");
  await assert.rejects(prepareRemoteImagesForModel(context, modelFor("google-generative-ai"), {
    cacheKey, signal: controller.signal,
    read: async () => { controller.abort(reason); return { data: Buffer.from("unused"), mimeType: "image/png" }; },
  }), (error) => error === reason);
  let reads = 0;
  await prepareRemoteImagesForModel(context, modelFor("google-generative-ai"), { cacheKey, read: async () => { reads++; return null; } });
  assert.equal(reads, 1);
});


test("Bedrock caps image bytes after provider switching and never reuses oversized Gemini cache entries", async () => {
  const data = await sharp(randomBytes(1150 * 1150 * 3), { raw: { width: 1150, height: 1150, channels: 3 } }).png().toBuffer();
  assert(data.length > 3_750_000 && data.length < 4 * 1024 * 1024);
  const input: Context = { messages: [{ role: "user", content: [marker], timestamp: 0 }] };
  const original = structuredClone(input);
  const cacheKey = {};
  let reads = 0;
  const options = { cacheKey, read: async () => { reads++; return { data, mimeType: "image/png" }; } };
  const google = await prepareRemoteImagesForModel(input, modelFor("google-generative-ai"), options);
  const googleContent = google.messages[0]?.content;
  assert(Array.isArray(googleContent) && googleContent[0]?.type === "image");
  assert.deepEqual(Buffer.from(googleContent[0].data, "base64"), data);
  const bedrockModel = modelFor("bedrock-converse-stream");
  const prepared = await prepareRemoteImagesForModel(input, bedrockModel, options);
  const content = prepared.messages[0]?.content;
  assert(Array.isArray(content) && content[0]?.type === "image");
  const bytes = Buffer.from(content[0].data, "base64");
  assert(bytes.length <= 3_750_000);
  await sharp(bytes).raw().toBuffer();
  assert.deepEqual(await prepareRemoteImagesForModel(input, bedrockModel, options), prepared);
  assert.equal(reads, 2, "Bedrock reuses only its own compliant request representation");
  const payload = await capturePayload(bedrockModel, prepared);
  assert(payload && typeof payload === "object" && "messages" in payload && Array.isArray(payload.messages));
  const sent = payload.messages[0].content.find((part: { image?: unknown }) => part.image)?.image;
  assert.deepEqual(Buffer.from(sent.source.bytes), bytes);
  assert.equal(sent.format, content[0].mimeType.slice("image/".length));
  assert.deepEqual(await prepareRemoteImagesForModel(input, modelFor("google-generative-ai"), options), google);
  assert.equal(reads, 3);
  assert.deepEqual(input, original);
  clearRemoteImageCache(cacheKey);
});
