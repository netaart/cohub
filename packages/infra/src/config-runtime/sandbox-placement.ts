import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

const CONFIG_PATH = join("platform", ".cohub", "sandbox", "placements.yaml");
const SCHEMA = "cohub.sandbox.placement.v1";
/** Pool for owners not listed under `users`; when it isn't configured they keep the deployment defaults. */
export const DEFAULT_SANDBOX_POOL = "default";
const POOL_NAME_PATTERN = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const TOLERATION_EFFECTS = new Set(["NoSchedule", "PreferNoSchedule", "NoExecute"]);
// Kubernetes label syntax: Pod creation rejects anything else, which would strand provisioning on a "valid" config.
const LABEL_NAME_PATTERN = /^[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;
const DNS_SUBDOMAIN_PATTERN = /^(?=.{1,253}$)[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

export type SandboxResources = {
  limits: { cpu: string; memory: string };
  requests: { cpu: string; memory: string };
};

export type SandboxPlacementToleration = {
  key: string;
  operator: "Equal" | "Exists";
  value?: string;
  effect: "NoSchedule" | "PreferNoSchedule" | "NoExecute";
};

export type SandboxPlacementPool = {
  name: string;
  nodeSelector?: Record<string, string>;
  tolerations?: SandboxPlacementToleration[];
  requestRatio?: number;
};

export type SandboxPlacementConfig = {
  pools: ReadonlyMap<string, SandboxPlacementPool>;
  /** Space owner UUID to pool name. */
  users: ReadonlyMap<string, string>;
};

export type SandboxPlacement = {
  pool: string;
  resources: SandboxResources;
  nodeSelector?: Record<string, string>;
  tolerations?: SandboxPlacementToleration[];
};

type CachedConfig = { mtimeMs: number; size: number; config: SandboxPlacementConfig };

const EMPTY_CONFIG: SandboxPlacementConfig = { pools: new Map(), users: new Map() };
const cache = new Map<string, CachedConfig>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isLabelKey(key: string) {
  const slash = key.lastIndexOf("/");
  const name = slash >= 0 ? key.slice(slash + 1) : key;
  return LABEL_NAME_PATTERN.test(name) && (slash < 0 || DNS_SUBDOMAIN_PATTERN.test(key.slice(0, slash)));
}

function labelKey(pool: string, value: unknown) {
  if (typeof value !== "string" || !isLabelKey(value)) {
    throw new Error(`Sandbox placement pool ${pool} has an invalid label key: ${String(value)}`);
  }
  return value;
}

function labelValue(pool: string, value: unknown) {
  if (typeof value !== "string" || !LABEL_NAME_PATTERN.test(value)) {
    throw new Error(`Sandbox placement pool ${pool} has an invalid label value: ${String(value)}`);
  }
  return value;
}

function parseNodeSelector(pool: string, value: unknown) {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw new Error(`Sandbox placement pool ${pool} nodeSelector must be a non-empty object`);
  }
  return Object.fromEntries(Object.entries(value).map(([key, selectorValue]) => [labelKey(pool, key), labelValue(pool, selectorValue)]));
}

function parseTolerations(pool: string, value: unknown): SandboxPlacementToleration[] {
  if (!Array.isArray(value)) throw new Error(`Sandbox placement pool ${pool} tolerations must be a list`);
  return value.map((item) => {
    if (!isRecord(item)) throw new Error(`Sandbox placement pool ${pool} tolerations must be objects`);
    const key = labelKey(pool, item.key);
    const effect = item.effect ?? "NoSchedule";
    if (typeof effect !== "string" || !TOLERATION_EFFECTS.has(effect)) {
      throw new Error(`Sandbox placement pool ${pool} toleration effect is invalid: ${String(effect)}`);
    }
    const operator = item.operator ?? (item.value === undefined ? "Exists" : "Equal");
    if (operator !== "Equal" && operator !== "Exists") {
      throw new Error(`Sandbox placement pool ${pool} toleration operator must be Equal or Exists`);
    }
    if (operator === "Exists" && item.value !== undefined) {
      throw new Error(`Sandbox placement pool ${pool} Exists toleration must not set a value`);
    }
    return {
      key,
      operator,
      ...(operator === "Equal" ? { value: labelValue(pool, item.value) } : {}),
      effect: effect as SandboxPlacementToleration["effect"],
    };
  });
}

export function parseSandboxPlacementConfig(rawText: string): SandboxPlacementConfig {
  const parsed = parse(rawText) as unknown;
  if (parsed === null || parsed === undefined) return EMPTY_CONFIG;
  if (!isRecord(parsed)) throw new Error("Sandbox placement config must be an object");
  if (parsed.schema !== undefined && parsed.schema !== SCHEMA) {
    throw new Error(`Unsupported sandbox placement config schema: ${String(parsed.schema)}`);
  }

  const pools = new Map<string, SandboxPlacementPool>();
  if (parsed.pools !== undefined) {
    if (!isRecord(parsed.pools)) throw new Error("Sandbox placement config pools must be an object");
    for (const [rawName, value] of Object.entries(parsed.pools)) {
      const name = rawName.trim();
      if (!POOL_NAME_PATTERN.test(name)) {
        throw new Error(`Sandbox placement pool name must be 1-63 lowercase letters, numbers, or hyphens: ${rawName}`);
      }
      if (!isRecord(value)) throw new Error(`Sandbox placement pool ${name} must be an object`);
      const { requestRatio } = value;
      if (requestRatio !== undefined && (typeof requestRatio !== "number" || !(requestRatio > 0 && requestRatio <= 1))) {
        throw new Error(`Sandbox placement pool ${name} requestRatio must be in (0, 1]`);
      }
      pools.set(name, {
        name,
        ...(value.nodeSelector !== undefined ? { nodeSelector: parseNodeSelector(name, value.nodeSelector) } : {}),
        ...(value.tolerations !== undefined ? { tolerations: parseTolerations(name, value.tolerations) } : {}),
        ...(requestRatio !== undefined ? { requestRatio } : {}),
      });
    }
  }

  const users = new Map<string, string>();
  if (parsed.users !== undefined) {
    if (!isRecord(parsed.users)) throw new Error("Sandbox placement config users must be an object");
    for (const [rawUser, pool] of Object.entries(parsed.users)) {
      const user = rawUser.trim();
      if (!user) throw new Error("Sandbox placement config contains an empty user id");
      if (typeof pool !== "string" || !pools.has(pool.trim())) {
        throw new Error(`Sandbox placement user ${user} references unknown pool: ${String(pool)}`);
      }
      users.set(user, pool.trim());
    }
  }
  return { pools, users };
}

const CPU_PATTERN = /^(\d+(?:\.\d+)?)(m?)$/;
const MEMORY_UNITS = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40 } as const;
const MEMORY_PATTERN = /^(\d+)(Ki|Mi|Gi|Ti)?$/;

