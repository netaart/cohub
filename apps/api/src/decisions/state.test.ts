import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { prepareDecisionState } from "./state.js";

async function inline(file: string, mime: string, model: string) {
  const data = await readFile(new URL(`../../../web/static/${file}`, import.meta.url));
  const url = `data:${mime};base64,${data.toString("base64")}`;
  const state = await prepareDecisionState([{ type: "image_url", image_url: url }], { model });
  assert.ok(Array.isArray(state));
  const part = state[0];
  assert.ok(part && typeof part !== "string");
  return { original: url, encoded: part.image_url.url };
}

test("Jev preserves compliant PNGs and transcodes WebP; Luna preserves WebP", async () => {
  const png = await inline("pwa/icon-512x512.png", "image/png", "jev-latest");
  assert.equal(png.encoded, png.original);
  const jev = await inline("board/neta-studio.webp", "image/webp", "typesafe/jev-1.14");
  const response = await fetch(jev.encoded);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(response.headers.get("content-type") === "image/jpeg"
    ? bytes[0] === 0xff && bytes[1] === 0xd8
    : response.headers.get("content-type") === "image/png" && bytes.readUInt32BE(0) === 0x89504e47);
  const luna = await inline("board/neta-studio.webp", "image/webp", "openai/gpt-6-luna-decisions");
  assert.equal(luna.encoded, luna.original);
  await assert.rejects(inline("pwa/icon-192x192.png", "image/png", "jev-latest"), /at least 256 pixels/);
});
