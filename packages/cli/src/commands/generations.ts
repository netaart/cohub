import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { Command } from "commander";
import {
  GenerationPolicyError,
  assertGenerationRequestAllowedByPolicy,
  parseGenerationPolicyFromEnv,
  type GenerationContentBlock,
} from "@neta-art/cohub";
import { createClient } from "../client.js";
import { resolveSpace } from "../space.js";
import { json as outJson, jsonRequested, ok, error, handleHttp, spinner } from "../output.js";

type GenerationSource =
  | { type: "url"; url: string }
  | { type: "base64"; mediaType: string; data: string };

export type MediaInputType = "image" | "video" | "audio";

const frameMediaRoles = new Set(["first_frame", "last_frame"]);
const referenceMediaRoles = new Set(["reference_image", "reference_video", "reference_audio"]);

const rolesByMediaType: Record<MediaInputType, ReadonlySet<string>> = {
  image: new Set([...frameMediaRoles, "reference_image"]),
  video: new Set(["reference_video"]),
  audio: new Set(["reference_audio"]),
};

const mediaRoles = new Set([...frameMediaRoles, ...referenceMediaRoles]);

const mimeByExt: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
};

function parseValue(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return value;
    }
  }
  return value;
}

function parseParams(param?: string[], parameters?: string): Record<string, unknown> | undefined {
  const result = parameters ? JSON.parse(parameters) as Record<string, unknown> : {};
  for (const item of param ?? []) {
    const index = item.indexOf("=");
    if (index <= 0) throw new Error(`Invalid --param value: ${item}`);
    result[item.slice(0, index)] = parseValue(item.slice(index + 1));
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

async function pathExists(path: string): Promise<boolean> {
  return Boolean(await stat(path).catch(() => null));
}

async function parseMediaInput(type: MediaInputType, rawValue: string): Promise<{ value: string; role?: string }> {
  const separator = rawValue.indexOf("=");
  if (separator <= 0) return { value: rawValue };

  const role = rawValue.slice(0, separator).trim();
  if (!mediaRoles.has(role)) return { value: rawValue };
  if (await pathExists(rawValue)) return { value: rawValue };
  if (!rolesByMediaType[type].has(role)) {
    return error("Invalid media role", `${role} cannot be used with --${type}`);
  }

  const value = rawValue.slice(separator + 1).trim();
  if (!value) return error("Invalid media input", `--${type} ${role}= requires a path or URL`);
  return { value, role };
}

export async function contentFromPathOrUrl(type: MediaInputType, rawValue: string): Promise<GenerationContentBlock> {
  const { value, role } = await parseMediaInput(type, rawValue);
  const meta = role ? { role } : undefined;
  if (/^https?:\/\//.test(value)) {
    return { type, source: { type: "url", url: value }, ...(meta ? { meta } : {}) } as GenerationContentBlock;
  }
  const data = await readFile(value);
  const mediaType = mimeByExt[extname(value).toLowerCase()] ?? "application/octet-stream";
  return {
    type,
    source: { type: "base64", mediaType, data: data.toString("base64") },
    ...(meta ? { meta } : {}),
  } as GenerationContentBlock;
}

function validateMediaRoleModes(content: GenerationContentBlock[]): void {
  const roles = content.map(metaRole).filter((role): role is string => Boolean(role));
  const hasFrameRole = roles.some((role) => frameMediaRoles.has(role));
  const hasReferenceRole = roles.some((role) => referenceMediaRoles.has(role));
  if (hasFrameRole && hasReferenceRole) {
    error(
      "Invalid media role mix",
      "Use first_frame/last_frame or reference_image/reference_video/reference_audio, not both.",
    );
  }
}

async function saveOutputs(output: GenerationContentBlock[], outputPath: string): Promise<string[]> {
  const outputs = output.filter((block) => block.type === "text" || block.type === "image" || block.type === "video" || block.type === "audio");
  if (outputs.length === 0) return [];

  const info = await stat(outputPath).catch(() => null);
  const isSingleFile = outputs.length === 1 && !(info?.isDirectory() ?? false);
  const targetPath = isSingleFile ? outputPath : await resolveOutputDirectory(outputPath, info);

  if (isSingleFile) await mkdir(dirname(targetPath), { recursive: true });
  else await mkdir(targetPath, { recursive: true });

  const savedPaths: string[] = [];
  for (const [i, block] of outputs.entries()) {
    if (block.type === "text") {
      const target = isSingleFile ? targetPath : join(targetPath, `generation-${i + 1}.txt`);
      await writeFile(target, block.text, "utf-8");
      savedPaths.push(target);
      continue;
    }

    const source = block.source as GenerationSource;
    const target = isSingleFile ? targetPath : join(targetPath, outputName(block, source.type === "url" ? source.url : undefined, i));
    if (source.type === "url") {
      const response = await fetch(source.url);
      if (!response.ok) throw new Error(`Failed to download ${source.url}: HTTP ${response.status}`);
      await writeFile(target, Buffer.from(await response.arrayBuffer()));
      savedPaths.push(target);
    } else {
      await writeFile(target, Buffer.from(source.data, "base64"));
      savedPaths.push(target);
    }
  }
  return savedPaths;
}

async function resolveOutputDirectory(outputPath: string, info: Awaited<ReturnType<typeof stat>> | null): Promise<string> {
  if (info?.isDirectory() || (!info && !extname(outputPath))) return outputPath;

  const ext = extname(outputPath);
  const stem = ext ? basename(outputPath, ext) : basename(outputPath);
  const parent = dirname(outputPath);
  const base = join(parent, `${stem}-outputs`);

  for (let i = 0; ; i += 1) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const candidateInfo = await stat(candidate).catch(() => null);
    if (!candidateInfo || candidateInfo.isDirectory()) return candidate;
  }
}

function outputName(block: GenerationContentBlock, url: string | undefined, index: number): string {
  const fromUrl = url ? basename(new URL(url).pathname) : "";
  const label = slugOutputLabel(block);
  if (fromUrl?.includes(".")) return `generation-${index + 1}-${label}-${fromUrl}`;
  const ext = block.type === "video" ? "mp4" : block.type === "audio" ? "bin" : block.type === "text" ? "txt" : "png";
  return `generation-${index + 1}-${label}.${ext}`;
}

function metaRole(block: GenerationContentBlock): string | undefined {
  const role = block.meta?.role;
  return typeof role === "string" && role.length > 0 ? role : undefined;
}

function humanizeRole(role: string): string {
  return role.replaceAll("_", " ").replaceAll("-", " ");
}

function slugify(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-|-$/g, "") || "output";
}

