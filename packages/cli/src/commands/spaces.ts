import { randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { resolveCohubEnvironment } from "@neta-art/cohub";
import type {
  CohubHttpClient,
  ContentBlock,
  CreateSpaceInput,
  LabelListItem,
  LabelResourceType,
} from "@neta-art/cohub";
import type { Command } from "commander";
import { uploadAvatarAsset, uploadChatImageAsset } from "../avatar.js";
import { createClient } from "../client.js";
import { putLocalFile } from "../http-put.js";
import { table, json as outJson, jsonRequested, ok, error, handleHttp, formatEpochMs, truncateText } from "../output.js";
import { resolveSpace } from "../space.js";
import { registerSpaceCommerce } from "./space-commerce.js";
import { registerSpaceActivity } from "./space-activity.js";
import { registerSpaceInvitations } from "./space-invitations.js";
import { registerSpaceTurns } from "./space-turns.js";
import { registerSpaceWebhooks } from "./space-webhooks.js";

type ModOptions = {
  json?: boolean;
  name?: string;
  slug?: string;
  yes?: boolean;
};

type SpaceUpdateOptions = {
  name?: string;
  slug?: string;
  json?: boolean;
};

export type SpaceCreateOptions = {
  name: string;
  description?: string;
  checkpoint?: string;
  autoDestroy?: string;
  idleTtl?: string;
  spec?: string;
  json?: boolean;
};

type PromptOptions = {
  session?: string;
  title?: string;
  model?: string;
  provider?: string;
  harness?: "cohub" | "pi" | "codex";
  thinkingLevel?: string;
  readOnly?: boolean;
  steer?: boolean;
  delayMs?: string;
  at?: string;
  cron?: string;
  timezone?: string;
  label?: string[];
  env?: string[];
  image?: string[];
  json?: boolean;
};

type CompletionOptions = {
  model?: string;
  provider?: string;
  systemPrompt?: string;
  stream?: boolean;
  temperature?: string;
  maxTokens?: string;
  thinkingLevel?: string;
  json?: boolean;
};

type UploadFile = {
  id: string;
  localPath: string;
  relativePath: string;
  name: string;
  size: number;
  mimeType: string | null;
};

type UploadOptions = {
  dir?: string;
  json?: boolean;
};

const cliEnv = resolveCohubEnvironment();
const defaultIdleTtlSeconds = cliEnv === "prod" ? 12 * 60 * 60 : 10 * 60;
const SPACE_ROLES = ["host", "builder", "guest"] as const;
const SANDBOX_SPEC_IDS = ["standard", "boost", "ultra"] as const;
const LABEL_RESOURCE_TYPES = ["session", "checkpoint", "file"] as const;
/** Table cell width for space descriptions; `--json` keeps the full value. */
const SPACE_DESCRIPTION_COLUMN_WIDTH = 40;

function parseInteger(value: string, name: string, options: { min?: number; max?: number } = {}): number {
  if (!/^-?\d+$/.test(value.trim())) return error(`Invalid ${name}`, `${name} must be an integer`);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) return error(`Invalid ${name}`, `${name} must be a safe integer`);
  if (options.min !== undefined && parsed < options.min) return error(`Invalid ${name}`, `${name} must be at least ${options.min}`);
  if (options.max !== undefined && parsed > options.max) return error(`Invalid ${name}`, `${name} must be at most ${options.max}`);
  return parsed;
}

function collectOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function parseEnvOptions(values: string[] | undefined): Record<string, string> | undefined {
  if (!values?.length) return undefined;
  const env: Record<string, string> = {};
  for (const value of values) {
    const index = value.indexOf("=");
    if (index <= 0) return error("Invalid env", "Use --env KEY=value");
    const name = value.slice(0, index).trim();
    if (!name) return error("Invalid env", "Env name is required");
    env[name] = value.slice(index + 1);
  }
  return env;
}

function parseChoice<const T extends readonly string[]>(value: string, name: string, choices: T): T[number] {
  if ((choices as readonly string[]).includes(value)) return value as T[number];
  return error(`Invalid ${name}`, `Use one of: ${choices.join(", ")}`);
}

function parseNullableRole(value: string | undefined, name: string): "host" | "builder" | "guest" | null {
  if (value === undefined || value === "null") return null;
  return parseChoice(value, name, SPACE_ROLES);
}

const parseAutoDestroy = (opts: { autoDestroy?: string; idleTtl?: string }) => {
  const mode = opts.autoDestroy ?? (opts.idleTtl ? "idle" : undefined);
  if (!mode) return undefined;
  if (mode === "never") return { mode: "never" as const };
  if (mode !== "idle") return error("Invalid auto destroy mode", "Use --auto-destroy idle or --auto-destroy never");
  const ttlSeconds = parseInteger(opts.idleTtl ?? String(defaultIdleTtlSeconds), "idle TTL", { min: 60, max: 30 * 24 * 60 * 60 });
  return { mode: "idle" as const, ttlSeconds };
};

const parseSandboxSpec = (value: string | undefined) => value ? parseChoice(value, "sandbox spec", SANDBOX_SPEC_IDS) : undefined;

export function buildSpaceCreateInput(opts: SpaceCreateOptions): CreateSpaceInput {
  const autoDestroy = parseAutoDestroy(opts);
  const spec = parseSandboxSpec(opts.spec);
  const checkpointId = opts.checkpoint?.trim();
  if (opts.checkpoint !== undefined && !checkpointId) {
    return error("Invalid checkpoint", "Checkpoint ID is required");
  }

  return {
    name: opts.name,
    description: opts.description,
    ...(checkpointId
      ? { bootstrapSource: { type: "checkpoint", checkpointId } as const }
      : {}),
    ...((autoDestroy || spec)
      ? {
          config: {
            sandbox: {
              ...(autoDestroy ? { autoDestroy } : {}),
              ...(spec ? { spec } : {}),
            },
          },
        }
      : {}),
  };
}

const formatAutoDestroy = (policy: { mode: "idle"; ttlSeconds: number } | { mode: "never" } | undefined) => {
  if (!policy) return `${cliEnv === "prod" ? "12h" : "10m"} (default)`;
  if (policy.mode === "never") return "never";
  if (policy.ttlSeconds % 86400 === 0) return `${policy.ttlSeconds / 86400}d`;
  if (policy.ttlSeconds % 3600 === 0) return `${policy.ttlSeconds / 3600}h`;
  if (policy.ttlSeconds % 60 === 0) return `${policy.ttlSeconds / 60}m`;
  return `${policy.ttlSeconds}s`;
};

const slashPath = (value: string) => value.split(sep).join("/");

const walkUploadPath = async (localPath: string, root: string): Promise<UploadFile[]> => {
  const info = await stat(localPath);
  const name = basename(localPath);
  const relativePath = slashPath(relative(root, localPath) || name);

  if (info.isDirectory()) {
    const children = await readdir(localPath);
    const nested = await Promise.all(children.map((child) => walkUploadPath(resolve(localPath, child), root)));
    return nested.flat();
  }
  if (!info.isFile()) return [];

  return [{
    id: randomUploadEntryId(),
    localPath,
    relativePath,
    name,
    size: info.size,
    mimeType: null,
  }];
};

const randomUploadEntryId = () => randomUUID();

// Upload semantics: a file keeps its name, and a directory contributes its
// contents directly under the target dir — like `aws s3 cp dir remote:path`
// or `rclone copy`.
export const planUploadInput = async (input: string): Promise<UploadFile[]> => {
  const localPath = resolve(input);
  const info = await stat(localPath);
  if (!info.isDirectory()) return walkUploadPath(localPath, dirname(localPath));
  const children = await readdir(localPath);
  const nested = await Promise.all(children.map((child) => walkUploadPath(resolve(localPath, child), localPath)));
  return nested.flat();
};

export async function collectUploadFiles(paths: string[]): Promise<UploadFile[]> {
  if (paths.length === 0) return error("No files provided", "Pass one or more local files or directories.");
  const files = (await Promise.all(paths.map(planUploadInput))).flat();
  if (files.length === 0) return error("No regular files found");
  const seen = new Map<string, string>();
  for (const file of files) {
    const source = seen.get(file.relativePath);
    if (source) throw new Error(`Duplicate upload path "${file.relativePath}" from ${source} and ${file.localPath}`);
    seen.set(file.relativePath, file.localPath);
  }
  return files;
}

