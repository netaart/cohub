import { posix } from "node:path";
import { SANDBOX_PLATFORM_AGENTS_PATH, SANDBOX_USER_AGENTS_PATH, SANDBOX_WORKSPACE_PATH } from "../runtime/paths.js";

// A Local Runtime maps these sandbox paths for cwd but cannot rewrite argv, so there
// path arguments under them run from the root, relative to it; globs keep the same anchor.
const MAPPED_SANDBOX_ROOTS = [SANDBOX_WORKSPACE_PATH, SANDBOX_PLATFORM_AGENTS_PATH, SANDBOX_USER_AGENTS_PATH, "/mods"];

export type ProcessSearchPath = { cwd: string; arg: string; base?: string };

/** cwd and path argument for an fd/rg search; `base` is set when output paths are relative to a mapped root. */
export function toProcessSearchPath(path: string, local: boolean): ProcessSearchPath {
  const unchanged = { cwd: SANDBOX_WORKSPACE_PATH, arg: path };
  if (!local || !path.startsWith("/")) return unchanged;
  const normalized = posix.normalize(path).replace(/(.)\/+$/, "$1");
  const root = MAPPED_SANDBOX_ROOTS.find((item) => normalized === item || normalized.startsWith(`${item}/`));
  if (!root) return unchanged;
  return { cwd: root, arg: normalized === root ? "." : normalized.slice(root.length + 1), base: root };
}
