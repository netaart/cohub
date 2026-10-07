import { createHash } from "node:crypto";
import type { Context } from "hono";

const opaqueTag = (tag: string) => tag.trim().replace(/^W\//, "");

function ifNoneMatchIncludes(header: string | undefined, etag: string) {
  if (!header) return false;
  const tag = opaqueTag(etag);
  return header.split(",").some((candidate) => candidate.trim() === "*" || opaqueTag(candidate) === tag);
}

export function jsonWithEtag(c: Context, value: unknown) {
  const body = JSON.stringify(value);
  const etag = `"${createHash("sha256").update(body).digest("base64url")}"`;
  c.header("ETag", etag);
  c.header("Cache-Control", "private, no-cache");
  if (ifNoneMatchIncludes(c.req.header("If-None-Match"), etag)) return c.body(null, 304);
  return c.body(body, 200, { "Content-Type": "application/json" });
}