async function putUploadEntry(entry: UploadFile, uploadUrl: string, headers?: Record<string, string>): Promise<void> {
  await putLocalFile({
    url: uploadUrl,
    filePath: entry.localPath,
    size: entry.size,
    headers,
    label: entry.relativePath,
  });
}

async function uploadFiles(command: Command, paths: string[], opts: UploadOptions): Promise<void> {
  const spaceId = await resolveSpace(command);
  const client = createClient();
  try {
    const files = await collectUploadFiles(paths);
    const plan = await client.space(spaceId).files.createUpload({
      destination: { kind: "workspace", targetDir: opts.dir },
      entries: files.map((file) => ({
        id: file.id,
        name: file.name,
        relativePath: file.relativePath,
        size: file.size,
        mimeType: file.mimeType,
      })),
    });
    const byId = new Map(files.map((file) => [file.id, file]));
    for (const entry of plan.entries) {
      const file = byId.get(entry.id);
      if (!file) throw new Error(`Missing upload entry: ${entry.id}`);
      // Remote downloadUrl entries have no uploadUrl; complete pulls them server-side.
      if (!entry.uploadUrl) continue;
      await putUploadEntry(file, entry.uploadUrl, entry.headers);
    }
    const result = await client.space(spaceId).files.completeUpload(plan.uploadId, {
      entries: plan.entries.map((entry) => ({ id: entry.id })),
    });
    if (jsonRequested(opts)) return outJson({ ...result, uploadId: plan.uploadId, files: files.length });
    ok(`Uploaded ${files.length} file${files.length === 1 ? "" : "s"}`);
  } catch (e: unknown) {
    handleHttp(e);
  }
}

async function confirmRestart(opts: { yes?: boolean }): Promise<void> {
  if (opts.yes) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return error("Confirmation required", "Pass --yes to restart the sandbox automatically.");
  process.stdout.write("Changing mods restarts the sandbox and may interrupt running work. Continue? [y/N] ");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
    break;
  }
  const answer = Buffer.concat(chunks).toString().trim().toLowerCase();
  if (answer !== "y" && answer !== "yes") return error("Cancelled");
}

async function readPromptContent(words: string[], options: { allowEmpty?: boolean } = {}): Promise<string> {
  let content = words.join(" ");
  if (!content && !process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    content = Buffer.concat(chunks).toString().trim();
  }
  if (!content && !options.allowEmpty) return error("No content", "Pass as argument or pipe via stdin");
  return content;
}

async function sendPrompt(command: Command, words: string[], opts: PromptOptions): Promise<void> {
  const content = await readPromptContent(words, { allowEmpty: Boolean(opts.image?.length) });
  const scheduleFlags = [opts.delayMs, opts.at, opts.cron].filter((value) => value !== undefined);
  if (scheduleFlags.length > 1) return error("Conflicting schedule", "Use only one of --delay-ms, --at, or --cron");
  if (opts.cron && !opts.timezone) return error("Missing timezone", "--timezone is required with --cron");

  const thinkingLevel = opts.thinkingLevel?.trim() || undefined;
  if (
    thinkingLevel
    && !new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).has(thinkingLevel)
  ) {
    return error("Invalid thinking level", "Use off|minimal|low|medium|high|xhigh|max");
  }

  const spaceId = await resolveSpace(command);
  const client = createClient();
  try {
    const schedule = opts.delayMs
      ? { mode: "delay" as const, delayMs: parseInteger(opts.delayMs, "delay", { min: 1 }) }
      : opts.at
        ? { mode: "at" as const, sendAt: opts.at }
        : opts.cron
          ? { mode: "repeat" as const, cronExpression: opts.cron, timezone: opts.timezone as string }
          : undefined;
    const sessionId = opts.session;
    const imagePaths = opts.image ?? [];
    const imageBlocks = imagePaths.length
      ? await Promise.all(
          imagePaths.map(async (path): Promise<ContentBlock> => {
            const asset = await uploadChatImageAsset({
              client,
              spaceId,
              sessionId,
              path,
            });
            return {
              type: "image",
              source: { type: "url", url: asset.publicUrl },
              _meta: {
                filename: basename(path),
                mediaType: "image/webp",
                size: asset.size,
                objectKey: asset.objectKey,
              },
            };
          }),
        )
      : [];
    const promptContent: ContentBlock[] = [
      ...(content ? [{ type: "text" as const, text: content }] : []),
      ...imageBlocks,
    ];
    const result = await client.space(spaceId).prompt({
      sessionId,
      title: sessionId === opts.session ? opts.title : undefined,
      content: promptContent,
      model: opts.model,
      provider: opts.provider,
      harness: opts.harness,
      thinkingLevel: thinkingLevel as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined,
      accessMode: opts.readOnly ? "read_only" : "full_access",
      intent: opts.steer ? "steer" : undefined,
      env: parseEnvOptions(opts.env),
      schedule,
      labelRefs: opts.label?.length ? opts.label : undefined,
    });
    if (jsonRequested(opts)) return outJson(result);
    if (result.mode === "immediate") return ok(`Prompt sent — sessionId: ${result.session.id}, turnId: ${result.turn.id}`);
    if (result.mode === "repeat") return ok(`Prompt scheduled — cronJobId: ${result.cronJobId}, nextRunAt: ${result.nextRunAt}`);
    return ok(`Prompt scheduled — taskRunId: ${result.taskRunId}, scheduledAt: ${result.scheduledAt}`);
  } catch (e: unknown) {
    handleHttp(e);
  }
}


async function runCompletionCommand(command: Command, words: string[], opts: CompletionOptions) {
  const spaceId = await resolveSpace(command);
  const content = words.join(" ").trim();
  if (!content && process.stdin.isTTY) {
    return error("Message required", "Pass content args or pipe via stdin");
  }
  let text = content;
  if (!text && !process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    text = Buffer.concat(chunks).toString().trim();
  }
  if (!text) return error("Message required", "Pass content args or pipe via stdin");

  const temperature = opts.temperature !== undefined ? Number(opts.temperature) : undefined;
  if (temperature !== undefined && !Number.isFinite(temperature)) {
    return error("Invalid temperature", "--temperature must be a number");
  }
  const maxTokens = opts.maxTokens !== undefined ? Number(opts.maxTokens) : undefined;
  if (maxTokens !== undefined && (!Number.isFinite(maxTokens) || maxTokens <= 0)) {
    return error("Invalid max tokens", "--max-tokens must be a positive number");
  }
  const thinkingLevel = opts.thinkingLevel?.trim() || undefined;
  if (
    thinkingLevel
    && !new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).has(thinkingLevel)
  ) {
    return error("Invalid thinking level", "Use off|minimal|low|medium|high|xhigh|max");
  }

  const client = createClient();
  const input = {
    provider: opts.provider,
    model: opts.model,
    systemPromptPath: opts.systemPrompt,
    messages: [{ role: "user" as const, content: [{ type: "text" as const, text }] }],
    temperature,
    maxTokens,
    thinkingLevel: thinkingLevel as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined,
  };

  try {
    if (opts.stream) {
      const iterator = client.space(spaceId).streamCompletion(input);
      let step = await iterator.next();
      let finalResult: Awaited<ReturnType<ReturnType<typeof client.space>["completion"]>> | null = null;
      while (!step.done) {
        const event = step.value;
        if (event.type === "delta") {
          if (!jsonRequested(opts)) process.stdout.write(event.text);
        } else if (event.type === "thinking_delta" && !jsonRequested(opts)) {
          process.stderr.write(event.text);
        }
        step = await iterator.next();
      }
      finalResult = step.value;
      if (jsonRequested(opts)) return outJson(finalResult);
      process.stdout.write("\n");
      if (finalResult.usage?.totalTokens != null) {
        process.stderr.write(`  tokens: ${finalResult.usage.totalTokens}\n`);
      }
      return;
    }

    const result = await client.space(spaceId).completion(input);
    if (jsonRequested(opts)) return outJson(result);
    const textOut = result.message.content
      .filter((block: ContentBlock): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
      .map((block: Extract<ContentBlock, { type: "text" }>) => block.text)
      .join("");
    console.log(textOut);
    if (result.usage?.totalTokens != null) {
      process.stderr.write(`\n  tokens: ${result.usage.totalTokens}\n`);
    }
  } catch (e: unknown) {
    handleHttp(e);
  }
}

