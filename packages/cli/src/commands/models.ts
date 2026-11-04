import type { Command } from "commander";
import {
  filterDiscoverableGenerationModels,
  filterGenerationDeclarationsByPolicy,
  getAllowedGenerationModelIds,
  parseGenerationPolicyFromEnv,
  type PublicGenerationDeclaration,
} from "@neta-art/cohub";
import { createClient } from "../client.js";
import { explicitSpace, failSpaceTarget, resolveSpaceRef } from "../space.js";
import { table, json as outJson, jsonRequested, error, handleHttp, type Row } from "../output.js";

type MultimodalModelSummary = Pick<PublicGenerationDeclaration, "model" | "title" | "description" | "pricing">;

export function toMultimodalModelSummary(model: PublicGenerationDeclaration): MultimodalModelSummary {
  return {
    model: model.model,
    ...(model.title ? { title: model.title } : {}),
    ...(model.description ? { description: model.description } : {}),
    // Keep pricing structured for `--json`; the human table formats it separately.
    ...(model.pricing ? { pricing: model.pricing } : {}),
  };
}

function printSection(title: string, lines: string[]): void {
  if (lines.length === 0) return;
  console.log(`\n${title}`);
  for (const line of lines) console.log(`  ${line}`);
}

type GenerationContentSpec = PublicGenerationDeclaration["content"]["input"][number];
type GenerationParameterSpec = NonNullable<PublicGenerationDeclaration["parameters"]>[string];
export type GenerationModelPricing = NonNullable<PublicGenerationDeclaration["pricing"]>;

const PRICE_UNIT_LABELS: Record<GenerationModelPricing["unit"], string> = {
  image: "image",
  second: "second",
  request: "request",
  "1m_tokens": "1M tokens",
};

/** USD amounts stay compact while preserving the precision the value actually needs. */
function formatUsdAmount(value: number): string {
  const magnitude = Math.abs(value);
  const isWholeDollar = magnitude >= 1 && Number.isInteger(value);
  const fractionDigits = value === 0 || isWholeDollar ? 0 : magnitude < 0.01 ? 4 : 2;
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits })}`;
}

/**
 * Render a display-only unit price, e.g. `$0.04 / image` or `$0.10–$0.50 / second`,
 * optionally suffixed with a qualifier note.
 *
 * The raw `pricing` object is preserved in `--json` for machines; this string
 * targets humans and agents reading the table output.
 */
export function formatGenerationPrice(pricing: GenerationModelPricing): string {
  const unit = PRICE_UNIT_LABELS[pricing.unit];
  const value = typeof pricing.amount === "number"
    ? formatUsdAmount(pricing.amount)
    : pricing.min === pricing.max
      ? formatUsdAmount(pricing.min)
      : `${formatUsdAmount(pricing.min)}\u2013${formatUsdAmount(pricing.max)}`;
  const base = `${value} / ${unit}`;
  return pricing.note ? `${base} \u00b7 ${pricing.note}` : base;
}

type LlmModelCost = {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
};

/** LLM catalog entries carry cost as an untyped `model.cost` bag; validate it before use. */
function readLlmModelCost(model: Record<string, unknown>): LlmModelCost | null {
  const cost = model.cost;
  if (!cost || typeof cost !== "object") return null;
  const { input, output, cacheRead, cacheWrite } = cost as Partial<LlmModelCost>;
  if (typeof input !== "number" || typeof output !== "number") return null;
  return {
    input,
    output,
    ...(typeof cacheRead === "number" ? { cacheRead } : {}),
    ...(typeof cacheWrite === "number" ? { cacheWrite } : {}),
  };
}

/** Zero or absent per-token components carry no signal, so they are omitted. */
function formatLlmCostValue(value: number | undefined): string | null {
  return typeof value === "number" && Number.isFinite(value) && value !== 0 ? formatUsdAmount(value) : null;
}

/**
 * Render per-million-token LLM cost, e.g. `$3 /M input · $15 /M output`,
 * appending cache rates only when the model declares them.
 */
export function formatLlmModelCost(model: Record<string, unknown>): string {
  const cost = readLlmModelCost(model);
  if (!cost) return "";
  const parts: Array<[number | undefined, string]> = [
    [cost.input, "input"],
    [cost.output, "output"],
    [cost.cacheRead, "cache read"],
    [cost.cacheWrite, "cache write"],
  ];
  return parts.flatMap(([value, label]) => {
    const formatted = formatLlmCostValue(value);
    return formatted ? [`${formatted} /M ${label}`] : [];
  }).join(" \u00b7 ");
}

/**
 * Drop hidden models from LLM discovery, mirroring generation models and the web
 * picker. Providers left with no visible model are removed so the catalog shape
 * matches what is actually shown. Explicit `true` is the only hidden signal.
 */
export function filterHiddenLlmModels<T extends { model: Record<string, unknown> }>(
  catalog: Record<string, T[]>,
): Record<string, T[]> {
  const visible: Record<string, T[]> = {};
  for (const [provider, entries] of Object.entries(catalog)) {
    const models = entries.filter((entry) => entry.model.hidden !== true);
    if (models.length > 0) visible[provider] = models;
  }
  return visible;
}

function formatContentSpec(spec: GenerationContentSpec): string {
  const details: string[] = [];
  const roles = (spec as GenerationContentSpec & { roles?: string[] }).roles;
  details.push(spec.required === false ? "optional" : "required");
  if (typeof spec.min === "number") details.push(`min ${spec.min}`);
  if (typeof spec.max === "number") details.push(`max ${spec.max}`);
  if (spec.sources?.length) details.push(`sources: ${spec.sources.join(", ")}`);
  if (roles?.length) details.push(`roles: ${roles.join(", ")}`);
  if (spec.merge) details.push(`merge: ${spec.merge}`);
  if (spec.description) details.push(spec.description);
  return `${spec.type}${details.length > 0 ? ` — ${details.join("; ")}` : ""}`;
}

function formatParameter(name: string, spec: GenerationParameterSpec): string[] {
  const lines = [`${name}`];
  const details: string[] = [`type: ${spec.type}`];
  if (spec.optional) details.push("optional");
  if ("default" in spec && spec.default !== undefined) details.push(`default: ${String(spec.default)}`);
  if ("min" in spec && typeof spec.min === "number") details.push(`min: ${spec.min}`);
  if ("max" in spec && typeof spec.max === "number") details.push(`max: ${spec.max}`);
  if ("enum" in spec && spec.enum?.length) details.push(`values: ${spec.enum.join(", ")}`);
  lines.push(`  ${details.join("; ")}`);
  if (spec.description) lines.push(`  ${spec.description}`);
  if ("examples" in spec && spec.examples?.length) lines.push(`  examples: ${spec.examples.map(String).join(", ")}`);
  return lines;
}

function printMultimodalModel(model: PublicGenerationDeclaration): void {
  console.log(model.title ?? model.model);
  printSection("Model", [model.model]);
  if (model.description) printSection("Description", [model.description]);
  if (model.pricing) printSection("Pricing", [formatGenerationPrice(model.pricing)]);

  printSection("Input", model.content.input.map(formatContentSpec));

  const parameterLines = Object.entries(model.parameters ?? {}).flatMap(([name, spec]) => formatParameter(name, spec));
  printSection("Parameters", parameterLines);

  const examples = model.examples ?? [];
  printSection("Examples", examples.map((example, index) => {
    const title = example.title ? `${example.title}: ` : "";
    const prompt = example.request.content.find((block) => block.type === "text")?.text;
    return `${index + 1}. ${title}${prompt ? `"${prompt}"` : example.request.model}`;
  }));
}

function readModelContext(model: Record<string, unknown>): number | null {
  const value = model.maxContext ?? model.contextWindow;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function formatModelContext(model: Record<string, unknown>): string {
  const value = readModelContext(model);
  if (value == null) return "";
  const source = typeof model.maxContextSource === "string" ? model.maxContextSource : null;
  const ref = typeof model.maxContextSourceRef === "string" ? `:${model.maxContextSourceRef}` : "";
  return source ? `${formatTokenCount(value)} (${source}${ref})` : formatTokenCount(value);
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export function registerModels(program: Command): void {
  const cmd = program
    .command("models")
    .description("List available LLM and multimodal models")
    .addHelpText("after", `

