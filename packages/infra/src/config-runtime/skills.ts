import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { isLocalHarness } from "@cohub/protocol/runtime";
import { createLogger } from "../logging/index.js";

const logger = createLogger({ serviceName: "cohub-skills" });

export const SKILLS_REDIS_KEY_VERSION = "v3";
export const PLATFORM_SKILLS_REDIS_KEY = `configs:skills:${SKILLS_REDIS_KEY_VERSION}:platform`;
export const USER_SKILLS_REDIS_KEY_PREFIX = `configs:skills:${SKILLS_REDIS_KEY_VERSION}:user`;
export const PROJECT_SKILLS_REDIS_KEY_PREFIX = `configs:skills:${SKILLS_REDIS_KEY_VERSION}:project`;
export const MOD_SKILLS_REDIS_KEY_PREFIX = `configs:skills:${SKILLS_REDIS_KEY_VERSION}:mod`;
export const SPACE_MOD_SKILLS_REDIS_KEY_PREFIX = `configs:skills:${SKILLS_REDIS_KEY_VERSION}:space-mods`;
export const SKILLS_CACHE_TTL_SEC = 24 * 60 * 60;
export const MAX_SKILL_CONTENT_CHARS = 100_000;
export const SKILL_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

const SAFE_REDIS_KEY_SEGMENT_REGEX = /^[0-9a-zA-Z_-]+$/;

export type SkillScope = "platform" | "mod" | "user" | "project";

/** Canonical sandbox workspace root; native Harnesses run with it as cwd. */
export const SANDBOX_WORKSPACE_ROOT = "/workspace";

/** Where a turn's skills execute. Cloud sandboxes mount platform/user/Mod
 * skill directories read-only; local sandboxes and native Harnesses reach
 * workspace files only. `unverified_sandbox` marks a provider lookup failure
 * and fails closed to workspace files. */
export type SkillExecutionTarget = "cloud_sandbox" | "local_sandbox" | "native_harness" | "unverified_sandbox";

/** Skills whose files exist on the executing target. Unreachable scopes are
 * filtered before expansion so they never surface as broken locations. */
export function reachableSkillScopes(target: SkillExecutionTarget): SkillScope[] {
  switch (target) {
    case "cloud_sandbox":
      return ["platform", "mod", "user", "project"];
    case "local_sandbox":
    case "native_harness":
    case "unverified_sandbox":
      return ["project"];
  }
}

/** Native Harnesses run with the workspace as cwd, so workspace skills use
 * workspace-relative locations instead of sandbox-absolute paths. */
export function nativeHarnessSkillLocation(skill: {
  sandboxFilePath: string;
  sandboxBaseDir: string;
}, workspaceRoot = SANDBOX_WORKSPACE_ROOT): { filePath: string; baseDir: string } {
  const stripRoot = (value: string): string => {
    if (value === workspaceRoot) return ".";
    if (value.startsWith(`${workspaceRoot}/`)) return value.slice(workspaceRoot.length + 1);
    return value;
  };
  return { filePath: stripRoot(skill.sandboxFilePath), baseDir: stripRoot(skill.sandboxBaseDir) };
}

/** Lookup failure message for a skill the platform knows but whose scope the
 * executing target cannot reach. */
export function unreachableSkillMessage(name: string, scope: SkillScope): string {
  return `Skill ${name} (${scope} scope) is not available in this execution environment`;
}

export type SkillCatalogSource = {
  type: "mod";
  modSpaceId: string;
  mountSlug: string;
};

export type ModSkillBinding = {
  skillsDir: string;
  sandboxDir: string;
  modSpaceId: string;
  mountSlug: string;
};

export type Skill = {
  name: string;
  description: string;
  content: string;
  filePath: string;
  sandboxFilePath: string;
  baseDir: string;
  sandboxBaseDir: string;
  scope: SkillScope;
  source?: SkillCatalogSource;
  /** When true, the skill is hidden from the model's system prompt and can only be invoked explicitly via `/skill:name`. */
  disableModelInvocation: boolean;
};