export function registerPrompt(program: Command): void {
  program
    .command("prompt [content...]")
    .description("Send or schedule a prompt in a space")
    .option("--session <id>", "Target session ID")
    .option("--title <title>", "Title for a newly created session or schedule")
    .option("-m, --model <model>", "Model name")
    .option("-p, --provider <provider>", "Provider name")
    .option("--harness <harness>", "Harness: cohub, pi, or codex", "cohub")
    .option("--thinking-level <level>", "Thinking level: off|minimal|low|medium|high|xhigh|max")
    .option("--read-only", "Use read-only tools")
    .option("--steer", "Interrupt the current turn and run immediately")
    .option("--delay-ms <ms>", "Delay sending by milliseconds")
    .option("--at <iso>", "Send once at an ISO 8601 time with timezone")
    .option("--cron <expression>", "Repeat using a 5-field cron expression")
    .option("--timezone <tz>", "IANA timezone for --cron, e.g. Asia/Shanghai")
    .option("--label <ref>", "Attach a label, e.g. Bug or Area/Frontend", collectOption, [])
    .option("--env <key=value>", "Set an environment variable for this turn", collectOption, [])
    .option("--image <path>", "Attach an image", collectOption, [])
    .option("--json", "Output as JSON")
    .action((words: string[], opts: PromptOptions) => sendPrompt(program, words, opts));

  program
    .command("completion [content...]")
    .description("Raw LLM completion with full message control")
    .option("-m, --model <model>", "Model name")
    .option("-p, --provider <provider>", "Provider name")
    .option("--system-prompt <path>", "Space-relative system prompt markdown path")
    .option("--stream", "Stream tokens via SSE")
    .option("--temperature <n>", "Sampling temperature")
    .option("--max-tokens <n>", "Maximum output tokens")
    .option("--thinking-level <level>", "Thinking level: off|minimal|low|medium|high|xhigh")
    .option("--json", "Output as JSON")
    .action((words: string[], opts: CompletionOptions) => runCompletionCommand(program, words, opts));
}

