import type { SpaceCommerceBenefit, SpaceCommerceOrder, SpaceCommerceProduct } from "@neta-art/cohub";
import type { Command } from "commander";
import { createClient } from "../client.js";
import { error, formatLocalDateTime, handleHttp, json as outJson, jsonRequested, ok, table } from "../output.js";
import { resolveSpace } from "../space.js";

const PRODUCT_STATUSES = ["draft", "active"] as const;
const PRODUCT_UPDATE_STATUSES = ["draft", "active", "archived"] as const;
const PRODUCT_VISIBILITIES = ["public", "private"] as const;
const BENEFIT_STATUSES = ["active", "archived"] as const;

type MetaValue = string | number | boolean;

type JsonOption = { json?: boolean };

const MIN_PRODUCT_AMOUNT_USD = 0.5;

type ProductCreateOptions = JsonOption & {
  productKey?: string;
  name?: string;
  amountUsd?: string;
  cohubBalanceUsd?: string;
  description?: string;
  status?: string;
  visibility?: string;
};

type ProductUpdateOptions = JsonOption & {
  productKey?: string;
  name?: string;
  description?: string;
  clearDescription?: boolean;
  status?: string;
  visibility?: string;
};

type ProductArchiveOptions = JsonOption & {
  productKey?: string;
  yes?: boolean;
};

type BenefitCreateOptions = JsonOption & {
  benefitKey?: string;
  name?: string;
  description?: string;
  type?: string;
  amount?: string;
  expiresInDays?: string;
  metadataJson?: string;
};

type BenefitUpdateOptions = JsonOption & {
  benefitKey?: string;
  name?: string;
  description?: string;
  clearDescription?: boolean;
  status?: string;
  metadataJson?: string;
};

type BenefitArchiveOptions = JsonOption & {
  benefitKey?: string;
  yes?: boolean;
};

type BindOptions = JsonOption & {
  productKey?: string;
  benefitKey?: string;
};

type UnbindOptions = BindOptions & {
  yes?: boolean;
};

type OrdersListOptions = JsonOption & {
  page?: string;
  limit?: string;
};

function requireText(value: string | undefined, label: string, flag: string): string {
  const text = value?.trim();
  if (text) return text;
  return error(`Missing ${label}`, `Pass ${flag}.`);
}

function parseChoice<const T extends readonly string[]>(value: string | undefined, label: string, choices: T): T[number] | undefined {
  if (value === undefined) return undefined;
  if ((choices as readonly string[]).includes(value)) return value as T[number];
  return error(`Invalid ${label}`, `Use one of: ${choices.join(", ")}.`);
}

function parseInteger(value: string | undefined, label: string, options: { fallback: number; min?: number; max?: number }): number {
  if (value === undefined) return options.fallback;
  if (!/^-?\d+$/.test(value.trim())) return error(`Invalid ${label}`, `${label} must be an integer.`);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) return error(`Invalid ${label}`, `${label} must be a safe integer.`);
  if (options.min !== undefined && parsed < options.min) return error(`Invalid ${label}`, `${label} must be at least ${options.min}.`);
  if (options.max !== undefined && parsed > options.max) return error(`Invalid ${label}`, `${label} must be at most ${options.max}.`);
  return parsed;
}

function parseAmountUsd(value: string | undefined): number {
  const text = requireText(value, "amount", "--amount-usd <amount>");
  if (!/^(?:\d+|\d+\.\d{1,2}|\.\d{1,2})$/.test(text)) {
    return error("Invalid amount", "--amount-usd must be a USD amount with at most 2 decimals.");
  }
  const amount = Number(text);
  if (!Number.isFinite(amount)) return error("Invalid amount", "--amount-usd must be a finite USD amount.");
  if (amount < MIN_PRODUCT_AMOUNT_USD) return error("Invalid amount", "--amount-usd must be at least 0.5.");
  return amount;
}

