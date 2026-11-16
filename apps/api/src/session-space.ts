import type { spaces } from "@cohub/db";
import { sanitizeSpaceBootstrapSource } from "./space-bootstrap-source.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Session detail is readable by guests of shared Chats, so it carries no Space secrets or internals. */
export function toSessionSpace(space: typeof spaces.$inferSelect) {
  const { storageRepoName: _storageRepoName, meta, ...rest } = space;
  if (!isRecord(meta)) return { ...rest, meta };
  const { extraEnv: _extraEnv, config: _config, ...safeMeta } = meta;
  if (isRecord(safeMeta.bootstrap)) {
    safeMeta.bootstrap = { ...safeMeta.bootstrap, source: sanitizeSpaceBootstrapSource(safeMeta.bootstrap.source) };
  }
  return { ...rest, meta: safeMeta };
}