export function registerSpaceCreate(
  spacesCmd: Command,
  dependencies: { createClient?: () => CohubHttpClient } = {},
): Command {
  const getClient = dependencies.createClient ?? createClient;
  return spacesCmd
    .command("create")
    .description("Create a new space")
    .requiredOption("-n, --name <name>", "Space name")
    .option("-d, --description <desc>", "Space description")
    .option("--checkpoint <id>", "Create from a checkpoint")
    .option("--auto-destroy <mode>", "Sandbox auto destroy mode: idle or never")
    .option("--idle-ttl <seconds>", "Idle auto destroy TTL in seconds, max 2592000 (30d)")
    .option("--spec <spec>", "Sandbox spec: standard, boost, or ultra")
    .option("--json", "Output as JSON")
    .action(async (opts: SpaceCreateOptions) => {
      const client = getClient();
      try {
        const result = await client.spaces.create(buildSpaceCreateInput(opts));
        if (jsonRequested(opts)) return outJson(result);
        ok(`Space created: ${result.space.id}`);
        table([{ ...result.space, taskRunId: result.taskRunId }], [
          { key: "id", label: "ID" },
          { key: "name", label: "Name" },
          { key: "taskRunId", label: "Task" },
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });
}

export function registerSpaces(program: Command): void {
  const spacesCmd = program.command("spaces").description("Space management");
  registerSpaceInvitations(spacesCmd);

  // ── spaces ls ──
  spacesCmd
    .command("ls")
    .alias("list")
    .description("List all spaces")
    .option("--mine", "Only spaces you own")
    .option("--pinned", "Only pinned spaces")
    .option("--json", "Output as JSON")
    .action(async (opts: { mine?: boolean; pinned?: boolean; json?: boolean }) => {
      const client = createClient();
      try {
        const [items, me] = await Promise.all([
          client.spaces.list(),
          opts.mine ? client.user.getMe() : Promise.resolve(null),
        ]);
        const myUuid = me?.uuid ?? null;
        const filtered = items.filter((item) => {
          if (opts.mine && myUuid && item.userUuid !== myUuid) return false;
          if (opts.pinned && !item.isPinned) return false;
          return true;
        });
        if (jsonRequested(opts)) return outJson(filtered);
        table(filtered, [
          { key: "id", label: "ID" },
          { key: "name", label: "Name" },
          { key: "description", label: "Description", format: (value) => truncateText(value, SPACE_DESCRIPTION_COLUMN_WIDTH) },
          { key: "isPinned", label: "Pinned" },
          { key: "createdAt", label: "Created" },
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  // ── spaces get ──
  spacesCmd
    .command("get [id]")
    .description("Show space details")
    .option("--json", "Output as JSON")
    .action(async (id: string | undefined, opts: { json?: boolean }) => {
      const spaceId = id?.trim() || await resolveSpace(spacesCmd);
      const client = createClient();
      try {
        const space = await client.spaces.get(spaceId);
        if (jsonRequested(opts)) return outJson(space);
        table([space], [
          { key: "id", label: "ID" },
          { key: "name", label: "Name" },
          { key: "slug", label: "Slug" },
          { key: "description", label: "Description", format: (value) => truncateText(value, SPACE_DESCRIPTION_COLUMN_WIDTH) },
          { key: "status", label: "Status" },
          { key: "createdAt", label: "Created" },
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  // ── spaces create ──
  registerSpaceCreate(spacesCmd);

  // ── spaces update ──
  spacesCmd
    .command("update <id>")
    .description("Update a space")
    .option("--name <name>", "Space name")
    .option("--slug <slug>", "Public space slug")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: SpaceUpdateOptions) => {
      const input = {
        name: opts.name,
        slug: opts.slug,
      };
      if (input.name === undefined && input.slug === undefined) {
        return error("Nothing to update", "Pass --name or --slug.");
      }

      const client = createClient();
      try {
        const result = await client.space(id).update(input);
        if (jsonRequested(opts)) return outJson(result);
        ok("Space updated");
        table([result.space], [
          { key: "id", label: "ID" },
          { key: "name", label: "Name" },
          { key: "slug", label: "Slug" },
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  // ── spaces rename ──
  spacesCmd
    .command("rename <id> <name>")
    .description("Rename a space")
    .action(async (id: string, name: string) => {
      const client = createClient();
      try {
        await client.space(id).rename(name);
        ok(`Space renamed to "${name}"`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  // ── spaces avatar ──
  spacesCmd
    .command("avatar <path>")
    .description("Upload the space avatar")
    .option("--json", "Output as JSON")
    .action(async (path: string, opts: { json?: boolean }) => {
      const spaceId = await resolveSpace(spacesCmd);
      const client = createClient();
      try {
        const asset = await uploadAvatarAsset({ client, purpose: "space_avatar", spaceId, path });
        const result = await client.space(spaceId).profile({ avatarUrl: asset.publicUrl });
        if (jsonRequested(opts)) return outJson({ ...result, asset });
        ok("Space avatar updated");
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  // ── spaces config ──
  spacesCmd
    .command("config <id>")
    .description("Show or update space configuration")
    .option("--auto-destroy <mode>", "Sandbox auto destroy mode: idle or never")
    .option("--idle-ttl <seconds>", "Idle auto destroy TTL in seconds, max 2592000 (30d)")
    .option("--spec <spec>", "Sandbox spec: standard, boost, or ultra")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { autoDestroy?: string; idleTtl?: string; spec?: string; json?: boolean }) => {
      const client = createClient();
      try {
        const autoDestroy = parseAutoDestroy(opts);
        const spec = parseSandboxSpec(opts.spec);
        if (autoDestroy || spec) {
          const result = await client.space(id).updateConfig({ sandbox: { ...(autoDestroy ? { autoDestroy } : {}), ...(spec ? { spec } : {}) } });
          if (jsonRequested(opts)) return outJson(result);
          ok(`Space config updated${autoDestroy ? ` — sandbox auto destroy: ${formatAutoDestroy(autoDestroy)}` : ""}${spec ? ` — sandbox spec: ${spec}` : ""}${result.sandbox?.pendingRestart ? " — restart the sandbox to apply" : ""}`);
          return;
        }
        const result = await client.space(id).getConfig();
        if (jsonRequested(opts)) return outJson(result);
        table([
          { key: "sandbox.autoDestroy", value: formatAutoDestroy(result.config.sandbox.autoDestroy) },
          { key: "sandbox.spec", value: result.config.sandbox.spec ?? "standard" },
          { key: "sandbox.appliedSpec", value: result.config.sandbox.appliedSpec ?? "—" },
          { key: "sandbox.allowedSpec", value: result.config.sandbox.allowedSpec ?? "standard" },
        ], [
          { key: "key", label: "Key" },
          { key: "value", label: "Value" },
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  // ── spaces prompt ──
  spacesCmd
    .command("prompt [content...]", { hidden: true })
    .alias("send")
    .description("Send or schedule a prompt in the target space")
    .option("--harness <harness>", "Harness: cohub, pi, or codex", "cohub")
    .option("--session <id>", "Target session ID")
    .option("--title <title>", "Title for a newly created session or schedule")
    .option("-m, --model <model>", "Model name")
    .option("-p, --provider <provider>", "Provider name")
    .option("--thinking-level <level>", "Thinking level: off|minimal|low|medium|high|xhigh|max")
    .option("--read-only", "Use read-only tools")
    .option("--steer", "Interrupt the current turn and run immediately")
    .option("--delay-ms <ms>", "Delay sending by milliseconds")
    .option("--at <iso>", "Send once at an ISO 8601 time with timezone")
    .option("--cron <expression>", "Repeat using a 5-field cron expression")
    .option("--timezone <tz>", "IANA timezone for --cron, e.g. Asia/Shanghai")
    .option("--label <ref>", "Attach a label, e.g. Bug or Area/Frontend", collectOption, [])
    .option("--env <key=value>", "Set an environment variable for this turn", collectOption, [])
    .option("--image <path>", "Attach an image", collectOption, [])
    .option("--json", "Output as JSON")
    .action((words: string[], opts: PromptOptions) => sendPrompt(spacesCmd, words, opts));

  // ── spaces completion ──
  spacesCmd
    .command("completion [content...]")
    .description("Raw LLM completion with full message control")
    .option("-m, --model <model>", "Model name")
    .option("-p, --provider <provider>", "Provider name")
    .option("--system-prompt <path>", "Space-relative system prompt markdown path")
    .option("--stream", "Stream tokens via SSE")
    .option("--temperature <n>", "Sampling temperature")
    .option("--max-tokens <n>", "Maximum output tokens")
    .option("--thinking-level <level>", "Thinking level: off|minimal|low|medium|high|xhigh")
    .option("--json", "Output as JSON")
    .action((words: string[], opts: CompletionOptions) => runCompletionCommand(spacesCmd, words, opts));

  // ── spaces files ──
  registerFiles(spacesCmd);

  // ── spaces sessions ──
  registerSessions(spacesCmd);

  // ── spaces turns ──
  registerSpaceTurns(spacesCmd);

  // ── spaces members ──
  registerMembers(spacesCmd);

  // ── spaces access ──
  registerAccess(spacesCmd);

  // ── spaces checkpoints ──
  registerCheckpoints(spacesCmd);

  // ── spaces mods ──
  registerMods(spacesCmd);

  // ── spaces labels ──
  registerLabels(spacesCmd);

  // ── spaces webhooks ──
  registerSpaceWebhooks(spacesCmd);

  // ── spaces pin / unpin (user-scope label convenience) ──
  spacesCmd
    .command("pin <id>")
    .description("Pin a space (add the Pinned user label)")
    .action(async (id: string) => {
      const client = createClient();
      try {
        await client.user.labels.patchResourceLabels("space", id.trim(), { addLabelRefs: ["Pinned"] });
        ok("Space pinned");
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  spacesCmd
    .command("unpin <id>")
    .description("Unpin a space (remove the Pinned user label)")
    .action(async (id: string) => {
      const client = createClient();
      try {
        await client.user.labels.patchResourceLabels("space", id.trim(), { removeLabelRefs: ["Pinned"] });
        ok("Space unpinned");
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  // ── spaces commerce ──
  registerSpaceCommerce(spacesCmd);

  // ── spaces activity ──
  registerSpaceActivity(spacesCmd);

  // ── spaces usage ──
  spacesCmd
    .command("usage [days]")
    .description("Space usage statistics (default: 30 days)")
    .option("--json", "Output as JSON")
    .action(async (days: string | undefined, opts: { json?: boolean }) => {
      const spaceId = await resolveSpace(spacesCmd);
      const client = createClient();
      try {
        const usage = await client.space(spaceId).usage.get(parseInteger(days ?? "30", "days", { min: 1 }));
        if (jsonRequested(opts)) return outJson(usage);
        console.log("\n  Summary:");
        table([usage.summary], [
          { key: "totalTokens", label: "Tokens" },
          { key: "costTotal", label: "Cost ($)" },
          { key: "requestCount", label: "Requests" },
          { key: "successCount", label: "Success" },
          { key: "errorCount", label: "Errors" },
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });
}

function flattenLabels(items: LabelListItem[], prefix = ""): Array<LabelListItem & { path: string }> {
  return items.flatMap((label) => {
    const path = prefix ? `${prefix}/${label.name}` : label.name;
    return [{ ...label, path }, ...flattenLabels(label.children ?? [], path)];
  });
}

function parseLabelResourceType(value: string): LabelResourceType {
  return parseChoice(value, "resource type", LABEL_RESOURCE_TYPES);
}

function parseLabelRefs(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function registerLabels(spacesCmd: Command): void {
  const labelsCmd = spacesCmd
    .command("labels")
    .description("Manage labels")
    .hook("preAction", async () => { await resolveSpace(spacesCmd); });

  labelsCmd
    .command("ls")
    .alias("list")
    .description("List labels")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const spaceId = await resolveSpace(spacesCmd);
      const client = createClient();
      try {
        const result = await client.space(spaceId).labels.list();
        if (jsonRequested(opts)) return outJson(result);
        table(flattenLabels(result.labels), [
          { key: "path", label: "Label" },
          { key: "rank", label: "Rank" },
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  labelsCmd
    .command("create <labelRef>")
    .description("Create a label")
    .option("--json", "Output as JSON")
    .action(async (labelRef: string, opts: { json?: boolean }) => {
      const spaceId = await resolveSpace(spacesCmd);
      const client = createClient();
      try {
        const result = await client.space(spaceId).labels.create(labelRef);
        if (jsonRequested(opts)) return outJson(result);
        ok("Label created");
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  labelsCmd
    .command("update <labelRef>")
    .description("Update a label")
    .option("--name <name>", "Label name")
    .option("--parent <ref>", "Parent label; use null for root")
    .option("--rank <n>", "Sort rank")
    .option("--json", "Output as JSON")
    .action(async (labelRef: string, opts: { name?: string; parent?: string; rank?: string; json?: boolean }) => {
      const spaceId = await resolveSpace(spacesCmd);
      const client = createClient();
      try {
        const result = await client.space(spaceId).labels.update(labelRef, {
          name: opts.name,
          parentRef: opts.parent === undefined ? undefined : opts.parent === "null" ? null : opts.parent,
          rank: opts.rank === undefined ? undefined : parseInteger(opts.rank, "rank", { min: -1_000_000, max: 1_000_000 }),
        });
        if (jsonRequested(opts)) return outJson(result);
        ok("Label updated");
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  labelsCmd
    .command("rm <labelRef>")
    .alias("delete")
    .description("Delete a label")
    .action(async (labelRef: string) => {
      const spaceId = await resolveSpace(spacesCmd);
      const client = createClient();
      try {
        await client.space(spaceId).labels.delete(labelRef);
        ok("Label deleted");
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  labelsCmd
    .command("reorder <labelRefs...>")
    .description("Reorder labels")
    .option("--json", "Output as JSON")
    .action(async (labelRefs: string[], opts: { json?: boolean }) => {
      const spaceId = await resolveSpace(spacesCmd);
      const client = createClient();
      try {
        const result = await client.space(spaceId).labels.reorder(labelRefs);
        if (jsonRequested(opts)) return outJson(result);
        ok("Labels reordered");
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  labelsCmd
    .command("items <labelRef>")
    .description("List label items")
    .option("--limit <n>", "Page size")
    .option("--cursor <cursor>", "Page cursor")
    .option("--json", "Output as JSON")
    .action(async (labelRef: string, opts: { limit?: string; cursor?: string; json?: boolean }) => {
      const spaceId = await resolveSpace(spacesCmd);
      const client = createClient();
      try {
        const result = await client.space(spaceId).labels.listItems(labelRef, {
          limit: opts.limit ? parseInteger(opts.limit, "limit", { min: 1 }) : undefined,
          cursor: opts.cursor,
        });
        if (jsonRequested(opts)) return outJson(result);
        table(result.items, [
          { key: "id", label: "ID" },
          { key: "resourceType", label: "Type" },
          { key: "resourceRef", label: "Resource" },
          { key: "rank", label: "Rank" },
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  labelsCmd
    .command("attach <labelRef> <resourceType> <resourceRef>")
    .description("Attach a label")
    .option("--json", "Output as JSON")
    .action(async (labelRef: string, resourceType: string, resourceRef: string, opts: { json?: boolean }) => {
      const spaceId = await resolveSpace(spacesCmd);
      const client = createClient();
      try {
        const result = await client.space(spaceId).labels.attach(labelRef, { resourceType: parseLabelResourceType(resourceType), resourceRef });
        if (jsonRequested(opts)) return outJson(result);
        ok("Label attached");
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  labelsCmd
    .command("detach <labelRef> <resourceType> <resourceRef>")
    .description("Detach a label")
    .action(async (labelRef: string, resourceType: string, resourceRef: string) => {
      const spaceId = await resolveSpace(spacesCmd);
      const client = createClient();
      try {
        await client.space(spaceId).labels.detach(labelRef, { resourceType: parseLabelResourceType(resourceType), resourceRef });
        ok("Label detached");
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  labelsCmd
    .command("patch <resourceType> <resourceRef>")
    .description("Patch resource labels")
    .option("--add <refs>", "Comma-separated label refs to add")
    .option("--remove <refs>", "Comma-separated label refs to remove")
    .option("--json", "Output as JSON")
    .action(async (resourceType: string, resourceRef: string, opts: { add?: string; remove?: string; json?: boolean }) => {
      const spaceId = await resolveSpace(spacesCmd);
      const client = createClient();
      try {
        const result = await client.space(spaceId).labels.patchResourceLabels(parseLabelResourceType(resourceType), resourceRef, {
          addLabelRefs: parseLabelRefs(opts.add),
          removeLabelRefs: parseLabelRefs(opts.remove),
        });
        if (jsonRequested(opts)) return outJson(result);
        ok("Resource labels patched");
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  labelsCmd
    .command("set <resourceType> <resourceRef> [labelRefs...]")
    .description("Set resource labels")
    .option("--labels <refs>", "Comma-separated label refs")
    .option("--json", "Output as JSON")
    .action(async (resourceType: string, resourceRef: string, labelRefs: string[], opts: { labels?: string; json?: boolean }) => {
      const spaceId = await resolveSpace(spacesCmd);
      const client = createClient();
      try {
        const refs = [...parseLabelRefs(opts.labels), ...labelRefs];
        const result = await client.space(spaceId).labels.setResourceLabels(parseLabelResourceType(resourceType), resourceRef, refs);
        if (jsonRequested(opts)) return outJson(result);
        ok("Resource labels updated");
      } catch (e: unknown) {
        handleHttp(e);
      }
    });
}

function registerMods(spacesCmd: Command): void {
  const modsCmd = spacesCmd
    .command("mods")
    .description("Manage space mods")
    .hook("preAction", async () => { await resolveSpace(spacesCmd); });

  modsCmd
    .command("ls")
    .alias("list")
    .description("List mods")
    .option("--json", "Output as JSON")
    .action(async (opts: ModOptions) => {
      const spaceId = await resolveSpace(spacesCmd);
      const client = createClient();
      try {
        const result = await client.space(spaceId).mods.list();
        if (jsonRequested(opts)) return outJson(result.items);
        table(result.items, [
          { key: "id", label: "ID" },
          { key: "modSpaceName", label: "Name" },
          { key: "mountPath", label: "Mount" },
          { key: "enabled", label: "On" },
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  modsCmd
    .command("add <modSpaceId>")
    .description("Add a mod")
    .option("--name <name>", "Display name")
    .option("--slug <slug>", "Mount slug")
    .option("-y, --yes", "Confirm sandbox restart")
    .option("--json", "Output as JSON")
    .action(async (modSpaceId: string, opts: ModOptions) => {
      await confirmRestart(opts);
      const spaceId = await resolveSpace(spacesCmd);
      const client = createClient();
      try {
        const result = await client.space(spaceId).mods.create({ modSpaceId, name: opts.name, mountSlug: opts.slug });
        if (jsonRequested(opts)) return outJson(result);
        ok(`Mod added — ${result.item.mountPath}; sandbox restarting`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  modsCmd
    .command("enable <modId>")
    .description("Enable a mod")
    .option("-y, --yes", "Confirm sandbox restart")
    .option("--json", "Output as JSON")
    .action(async (modId: string, opts: ModOptions) => {
      await confirmRestart(opts);
      const spaceId = await resolveSpace(spacesCmd);
      const client = createClient();
      try {
        const result = await client.space(spaceId).mods.update(modId, { enabled: true });
        if (jsonRequested(opts)) return outJson(result);
        ok("Mod enabled; sandbox restarting");
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  modsCmd
    .command("disable <modId>")
    .description("Disable a mod")
    .option("-y, --yes", "Confirm sandbox restart")
    .option("--json", "Output as JSON")
    .action(async (modId: string, opts: ModOptions) => {
      await confirmRestart(opts);
      const spaceId = await resolveSpace(spacesCmd);
      const client = createClient();
      try {
        const result = await client.space(spaceId).mods.update(modId, { enabled: false });
        if (jsonRequested(opts)) return outJson(result);
        ok("Mod disabled; sandbox restarting");
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  modsCmd
    .command("rm <modId>")
    .alias("remove")
    .description("Remove a mod")
    .option("-y, --yes", "Confirm sandbox restart")
    .option("--json", "Output as JSON")
    .action(async (modId: string, opts: ModOptions) => {
      await confirmRestart(opts);
      const spaceId = await resolveSpace(spacesCmd);
      const client = createClient();
      try {
        const result = await client.space(spaceId).mods.remove(modId);
        if (jsonRequested(opts)) return outJson(result);
        ok("Mod removed; sandbox restarting");
      } catch (e: unknown) {
        handleHttp(e);
      }
    });
}

// ── File operations ──

type DiffFileLike = {
  path: string;
  oldPath?: string | null;
  status?: string | null;
  kind: string;
  binary?: boolean;
  asset?: boolean;
  additions?: number | null;
  deletions?: number | null;
  oldSize?: number | null;
  newSize?: number | null;
  truncated?: boolean;
  lines: Array<{ type: string; text: string }>;
};

type DiffSummaryLike = {
  files: Array<{
    status: string;
    path: string;
    oldPath?: string | null;
    additions: number | null;
    deletions: number | null;
    binary: boolean;
    asset: boolean;
  }>;
  truncated: boolean;
  incomplete?: boolean;
  stats?: {
    changedFileCount: number;
    additions: number;
    deletions: number;
  };
};

function formatDiffBytes(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value >= 10 * 1024 ? 0 : 1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function printDiffFile(file: DiffFileLike): void {
  if (file.kind !== "text") {
    const size =
      file.oldSize !== undefined || file.newSize !== undefined
        ? `  (${formatDiffBytes(file.oldSize)} → ${formatDiffBytes(file.newSize)})`
        : "";
    console.log(`${file.status ?? "?"}  ${file.path}  (${file.kind})${size}`);
    return;
  }
  if (file.lines.length === 0) {
    console.log(`${file.status ?? "?"}  ${file.path}  (no textual changes)`);
    return;
  }
  for (const line of file.lines) {
    if (line.type === "add") console.log(`+${line.text}`);
    else if (line.type === "del") console.log(`-${line.text}`);
    else if (line.type === "hunk") console.log(line.text);
    else if (line.type === "meta") continue;
    else console.log(` ${line.text}`);
  }
  if (file.truncated) console.log("  … truncated");
}

function printDiffSummary(
  summary: DiffSummaryLike,
  options?: { emptyLabel?: string; footer?: string | null },
): void {
  if (summary.files.length === 0) {
    console.log(options?.emptyLabel ?? "  (no changes)");
    return;
  }
  if (summary.stats) {
    const parts = [`${summary.stats.changedFileCount} file(s)`];
    if (summary.stats.additions > 0) parts.push(`+${summary.stats.additions}`);
    if (summary.stats.deletions > 0) parts.push(`-${summary.stats.deletions}`);
    console.log(`  ${parts.join(" · ")}`);
  }
  table(
    summary.files.map((file) => ({
      status: file.status,
      path: file.oldPath ? `${file.oldPath} → ${file.path}` : file.path,
      plus: file.additions ?? (file.binary || file.asset ? "-" : "0"),
      minus: file.deletions ?? (file.binary || file.asset ? "-" : "0"),
    })),
    [
      { key: "status", label: "St" },
      { key: "path", label: "Path" },
      { key: "plus", label: "+" },
      { key: "minus", label: "-" },
    ],
  );
  if (options?.footer) console.log(options.footer);
  else if (summary.incomplete) console.log("  … partial scan");
  else if (summary.truncated) console.log("  … truncated");
}

function registerFiles(spacesCmd: Command): void {
  const filesCmd = spacesCmd
    .command("files")
    .description("File operations")
    .hook("preAction", async () => { await resolveSpace(spacesCmd); });

  filesCmd
    .command("ls [path]")
    .alias("list")
    .description("List directory tree")
    .option("--json", "Output as JSON")
    .action(async (path: string | undefined, opts: { json?: boolean }) => {
      const spaceId = await resolveSpace(spacesCmd);
      const client = createClient();
      try {
        const tree = await client.space(spaceId).files.list(path ?? "");
        if (jsonRequested(opts)) return outJson(tree);
        if (tree.entries.length === 0) {
          console.log("  (empty)");
          return;
        }
        table(tree.entries, [
          { key: "name", label: "Name" },
          { key: "type", label: "Type" },
          { key: "size", label: "Size" },
          { key: "mtimeMs", label: "Modified", format: formatEpochMs },
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  filesCmd
    .command("cat <path>")
    .description("Read file content")
    .action(async (path: string) => {
      const spaceId = await resolveSpace(spacesCmd);
      const client = createClient();
      try {
        const file = await client.space(spaceId).files.read(path);
        if (!("content" in file)) return error("File is being prepared. Please retry shortly.");
        if (file.delivery === "url" && file.url) {
          console.log(`[CDN] ${file.url}`);
        }
        console.log(file.content);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  filesCmd
    .command("write <path>")
    .description("Write file content")
    .option("-c, --content <text>", "File content")
    .option("-e, --encoding <enc>", "Encoding (utf-8 or base64)", "utf-8")
    .action(async (path: string, opts: { content?: string; encoding?: string }) => {
      let content = opts.content ?? "";
      if (!content && !process.stdin.isTTY) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        content = Buffer.concat(chunks).toString();
      }
      if (!content) return error("No content provided", "Use -c or pipe via stdin");

      const spaceId = await resolveSpace(spacesCmd);
      const client = createClient();
      try {
        const result = await client.space(spaceId).files.write({
          path,
          content,
          encoding: opts.encoding as "utf-8" | "base64",
        });
        ok(`Written ${result.size} bytes to ${result.path}`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  filesCmd
    .command("upload <paths...>")
    .description("Upload local files; directory contents land under the target dir")
    .option("--dir <path>", "Target directory in the space")
    .option("--json", "Output as JSON")
    .action((paths: string[], opts: UploadOptions) => uploadFiles(spacesCmd, paths, opts));

  filesCmd
    .command("mkdir <path>")
    .description("Create a directory")
    .action(async (path: string) => {
      const spaceId = await resolveSpace(spacesCmd);
      const client = createClient();
      try {
        await client.space(spaceId).files.createDir(path);
        ok(`Directory created: ${path}`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  filesCmd
    .command("rm <path>")
    .description("Delete a file or directory")
    .option("-r, --recursive", "Delete recursively")
    .action(async (path: string, opts: { recursive?: boolean }) => {
      const spaceId = await resolveSpace(spacesCmd);
      const client = createClient();
      try {
        await client.space(spaceId).files.delete(path, opts.recursive ?? false);
        ok(`Deleted: ${path}`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  filesCmd
    .command("mv <from> <to>")
    .description("Move or rename")
    .action(async (from: string, to: string) => {
      const spaceId = await resolveSpace(spacesCmd);
      const client = createClient();
      try {
        await client.space(spaceId).files.move({ fromPath: from, toPath: to });
        ok(`Moved: ${from} → ${to}`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  filesCmd
    .command("diff [path]")
    .description("Show pending workspace changes vs last checkpoint")
    .option("--json", "Output as JSON")
    .action(async (path: string | undefined, opts: { json?: boolean }) => {
      const spaceId = await resolveSpace(spacesCmd);
      const client = createClient();
      try {
        if (path) {
          const file = await client.space(spaceId).files.diffFile(path);
          if (jsonRequested(opts)) return outJson(file);
          printDiffFile(file);
          return;
        }
        const summary = await client.space(spaceId).files.diff();
        if (jsonRequested(opts)) return outJson(summary);
        printDiffSummary(summary, {
          emptyLabel: "  (no pending changes)",
          footer: summary.incomplete
            ? "  … partial scan"
            : summary.truncated
              ? "  … truncated"
              : null,
        });
      } catch (e: unknown) {
        handleHttp(e);
      }
    });
}

// ── Session operations ──

type SessionCreateOptions = {
  label?: string[];
  image?: string[];
  json?: boolean;
};

function registerSessions(spacesCmd: Command): void {
  const sessionsCmd = spacesCmd
    .command("sessions")
    .description("Browse sessions and turns")
    .hook("preAction", async () => { await resolveSpace(spacesCmd); });

  sessionsCmd
    .command("ls")
    .alias("list")
    .description("List sessions")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const spaceId = await resolveSpace(spacesCmd);
      const client = createClient();
      try {
        const result = await client.space(spaceId).sessions.list();
        if (jsonRequested(opts)) return outJson(result);
        if (result.sessions.length === 0) {
          console.log("  (empty)");
          return;
        }
        table(result.sessions, [
          { key: "id", label: "ID" },
          { key: "title", label: "Title" },
          { key: "totalMessages", label: "Messages" },
          { key: "createdAt", label: "Created" },
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  sessionsCmd
    .command("create [title]")
    .description("Create a session")
    .option("--label <ref>", "Attach a label, e.g. Bug or Area/Frontend", collectOption, [])
    .option("--json", "Output as JSON")
    .action(async (title: string | undefined, opts: SessionCreateOptions) => {
      const spaceId = await resolveSpace(spacesCmd);
      const client = createClient();
      try {
        const result = await client.space(spaceId).sessions.create({
          title,
          labelRefs: opts.label?.length ? opts.label : undefined,
        });
        if (jsonRequested(opts)) return outJson(result);
        ok(`Session created: ${result.session.id}`);
        table([result.session], [
          { key: "id", label: "ID" },
          { key: "title", label: "Title" },
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  sessionsCmd
    .command("get <id>")
    .description("Session details")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const spaceId = await resolveSpace(spacesCmd);
      const client = createClient();
      try {
        const result = await client.space(spaceId).session(id).get();
        if (jsonRequested(opts)) return outJson(result);
        table([result.session], [
          { key: "id", label: "ID" },
          { key: "title", label: "Title" },
          { key: "totalMessages", label: "Messages" },
          { key: "totalToolCalls", label: "Tool Calls" },
          { key: "createdAt", label: "Created" },
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  sessionsCmd
    .command("files <id>")
    .description("List Space files changed by a session")
    .option("--limit <n>", "Maximum files to list; the server caps it", "200")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { limit: string; json?: boolean }) => {
      const spaceId = await resolveSpace(spacesCmd);
      const limit = Number.parseInt(opts.limit, 10);
      if (!Number.isInteger(limit) || limit < 1) {
        return error("Invalid limit", "--limit must be a positive integer");
      }
      const client = createClient();
      try {
        const result = await client.space(spaceId).session(id).files({ limit });
        if (jsonRequested(opts)) return outJson(result);
        if (result.files.length === 0) {
          console.log("  (empty)");
          return;
        }
        table(result.files.map((file) => ({
          path: file.path,
          change: file.lastKind,
          count: file.changeCount,
          turn: file.lastTurnSequence,
          changedAt: file.lastChangedAt,
        })), [
          { key: "path", label: "Path" },
          { key: "change", label: "Change" },
          { key: "count", label: "Count" },
          { key: "turn", label: "Turn" },
          { key: "changedAt", label: "Changed" },
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  sessionsCmd
    .command("rename <id> <name>")
    .description("Rename a session")
    .action(async (id: string, name: string) => {
      const spaceId = await resolveSpace(spacesCmd);
      const client = createClient();
      try {
        await client.space(spaceId).session(id).rename(name);
        ok(`Session renamed to "${name}"`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  // ── sessions tail ──
  sessionsCmd
    .command("tail <id>")
    .description("Stream realtime session events")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const spaceId = await resolveSpace(spacesCmd);
      const client = createClient();
      const session = client.space(spaceId).session(id);

      process.stdout.write("  Listening for events...\n\n");

      let lastAppendPath: string | null = null;
      session.on("turn.patch", (e: { payload?: Record<string, unknown> }) => {
        if (jsonRequested(opts)) {
          console.log(JSON.stringify(e));
        } else {
          const ops = e.payload?.ops as Array<{ o?: string; p?: string; v?: unknown }> | undefined;
          for (const op of ops ?? []) {
            if (op.o === "append" && typeof op.v === "string" && op.p?.endsWith("/text")) {
              lastAppendPath = op.p;
              process.stdout.write(op.v);
              continue;
            }
            if (op.o === "append" && typeof op.p === "string") {
              lastAppendPath = op.p;
              continue;
            }
            if (!op.o && !op.p && typeof op.v === "string" && lastAppendPath?.endsWith("/text")) {
              process.stdout.write(op.v);
            }
          }
        }
      });

      session.on("turn.finalized", () => {
        process.stdout.write("\n\n  ✓ Done\n");
        process.exit(0);
      });

      session.on("turn.error", (e: unknown) => {
        process.stderr.write(`\n  ✗ Error\n`);
        if (jsonRequested(opts)) process.stderr.write(`${JSON.stringify(e)}\n`);
        process.exit(1);
      });
    });

  // ── sessions turns ──
  registerTurns(sessionsCmd);

  // ── sessions access ──
  registerSessionAccess(sessionsCmd);
}

// ── Turn operations ──

function registerTurns(sessionsCmd: Command): void {
  const turnsCmd = sessionsCmd.command("turns").description("Inspect session turns");

  turnsCmd
    .command("ls <sessionId>")
    .alias("list")
    .description("List recent turns")
    .option("--cursor <sequence>", "Turn sequence cursor")
    .option("--direction <older|newer>", "Page direction", "older")
    .option("--limit <n>", "Page size", "30")
    .option("--json", "Output as JSON")
    .action(async (sessionId: string, opts: { cursor?: string; direction?: string; limit?: string; json?: boolean }) => {
      const spaceId = await resolveSpace(sessionsCmd);
      const client = createClient();
      try {
        const result = await client.space(spaceId).session(sessionId).turns.listPaginated({
          cursor: opts.cursor === undefined ? undefined : parseInteger(opts.cursor, "cursor", { min: 0 }),
          direction: parseChoice(opts.direction ?? "older", "direction", ["older", "newer"] as const),
          limit: parseInteger(opts.limit ?? "30", "limit", { min: 1, max: 100 }),
        });
        if (jsonRequested(opts)) return outJson(result);
        if (result.turns.length === 0) return console.log("  No turns found");
        table(result.turns, [
          { key: "sequence", label: "Seq" },
          { key: "id", label: "ID" },
          { key: "status", label: "Status" },
          { key: "userText", label: "User" },
          { key: "assistantText", label: "Assistant" },
          { key: "updatedAt", label: "Updated" },
        ]);
        if (result.hasMore) console.log(`\n  More turns available — next cursor: ${result.nextCursor}`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  turnsCmd
    .command("get <sessionId> <turnId>")
    .description("Show turn details")
    .option("--json", "Output as JSON")
    .action(async (sessionId: string, turnId: string, opts: { json?: boolean }) => {
      const spaceId = await resolveSpace(sessionsCmd);
      const client = createClient();
      try {
        const result = await client.space(spaceId).session(sessionId).turns.get(turnId);
        if (jsonRequested(opts)) return outJson(result);
        table([result.turn], [
          { key: "sequence", label: "Seq" },
          { key: "id", label: "ID" },
          { key: "status", label: "Status" },
          { key: "provider", label: "Provider" },
          { key: "model", label: "Model" },
          { key: "stopReason", label: "Stop" },
          { key: "errorMessage", label: "Error" },
        ]);
        if (result.turn.userText) console.log(`\nUser:\n${result.turn.userText}`);
        if (result.turn.assistantText) console.log(`\nAssistant:\n${result.turn.assistantText}`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  turnsCmd
    .command("steer <sessionId> <turnId>")
    .description("Run a queued follow-up now")
    .option("--json", "Output as JSON")
    .action(async (sessionId: string, turnId: string, opts: { json?: boolean }) => {
      const spaceId = await resolveSpace(sessionsCmd);
      const client = createClient();
      try {
        const result = await client.space(spaceId).session(sessionId).steerTurn(turnId);
        if (jsonRequested(opts)) return outJson(result);
        ok(`Turn steered: ${result.turn.id}`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  turnsCmd
    .command("cancel <sessionId> <turnId>")
    .description("Cancel a queued follow-up")
    .option("--json", "Output as JSON")
    .action(async (sessionId: string, turnId: string, opts: { json?: boolean }) => {
      const spaceId = await resolveSpace(sessionsCmd);
      const client = createClient();
      try {
        const result = await client.space(spaceId).session(sessionId).cancelTurn(turnId);
        if (jsonRequested(opts)) return outJson(result);
        ok(`Turn cancelled: ${result.turn.id}`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  turnsCmd
    .command("index <sessionId>", { hidden: true })
    .description("List lightweight turn index")
    .option("--cursor <sequence>", "Turn sequence cursor")
    .option("--limit <n>", "Page size", "100")
    .option("--json", "Output as JSON")
    .action(async (sessionId: string, opts: { cursor?: string; limit?: string; json?: boolean }) => {
      const spaceId = await resolveSpace(sessionsCmd);
      const client = createClient();
      try {
        const result = await client.space(spaceId).session(sessionId).turns.index({
          cursor: opts.cursor === undefined ? undefined : parseInteger(opts.cursor, "cursor", { min: 0 }),
          limit: parseInteger(opts.limit ?? "100", "limit", { min: 1, max: 500 }),
        });
        if (jsonRequested(opts)) return outJson(result);
        if (result.turns.length === 0) return console.log("  No turns found");
        table(result.turns, [
          { key: "sequence", label: "Seq" },
          { key: "id", label: "ID" },
          { key: "status", label: "Status" },
          { key: "userPreview", label: "User" },
          { key: "assistantPreview", label: "Assistant" },
        ]);
        if (result.hasMore) console.log(`\n  More turns available — next cursor: ${result.nextCursor}`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  turnsCmd
    .command("window <sessionId>", { hidden: true })
    .description("Load turns around a sequence or turn ID")
    .option("--sequence <n>", "Anchor turn sequence")
    .option("--turn <id>", "Anchor turn ID")
    .option("--before <n>", "Turns before anchor", "10")
    .option("--after <n>", "Turns after anchor", "20")
    .option("--json", "Output as JSON")
    .action(async (sessionId: string, opts: { sequence?: string; turn?: string; before?: string; after?: string; json?: boolean }) => {
      const spaceId = await resolveSpace(sessionsCmd);
      if (!opts.sequence && !opts.turn) return error("Missing anchor", "Use --sequence <n> or --turn <id>");
      const client = createClient();
      try {
        const result = await client.space(spaceId).session(sessionId).turns.window({
          sequence: opts.sequence === undefined ? undefined : parseInteger(opts.sequence, "sequence", { min: 0 }),
          turnId: opts.turn,
          before: parseInteger(opts.before ?? "10", "before", { min: 0, max: 200 }),
          after: parseInteger(opts.after ?? "20", "after", { min: 0, max: 200 }),
        });
        if (jsonRequested(opts)) return outJson(result);
        if (result.turns.length === 0) return console.log("  No turns found");
        table(result.turns, [
          { key: "sequence", label: "Seq" },
          { key: "id", label: "ID" },
          { key: "status", label: "Status" },
          { key: "userText", label: "User" },
          { key: "assistantText", label: "Assistant" },
        ]);
        console.log(`\n  Window — older: ${result.hasMoreOlder ? "yes" : "no"}, newer: ${result.hasMoreNewer ? "yes" : "no"}`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });
}

// ── Session access operations ──

function registerSessionAccess(sessionsCmd: Command): void {
  const accessCmd = sessionsCmd.command("access").description("Session access control");

  accessCmd
    .command("get <id>")
    .description("Get session access policy")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const client = createClient();
      try {
        const policy = await client.sessionAccess.get(id);
        if (jsonRequested(opts)) return outJson(policy);
        table([policy], [
          { key: "signed_in_user", label: "Signed-in" },
          { key: "anonymous_user", label: "Anonymous" },
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  accessCmd
    .command("set <id>")
    .description("Set session anonymous access")
    .option("--anonymous <role>", "Anonymous role (host|builder|guest|null)")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { anonymous?: string; json?: boolean }) => {
      const client = createClient();
      try {
        const policy = await client.sessionAccess.set(id, {
          anonymous_user: parseNullableRole(opts.anonymous, "anonymous role"),
        });
        if (jsonRequested(opts)) return outJson(policy);
        ok("Session access updated");
        table([policy], [
          { key: "signed_in_user", label: "Signed-in" },
          { key: "anonymous_user", label: "Anonymous" },
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  accessCmd
    .command("remove <id>")
    .description("Remove session access override")
    .action(async (id: string) => {
      const client = createClient();
      try {
        await client.sessionAccess.remove(id);
        ok(`Session access override removed: ${id}`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });
}

// ── Member operations ──

function registerMembers(spacesCmd: Command): void {
  const memCmd = spacesCmd
    .command("members")
    .description("Member management")
    .hook("preAction", async () => { await resolveSpace(spacesCmd); });

  memCmd
    .command("ls")
    .alias("list")
    .description("List space members")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const spaceId = await resolveSpace(spacesCmd);
      const client = createClient();
      try {
        const result = await client.space(spaceId).members.list();
        if (jsonRequested(opts)) return outJson(result);
        if (result.items.length === 0) {
          console.log("  (empty)");
          return;
        }
        table(result.items, [
          { key: "userId", label: "User ID" },
          { key: "role", label: "Role" },
          { key: "createdAt", label: "Since" },
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  memCmd
    .command("update <userId> <role>")
    .description("Change member role (host | builder | guest)")
    .action(async (userId: string, role: string) => {
      const spaceId = await resolveSpace(spacesCmd);
      const client = createClient();
      try {
        await client.space(spaceId).members.update(userId, parseChoice(role, "role", SPACE_ROLES));
        ok(`${userId} → ${role}`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  memCmd
    .command("remove <userId>")
    .description("Remove a member")
    .action(async (userId: string) => {
      const spaceId = await resolveSpace(spacesCmd);
      const client = createClient();
      try {
        await client.space(spaceId).members.remove(userId);
        ok(`${userId} removed`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });
}

// ── Access control ──

function registerAccess(spacesCmd: Command): void {
  const accCmd = spacesCmd
    .command("access")
    .description("Access control")
    .hook("preAction", async () => { await resolveSpace(spacesCmd); });

  accCmd
    .command("get")
    .description("Get access policy")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const spaceId = await resolveSpace(spacesCmd);
      const client = createClient();
      try {
        const policy = await client.space(spaceId).access.get();
        if (jsonRequested(opts)) return outJson(policy);
        table([policy], [
          { key: "signed_in_user", label: "Signed-in" },
          { key: "anonymous_user", label: "Anonymous" },
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  accCmd
    .command("set")
    .description("Set access policy")
    .option("--signed-in <role>", "Role for signed-in users (host|builder|guest|null)")
    .option("--anonymous <role>", "Role for anonymous users (host|builder|guest|null)")
    .option("--json", "Output as JSON")
    .action(async (opts: { signedIn?: string; anonymous?: string; json?: boolean }) => {
      const spaceId = await resolveSpace(spacesCmd);
      const client = createClient();
      try {
        const policy = await client.space(spaceId).access.set({
          signed_in_user: parseNullableRole(opts.signedIn, "signed-in role"),
          anonymous_user: parseNullableRole(opts.anonymous, "anonymous role"),
        });
        if (jsonRequested(opts)) return outJson(policy);
        ok("Access policy updated");
        table([policy], [
          { key: "signed_in_user", label: "Signed-in" },
          { key: "anonymous_user", label: "Anonymous" },
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });
}

// ── Checkpoint operations ──

function registerCheckpoints(spacesCmd: Command): void {
  const cpCmd = spacesCmd
    .command("checkpoints")
    .description("Checkpoint management")
    .hook("preAction", async () => { await resolveSpace(spacesCmd); });

  cpCmd
    .command("ls")
    .alias("list")
    .description("List checkpoints")
    .option("--limit <n>", "Maximum checkpoints to return", (value) => Number(value))
    .option("--cursor <cursor>", "Pagination cursor")
    .option("--json", "Output as JSON")
    .action(async (opts: { limit?: number; cursor?: string; json?: boolean }) => {
      const spaceId = await resolveSpace(spacesCmd);
      const client = createClient();
      try {
        const result = await client.space(spaceId).checkpoints.list({
          limit: opts.limit,
          cursor: opts.cursor,
        });
        if (jsonRequested(opts)) return outJson(result);
        if (result.checkpoints.length === 0) {
          console.log("  (empty)");
          return;
        }
        table(result.checkpoints, [
          { key: "id", label: "ID" },
          { key: "commitHash", label: "Commit" },
          { key: "description", label: "Description" },
          { key: "createdAt", label: "Created" },
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  cpCmd
    .command("get <id>")
    .description("Checkpoint details")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const spaceId = await resolveSpace(spacesCmd);
      const client = createClient();
      try {
        const result = await client.space(spaceId).checkpoints.get(id);
        if (jsonRequested(opts)) return outJson(result);
        table([result.checkpoint], [
          { key: "id", label: "ID" },
          { key: "commitHash", label: "Commit" },
          { key: "description", label: "Description" },
          { key: "forkCount", label: "Forks" },
          { key: "createdAt", label: "Created" },
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  cpCmd
    .command("create [description]")
    .description("Create a checkpoint")
    .option("--json", "Output as JSON")
    .action(async (description: string | undefined, opts: { json?: boolean }) => {
      const spaceId = await resolveSpace(spacesCmd);
      const client = createClient();
      try {
        const result = await client.space(spaceId).checkpoints.create(description ?? null);
        if (jsonRequested(opts)) return outJson(result);
        ok(`Checkpoint created — taskRunId: ${result.taskRunId}`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  cpCmd
    .command("ls-tree <checkpointId> [path]")
    .description("List checkpoint tree")
    .option("--json", "Output as JSON")
    .action(async (checkpointId: string, path: string | undefined, opts: { json?: boolean }) => {
      const spaceId = await resolveSpace(spacesCmd);
      const client = createClient();
      try {
        const tree = await client.space(spaceId).checkpoints(checkpointId).files.list(path ?? "");
        if (jsonRequested(opts)) return outJson(tree);
        if (tree.entries.length === 0) {
          console.log("  (empty)");
          return;
        }
        table(tree.entries, [
          { key: "name", label: "Name" },
          { key: "type", label: "Type" },
          { key: "size", label: "Size" },
          { key: "mimeType", label: "MIME" },
          { key: "mtimeMs", label: "Modified", format: formatEpochMs },
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  cpCmd
    .command("show <checkpointId> <path>")
    .description("Show checkpoint file content")
    .option("--json", "Output as JSON")
    .action(async (checkpointId: string, path: string, opts: { json?: boolean }) => {
      const spaceId = await resolveSpace(spacesCmd);
      const client = createClient();
      try {
        const file = await client.space(spaceId).checkpoints(checkpointId).files.read(path);
        if (jsonRequested(opts)) return outJson(file);
        if (file.delivery === "url" && file.url) {
          console.log(file.url);
          return;
        }
        console.log(file.content);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  cpCmd
    .command("diff <checkpointId> [path]")
    .description("Show checkpoint diff vs parent (or --base)")
    .option("--base <checkpointId>", "Compare against another checkpoint")
    .option("--json", "Output as JSON")
    .action(async (checkpointId: string, path: string | undefined, opts: { base?: string; json?: boolean }) => {
      const spaceId = await resolveSpace(spacesCmd);
      const client = createClient();
      try {
        if (path) {
          const file = await client.space(spaceId).checkpoints(checkpointId).diff.file(path, { base: opts.base ?? null });
          if (jsonRequested(opts)) return outJson(file);
          printDiffFile(file);
          return;
        }
        const summary = await client.space(spaceId).checkpoints(checkpointId).diff.summary({ base: opts.base ?? null });
        if (jsonRequested(opts)) return outJson(summary);
        printDiffSummary(summary, {
          emptyLabel: "  (no changes)",
          footer: summary.truncated ? "  … truncated" : null,
        });
      } catch (e: unknown) {
        handleHttp(e);
      }
    });
}