function parseMetadataJson(value: string | undefined): Record<string, MetaValue> | undefined {
  if (value === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return error("Invalid metadata", "--metadata-json must be a JSON object.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return error("Invalid metadata", "--metadata-json must be a JSON object.");
  }
  const metadata: Record<string, MetaValue> = {};
  for (const [key, item] of Object.entries(parsed)) {
    if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
      return error("Invalid metadata", `Metadata value for "${key}" must be string, number, or boolean.`);
    }
    if (typeof item === "number" && !Number.isFinite(item)) {
      return error("Invalid metadata", `Metadata value for "${key}" must be a finite number.`);
    }
    metadata[key] = item;
  }
  return metadata;
}

function compact<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>;
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
    balance: product.cohubBalance ? formatUsd(product.cohubBalance.amountUsd) : "",
    credits: product.display.creditsAmount ?? "",
  })), [
    { key: "key", label: "Key" },
    { key: "name", label: "Name" },
    { key: "status", label: "Status" },
    { key: "visibility", label: "Visibility" },
    { key: "price", label: "Price" },
    { key: "balance", label: "Cohub Balance" },
    { key: "credits", label: "Credits" },
  ]);
}

function printBenefits(benefits: SpaceCommerceBenefit[]): void {
  table(benefits.map((benefit) => {
    let detail: string;
    if (benefit.type === "credits") {
      const config = benefit.config;
      detail = `${config.amount} credits${config.expiresInDays != null ? ` · ${config.expiresInDays}d` : ""}`;
    } else {
      detail = JSON.stringify(benefit.config.metadata);
    }
    return {
      key: benefit.key,
      name: benefit.name,
      type: benefit.type,
      status: benefit.status,
      detail,
    };
  }), [
    { key: "key", label: "Key" },
    { key: "name", label: "Name" },
    { key: "type", label: "Type" },
    { key: "status", label: "Status" },
    { key: "detail", label: "Detail" },
  ]);
}

function printOrders(orders: SpaceCommerceOrder[]): void {
  table(orders.map((order) => ({
    id: order.id,
    product: order.productKeySnapshot,
    status: order.status,
    amount: formatMinorUsd(order.amountSnapshot),
    created: order.createdAt,
  })), [
    { key: "id", label: "ID" },
    { key: "product", label: "Product" },
    { key: "status", label: "Status" },
    { key: "amount", label: "Amount" },
    { key: "created", label: "Created", format: formatLocalDateTime },
  ]);
}

async function confirmDanger(opts: { yes?: boolean }, detail: string): Promise<void> {
  if (opts.yes) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return error("Confirmation required", `Pass --yes to ${detail}.`);
  process.stdout.write(`${detail[0]?.toUpperCase() ?? "C"}${detail.slice(1)}? [y/N] `);
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
    break;
  }
  const answer = Buffer.concat(chunks).toString().trim().toLowerCase();
  if (answer !== "y" && answer !== "yes") return error("Cancelled");
}

async function commerceClient(spacesCmd: Command) {
  const spaceId = await resolveSpace(spacesCmd);
  return { spaceId, commerce: createClient().space(spaceId).commerce };
}

