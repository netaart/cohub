import { isDeepStrictEqual } from "node:util";
import { APPROVAL_MODES, type ApprovalMode, type RuntimeTurnInput } from "@neta-art/cohub";
import { record, type JsonRecord } from "../json-rpc.js";
import type { CodexChannel } from "../native/codex-link.js";
import { atLeast, type Version } from "../native/version.js";

/**
 * First app-server whose thread settings and permission profiles Cohub has verified, and which
 * honours the per-thread unload delay a loaded thread needs to be reopened with Cohub's profile.
 */
export const CODEX_APPROVAL_MIN_VERSION: Version = [0, 164, 0];

// Profiles name POSIX paths; Codex's Windows sandbox is not covered.
export const codexApprovalModes = (version: Version | null): ApprovalMode[] =>
  process.platform !== "win32" && atLeast(version, CODEX_APPROVAL_MIN_VERSION) ? [...APPROVAL_MODES] : [];

const READ_ONLY_PROFILE = "cohub-read-only";
/**
 * Codex runs a command its rules allow outside the sandbox, so `sandbox: "read-only"` alone lets a
 * pre-approved `touch` write. A profile that denies any read keeps such commands sandboxed; the
 * denied path does not exist and only serves to set that restriction. Every explicit mode defines
 * the profile, so a later read-only Turn can select it on a thread that is already loaded.
 */
export const CODEX_APPROVAL_CONFIG = { [`permissions.${READ_ONLY_PROFILE}`]: { extends: ":read-only", filesystem: { "/.cohub-read-only": "none" } } };
const WORKSPACE_WRITE = { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };

type Settings = { approvalPolicy: unknown; approvalsReviewer: unknown; sandboxPolicy?: unknown; permissions?: string };
export type CodexApproval = {
  mode: ApprovalMode;
  /** Thread open parameters; a profile must be selected once the profile table exists. */
  open: JsonRecord;
  /** The next Turn's settings, confirmed before anything is sent. */
  settings: Settings;
  sandbox?: unknown;
};

/** The platform's read-only access always wins; `null` keeps the legacy behaviour. */
export function codexApprovalMode(input: RuntimeTurnInput, version: Version | null): ApprovalMode | null {
  if (input.accessMode === "read_only" && input.approvalMode && input.approvalMode !== "read_only") {
    throw new Error("The approval mode conflicts with read-only access");
  }
  const mode = input.accessMode === "read_only" ? "read_only" : input.approvalMode;
  if (!mode || codexApprovalModes(version).includes(mode)) return mode ?? null;
  if (!input.approvalMode) return null;
  throw new Error(`Codex approval modes need app-server ${CODEX_APPROVAL_MIN_VERSION.join(".")} or newer; update Codex and restart its app-server`);
}

export async function resolveCodexApproval(mode: ApprovalMode, codex: CodexChannel, cwd: string): Promise<CodexApproval> {
  const never = { approvalPolicy: "never", approvalsReviewer: "user" };
  if (mode === "read_only") return { mode, open: { permissions: READ_ONLY_PROFILE, ...never }, settings: { permissions: READ_ONLY_PROFILE, ...never } };
  if (mode === "full_access") return { mode, open: { permissions: ":danger-full-access", ...never }, settings: { sandboxPolicy: { type: "dangerFullAccess" }, ...never } };
  if (mode === "auto") {
    const approval = { approvalPolicy: "on-request", approvalsReviewer: "auto_review" };
    return { mode, open: { permissions: ":workspace", ...approval }, settings: { sandboxPolicy: WORKSPACE_WRITE, ...approval } };
  }
  // Only Codex resolves the machine's settings (profiles, requirements), so ask it for a fresh thread's.
  const probe = await codex.request("thread/start", { cwd, ephemeral: true, config: { "features.hooks": false } });
  const probeId = text(record(probe.thread).id);
  if (probeId) await codex.request("thread/unsubscribe", { threadId: probeId }).catch(() => undefined);
  const sandbox = record(probe.sandbox);
  if (probe.approvalPolicy == null || typeof probe.approvalsReviewer !== "string" || !sandbox.type) throw new Error("Codex did not report its local approval settings");
  const approval = { approvalPolicy: probe.approvalPolicy, approvalsReviewer: probe.approvalsReviewer };
  const profile = text(record(probe.activePermissionProfile).id)
    || (sandbox.type === "dangerFullAccess" ? ":danger-full-access" : sandbox.type === "readOnly" ? ":read-only" : ":workspace");
  // A built-in profile is exactly its sandbox policy, which needs no profile table on a loaded thread.
  return {
    mode, open: { permissions: profile, ...approval }, sandbox: probe.sandbox,
    settings: profile.startsWith(":") ? { sandboxPolicy: probe.sandbox, ...approval } : { permissions: profile, ...approval },
  };
}