function formatOutputLabel(block: GenerationContentBlock): string {
  const role = metaRole(block);
  if (!role) return block.type;
  const label = humanizeRole(role);
  return block.type === "image" && ["first_frame", "last_frame", "reference_image"].includes(role)
    ? label
    : `${block.type} (role: ${role})`;
}

function slugOutputLabel(block: GenerationContentBlock): string {
  return slugify(metaRole(block) ?? block.type);
}

function printGeneration(output: GenerationContentBlock[]): void {
  for (const block of output) {
    if (block.type === "text") {
      console.log(block.text);
    } else if (block.source.type === "url") {
      console.log(`${formatOutputLabel(block)}: ${block.source.url}`);
    } else {
      console.log(`${formatOutputLabel(block)}: base64 ${block.source.mediaType} (${block.source.data.length} chars)`);
    }
  }
}

function resumeHint(taskRunId: string): string {
  return `Use \`cohub tasks get ${taskRunId} --json\` to inspect the task later.`;
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  return restSeconds > 0 ? `${minutes}m ${restSeconds}s` : `${minutes}m`;
}

function parseTimeoutMs(value?: string): number | undefined {
  if (!value) return undefined;
  if (!/^\d+$/.test(value.trim())) return error("Invalid timeout", "--timeout-ms must be a positive integer");
  const timeoutMs = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return error("Invalid timeout", "--timeout-ms must be a positive integer");
  return timeoutMs;
}

