import assert from "node:assert/strict";
import { DEFAULT_COMPACTION_SETTINGS, shouldCompact } from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateProxyContextTokens, FLAT_IMAGE_TOKEN_ESTIMATE, resolveReserveTokens } from "../runtime/compaction-policy.js";

const asMessages = (messages: unknown[]) => messages as AgentMessage[];

const textMessage = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const imageMessage = (base64Chars: number) => ({
  role: "user",
  content: [{ type: "image", data: "a".repeat(base64Chars), mimeType: "image/webp" }],
});

// ── Text is charged at the usual ~4 chars/token ──
assert.equal(estimateProxyContextTokens(asMessages([textMessage("a".repeat(400))])), 100);
assert.equal(estimateProxyContextTokens(asMessages([{ role: "user", content: "a".repeat(40) }])), 10);

// ── Images count as a flat bounded estimate, not their raw base64 length ──
// Models receive images bounded to 1280px, so per-image vision cost is
// predictable; base64 length is a text-billing proxy artifact that compaction
// accounting deliberately ignores (same approach as pi/codex).
assert.equal(estimateProxyContextTokens(asMessages([imageMessage(200_000)])), FLAT_IMAGE_TOKEN_ESTIMATE);
assert.equal(estimateProxyContextTokens(asMessages([imageMessage(20)])), FLAT_IMAGE_TOKEN_ESTIMATE);

// ── Mixed content sums both views ──
assert.equal(
  estimateProxyContextTokens(asMessages([textMessage("a".repeat(400)), imageMessage(1_000)])),
  100 + FLAT_IMAGE_TOKEN_ESTIMATE,
);

// ── Thinking blocks and unknown block shapes still contribute ──
assert.equal(
  estimateProxyContextTokens(asMessages([{ role: "assistant", content: [{ type: "thinking", thinking: "a".repeat(40) }] }])),
  10,
);
assert.ok(
  estimateProxyContextTokens(asMessages([{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "/tmp/x" } }] }])) > 0,
);

// ── Malformed content never throws ──
assert.equal(estimateProxyContextTokens(asMessages([{ role: "user" }])), 0);
assert.equal(estimateProxyContextTokens(asMessages([{ role: "user", content: null }])), 0);
assert.equal(estimateProxyContextTokens(asMessages([{ role: "user", content: [null, 42, "raw"] }])), 0);
assert.equal(estimateProxyContextTokens(asMessages([])), 0);

// ── Images without usable data are ignored rather than guessed at ──
assert.equal(estimateProxyContextTokens(asMessages([{ role: "user", content: [{ type: "image", mimeType: "image/webp" }] }])), 0);

// ── Image-heavy sessions estimate at flat per-image cost regardless of payload ──
// Session f17dad70: 45 normalized images plus ~324k chars of text. The proxy
// billed ~4.56M tokens for the base64 payloads, but accounting follows the
// bounded vision-cost model: text + 45 * flat image estimate.
const contextWindow = 1_000_000;
const settings = { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens: resolveReserveTokens(contextWindow) };
const imageHeavySession = asMessages([
  textMessage("a".repeat(324_000)),
  ...Array.from({ length: 45 }, () => imageMessage(196_074)),
]);

const proxyTokens = estimateProxyContextTokens(imageHeavySession);
assert.equal(proxyTokens, 324_000 / 4 + 45 * FLAT_IMAGE_TOKEN_ESTIMATE);
assert.equal(shouldCompact(Math.max(189_451, proxyTokens), contextWindow, settings), false);

// ── An image-free session is unaffected by flat image accounting ──
const textOnlySession = asMessages([textMessage("a".repeat(400_000))]);
assert.equal(estimateProxyContextTokens(textOnlySession), 100_000);
assert.equal(shouldCompact(Math.max(100_000, estimateProxyContextTokens(textOnlySession)), contextWindow, settings), false);

// ── Reserve tokens scale down for small windows, cap for large ones ──
assert.equal(resolveReserveTokens(1_000_000), 32_768);
assert.equal(resolveReserveTokens(8_000), 2_000);
assert.equal(resolveReserveTokens(0), 32_768);
assert.ok(resolveReserveTokens(4) >= 1);
