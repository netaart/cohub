import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import {
  parseGenerationModelDeclaration,
  type GenerationModelDeclaration,
} from "@neta-art/generation";
import {
  createCachedGenerationsConfig,
  GENERATIONS_CACHE_TTL_SEC,
  getUserGenerationsRedisKey,
  mergeGenerationsConfigs,
  parseCachedGenerationsConfig,
  PLATFORM_GENERATIONS_REDIS_KEY,
  type GenerationsConfig,
} from "./generations.js";

const GENERATIONS_DIR = ".cohub/generations";
const DECLARATION_EXTENSIONS = new Set([".yaml", ".yml", ".json"]);

type RedisLike = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", ttl: number): Promise<unknown>;
};

export type GenerationDeclarationLoader = ReturnType<typeof createGenerationDeclarationLoader>;

function parseDeclaration(rawText: string, path: string): GenerationModelDeclaration {
  return parseGenerationModelDeclaration(rawText, path);
}

async function readGenerationsConfigFromDir(dir: string): Promise<{ rawText: string; content: GenerationsConfig }> {
  const entries = await readdir(dir);
  const declarations: GenerationModelDeclaration[] = [];
  const rawParts: string[] = [];
  for (const entry of entries.sort()) {
    if (!DECLARATION_EXTENSIONS.has(extname(entry))) continue;
    const path = join(dir, entry);
    const rawText = await readFile(path, "utf-8");
    rawParts.push(`${entry}\n${rawText}`);
    declarations.push(parseDeclaration(rawText, path));
  }
  declarations.sort((a, b) => a.model.localeCompare(b.model));
  return { rawText: rawParts.join("\n---\n"), content: { declarations } };
}

export type PublicGenerationDeclaration = Omit<GenerationModelDeclaration, "adapter">;

export type ListGenerationModelsResponse = {
  models: PublicGenerationDeclaration[];
};

export function toPublicGenerationDeclaration(declaration: GenerationModelDeclaration): PublicGenerationDeclaration {
  const { adapter: _adapter, ...publicDeclaration } = declaration;
  return publicDeclaration;
}

export function createGenerationDeclarationLoader(input: {
  platformConfigRoot: string;
  redis: RedisLike;
  warn?: (message: string) => void;
}) {
  const platformGenerationsDir = () => join(input.platformConfigRoot, "platform", GENERATIONS_DIR);
  const userGenerationsDir = (userId: string) => join(input.platformConfigRoot, "users", userId, GENERATIONS_DIR);
  const inflightByKey = new Map<string, Promise<GenerationsConfig | null>>();

  async function loadGenerationsFromDir(params: {
    dir: string;
    redisKey: string;
    allowMissing: boolean;
  }): Promise<GenerationsConfig | null> {
    try {
      const { rawText, content } = await readGenerationsConfigFromDir(params.dir);
      const uncategorized = content.declarations.filter((declaration) => !declaration.category).map((declaration) => declaration.model);
      if (uncategorized.length > 0) input.warn?.(`Generation models without category in ${params.dir}: ${uncategorized.join(", ")}`);
      const cached = createCachedGenerationsConfig({ rawText, content });
      await input.redis.set(params.redisKey, JSON.stringify(cached), "EX", GENERATIONS_CACHE_TTL_SEC).catch(() => undefined);
      return content;
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : undefined;
      if (code === "ENOENT" && params.allowMissing) {
        const cached = createCachedGenerationsConfig({ content: null });
        await input.redis.set(params.redisKey, JSON.stringify(cached), "EX", GENERATIONS_CACHE_TTL_SEC).catch(() => undefined);
        return null;
      }
      throw error;
    }
  }

  async function loadCachedGenerations(params: {
    redisKey: string;
    dir: string;
    allowMissing: boolean;
  }): Promise<GenerationsConfig | null> {
    const inflight = inflightByKey.get(params.redisKey);
    if (inflight) return inflight;

    const promise = (async () => {
      const cached = await input.redis.get(params.redisKey).catch(() => null);
      if (cached) {
        const parsed = parseCachedGenerationsConfig(cached);
        if (parsed) return parsed.content;
      }
      return loadGenerationsFromDir(params);
    })();

    inflightByKey.set(params.redisKey, promise);
    try {
      return await promise;
    } finally {
      inflightByKey.delete(params.redisKey);
    }
  }

  async function loadGenerationDeclarations(userId: string): Promise<GenerationModelDeclaration[]> {
    const platformGenerations = await loadCachedGenerations({
      redisKey: PLATFORM_GENERATIONS_REDIS_KEY,
      dir: platformGenerationsDir(),
      allowMissing: false,
    });
    if (!platformGenerations) throw new Error("Generation declarations directory not found");

    const userGenerations = await loadCachedGenerations({
      redisKey: getUserGenerationsRedisKey(userId),
      dir: userGenerationsDir(userId),
      allowMissing: true,
    });

    return mergeGenerationsConfigs(platformGenerations, userGenerations).declarations;
  }

  return {
    loadGenerationDeclarations,
    async loadGenerationDeclaration(userId: string, model: string): Promise<GenerationModelDeclaration | null> {
      const declarations = await loadGenerationDeclarations(userId);
      return declarations.find((declaration) => declaration.model === model) ?? null;
    },
    async loadPublicGenerationModels(userId: string): Promise<ListGenerationModelsResponse> {
      return {
        models: (await loadGenerationDeclarations(userId)).map(toPublicGenerationDeclaration),
      };
    },
  };
}
