import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import { createClient } from "../client.js";
import { handleHttp, json as outJson, jsonRequested, ok, table, warn } from "../output.js";
import { resolveSpace } from "../space.js";

const usd = (value: number) => `$${value.toFixed(2)}`;
const uncertain = (cause: unknown) => {
  const status = (cause as { status?: number }).status;
  return !status || status >= 500;
};

function retryHint(command: string, requestId: string) {
  warn(`Result unknown. Retry with: ${command} --request-id ${requestId}`);
}

export function registerSpaceWallet(spaces: Command): void {
  const wallet = spaces.command("wallet").description("Space wallet balance, funding, and activity");
  const space = async () => createClient().space(await resolveSpace(spaces)).wallet;

  wallet.command("balance").option("--json", "Output as JSON").action(async (opts: { json?: boolean }) => {
    try {
      const value = await (await space()).get();
      if (jsonRequested(opts)) return outJson(value);
      table([{ balance: `$${value.balanceUsd.toFixed(8)}`, usable: value.usable }], [{ key: "balance", label: "Balance" }, { key: "usable", label: "Usable" }]);
    } catch (cause) { handleHttp(cause); }
  });

  wallet.command("funding").description("Funding tiers and your transferable balance").option("--json", "Output as JSON").action(async (opts: { json?: boolean }) => {
    try {
      const value = await (await space()).funding();
      if (jsonRequested(opts)) return outJson(value);
      table(value.tiers.map((tier) => ({ product: tier.productKey, amount: usd(tier.amountUsd), price: usd(tier.priceUsd) })), [{ key: "product", label: "Product" }, { key: "amount", label: "Credits" }, { key: "price", label: "Price" }]);
      console.log(`Public funding: ${value.publicFunding ? "on" : "off"}`);
      if (value.transfer) console.log(`Transferable balance: ${usd(value.transfer.allowanceUsd)} (whole dollars, ${usd(value.transfer.minUsd)}–${usd(value.transfer.maxUsd)})`);
    } catch (cause) { handleHttp(cause); }
  });

  wallet.command("public-funding <state>").description("Let anyone signed in fund this wallet (on|off)").action(async (state: string) => {
    try {
      if (state !== "on" && state !== "off") throw new Error("State must be on or off");
      await createClient().space(await resolveSpace(spaces)).profile({ fundingEnabled: state === "on" });
      ok(`Public funding ${state}`);
    } catch (cause) { handleHttp(cause); }
  });

  wallet.command("activity").option("--page <page>", "Page number", "1").option("--json", "Output as JSON").action(async (opts: { page: string; json?: boolean }) => {
    try {
      const page = Number(opts.page);
      if (!Number.isInteger(page) || page < 1 || page > 10_000) throw new Error("Page must be an integer between 1 and 10000");
      const value = await (await space()).activities(page);
      if (jsonRequested(opts)) return outJson(value);
      table(value.items, [{ key: "title", label: "Activity" }, { key: "amountUsd", label: "Amount (USD)" }, { key: "actorUserId", label: "User" }, { key: "createdAt", label: "Date" }]);
    } catch (cause) { handleHttp(cause); }
  });

  wallet.command("transfer <amount>").description("Move purchased personal balance into the wallet (whole USD)").option("--request-id <uuid>", "Continue an earlier uncertain transfer").option("--json", "Output as JSON").action(async (amount: string, opts: { requestId?: string; json?: boolean }) => {
    const id = opts.requestId ?? randomUUID();
    let sent = false;
    try {
      const amountUsd = Number(amount);
      if (!Number.isInteger(amountUsd) || amountUsd < 1) throw new Error("Amount must be a whole number of USD");
      const api = await space();
      sent = true;
      const value = await api.transfer({ id, amountUsd });
      if (jsonRequested(opts)) return outJson(value);
      if (value.state === "completed") ok(`Added ${usd(value.creditedUsd)} to the Space wallet`);
      else if (value.state === "refunded") warn(`Returned ${usd(value.refundedUsd)} to your balance`);
      else console.log(`Processing. Check with: cohub spaces wallet transfer-status ${id}`);
    } catch (cause) {
      if (sent && uncertain(cause)) retryHint(`cohub spaces wallet transfer ${amount}`, id);
      handleHttp(cause);
    }
  });

  wallet.command("transfer-status <id>").option("--json", "Output as JSON").action(async (id: string, opts: { json?: boolean }) => {
    try {
      const value = await (await space()).getTransfer(id);
      if (jsonRequested(opts)) return outJson(value);
      table([{ state: value.state, amount: usd(value.amountUsd), credited: usd(value.creditedUsd), refunded: usd(value.refundedUsd) }], [{ key: "state", label: "State" }, { key: "amount", label: "Amount" }, { key: "credited", label: "Credited" }, { key: "refunded", label: "Refunded" }]);
    } catch (cause) { handleHttp(cause); }
  });

  wallet.command("recharge <product>").description("Open checkout for a funding tier").option("--request-id <uuid>", "Continue an earlier uncertain checkout").option("--json", "Output as JSON").action(async (productKey: string, opts: { requestId?: string; json?: boolean }) => {
    const id = opts.requestId ?? randomUUID();
    let sent = false;
    try {
      const api = await space();
      sent = true;
      const value = await api.createOrder({ id, productKey });
      if (jsonRequested(opts)) return outJson(value);
      if (!value.checkout.checkoutUsable || !value.checkout.checkoutUrl) throw new Error(value.checkout.message ?? "Checkout is unavailable");
      console.log(value.checkout.checkoutUrl);
      console.log(`After paying: cohub spaces wallet confirm ${value.orderId}`);
    } catch (cause) {
      if (sent && uncertain(cause)) retryHint(`cohub spaces wallet recharge ${productKey}`, id);
      handleHttp(cause);
    }
  });

  wallet.command("confirm <order>").action(async (orderId: string) => {
    try { outJson(await (await space()).confirmOrder(orderId)); }
    catch (cause) { handleHttp(cause); }
  });

  wallet.command("catalog").option("--json", "Output as JSON").action(async (opts: { json?: boolean }) => {
    try {
      const value = await (await space()).catalog();
      if (jsonRequested(opts)) return outJson(value);
      table(value.products.map((product) => ({ key: product.key, name: product.name, price: product.pricing.amountUsd })), [{ key: "key", label: "Product" }, { key: "name", label: "Name" }, { key: "price", label: "Price (USD)" }]);
    } catch (cause) { handleHttp(cause); }
  });
}
