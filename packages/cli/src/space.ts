import type { Command } from "commander";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HOME_SPACE_SLUG, parseSpaceRef, resolveCohubEnvironment } from "@neta-art/cohub";
import { readAuthSession } from "./auth.js";
import { createClient } from "./client.js";
import { getRuntimeSpaceBinding } from "./runtime/space-binding.js";
import { error, handleHttp } from "./output.js";

const CONFIG_DIR = join(homedir(), ".config", "cohub");
const CACHE_PATH = join(CONFIG_DIR, "home-space.json");
/** Legacy cache that may name another user's Home; never read. */
const LEGACY_CACHE_PATH = join(CONFIG_DIR, "default-space.json");
/** Home space is stable; a one-day TTL bounds how long a stale hit survives. */
const CACHE_TTL_MS = 86_400_000;

const SPACE_REF_HINT = "Use a Space ID, a slug you own such as home, or username/slug.";

type HomeSpaceCache = {
  /** Identity fingerprint the cached space belongs to (env + subject). */
  key: string;
  spaceId: string;
  cachedAt: number;
};

export class SpaceTargetError extends Error {
  override name = "SpaceTargetError";

  constructor(message: string, readonly detail?: string) {
    super(message);
  }
}

function jwtClaim(token: string | undefined | null, key: string): string | null {
  const payload = token?.split(".")[1];
  if (!payload) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as Record<string, unknown>;
    const value = parsed[key];
    return typeof value === "string" && value ? value : null;
  } catch {
    return null;
  }
}

/**
 * Cache key aligned with auth: execution token is exclusive (same as
 * `resolveAccessToken`) and never falls back to a local Logto session.
 * Execution grants identify the actor as `actorUserId`, not `sub`.
 */
export function identityKeyFrom(input: {
  env: string;
  executionToken?: string | null;
  idToken?: string | null;
  accessToken?: string | null;
}): string | null {
  if (input.executionToken) {
    const actor = jwtClaim(input.executionToken, "actorUserId") ?? jwtClaim(input.executionToken, "sub");
    return actor ? `${input.env}:${actor}` : null;
  }
  const sub = jwtClaim(input.idToken, "sub") ?? jwtClaim(input.accessToken, "sub");
  return sub ? `${input.env}:${sub}` : null;
}

export function currentIdentityKey(): string | null {
  const session = readAuthSession();
  return identityKeyFrom({
    env: resolveCohubEnvironment(),
    executionToken: process.env.COHUB_EXECUTION_TOKEN?.trim(),
    idToken: session?.idToken,
    accessToken: session?.accessToken,
  });
}

/** Exported for tests; production always uses `CACHE_PATH`. */
export function readHomeSpaceCache(path: string, key: string, now = Date.now()): string | null {
  try {
    const cache = JSON.parse(readFileSync(path, "utf-8")) as Partial<HomeSpaceCache>;
    if (cache.key !== key || typeof cache.spaceId !== "string" || typeof cache.cachedAt !== "number") return null;
    if (now - cache.cachedAt > CACHE_TTL_MS) return null;
    return cache.spaceId;
  } catch {
    return null;
  }
}

function writeHomeSpaceCache(key: string, spaceId: string): void {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    const cache: HomeSpaceCache = { key, spaceId, cachedAt: Date.now() };
    writeFileSync(CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
    rmSync(LEGACY_CACHE_PATH, { force: true });
  } catch {
    // Cache is best-effort; never fail the command over it.
  }
}

let homeSpacePromise: Promise<string> | null = null;
const spaceRefs = new Map<string, Promise<string>>();

export function clearHomeSpaceCache(): void {
  homeSpacePromise = null;
  spaceRefs.clear();
  try {
    rmSync(CACHE_PATH, { force: true });
    rmSync(LEGACY_CACHE_PATH, { force: true });
  } catch {
    // Best-effort, same as writes.
  }
}

/** Explicit target from `-s/--space` (any ancestor) or `COHUB_SPACE_ID`, else null. */
export function explicitSpace(program: Command): string | null {
  let current: Command | null = program;
  while (current) {
    const opts = current.opts() as Record<string, unknown>;
    if (typeof opts.space === "string" && opts.space.trim()) return opts.space.trim();
    current = current.parent ?? null;
  }
  return process.env.COHUB_SPACE_ID?.trim() || null;
}

/** Cached per identity and memoized per process. */
export function resolveHomeSpace(): Promise<string> {
  homeSpacePromise ??= (async () => {
    const key = currentIdentityKey();
    const cached = key ? readHomeSpaceCache(CACHE_PATH, key) : null;
    if (cached) return cached;
    const space = await createClient().spaces.ensureHome();
    if (key) writeHomeSpaceCache(key, space.id);
    return space.id;
  })();
  return homeSpacePromise;
}

async function lookupSpaceRef(value: string): Promise<string> {
  const ref = parseSpaceRef(value);
  if (!ref) throw new SpaceTargetError(`Invalid space '${value}'`, SPACE_REF_HINT);
  if (ref.kind === "id") return ref.id;
  if (ref.kind === "owned" && ref.slug === HOME_SPACE_SLUG) return resolveHomeSpace();
  const spaces = createClient().spaces;
  try {
    const space = ref.kind === "owned"
      ? await spaces.getOwnedBySlug(ref.slug)
      : await spaces.getBySlug(ref.username, ref.slug);
    return space.id;
  } catch (e: unknown) {
    if ((e as { status?: number }).status === 404) throw new SpaceTargetError(`Space '${value}' not found`, SPACE_REF_HINT);
    throw e;
  }
}

export function resolveSpaceRef(value: string): Promise<string> {
  const key = value.trim();
  let resolved = spaceRefs.get(key);
  if (!resolved) {
    resolved = lookupSpaceRef(key);
    spaceRefs.set(key, resolved);
  }
  return resolved;
}

export function failSpaceTarget(e: unknown): never {
  if (e instanceof SpaceTargetError) return error(e.message, e.detail);
  return handleHttp(e);
}

/** Shared exit for commands that need a space but resolved none. */
export function missingSpaceError(): never {
  return error(
    "No target space",
    "Pass -s <space> (an ID, home, or username/slug), set COHUB_SPACE_ID, or run in a directory bound with `cohub runtime up`.",
  );
}

export async function resolveBoundSpace(
  options: { cwd?: string; bindingsPath?: string } = {},
): Promise<string | null> {
  const bound = await getRuntimeSpaceBinding(
    options.cwd ?? process.cwd(),
    currentIdentityKey(),
    options.bindingsPath,
  ).catch(handleHttp);
  return bound?.spaceId ?? null;
}

export type SpaceTargetOptions = {
  /** Only for commands that start new work. */
  home?: boolean;
  cwd?: string;
  bindingsPath?: string;
};

/** Explicit target or `COHUB_SPACE_ID`, then the directory binding, then Home when allowed. */
export async function resolveSpaceTarget(target?: string | null, options: SpaceTargetOptions = {}): Promise<string> {
  const explicit = target?.trim() || process.env.COHUB_SPACE_ID?.trim() || null;
  try {
    if (explicit) return await resolveSpaceRef(explicit);
    const bound = await resolveBoundSpace(options);
    if (bound) return bound;
    if (options.home) return await resolveHomeSpace();
  } catch (e: unknown) {
    return failSpaceTarget(e);
  }
  return missingSpaceError();
}

export function resolveSpace(command: Command, options: Pick<SpaceTargetOptions, "home"> = {}): Promise<string> {
  return resolveSpaceTarget(explicitSpace(command), options);
}
