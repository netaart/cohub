import { createHash } from "node:crypto";
import type { LocalHarness } from "@neta-art/cohub";
import { transcriptFormat } from "../harnesses/index.js";

/** Deterministic UUID-shaped id. A native Turn always names the same cloud Turn. */
export function nativeStableId(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Cloud Turn id of a native Turn. A transcript can reach more than one Space (a directory rebound
 * to another Space, or another account), so the Space is part of the identity; within it, globally
 * unique Turn keys (Codex: a fork shares its history's Turns) stand alone and others are per session.
 */
export function nativeTurnId(spaceId: string, harness: LocalHarness, nativeSessionId: string, turnKey: string): string {
  return nativeStableId(JSON.stringify(transcriptFormat(harness).globalTurnKeys ? ["native", spaceId, harness, turnKey] : ["native", spaceId, harness, nativeSessionId, turnKey]));
}