export type SkillCatalogEntry = {
  name: string;
  description: string;
  scope: SkillScope;
  source?: SkillCatalogSource;
};

export type SkillsConfig = {
  skills: Skill[];
};

export type CachedSkillsConfig = {
  rev: string;
  updatedAt: string;
  sourceCheckpointId?: string | null;
  content: SkillsConfig | null;
};

export function assertSafeRedisKeySegment(value: string, label = "value"): string {
  const trimmed = value.trim();
  if (!SAFE_REDIS_KEY_SEGMENT_REGEX.test(trimmed)) {
    throw new Error(`Invalid ${label} for Redis key`);
  }
  return trimmed;
}

export function isValidSkillName(name: string): boolean {
  return SKILL_NAME_REGEX.test(name);
}

function createFastContentHash(rawText: string): string {
  let hash = 2166136261;
  for (let i = 0; i < rawText.length; i++) {
    hash ^= rawText.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16)}:${rawText.length}`;
}

export function getUserSkillsRedisKey(userId: string): string {
  return `${USER_SKILLS_REDIS_KEY_PREFIX}:${assertSafeRedisKeySegment(userId, "userId")}`;
}

export function getProjectSkillsRedisKey(spaceId: string, revision: string): string {
  return `${PROJECT_SKILLS_REDIS_KEY_PREFIX}:${assertSafeRedisKeySegment(spaceId, "spaceId")}:${createFastContentHash(revision)}`;
}

export function getModSkillsRedisKey(modSpaceId: string, revision: string): string {
  return `${MOD_SKILLS_REDIS_KEY_PREFIX}:${assertSafeRedisKeySegment(modSpaceId, "modSpaceId")}:${createFastContentHash(revision)}`;
}

export function getSpaceModSkillsRedisKey(spaceId: string, fingerprint: string): string {
  return `${SPACE_MOD_SKILLS_REDIS_KEY_PREFIX}:${assertSafeRedisKeySegment(spaceId, "spaceId")}:${createFastContentHash(fingerprint)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isSkillCatalogSource(value: unknown): value is SkillCatalogSource {
  return isRecord(value)
    && value.type === "mod"
    && typeof value.modSpaceId === "string"
    && typeof value.mountSlug === "string";
}

export function isSkill(value: unknown): value is Skill {
  if (!isRecord(value)) return false;
  if (value.scope !== "platform" && value.scope !== "mod" && value.scope !== "user" && value.scope !== "project") return false;
  return typeof value.name === "string"
    && typeof value.description === "string"
    && typeof value.content === "string"
    && typeof value.filePath === "string"
    && typeof value.sandboxFilePath === "string"
    && typeof value.baseDir === "string"
    && typeof value.sandboxBaseDir === "string"
    && (value.source === undefined || isSkillCatalogSource(value.source))
    && typeof value.disableModelInvocation === "boolean";
}

export function isSkillsConfig(value: unknown): value is SkillsConfig {
  if (!isRecord(value) || !Array.isArray(value.skills)) return false;
  return value.skills.every(isSkill);
}

export function createCachedSkillsConfig(input: {
  rawText?: string;
  content: SkillsConfig | null;
  sourceCheckpointId?: string | null;
  rev?: string;
  updatedAt?: string;
}): CachedSkillsConfig {
  return {
    rev: input.rev ?? (input.rawText !== undefined ? createFastContentHash(input.rawText) : `missing:${input.sourceCheckpointId ?? "unknown"}`),
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    sourceCheckpointId: input.sourceCheckpointId ?? null,
    content: input.content,
  };
}

export function parseCachedSkillsConfig(rawText: string): CachedSkillsConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const content = parsed.content;
  if (content !== null && !isSkillsConfig(content)) return null;
  return {
    rev: typeof parsed.rev === "string" ? parsed.rev : "unknown",
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
    sourceCheckpointId: typeof parsed.sourceCheckpointId === "string" ? parsed.sourceCheckpointId : null,
    content,
  };
}

