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

/** Space meta for non-members: only what the Space page displays. */
export function toPublicSpaceMeta(meta: unknown): Record<string, unknown> | null {
  if (!isRecord(meta)) return null;
  const publicMeta: Record<string, unknown> = {};
  if (isRecord(meta.bootstrap)) publicMeta.bootstrap = { status: meta.bootstrap.status ?? null, stage: meta.bootstrap.stage ?? null };
  if (meta.publicProfile !== undefined) publicMeta.publicProfile = meta.publicProfile;
  return publicMeta;
}