const SETTINGS_TIMEOUT_MS = 10_000;

function confirms(current: JsonRecord, approval: CodexApproval): boolean {
  const { settings, sandbox, mode } = approval;
  const currentSandbox = current.sandbox ?? current.sandboxPolicy;
  return isDeepStrictEqual(current.approvalPolicy, settings.approvalPolicy) && current.approvalsReviewer === settings.approvalsReviewer
    && (!settings.permissions || text(record(current.activePermissionProfile).id) === settings.permissions)
    && (settings.sandboxPolicy === undefined && sandbox === undefined || isDeepStrictEqual(currentSandbox, settings.sandboxPolicy ?? sandbox))
    && (mode !== "read_only" || isDeepStrictEqual(currentSandbox, { type: "readOnly", networkAccess: false }));
}

/**
 * Make the mode the thread's next-Turn settings, and send nothing unless Codex reports exactly them:
 * a loaded thread ignores open-time overrides, and an unchanged update reports nothing. A thread
 * loaded before Cohub defined its profile there is reopened with it (`reopen`).
 */
export async function applyCodexApproval(approval: CodexApproval, codex: CodexChannel, threadId: string, opened: JsonRecord, reopen: () => Promise<JsonRecord>): Promise<void> {
  if (confirms(opened, approval)) return;
  try { await update(approval, codex, threadId); }
  catch (error) {
    if (!approval.settings.permissions) throw error;
    if (confirms(await reopen(), approval)) return;
    await update(approval, codex, threadId);
  }
}

async function update(approval: CodexApproval, codex: CodexChannel, threadId: string): Promise<void> {
  let off = () => {};
  const updated = new Promise<JsonRecord>((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error("Codex did not confirm the selected approval mode; nothing was sent")); }, SETTINGS_TIMEOUT_MS);
    const offEvent = codex.onEvent((event) => {
      if (event.method !== "thread/settings/updated" || event.params.threadId !== threadId) return;
      off();
      resolve(record(event.params.threadSettings));
    });
    off = () => { clearTimeout(timer); offEvent(); };
  });
  updated.catch(() => undefined);
  try { await codex.request("thread/settings/update", { threadId, ...approval.settings }); }
  catch (error) {
    off();
    throw new Error(`Codex refused the selected approval mode: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!confirms(await updated, approval)) throw new Error("Codex did not confirm the selected approval mode; nothing was sent");
}

const UNLOAD_TIMEOUT_MS = 15_000;

/** Wait until no client holds the thread, so the next resume applies Cohub's thread config. */
export async function waitForUnload(codex: CodexChannel, threadId: string): Promise<void> {
  await codex.request("thread/unsubscribe", { threadId });
  const deadline = Date.now() + UNLOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const loaded = await codex.request("thread/loaded/list", {});
    if (!(Array.isArray(loaded.data) && loaded.data.includes(threadId))) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("This Codex conversation is open in another Codex client; close it there to change its approval mode, then retry");
}

const text = (value: unknown) => typeof value === "string" ? value : "";