export function mergeSkillsConfigs(...configs: Array<SkillsConfig | null | undefined>): SkillsConfig {
  const skills = new Map<string, Skill>();
  for (const config of configs) {
    for (const skill of config?.skills ?? []) {
      skills.set(skill.name, skill);
    }
  }
  return { skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

function isSafeSkillChildPath(value: string): boolean {
  if (!value || value.startsWith("/")) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function getSandboxChildPath(rootDir: string, targetPath: string, sandboxDir: string): string {
  const relativePath = relative(rootDir, targetPath).replaceAll("\\", "/");
  if (isSafeSkillChildPath(relativePath)) return `${sandboxDir}/${relativePath}`;

  const normalizedPath = targetPath.replaceAll("\\", "/");
  const skillsMarker = "/.agents/skills/";
  const markerIndex = normalizedPath.lastIndexOf(skillsMarker);
  const cachedRelativePath = markerIndex === -1
    ? ""
    : normalizedPath.slice(markerIndex + skillsMarker.length);
  if (!isSafeSkillChildPath(cachedRelativePath)) {
    throw new Error(`Skill path is outside its source directory: ${targetPath}`);
  }
  return `${sandboxDir}/${cachedRelativePath}`;
}

export function bindModSkillsConfig(
  config: SkillsConfig,
  input: ModSkillBinding,
): SkillsConfig {
  const source: SkillCatalogSource = {
    type: "mod",
    modSpaceId: input.modSpaceId,
    mountSlug: input.mountSlug,
  };
  return {
    skills: config.skills.map((skill) => ({
      ...skill,
      sandboxFilePath: getSandboxChildPath(input.skillsDir, skill.filePath, input.sandboxDir),
      sandboxBaseDir: getSandboxChildPath(input.skillsDir, skill.baseDir, input.sandboxDir),
      scope: "mod",
      source,
    })),
  };
}

function getModSkillBindingKey(source: Pick<SkillCatalogSource, "modSpaceId" | "mountSlug">): string {
  return `${source.modSpaceId}\0${source.mountSlug}`;
}

export function bindSpaceModSkillsConfig(config: SkillsConfig, bindings: ModSkillBinding[]): SkillsConfig {
  const bindingsBySource = new Map(bindings.map((binding) => [getModSkillBindingKey(binding), binding]));
  return {
    skills: config.skills.map((skill) => {
      if (skill.scope !== "mod" || !skill.source) {
        throw new Error(`Cached Mod skill is missing source metadata: ${skill.name}`);
      }
      const binding = bindingsBySource.get(getModSkillBindingKey(skill.source));
      if (!binding) {
        throw new Error(`Cached Mod skill has an unknown source: ${skill.name}`);
      }
      const [bound] = bindModSkillsConfig({ skills: [skill] }, binding).skills;
      if (!bound) throw new Error(`Failed to bind cached Mod skill: ${skill.name}`);
      return bound;
    }),
  };
}

export function toSkillCatalog(skills: Skill[]): SkillCatalogEntry[] {
  return skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    scope: skill.scope,
    ...(skill.source ? { source: skill.source } : {}),
  }));
}

export function stripSkillFrontmatter(markdown: string): string {
  const match = markdown.match(/^---\n[\s\S]*?\n---\n?/);
  return match ? markdown.slice(match[0].length) : markdown;
}

export function escapeXmlAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\n", " ")
    .replaceAll("\r", " ");
}

/**
 * Render a `/skill:` expansion block.
 *
 * `location` overrides the skill's sandbox-absolute paths. Native Harnesses
 * (Pi/Codex) run with the workspace as cwd, so workspace-relative paths are
 * resolvable there without a sandbox mount.
 */
