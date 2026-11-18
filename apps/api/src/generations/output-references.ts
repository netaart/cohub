import { taskRuns } from "@cohub/db";
import { createLogger } from "@cohub/infra/logging";
import type { GenerationContentBlock } from "@cohub/protocol/generation";
import { and, desc, eq, gt, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";

const OUTPUT_REFERENCE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_REFERENCED_TASKS = 10;
const logger = createLogger({ serviceName: "cohub-api" });

type Meta = Record<string, unknown>;

const unresolvedModelUrl = (block: GenerationContentBlock) =>
  block.type === "3d" && block.source.type === "url" && block.meta?.task_id === undefined ? block.source.url : null;

function outputMetaByUrl(outputs: unknown[], urls: ReadonlySet<string>): Map<string, Meta> {
  const metaByUrl = new Map<string, Meta>();
  for (const output of outputs) {
    if (!Array.isArray(output)) continue;
    for (const block of output as GenerationContentBlock[]) {
      if (block?.type !== "3d" || block.source?.type !== "url" || !urls.has(block.source.url)) continue;
      if (block.meta?.task_id === undefined || metaByUrl.has(block.source.url)) continue;
      metaByUrl.set(block.source.url, block.meta);
    }
  }
  return metaByUrl;
}

export async function resolveOutputReferences(
  userId: string,
  content: GenerationContentBlock[],
): Promise<GenerationContentBlock[]> {
  const urls = new Set(content.flatMap((block) => unresolvedModelUrl(block) ?? []));
  if (urls.size === 0) return content;

  const rows = await db
    .select({ output: sql<unknown>`${taskRuns.result}->'output'` })
    .from(taskRuns)
    .where(and(
      sql`${taskRuns.taskType} = 'generation'`,
      eq(taskRuns.userUuid, userId),
      gt(taskRuns.createdAt, new Date(Date.now() - OUTPUT_REFERENCE_WINDOW_MS)),
      eq(taskRuns.status, "completed"),
      or(...[...urls].map((url) =>
        sql`${taskRuns.result} @> ${JSON.stringify({ output: [{ type: "3d", source: { url } }] })}::jsonb`)),
    ))
    .orderBy(desc(taskRuns.createdAt))
    .limit(MAX_REFERENCED_TASKS)
    .catch((error: unknown) => {
      logger.warn("[generations] failed to resolve 3d output references", { userId, error });
      return [];
    });
  const metaByUrl = outputMetaByUrl(rows.map((row) => row.output), urls);
  if (metaByUrl.size === 0) return content;

  return content.map((block) => {
    const url = unresolvedModelUrl(block);
    const meta = url ? metaByUrl.get(url) : undefined;
    return meta ? { ...block, meta: { ...meta, ...block.meta } } : block;
  });
}