function parseCpuMillis(value: string) {
  const match = CPU_PATTERN.exec(value);
  if (!match) throw new Error(`Unsupported CPU quantity: ${value}`);
  return match[2] ? Number(match[1]) : Number(match[1]) * 1000;
}

function parseMemoryBytes(value: string) {
  const match = MEMORY_PATTERN.exec(value);
  if (!match) throw new Error(`Unsupported memory quantity: ${value}`);
  const unit = match[2] as keyof typeof MEMORY_UNITS | undefined;
  return Number(match[1]) * (unit ? MEMORY_UNITS[unit] : 1);
}

// Canonical forms, so the kubelet-reported resources compare equal as strings after a resize.
function formatCpu(millis: number) {
  return millis % 1000 === 0 ? String(millis / 1000) : `${millis}m`;
}

function formatMemory(bytes: number) {
  for (const unit of ["Ti", "Gi"] as const) {
    if (bytes % MEMORY_UNITS[unit] === 0) return `${bytes / MEMORY_UNITS[unit]}${unit}`;
  }
  return `${bytes / MEMORY_UNITS.Mi}Mi`;
}

function scaleSandboxRequests(limits: SandboxResources["limits"], ratio: number): SandboxResources["requests"] {
  const mebibyte = MEMORY_UNITS.Mi;
  return {
    cpu: formatCpu(Math.max(1, Math.floor(parseCpuMillis(limits.cpu) * ratio))),
    memory: formatMemory(Math.max(1, Math.floor((parseMemoryBytes(limits.memory) * ratio) / mebibyte)) * mebibyte),
  };
}

export function resolveSandboxPlacement(
  config: SandboxPlacementConfig,
  ownerUserId: string,
  specResources: SandboxResources,
): SandboxPlacement {
  const pool = config.pools.get(config.users.get(ownerUserId) ?? DEFAULT_SANDBOX_POOL);
  if (!pool) return { pool: DEFAULT_SANDBOX_POOL, resources: specResources };
  return {
    pool: pool.name,
    resources: pool.requestRatio === undefined
      ? specResources
      : { limits: specResources.limits, requests: scaleSandboxRequests(specResources.limits, pool.requestRatio) },
    ...(pool.nodeSelector ? { nodeSelector: pool.nodeSelector } : {}),
    ...(pool.tolerations ? { tolerations: pool.tolerations } : {}),
  };
}

/** Never throws: an invalid edit is reported and the last valid config stays in effect. */
export async function loadSandboxPlacementConfig(
  platformConfigRoot: string,
  onError: (error: unknown) => void,
): Promise<SandboxPlacementConfig> {
  const path = join(platformConfigRoot, CONFIG_PATH);
  try {
    const info = await stat(path);
    const cached = cache.get(platformConfigRoot);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.config;
    const config = parseSandboxPlacementConfig(await readFile(path, "utf-8"));
    cache.set(platformConfigRoot, { mtimeMs: info.mtimeMs, size: info.size, config });
    return config;
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") {
      cache.delete(platformConfigRoot);
      return EMPTY_CONFIG;
    }
    onError(error);
    return cache.get(platformConfigRoot)?.config ?? EMPTY_CONFIG;
  }
}