export function registerSpaceCommerce(spacesCmd: Command): void {
  const commerceCmd = spacesCmd
    .command("commerce")
    .description("Manage space commerce")
    .addHelpText("after", `
Examples:
  cohub -s <space-id> spaces commerce setup
  cohub -s <space-id> spaces commerce products list
  COHUB_SPACE_ID=<space-id> cohub spaces commerce orders list --limit 10
`);

  commerceCmd
    .command("setup")
    .description("Initialize commerce for the target space")
    .option("--json", "Output as JSON")
    .action(async (opts: JsonOption) => {
      const { commerce } = await commerceClient(spacesCmd);
      try {
        const result = await commerce.setup();
        if (jsonRequested(opts)) return outJson(result);
        ok(`Commerce initialized: ${result.businessKey}`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  const productsCmd = commerceCmd
    .command("products")
    .description("Manage products")
    .addHelpText("after", `
Examples:
  cohub -s <space-id> spaces commerce products list
  cohub -s <space-id> spaces commerce products create --name "Pro Pack" --amount-usd 9.99
`);

  productsCmd
    .command("list")
    .description("List products")
    .option("--json", "Output as JSON")
    .action(async (opts: JsonOption) => {
      const { commerce } = await commerceClient(spacesCmd);
      try {
        const result = await commerce.listProducts();
        if (jsonRequested(opts)) return outJson(result);
        printProducts(result.products);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  productsCmd
    .command("create")
    .description("Create a product")
    .option("--product-key <key>", "Product key override")
    .option("--name <name>", "Product name")
    .option("--amount-usd <amount>", "One-time price in USD")
    .option("--cohub-balance-usd <amount>", "Included Cohub Balance in whole USD")
    .option("--description <text>", "Product description")
    .option("--status <status>", "Product status: draft, active")
    .option("--visibility <visibility>", "Product visibility: public, private")
    .option("--json", "Output as JSON")
    .action(async (opts: ProductCreateOptions) => {
      const amountUsd = parseAmountUsd(opts.amountUsd);
      const cohubBalanceUsd = opts.cohubBalanceUsd === undefined
        ? undefined
        : parseInteger(opts.cohubBalanceUsd, "cohub-balance-usd", { fallback: 0, min: 1 });
      if (cohubBalanceUsd !== undefined && cohubBalanceUsd > amountUsd) {
        return error("Invalid Cohub Balance", "--cohub-balance-usd cannot exceed --amount-usd.");
      }
      const input = {
        key: opts.productKey?.trim() || undefined,
        name: requireText(opts.name, "name", "--name <name>"),
        description: opts.description,
        amountUsd,
        cohubBalanceUsd,
        status: parseChoice(opts.status, "status", PRODUCT_STATUSES),
        visibility: parseChoice(opts.visibility, "visibility", PRODUCT_VISIBILITIES),
      };
      const { commerce } = await commerceClient(spacesCmd);
      try {
        const result = await commerce.createProduct(input);
        if (jsonRequested(opts)) return outJson(result);
        ok(`Product created: ${result.product.key}`);
        printProducts([result.product]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  productsCmd
    .command("update")
    .description("Update a product")
    .option("--product-key <key>", "Product key")
    .option("--name <name>", "Product name")
    .option("--description <text>", "Product description")
    .option("--clear-description", "Clear the product description")
    .option("--status <status>", "Product status: draft, active, archived")
    .option("--visibility <visibility>", "Product visibility: public, private")
    .option("--json", "Output as JSON")
    .action(async (opts: ProductUpdateOptions) => {
      if (opts.description !== undefined && opts.clearDescription) return error("Conflicting description", "Use either --description or --clear-description.");
      const productKey = requireText(opts.productKey, "product key", "--product-key <key>");
      const input = compact({
        name: opts.name,
        description: opts.clearDescription ? null : opts.description,
        status: parseChoice(opts.status, "status", PRODUCT_UPDATE_STATUSES),
        visibility: parseChoice(opts.visibility, "visibility", PRODUCT_VISIBILITIES),
      });
      if (Object.keys(input).length === 0) return error("Nothing to update", "Pass --name, --description, --clear-description, --status, or --visibility.");
      const { commerce } = await commerceClient(spacesCmd);
      try {
        const result = await commerce.updateProduct(productKey, input);
        if (jsonRequested(opts)) return outJson(result);
        ok(`Product updated: ${result.product.key}`);
        printProducts([result.product]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  productsCmd
    .command("archive")
    .description("Archive a product")
    .option("--product-key <key>", "Product key")
    .option("-y, --yes", "Confirm archive")
    .option("--json", "Output as JSON")
    .action(async (opts: ProductArchiveOptions) => {
      const productKey = requireText(opts.productKey, "product key", "--product-key <key>");
      await confirmDanger(opts, `archive product "${productKey}"`);
      const { commerce } = await commerceClient(spacesCmd);
      try {
        const result = await commerce.updateProduct(productKey, { status: "archived" });
        if (jsonRequested(opts)) return outJson(result);
        ok(`Product archived: ${result.product.key}`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  const benefitsCmd = commerceCmd
    .command("benefits")
    .description("Manage benefits")
    .addHelpText("after", `
Examples:
  cohub -s <space-id> spaces commerce benefits list
  cohub -s <space-id> spaces commerce benefits create --name "Premium Export" --metadata-json '{"limit":100}'
`);

  benefitsCmd
    .command("list")
    .description("List benefits")
    .option("--json", "Output as JSON")
    .action(async (opts: JsonOption) => {
      const { commerce } = await commerceClient(spacesCmd);
      try {
        const result = await commerce.listBenefits();
        if (jsonRequested(opts)) return outJson(result);
        printBenefits(result.benefits);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  benefitsCmd
    .command("create")
    .description("Create a benefit")
    .option("--benefit-key <key>", "Benefit key override")
    .option("--name <name>", "Benefit name")
    .option("--description <text>", "Benefit description")
    .option("--type <type>", "Benefit type: feature, credits (default: feature)")
    .option("--amount <n>", "Credit amount (credits type only)")
    .option("--expires-in-days <n>", "Credit expiry in days (credits type only)")
    .option("--metadata-json <json>", "Benefit metadata JSON object (feature type only)")
    .option("--json", "Output as JSON")
    .action(async (opts: BenefitCreateOptions) => {
      const name = requireText(opts.name, "name", "--name <name>");
      const type = parseChoice(opts.type, "type", ["feature", "credits"]) ?? "feature";
      if (type === "credits") {
        const amount = parseInteger(opts.amount, "amount", { fallback: 0, min: 1 });
        if (amount < 1) return error("Missing amount", "Pass --amount <n> with a positive integer for credits benefits.");
        const input = {
          key: opts.benefitKey?.trim() || undefined,
          name,
          description: opts.description,
          type: "credits" as const,
          amount,
          expiresInDays: opts.expiresInDays !== undefined
            ? parseInteger(opts.expiresInDays, "expires-in-days", { fallback: 0, min: 1 })
            : undefined,
        };
        const { commerce } = await commerceClient(spacesCmd);
        try {
          const result = await commerce.createBenefit(input);
          if (jsonRequested(opts)) return outJson(result);
          ok(`Benefit created: ${result.benefit.key}`);
          printBenefits([result.benefit]);
        } catch (e: unknown) {
          handleHttp(e);
        }
        return;
      }
      const input = {
        key: opts.benefitKey?.trim() || undefined,
        name,
        description: opts.description,
        type: "feature" as const,
        metadata: parseMetadataJson(opts.metadataJson),
      };
      const { commerce } = await commerceClient(spacesCmd);
      try {
        const result = await commerce.createBenefit(input);
        if (jsonRequested(opts)) return outJson(result);
        ok(`Benefit created: ${result.benefit.key}`);
        printBenefits([result.benefit]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  benefitsCmd
    .command("update")
    .description("Update a benefit")
    .option("--benefit-key <key>", "Benefit key")
    .option("--name <name>", "Benefit name")
    .option("--description <text>", "Benefit description")
    .option("--clear-description", "Clear the benefit description")
    .option("--status <status>", "Benefit status: active, archived")
    .option("--metadata-json <json>", "Replace metadata with a JSON object")
    .option("--json", "Output as JSON")
    .action(async (opts: BenefitUpdateOptions) => {
      if (opts.description !== undefined && opts.clearDescription) return error("Conflicting description", "Use either --description or --clear-description.");
      const benefitKey = requireText(opts.benefitKey, "benefit key", "--benefit-key <key>");
      const input = compact({
        name: opts.name,
        description: opts.clearDescription ? null : opts.description,
        status: parseChoice(opts.status, "status", BENEFIT_STATUSES),
        metadata: parseMetadataJson(opts.metadataJson),
      });
      if (Object.keys(input).length === 0) return error("Nothing to update", "Pass --name, --description, --clear-description, --status, or --metadata-json.");
      const { commerce } = await commerceClient(spacesCmd);
      try {
        const result = await commerce.updateBenefit(benefitKey, input);
        if (jsonRequested(opts)) return outJson(result);
        ok(`Benefit updated: ${result.benefit.key}`);
        printBenefits([result.benefit]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  benefitsCmd
    .command("archive")
    .description("Archive a benefit")
    .option("--benefit-key <key>", "Benefit key")
    .option("-y, --yes", "Confirm archive")
    .option("--json", "Output as JSON")
    .action(async (opts: BenefitArchiveOptions) => {
      const benefitKey = requireText(opts.benefitKey, "benefit key", "--benefit-key <key>");
      await confirmDanger(opts, `archive benefit "${benefitKey}"`);
      const { commerce } = await commerceClient(spacesCmd);
      try {
        const result = await commerce.updateBenefit(benefitKey, { status: "archived" });
        if (jsonRequested(opts)) return outJson(result);
        ok(`Benefit archived: ${result.benefit.key}`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  commerceCmd
    .command("bind")
    .description("Bind a benefit to a product")
    .option("--product-key <key>", "Product key")
    .option("--benefit-key <key>", "Benefit key")
    .option("--json", "Output as JSON")
    .action(async (opts: BindOptions) => {
      const input = {
        productKey: requireText(opts.productKey, "product key", "--product-key <key>"),
        benefitKey: requireText(opts.benefitKey, "benefit key", "--benefit-key <key>"),
      };
      const { commerce } = await commerceClient(spacesCmd);
      try {
        const result = await commerce.bindProductBenefit(input);
        if (jsonRequested(opts)) return outJson(result);
        ok(`Benefit bound: ${input.benefitKey} -> ${input.productKey}`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  commerceCmd
    .command("unbind")
    .description("Unbind a benefit from a product")
    .option("--product-key <key>", "Product key")
    .option("--benefit-key <key>", "Benefit key")
    .option("-y, --yes", "Confirm unbind")
    .option("--json", "Output as JSON")
    .action(async (opts: UnbindOptions) => {
      const input = {
        productKey: requireText(opts.productKey, "product key", "--product-key <key>"),
        benefitKey: requireText(opts.benefitKey, "benefit key", "--benefit-key <key>"),
      };
      await confirmDanger(opts, `unbind benefit "${input.benefitKey}" from product "${input.productKey}"`);
      const { commerce } = await commerceClient(spacesCmd);
      try {
        const result = await commerce.unbindProductBenefit(input);
        if (jsonRequested(opts)) return outJson(result);
        ok(`Benefit unbound: ${input.benefitKey} -> ${input.productKey}`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  const ordersCmd = commerceCmd
    .command("orders")
    .description("Manage orders");

  ordersCmd
    .command("list")
    .description("List recent orders")
    .option("--page <page>", "Page number")
    .option("--limit <limit>", "Page size, max 50")
    .option("--json", "Output as JSON")
    .action(async (opts: OrdersListOptions) => {
      const { commerce } = await commerceClient(spacesCmd);
      try {
        const result = await commerce.listOrders({
          page: parseInteger(opts.page, "page", { fallback: 1, min: 1 }),
          limit: parseInteger(opts.limit, "limit", { fallback: 20, min: 1, max: 50 }),
        });
        if (jsonRequested(opts)) return outJson(result);
        printOrders(result.orders);
        if (result.pagination.hasMore) console.log(`\nNext page: ${result.pagination.nextPage}`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });
}
