import type { Command } from "commander";
import { createClient } from "../client.js";
import { handleHttp, json as outJson, jsonRequested, table } from "../output.js";
import { resolveSpace } from "../space.js";

export function registerSpaceWallet(spaces: Command): void {
  const wallet = spaces.command("wallet").description("Space wallet balance, recharge, and activity");
  wallet.command("balance").option("--json", "Output as JSON").action(async (opts: { json?: boolean }) => {
    try {
      const value = await createClient().space(await resolveSpace(spaces)).wallet.get();
      if (jsonRequested(opts)) return outJson(value);
      table([{ balance: `$${value.balanceUsd.toFixed(8)}`, usable: value.usable }], [{ key: "balance", label: "Balance" }, { key: "usable", label: "Usable" }]);
    } catch (cause) { handleHttp(cause); }
  });
  wallet.command("catalog").option("--json", "Output as JSON").action(async (opts: { json?: boolean }) => {
    try {
      const value = await createClient().space(await resolveSpace(spaces)).wallet.catalog();
      if (jsonRequested(opts)) return outJson(value);
      table(value.products.map((product) => ({ key: product.key, name: product.name, price: product.pricing.amountUsd })), [{ key: "key", label: "Product" }, { key: "name", label: "Name" }, { key: "price", label: "Price (USD)" }]);
    } catch (cause) { handleHttp(cause); }
  });
  wallet.command("activity").option("--page <page>", "Page number", "1").option("--json", "Output as JSON").action(async (opts: { page: string; json?: boolean }) => {
    try {
      const page = Number(opts.page);
      if (!Number.isInteger(page) || page < 1 || page > 10_000) throw new Error("Page must be an integer between 1 and 10000");
      const value = await createClient().space(await resolveSpace(spaces)).wallet.activities(page);
      if (jsonRequested(opts)) return outJson(value);
      table(value.items, [{ key: "title", label: "Activity" }, { key: "amountUsd", label: "Amount (USD)" }, { key: "actorUserId", label: "User" }, { key: "createdAt", label: "Date" }]);
    } catch (cause) { handleHttp(cause); }
  });
  wallet.command("recharge <product>").requiredOption("--request-id <uuid>", "Stable UUID; reuse when retrying this recharge").option("--json", "Output as JSON").action(async (productKey: string, opts: { requestId: string; json?: boolean }) => {
    try {
      const value = await createClient().space(await resolveSpace(spaces)).wallet.createOrder({ id: opts.requestId, productKey });
      if (jsonRequested(opts)) return outJson(value);
      if (!value.checkout.checkoutUsable || !value.checkout.checkoutUrl) throw new Error(value.checkout.message ?? "Checkout is unavailable");
      console.log(value.checkout.checkoutUrl);
      console.log(`Order: ${value.orderId}`);
    } catch (cause) { handleHttp(cause); }
  });
  wallet.command("confirm <order>").action(async (orderId: string) => {
    try { outJson(await createClient().space(await resolveSpace(spaces)).wallet.confirmOrder(orderId)); }
    catch (cause) { handleHttp(cause); }
  });
}
