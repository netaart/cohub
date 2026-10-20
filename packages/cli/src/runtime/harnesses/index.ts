import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { LOCAL_HARNESSES, type LocalHarness, type RuntimeCapabilities } from "@neta-art/cohub";
import { harnessExecutableCandidates } from "./process.js";
import { piHarness } from "./pi.js";
import { codexHarness } from "./codex.js";
import { claudeHarness } from "./claude.js";
import { workbuddyHarness } from "./workbuddy.js";
import type { HarnessExecutables, LocalHarnessAdapter, NativeTranscriptFormat } from "./types.js";

export type { HarnessExecutables, HarnessModel, HarnessResult, LocalHarnessAdapter } from "./types.js";
export { harnessCommand, harnessExecutableCandidates } from "./process.js";

/** Every local harness is one adapter; the protocol registry lists their identities. Built lazily to tolerate import cycles. */
let registry: Readonly<Record<LocalHarness, LocalHarnessAdapter>> | null = null;
const adapters = () => registry ??= { pi: piHarness, codex: codexHarness, claude: claudeHarness, workbuddy: workbuddyHarness };

export const harnessAdapter = (harness: LocalHarness): LocalHarnessAdapter => adapters()[harness];
export const harnessExecutable = (harness: LocalHarness, executables: HarnessExecutables) => executables[harness] || adapters()[harness].binary;
export const transcriptFormat = (harness: LocalHarness): NativeTranscriptFormat => adapters()[harness].transcript;

/** Discover installed executables only; authentication/capability errors stay explicit. */
export async function installedHarnesses(cwd: string, executables: HarnessExecutables, path = process.env.PATH ?? ""): Promise<LocalHarness[]> {
  const explicit = LOCAL_HARNESSES.filter((harness) => executables[harness]);
  const found = await Promise.all((explicit.length ? explicit : LOCAL_HARNESSES).map(async (harness) => {
    for (const candidate of harnessExecutableCandidates(harnessExecutable(harness, executables), cwd, path)) {
      try { await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK); if ((await stat(candidate)).isFile()) return harness; }
      catch { /* Try the next PATH entry. */ }
    }
    return null;
  }));
  return found.filter((harness): harness is LocalHarness => harness !== null);
}

/**
 * Explicitly requested harnesses must all work. With `onUnavailable`, a failing harness is reported
 * and left out instead, so auto-discovery still starts with the ones that work.
 */
export async function discoverHarnesses(harnesses: LocalHarness[], executables: HarnessExecutables, cwd: string, onUnavailable?: (harness: LocalHarness, error: unknown) => void): Promise<RuntimeCapabilities> {
  const catalogs = await Promise.all(harnesses.map(async (harness) => {
    try { return { harness, models: await adapters()[harness].models(harnessExecutable(harness, executables), cwd) }; }
    catch (error) {
      if (!onUnavailable) throw error;
      onUnavailable(harness, error);
      return null;
    }
  }));
  const available = catalogs.filter((catalog) => catalog !== null);
  return { harnesses: available.map((catalog) => catalog.harness), models: available.flatMap((catalog) => catalog.models) };
}
