import {
  resolveExecutionAppId,
  type SpaceCommerceProduct,
  type AppCommerceEntitlement,
  type AppCommerceEntitlementsResponse,
  type AppCommerceOrder,
} from "@neta-art/cohub";
import type { Command } from "commander";
import { createClient } from "../client.js";
import { error, formatLocalDateTime, handleHttp, json as outJson, jsonRequested, ok, table } from "../output.js";

type JsonOption = { json?: boolean };

type ProductKeysOptions = JsonOption & {
  appId?: string;
  productKey?: string[];
};

type PurchaseOptions = JsonOption & {
  appId?: string;
  productKey?: string;
};

type OrderGetOptions = JsonOption & {
  appId?: string;
  orderId?: string;
};

type ConsumeOptions = JsonOption & {
  appId?: string;
  amount?: string;
  operationId?: string;
  reason?: string;
};

function collectOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function requireText(value: string | undefined, label: string, flag: string): string {
  const text = value?.trim();
  if (text) return text;
  return error(`Missing ${label}`, `Pass ${flag}.`);
}

function requireAppId(value: string | undefined): string {
  return requireText(value ?? resolveExecutionAppId() ?? undefined, "app ID", "--app-id <id>");
}

function requireList(values: string[] | undefined, label: string, flag: string): string[] {
  const items = [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
  if (items.length > 0) return items;
  return error(`Missing ${label}`, `Pass ${flag}.`);
}

function formatUsd(amount: number): string {
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatMinorUsd(amountMinor: number): string {
  return formatUsd(amountMinor / 100);
}

function printProducts(products: SpaceCommerceProduct[]): void {
  table(products.map((product) => ({
    key: product.key,
    name: product.name,
    status: product.status,
    visibility: product.visibility,
    price: formatUsd(product.pricing.amountUsd),
    credits: product.display.creditsAmount ?? "",
  })), [
    { key: "key", label: "Key" },
    { key: "name", label: "Name" },
    { key: "status", label: "Status" },
    { key: "visibility", label: "Visibility" },
    { key: "price", label: "Price" },
    { key: "credits", label: "Credits" },
  ]);
}

function printEntitlements(result: AppCommerceEntitlementsResponse): void {
  table(result.entitlements.map((item: AppCommerceEntitlement) => ({
    benefitKey: item.benefitKey,
    enabled: item.enabled ? "yes" : "no",
    metadata: item.metadata ? JSON.stringify(item.metadata) : "",
  })), [
    { key: "benefitKey", label: "Benefit" },
    { key: "enabled", label: "Enabled" },
    { key: "metadata", label: "Metadata" },
  ]);
  console.log(`\nCredits available: ${result.credits.available} (net: ${result.credits.net})`);
}

function printOrder(order: AppCommerceOrder): void {
  table([{
    id: order.id,
    product: order.productKeySnapshot,
    status: order.status,
    amount: formatMinorUsd(order.amountSnapshot),
    paid: formatMinorUsd(order.paidAmountSnapshot),
    created: order.createdAt,
    paidAt: order.paidAt ?? "",
  }], [
    { key: "id", label: "ID" },
    { key: "product", label: "Product" },
    { key: "status", label: "Status" },
    { key: "amount", label: "Amount" },
    { key: "paid", label: "Paid" },
    { key: "created", label: "Created", format: formatLocalDateTime },
    { key: "paidAt", label: "Paid At" },
  ]);
}

export function registerAppCommerce(appsCmd: Command): void {
  const commerceCmd = appsCmd
    .command("commerce")
    .description("App commerce operations")
    .addHelpText("after", `
Examples:
  cohub apps commerce products resolve --app-id <app-id> --product-key pro_pack
  cohub apps commerce entitlements --app-id <app-id>
  cohub apps commerce credits consume --app-id <app-id> --amount 100
`);

  const productsCmd = commerceCmd
    .command("products")
    .description("Resolve commerce products");

  productsCmd
    .command("resolve")
    .description("Resolve public products for an app")
    .option("--app-id <id>", "App ID")
    .option("--product-key <key>", "Product key", collectOption)
    .option("--json", "Output as JSON")
    .action(async (opts: ProductKeysOptions) => {
      const appId = requireAppId(opts.appId);
      const productKeys = requireList(opts.productKey, "product key", "--product-key <key>");
      const client = createClient();
      try {
        const result = await client.appCommerce.resolveProducts(appId, { productKeys });
        if (jsonRequested(opts)) return outJson(result);
        printProducts(result.products);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  commerceCmd
    .command("entitlements")
    .description("Show viewer entitlements and credit balance for an app")
    .option("--app-id <id>", "App ID")
    .option("--json", "Output as JSON")
    .action(async (opts: JsonOption & { appId?: string }) => {
      const appId = requireAppId(opts.appId);
      const client = createClient();
      try {
        const result = await client.appCommerce.getEntitlements(appId);
        if (jsonRequested(opts)) return outJson(result);
        printEntitlements(result);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  const creditsCmd = commerceCmd
    .command("credits")
    .description("Consume credits for an app");

  creditsCmd
    .command("consume")
    .description("Consume credits for an app (self by default)")
    .option("--app-id <id>", "App ID")
    .option("--amount <n>", "Positive integer credit amount")
    .option("--operation-id <id>", "Idempotency key (generated when omitted)")
    .option("--reason <text>", "Reason for the consumption")
    .option("--json", "Output as JSON")
    .action(async (opts: ConsumeOptions) => {
      const appId = requireAppId(opts.appId);
      const amountText = requireText(opts.amount, "amount", "--amount <n>");
      const amount = Number.parseInt(amountText, 10);
      if (!Number.isSafeInteger(amount) || amount <= 0) {
        return error("Invalid amount", "--amount must be a positive integer.");
      }
      const operationId = opts.operationId?.trim() || crypto.randomUUID();
      const client = createClient();
      try {
        const result = await client.appCommerce.consumeCredits(appId, {
          amount,
          operationId,
          reason: opts.reason,
        });
        if (jsonRequested(opts)) return outJson({ ...result, operationId });
        ok(`Consumed ${result.amount} credits (operation: ${operationId})`);
        table([{
          status: result.status,
          amount: result.amount,
          remaining: result.remaining,
          shortfall: result.shortfall ?? "",
        }], [
          { key: "status", label: "Status" },
          { key: "amount", label: "Amount" },
          { key: "remaining", label: "Remaining" },
          { key: "shortfall", label: "Shortfall" },
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  commerceCmd
    .command("purchase")
    .description("Create an app purchase checkout")
    .option("--app-id <id>", "App ID")
    .option("--product-key <key>", "Product key")
    .option("--json", "Output as JSON")
    .action(async (opts: PurchaseOptions) => {
      const appId = requireAppId(opts.appId);
      const productKey = requireText(opts.productKey, "product key", "--product-key <key>");
      const client = createClient();
      try {
        const result = await client.appCommerce.purchase(appId, { productKey });
        if (jsonRequested(opts)) return outJson(result);
        ok(`Checkout created: ${result.checkout.orderId}`);
        table([{
          orderId: result.checkout.orderId,
          productKey: result.checkout.productKey,
          usable: result.checkout.checkoutUsable ? "yes" : "no",
          status: result.checkout.status ?? "",
          checkoutUrl: result.checkout.checkoutUrl ?? "",
          message: result.checkout.message ?? "",
        }], [
          { key: "orderId", label: "Order" },
          { key: "productKey", label: "Product" },
          { key: "usable", label: "Usable" },
          { key: "status", label: "Status" },
          { key: "checkoutUrl", label: "Checkout URL" },
          { key: "message", label: "Message" },
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  const ordersCmd = commerceCmd
    .command("orders")
    .description("Look up commerce orders");

  ordersCmd
    .command("get")
    .description("Show an app commerce order")
    .option("--app-id <id>", "App ID")
    .option("--order-id <id>", "Order ID")
    .option("--json", "Output as JSON")
    .action(async (opts: OrderGetOptions) => {
      const appId = requireAppId(opts.appId);
      const orderId = requireText(opts.orderId, "order ID", "--order-id <id>");
      const client = createClient();
      try {
        const result = await client.appCommerce.getOrder(appId, orderId);
        if (jsonRequested(opts)) return outJson(result);
        printOrder(result.order);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });
}
