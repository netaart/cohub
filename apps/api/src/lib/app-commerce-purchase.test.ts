import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAppPurchaseIdempotencyKey,
  normalizePurchaseAttemptId,
  resolvePurchaseReturnUrl,
  toPromotionMoney,
} from "./app-commerce-purchase.js";
import { buildAppCheckoutReturnUrls } from "./space-commerce.js";

test("checkout accepts only this App's HTTPS page or bound origins", async () => {
  const appId = "00000000-0000-4000-8000-000000000001";
  const publicAppUrl = "https://cohub.live/owner/space/w/shop";
  const resolve = (url: unknown) => resolvePurchaseReturnUrl(url, {
    publicAppUrl, appId, hostTemplate: "{id}.apps.test",
  }, async (host) => host === "shop.neta.art" ? { appId, active: true }
    : host === "pending.test" ? { appId, active: false }
    : host === "other.test" ? { appId: "other", active: true } : null);
  assert.equal(await resolve(`${publicAppUrl}?cart=1#done`), `${publicAppUrl}?cart=1#done`);
  const managed = `https://${appId}.apps.test/cart`;
  assert.equal(await resolve(managed), managed);
  for (const invalid of [null, "/cart", `${publicAppUrl}-other`, "http://shop.neta.art/cart",
    "https://shop.neta.art:8443", "https://other.test", "https://pending.test", "https://unbound.test"]) {
    assert.equal(await resolve(invalid), null, String(invalid));
  }
  const appUrl = await resolve("https://SHOP.neta.art:443/cart?item=1#/done");
  assert.ok(appUrl);
  assert.deepEqual(buildAppCheckoutReturnUrls({ appUrl }), {
    successRedirectUrl: "https://shop.neta.art/cart?item=1&cohub_checkout=success#/done",
    failedRedirectUrl: "https://shop.neta.art/cart?item=1&cohub_checkout=failed#/done",
    cancelRedirectUrl: "https://shop.neta.art/cart?item=1&cohub_checkout=cancel#/done",
  });
});

test("normalizes valid Work purchase attempt ids", () => {
  assert.equal(normalizePurchaseAttemptId(" attempt_123 "), "attempt_123");
  assert.equal(normalizePurchaseAttemptId("a".repeat(128)), "a".repeat(128));
});

test("rejects invalid Work purchase attempt ids", () => {
  assert.equal(normalizePurchaseAttemptId(undefined), null);
  assert.equal(normalizePurchaseAttemptId(""), null);
  assert.equal(normalizePurchaseAttemptId("attempt.with.dot"), null);
  assert.equal(normalizePurchaseAttemptId("a".repeat(129)), null);
});

test("converts Billing minor amounts with the currency exponent", () => {
  assert.deepEqual(toPromotionMoney(1234, "usd"), { value: 12.34, currency: "USD" });
  assert.deepEqual(toPromotionMoney(1234, "JPY"), { value: 1234, currency: "JPY" });
  assert.equal(toPromotionMoney(-1, "USD"), null);
  assert.equal(toPromotionMoney(100, "invalid"), null);
});

test("builds stable, context-scoped Work purchase idempotency keys", () => {
  const input = {
    appId: "work-1",
    buyerUserUuid: "buyer-1",
    productKey: "balance-pack",
    purchaseAttemptId: "attempt-1",
  };
  const key = createAppPurchaseIdempotencyKey(input);

  assert.equal(key, createAppPurchaseIdempotencyKey(input));
  assert.match(key, /^cohub-work-purchase-v1-[a-f0-9]{64}$/);
  assert.notEqual(
    key,
    createAppPurchaseIdempotencyKey({ ...input, buyerUserUuid: "buyer-2" }),
  );
  assert.notEqual(
    key,
    createAppPurchaseIdempotencyKey({ ...input, productKey: "other-pack" }),
  );
});
