import { createHash } from "node:crypto";

/** Deterministic UUID-shaped id. A native Turn always names the same cloud Turn. */
export function nativeStableId(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Cloud Turn id of a native Turn. A transcript can reach more than one Space (a directory rebound
 * to another Space, or another account), so the Space is part of the identity; within it, Codex
 * Turn ids are globally unique (a fork shares its history's Turns) and Pi entry ids are per
 * session.
 */
export function nativeTurnId(spaceId: string, harness: "pi" | "codex", nativeSessionId: string, turnKey: string): string {
  return nativeStableId(JSON.stringify(harness === "pi" ? ["native", spaceId, "pi", nativeSessionId, turnKey] : ["native", spaceId, "codex", turnKey]));
}
