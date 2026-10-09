import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withRuntimeSpaceBindingsLock } from "../space-binding.js";

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/** First line of the installed extension; a file without it belongs to someone else. */
const PI_EXTENSION_HEADER = "// Cohub control extension for Pi. Managed by `cohub runtime`; local edits are replaced on upgrade.\n";
/** CLI 8.0–8.2 installed a re-export under this comment; its module is gone, so Pi fails to start while it remains. */
const LEGACY_PI_EXTENSION_HEADER = "// Cohub native Turn sync";
/** Earlier releases installed Codex hooks; they are removed on upgrade. */
const LEGACY_CODEX_HOOKS = /\n*# BEGIN COHUB NATIVE SYNC\n[\s\S]*?# END COHUB NATIVE SYNC\n?/;

export const piAgentDirectory = () => process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
const codexConfigPath = () => join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "config.toml");

/** The extension shipped with this CLI: one self-contained module, loadable by Pi as is. */
export const piExtensionSource = () => fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./pi-extension.ts" : "./pi-extension.js", import.meta.url));
const piExtensionPath = (extension: string) => join(piAgentDirectory(), "extensions", `cohub${extension}`);
const readOptional = (path: string) => readFile(path, "utf8").catch((error) => { if (missing(error)) return null; throw error; });
const isLegacy = (text: string | null) => Boolean(text?.startsWith(LEGACY_PI_EXTENSION_HEADER));

export type PiExtensionState = "installed" | "outdated" | "missing" | "foreign";

export async function piExtensionState(): Promise<PiExtensionState> {
  const source = piExtensionSource();
  const [expected, current, legacy] = await Promise.all([readFile(source, "utf8"), readOptional(piExtensionPath(extname(source))), readOptional(piExtensionPath(".ts"))]);
  if (isLegacy(legacy)) return "outdated";
  if (current === null) return "missing";
  if (current === PI_EXTENSION_HEADER + expected) return "installed";
  return current.startsWith(PI_EXTENSION_HEADER) ? "outdated" : "foreign";
}

/** Install or upgrade the Pi extension in the user's Pi configuration. */
export async function installPiExtension(): Promise<PiExtensionState> {
  const source = piExtensionSource();
  const content = PI_EXTENSION_HEADER + await readFile(source, "utf8");
  const target = piExtensionPath(extname(source));
  await writeManaged(target, (existing) => {
    if (existing !== null && !existing.startsWith(PI_EXTENSION_HEADER) && !isLegacy(existing)) throw new Error(`${target} exists and is not managed by Cohub; move it aside, then retry`);
    return content;
  }, { backup: false });
  // Pi loads every file here: drop a legacy or managed copy under the other extension.
  for (const other of [".ts", ".js"].map(piExtensionPath).filter((path) => path !== target)) {
    const text = await readOptional(other).catch(() => null);
    if (isLegacy(text) || text?.startsWith(PI_EXTENSION_HEADER)) await rm(other, { force: true });
  }
  return "installed";
}

/** Remove the Codex hooks earlier releases installed; Cohub now reads Codex's own files instead. */
export async function removeLegacyCodexHooks(): Promise<boolean> {
  const path = codexConfigPath();
  // Read first: the lock would create `~/.codex` for someone who never used Codex.
  if (!LEGACY_CODEX_HOOKS.test(await readOptional(path) ?? "")) return false;
  let removed = false;
  await writeManaged(path, (existing) => {
    if (existing === null || !LEGACY_CODEX_HOOKS.test(existing)) return existing;
    removed = true;
    return existing.replace(LEGACY_CODEX_HOOKS, "\n");
  }).catch((error) => { if (!missing(error)) throw error; });
  return removed;
}

/** Replace a user configuration file atomically, keeping one backup of what was there. */
async function writeManaged(path: string, update: (existing: string | null) => string | null, options = { backup: true }) {
  await withRuntimeSpaceBindingsLock(async () => {
    const info = await lstat(path).catch((error) => { if (missing(error)) return null; throw error; });
    if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error(`Refusing to replace a non-regular file: ${path}`);
    const original = info ? await readFile(path, "utf8") : null;
    const next = update(original);
    if (next === null || next === original) return;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    if (original !== null && options.backup) {
      const backup = `${path}.cohub-backup-${createHash("sha256").update(original).digest("hex").slice(0, 16)}`;
      const file = await open(backup, "wx", 0o600).catch((error) => { if ((error as NodeJS.ErrnoException).code === "EEXIST") return null; throw error; });
      if (file) { try { await file.writeFile(original); await file.sync(); } finally { await file.close(); } }
    }
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", info?.mode ?? 0o600);
      try { await file.writeFile(next); await file.sync(); } finally { await file.close(); }
      const current = await readFile(path, "utf8").catch((error) => { if (missing(error)) return null; throw error; });
      if (current !== original) throw new Error(`Configuration changed during installation: ${path}`);
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }, { lockPath: `${path}.cohub-lock` });
}