export function formatSkillExpansion(input: {
  name: string;
  sandboxFilePath: string;
  sandboxBaseDir: string;
  content: string;
  argsText?: string;
  location?: { filePath: string; baseDir: string };
}): string {
  if (!isValidSkillName(input.name)) {
    throw new Error(`Invalid skill name: ${input.name}`);
  }
  const filePath = input.location?.filePath ?? input.sandboxFilePath;
  const baseDir = input.location?.baseDir ?? input.sandboxBaseDir;
  const body = stripSkillFrontmatter(input.content).trim().slice(0, MAX_SKILL_CONTENT_CHARS);
  const block = [
    `<skill name="${escapeXmlAttr(input.name)}" location="${escapeXmlAttr(filePath)}">`,
    `References are relative to ${baseDir}.`,
    "",
    body,
    "</skill>",
  ].join("\n");
  const argsText = input.argsText?.trim() ?? "";
  return argsText ? `${block}\n\n${argsText}` : block;
}

export function parseSkillFrontmatter(markdown: string): {
  attributes: Record<string, string>;
  body: string;
} {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { attributes: {}, body: markdown };

  const attributes: Record<string, string> = {};
  const lines = (match[1] ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (key && (value === ">" || value === "|")) {
      const blockType = value as ">" | "|";
      const parts: string[] = [];
      while (i + 1 < lines.length) {
        const nextLine = lines[i + 1];
        if (nextLine === undefined) break;
        if (nextLine.length === 0 || nextLine[0] !== " ") break;
        i++;
        parts.push(nextLine.trim());
      }
      if (parts.length > 0) {
        value = blockType === ">" ? parts.join(" ") : parts.join("\n");
      }
    }
    if (key) attributes[key] = value;
  }

  return {
    attributes,
    body: markdown.slice(match[0].length),
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse a frontmatter value as a YAML 1.2 core-schema boolean.
 * Accepts `true`/`True`/`TRUE` (case-insensitive), tolerates trailing inline
 * comments (`true # note`) and surrounding quotes. Anything else is false.
 */
function parseFrontmatterBoolean(value: string | undefined): boolean {
  if (value === undefined) return false;
  const withoutComment = value.replace(/\s+#.*$/, "").trim();
  const unquoted = withoutComment.replace(/^["']|["']$/g, "").trim();
  return unquoted.toLowerCase() === "true";
}

export async function loadSkillsFromDirectory(input: {
  dir: string;
  sandboxDir: string;
  scope: SkillScope;
  maxContentChars?: number;
}): Promise<{ rawText: string; content: SkillsConfig }> {
  if (!(await pathExists(input.dir))) {
    return { rawText: "", content: { skills: [] } };
  }

  const maxContentChars = input.maxContentChars ?? MAX_SKILL_CONTENT_CHARS;
  const skills: Skill[] = [];
  const rawParts: string[] = [];

  const walk = async (dir: string): Promise<void> => {
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }

    for (const name of entries.sort()) {
      if (name.startsWith(".")) continue;
      const full = join(dir, name);
      let stats: Awaited<ReturnType<typeof stat>>;
      try {
        stats = await stat(full);
      } catch {
        continue;
      }
      if (!stats.isDirectory()) continue;

      const skillFile = join(full, "SKILL.md");
      try {
        const rawText = (await readFile(skillFile, "utf-8")).slice(0, maxContentChars);
        const { attributes, body } = parseSkillFrontmatter(rawText);
        const relativePath = skillFile.slice(input.dir.length + 1).replaceAll("\\", "/");
        const relativeDir = full.slice(input.dir.length + 1).replaceAll("\\", "/");
        const skillName = attributes.name?.trim() || basename(full);
        if (!isValidSkillName(skillName)) continue;
        const description = attributes.description?.trim()
          || body.split("\n").find((line) => line.trim())?.trim().slice(0, 80)
          || skillName;
        rawParts.push(`${relativePath}\n${rawText}`);
        skills.push({
          name: skillName,
          description,
          content: rawText,
          filePath: skillFile,
          sandboxFilePath: `${input.sandboxDir}/${relativePath}`,
          baseDir: full,
          sandboxBaseDir: `${input.sandboxDir}/${relativeDir}`,
          scope: input.scope,
          disableModelInvocation: parseFrontmatterBoolean(attributes["disable-model-invocation"]),
        });
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : undefined;
        // Missing SKILL.md means this is not a skill root; recurse into subdirectories.
        if (code === "ENOENT") {
          await walk(full);
          continue;
        }
        // Any other failure (permissions, I/O, parse) isolates to this skill: log and skip
        // so one broken optional skill never aborts the whole prompt build.
        logger.warn("failed to load skill", { skillFile, error: error instanceof Error ? error.message : String(error) });
      }
    }
  };

  await walk(input.dir);
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { rawText: rawParts.join("\n---\n"), content: { skills } };
}

export async function getDirectoryRevision(dir: string, checkpointMetaPath?: string): Promise<string> {
  const candidates = checkpointMetaPath ? [checkpointMetaPath, dir] : [dir];
  for (const path of candidates) {
    try {
      const stats = await stat(path);
      return `${path}:${Math.trunc(stats.mtimeMs)}:${stats.size}`;
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : undefined;
      if (code !== "ENOENT") throw error;
    }
  }
  return `${dir}:missing`;
}

/** Provider lookup injected by api/worker. `null` means no sandbox record
 * exists (cloud spaces create theirs lazily) and resolves to the cloud
 * default; rejections mean the lookup itself failed and fail closed. */
export type SandboxProviderLookup = (spaceId: string) => Promise<"cloud" | "local" | null>;

/**
 * Resolve where a turn's skills execute. Native Harnesses (Pi/Codex) run on
 * the user's machine; Cohub turns run in the space's sandbox, whose provider
 * decides whether platform/user/Mod skill directories are mounted. A failed
 * provider lookup fails closed (workspace files only), never wide open.
 */
export async function resolveSkillExecutionTarget(input: {
  harness?: string | null;
  spaceId?: string | null;
  getSandboxProvider?: SandboxProviderLookup;
}): Promise<SkillExecutionTarget> {
  if (isLocalHarness(input.harness)) return "native_harness";
  if (!input.spaceId) return "cloud_sandbox";
  if (!input.getSandboxProvider) return "unverified_sandbox";
  try {
    // A missing record is the cloud default (cloud spaces register lazily);
    // only a failed lookup fails closed.
    const provider = await input.getSandboxProvider(input.spaceId);
    return provider === "local" ? "local_sandbox" : "cloud_sandbox";
  } catch {
    return "unverified_sandbox";
  }
}

/** Scope-config loader injected by api/worker; each loads one scope's skills. */
export type SkillScopeLoader = {
  platform: () => Promise<SkillsConfig | null>;
  mod: (spaceId: string) => Promise<SkillsConfig | null>;
  user: (userId: string) => Promise<SkillsConfig | null>;
  project: (spaceId: string) => Promise<SkillsConfig | null>;
};

export type ExpandedSkillCommand = {
  renderedText: string;
  skill: {
    name: string;
    description: string;
    scope: SkillScope;
    source?: SkillCatalogSource;
    sandboxFilePath: string;
    sandboxBaseDir: string;
  };
  argsText: string;
  rawInput: string;
};

export type SkillLoader = {
  /** Target-respecting fetch: unreachable scopes are skipped. */
  fetch(options: { userId?: string | null; spaceId?: string | null; harness?: string | null }): Promise<Skill[]>;
  /** Reachability-ignoring scope lookup for diagnostics. */
  findScope(skillName: string, options: { userId?: string | null; spaceId?: string | null }): Promise<SkillScope | null>;
  /** Resolve a `/skill:name args` command once against one target: expand a
   * reachable skill, pass unknown skills through on native Harnesses, and
   * report known-but-unreachable skills explicitly otherwise. */
  expand(text: string, options: { userId?: string | null; spaceId?: string | null; harness?: string | null }): Promise<ExpandedSkillCommand | null>;
};

/**
 * One shared implementation of reachability-filtered skill loading for the
 * API and worker. Scope IO stays injected; target resolution, scope gating,
 * and `/skill:` expansion live here so both entry points behave identically.
 */
export function createSkillLoader(input: {
  scopes: SkillScopeLoader;
  getSandboxProvider?: SandboxProviderLookup;
}): SkillLoader {
  const loadScope = (scope: SkillScope, options: { userId?: string | null; spaceId?: string | null }): Promise<SkillsConfig | null> => {
    switch (scope) {
      case "platform": return input.scopes.platform();
      case "mod": return options.spaceId ? input.scopes.mod(options.spaceId) : Promise.resolve(null);
      case "user": return options.userId ? input.scopes.user(options.userId) : Promise.resolve(null);
      case "project": return options.spaceId ? input.scopes.project(options.spaceId) : Promise.resolve(null);
    }
  };

  const loadAll = (scopes: SkillScope[], options: { userId?: string | null; spaceId?: string | null }) =>
    Promise.all(scopes.map((scope) => loadScope(scope, options)));

  const resolveTarget = (options: { harness?: string | null; spaceId?: string | null }) =>
    resolveSkillExecutionTarget({
      harness: options.harness,
      spaceId: options.spaceId,
      getSandboxProvider: input.getSandboxProvider,
    });

  const fetchFor = async (target: SkillExecutionTarget, options: { userId?: string | null; spaceId?: string | null }) =>
    mergeSkillsConfigs(...await loadAll(reachableSkillScopes(target), options)).skills;

  const findScope = async (skillName: string, options: { userId?: string | null; spaceId?: string | null }) => {
    const groups = await loadAll(["platform", "mod", "user", "project"], options);
    return mergeSkillsConfigs(...groups).skills.find((skill) => skill.name === skillName)?.scope ?? null;
  };

  return {
    async fetch(options) {
      return fetchFor(await resolveTarget(options), options);
    },
    findScope,
    async expand(text, options) {
      const trimmed = text.trimStart();
      if (!trimmed.startsWith("/skill:")) return null;

      const rest = trimmed.slice("/skill:".length);
      const spaceIndex = rest.search(/\s/);
      const skillName = spaceIndex === -1 ? rest : rest.slice(0, spaceIndex);
      const argsText = spaceIndex === -1 ? "" : rest.slice(spaceIndex + 1).trim();
      if (!skillName) return null;
      if (!isValidSkillName(skillName)) {
        throw new Error(`Unknown skill: ${skillName}`);
      }

      // One target resolution drives both filtering and the location mode.
      const target = await resolveTarget(options);
      const skill = (await fetchFor(target, options)).find((item) => item.name === skillName);
      if (!skill) {
        // Cohub turns distinguish "known but unreachable here" from "unknown".
        // Native Harnesses run with the user's own skill files, so a skill the
        // platform does not know passes through verbatim instead of failing.
        if (target === "native_harness") return null;
        const known = await findScope(skillName, options);
        if (known) throw new Error(unreachableSkillMessage(skillName, known));
        throw new Error(`Unknown skill: ${skillName}`);
      }

      return {
        renderedText: formatSkillExpansion({
          name: skill.name,
          sandboxFilePath: skill.sandboxFilePath,
          sandboxBaseDir: skill.sandboxBaseDir,
          content: skill.content,
          argsText,
          ...(target === "native_harness"
            ? { location: nativeHarnessSkillLocation(skill) }
            : {}),
        }),
        skill: {
          name: skill.name,
          description: skill.description,
          scope: skill.scope,
          ...(skill.source ? { source: skill.source } : {}),
          sandboxFilePath: skill.sandboxFilePath,
          sandboxBaseDir: skill.sandboxBaseDir,
        },
        argsText,
        rawInput: text,
      };
    },
  };
}
