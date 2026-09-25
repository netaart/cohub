import { createInterface } from "node:readline/promises";
import { serializeDiagnosticError } from "../diagnostics.js";
import type { Harness } from "./adapters.js";
import { CODEX_SHARED_MIN_VERSION, supportsSharedServer } from "./codex-link.js";
import { PI_MIN_VERSION } from "./pi-link.js";
import { atLeast, formatVersion, harnessVersion } from "./version.js";
import { readNativeConfig, runtimeStateRoot, writeNativeConfig, type NativeConfig } from "./config.js";
import { discoverTranscripts } from "./ingest.js";
import { installPiExtension, piExtensionState, removeLegacyCodexHooks } from "./install.js";

export type NativeSyncReport = {
  enabled: boolean;
  harnesses: Harness[];
  codexShared: boolean;
  importHistory: boolean;
  note?: string;
};

type Input = { root: string; spaceId: string; identity: string; harnesses: Harness[]; yes?: boolean; executables?: { pi?: string; codex?: string } };
type Ask = (question: string) => Promise<boolean>;

/** Whether this directory already syncs every requested harness. */
export function nativeSyncSatisfied(config: NativeConfig | null, input: { spaceId: string; root: string; harnesses: Harness[] }): boolean {
  return Boolean(config && config.spaceId === input.spaceId && config.root === input.root && input.harnesses.every((harness) => config.harnesses.includes(harness)));
}

async function defaultAsk(question: string) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try { return /^(|y(es)?)$/i.test((await rl.question(question)).trim()); } finally { rl.close(); }
}

/**
 * Enable native sync after consent. Native history may contain secrets, so nothing is read before
 * the user agrees; a failure here never blocks the Runtime, it only leaves sessions read-only.
 */
export async function ensureNativeSync(input: Input, log: (line: string) => void = (line) => process.stderr.write(line), ask: Ask = defaultAsk): Promise<NativeSyncReport> {
  const stateRoot = runtimeStateRoot(input.spaceId);
  const previous = await readNativeConfig(stateRoot, input.identity).catch(() => null);
  if (previous && nativeSyncSatisfied(previous, input)) {
    await maintain(previous, log, input.executables?.pi);
    return { enabled: true, harnesses: previous.harnesses, codexShared: previous.codexShared, importHistory: false };
  }
  const interactive = process.stdin.isTTY === true;
  const confirm: Ask = async (question) => input.yes ? true : interactive ? await ask(question) : false;
  if (!input.yes && !interactive) {
    log("Native sync off · rerun interactively or with --yes to enable\n");
    return { enabled: false, harnesses: input.harnesses, codexShared: false, importHistory: false, note: "non-interactive" };
  }
  const names = input.harnesses.map((harness) => harness === "pi" ? "Pi" : "Codex").join(" and ");
  if (!await confirm(`Sync ${names} chats in this folder to this Space so they continue on the web? Their history may contain secrets. [Y/n] `)) {
    return { enabled: false, harnesses: input.harnesses, codexShared: false, importHistory: false, note: "declined" };
  }
  let codexShared = previous?.codexShared ?? false;
  if (input.harnesses.includes("codex") && !codexShared) {
    const version = await harnessVersion(input.executables?.codex || "codex");
    if (!supportsSharedServer(version)) {
      log(`Codex ${formatVersion(version)} predates the shared app-server (${CODEX_SHARED_MIN_VERSION.join(".")}+); terminal Codex chats sync read-only\n`);
    } else {
      codexShared = await confirm("Let terminal Codex and the web drive the same live sessions? Cohub starts Codex's shared app-server, which keeps running in the background. [Y/n] ");
    }
  }
  const harnesses = [...new Set([...(previous?.root === input.root ? previous.harnesses : []), ...input.harnesses])];
  const config: NativeConfig = {
    version: 2, identity: input.identity, spaceId: input.spaceId, root: input.root, harnesses,
    // History is whatever existed before the first consent for this directory.
    enabledAt: previous?.root === input.root ? previous.enabledAt : new Date().toISOString(),
    codexShared,
  };
  try {
    await writeNativeConfig(stateRoot, config);
  } catch (error) {
    log(`Native sync unavailable; Runtime continues without it — ${serializeDiagnosticError(error).message}\n`);
    return { enabled: false, harnesses: input.harnesses, codexShared: false, importHistory: false, note: "config" };
  }
  await maintain(config, log, input.executables?.pi, true);
  const history = (await discoverTranscripts(input.root, input.harnesses, { headers: true }).catch(() => []))
    .filter((candidate) => candidate.mtimeMs < Date.parse(config.enabledAt)).length;
  let importHistory = false;
  if (history && !previous) {
    importHistory = await confirm(`Import ${history} earlier conversation${history === 1 ? "" : "s"} from this folder? [Y/n] `);
    if (!importHistory) log("Import them later with cohub runtime import\n");
  }
  return { enabled: true, harnesses, codexShared, importHistory };
}

/** Keep integrations current on every `up`. */
async function maintain(config: NativeConfig, log: (line: string) => void, piBinary: string | undefined, announce = false) {
  if (config.harnesses.includes("pi")) await maintainPiExtension(piBinary, log, announce);
}

/**
 * Before any harness starts, repair what earlier releases installed: an outdated Pi extension can keep
 * Pi from starting, and legacy Codex hooks run a script that is gone. Both had consent back then.
 */
export async function repairIntegrations(piBinary: string | undefined, log: (line: string) => void = (line) => process.stderr.write(line)) {
  await removeLegacyCodexHooks().catch(() => undefined);
  if (await piExtensionState().catch(() => null) === "outdated") await maintainPiExtension(piBinary, log);
}

/** Pi without the extension still syncs, read-only. */
async function maintainPiExtension(piBinary: string | undefined, log: (line: string) => void, announce = false) {
  const version = await harnessVersion(piBinary || "pi");
  if (!atLeast(version, PI_MIN_VERSION)) {
    log(`Pi ${formatVersion(version)} predates the Cohub extension (${PI_MIN_VERSION.join(".")}+); Pi chats sync read-only\n`);
    return;
  }
  try {
    const state = await piExtensionState();
    if (state === "installed") return;
    if (state === "foreign" || state === "missing" && !announce) {
      log("Pi extension not installed; Pi chats sync read-only. Install with cohub runtime attach --harness pi\n");
      return;
    }
    await installPiExtension();
    log(state === "outdated" ? "Pi extension updated; run /reload in open Pi sessions\n" : "Pi extension installed; run /reload in open Pi sessions to connect them\n");
  } catch (error) {
    log(`Pi extension not installed — ${serializeDiagnosticError(error).message}; Pi chats sync read-only\n`);
  }
}