Examples:
  cohub models ls
  cohub models ls --space <spaceId>
  cohub models ls --model-type multimodal
  cohub models ls --model-type multimodal --json
  cohub models show <model>
  cohub models show <model> --json
`);

  cmd
    .command("ls")
    .alias("list")
    .description("List available models")
    .option("--model-type <type>", "Model type: llm | multimodal", "llm")
    .option("--json", "Output as JSON")
    .action(async (opts: { modelType?: string; json?: boolean }, command: Command) => {
      const client = createClient();
      try {
        if (opts.modelType === "multimodal") {
          const response = await client.models.listMultimodal();
          const policy = parseGenerationPolicyFromEnv(process.env);
          const allowedModelIds = getAllowedGenerationModelIds(policy);
          const filtered = filterGenerationDeclarationsByPolicy(response.models, policy);
          const models = filterDiscoverableGenerationModels(filtered, {
            includeModelIds: allowedModelIds ?? undefined,
          }).map(toMultimodalModelSummary);
          if (jsonRequested(opts)) return outJson({ models });
          table(models as unknown as Row[], [
            { key: "model", label: "Model" },
            { key: "title", label: "Title" },
            {
              key: "pricing",
              label: "Price",
              format: (value) => (value ? formatGenerationPrice(value as GenerationModelPricing) : ""),
            },
            { key: "description", label: "Description" },
          ]);
          return;
        }

        if (opts.modelType && opts.modelType !== "llm") {
          return error("Invalid model type", "Use --model-type llm or --model-type multimodal");
        }

        const spaceRef = explicitSpace(command);
        const spaceId = spaceRef ? await resolveSpaceRef(spaceRef).catch(failSpaceTarget) : undefined;
        const catalog = await client.models.list({ spaceId });
        const visibleCatalog = filterHiddenLlmModels(catalog);
        if (jsonRequested(opts)) return outJson(visibleCatalog);
        if (Object.keys(visibleCatalog).length === 0) return console.log("  (empty)");

        for (const [provider, entries] of Object.entries(visibleCatalog)) {
          console.log(`\n  ${provider}`);
          console.log(`  ${"─".repeat(provider.length)}`);
          table(entries.map((entry) => ({
            id: entry.id,
            provider: entry.provider,
            context: formatModelContext(entry.model),
            cost: formatLlmModelCost(entry.model),
          })), [
            { key: "id", label: "ID" },
            { key: "provider", label: "Provider" },
            { key: "context", label: "Max context" },
            { key: "cost", label: "Cost" },
          ]);
        }
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  cmd
    .command("show")
    .description("Show full multimodal model details")
    .argument("<model>", "Multimodal model ID")
    .option("--json", "Output as JSON")
    .action(async (modelId: string, opts: { json?: boolean }) => {
      const client = createClient();
      try {
        const response = await client.models.listMultimodal();
        const models = filterGenerationDeclarationsByPolicy(response.models, parseGenerationPolicyFromEnv(process.env));
        const model = models.find((item) => item.model === modelId);
        if (!model) {
          return error("Model not found", `No multimodal model named ${modelId}`);
        }
        if (jsonRequested(opts)) return outJson(model);
        printMultimodalModel(model);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });
}