function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function parseMeta(value?: string): Record<string, unknown> | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return error("Invalid meta", "--meta must be a JSON object");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return error("Invalid meta", "--meta must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export function registerGenerations(program: Command): void {
  program
    .command("generate")
    .description("Generate multimodal outputs")
    .argument("<prompt>", "Prompt text")
    .requiredOption("-m, --model <model>", "Multimodal model ID from `cohub models ls --model-type multimodal`")
    .option(
      "--image <path-or-url>",
      "Image input file path or URL; prefix with first_frame=, last_frame=, or reference_image= when needed; repeatable",
      collect,
      [],
    )
    .option(
      "--video <path-or-url>",
      "Video input file path or URL; prefix with reference_video= when needed; repeatable",
      collect,
      [],
    )
    .option(
      "--audio <path-or-url>",
      "Audio input file path or URL; prefix with reference_audio= when needed; repeatable",
      collect,
      [],
    )
    .option("--param <key=value>", "Generation parameter; repeatable, values may be JSON/number/boolean", collect, [])
    .option("--parameters <json>", "Generation parameters as a JSON object")
    .option("--meta <json>", "Meta as a JSON object")
    .option("-o, --output <path>", "Save generated output to a file or directory")
    .option("--async", "Queue the generation task and return immediately")
    .option("--timeout-ms <ms>", "Maximum time to wait in synchronous mode")
    .option("--json", "Output as JSON")
    .addHelpText("after", `

Examples:
  cohub models ls --model-type multimodal
  cohub -s <space-id> generate "A calm lake at sunrise" -m <model> -o lake.png
  COHUB_SPACE_ID=<space-id> cohub generate "Restyle this image" -m <model> --image input.png
  cohub -s <space-id> generate "Smooth transition" -m seedance-2-0-fast --image first_frame=https://example.com/first.png --image last_frame=https://example.com/last.png
  cohub -s <space-id> generate "Use these references" -m seedance-2-0-fast --image reference_image=https://example.com/a.png --image reference_image=https://example.com/b.png
  cohub -s <space-id> generate "Follow this soundtrack" -m minimax-h3 --audio reference_audio=https://example.com/reference.mp3
  cohub -s <space-id> generate "A calm lake" -m <model> --async
`)
    .action(async (prompt: string, opts: {
      model: string;
      image: string[];
      video: string[];
      audio: string[];
      param: string[];
      parameters?: string;
      meta?: string;
      output?: string;
      async?: boolean;
      timeoutMs?: string;
      json?: boolean;
    }) => {
      try {
        const spaceId = await resolveSpace(program);
        const content: GenerationContentBlock[] = [{ type: "text", text: prompt }];
        content.push(...await Promise.all(opts.image.map((value) => contentFromPathOrUrl("image", value))));
        content.push(...await Promise.all(opts.video.map((value) => contentFromPathOrUrl("video", value))));
        content.push(...await Promise.all(opts.audio.map((value) => contentFromPathOrUrl("audio", value))));
        validateMediaRoleModes(content);

        const parameters = parseParams(opts.param, opts.parameters);
        try {
          assertGenerationRequestAllowedByPolicy({
            policy: parseGenerationPolicyFromEnv(process.env),
            model: opts.model,
            parameters,
          });
        } catch (policyError) {
          if (policyError instanceof GenerationPolicyError) return error("Generation settings", policyError.message);
          throw policyError;
        }

        const meta = parseMeta(opts.meta);
        const client = createClient();
        const created = await client.generations.create({
          spaceId,
          sessionId: envValue("COHUB_SESSION_ID"),
          turnId: envValue("COHUB_TURN_ID"),
          model: opts.model,
          content,
          parameters,
          meta,
        });

        if (opts.async) {
          if (jsonRequested(opts)) return outJson(created);
          return ok(`Generation queued — task ID: ${created.taskRunId}\n    ${resumeHint(created.taskRunId)}`);
        }

        const spin = spinner();
        let pollCount = 0;
        const waitStartedAt = Date.now();
        if (!jsonRequested(opts)) {
          process.stderr.write(`  Generation queued — task ID: ${created.taskRunId}\n`);
          process.stderr.write(`  ${resumeHint(created.taskRunId)}\n`);
          spin.start("Generating...");
        }
        const result = await client.generations.wait(created.taskRunId, {
          timeoutMs: parseTimeoutMs(opts.timeoutMs),
          onPoll: () => {
            pollCount += 1;
            spin.update(`Generating... ${formatElapsed(Date.now() - waitStartedAt)}, ${pollCount} polls`);
          },
        });
        if (!jsonRequested(opts)) spin.stop(`Generation completed — task ID: ${created.taskRunId}, ${formatElapsed(Date.now() - waitStartedAt)}, ${pollCount} polls`);

        const savedPaths = opts.output ? await saveOutputs(result.output, opts.output) : [];
        if (jsonRequested(opts)) return outJson(savedPaths.length > 0 ? { ...result, taskRunId: created.taskRunId, savedPaths } : { ...result, taskRunId: created.taskRunId });
        printGeneration(result.output);
        if (result.requestId || result.cost !== undefined || result.billing) {
          const details = [
            result.requestId ? `request ID: ${result.requestId}` : null,
            result.cost !== undefined ? `official cost: ${result.cost}` : null,
            result.billing ? `billing: ${result.billing.status}` : null,
            result.billing ? `effective amount: ${result.billing.amountUsd}` : null,
            result.billing?.discountMultiplier !== undefined
              ? `multiplier: ${result.billing.discountMultiplier}`
              : null,
            result.billing?.reason ? `billing reason: ${result.billing.reason}` : null,
          ].filter(Boolean).join(", ");
          if (details) process.stderr.write(`  ${details}\n`);
        }
        if (savedPaths.length > 0) ok(`Saved to ${savedPaths.join(", ")}`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });
}

function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}
