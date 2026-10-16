import type { RuntimeTurnInput } from "@neta-art/cohub";
import { isDeepStrictEqual } from "node:util";
import type { CodexChannel } from "./codex-link.js";
import { record, type JsonRecord } from "../json-rpc.js";
import { atLeast, type Version } from "./version.js";

/** Old servers can silently ignore fields; only enable versions whose complete contract is verified. */
export const CODEX_APPROVAL_MIN_VERSION: Version = [0, 162, 1];
export const CODEX_APPROVAL_MODES = ["inherit", "read_only", "auto", "full_access"] as const;

export function supportsCodexApprovalModes(userAgent: string | undefined): boolean {
  const match = userAgent && /(?:^|\/)(\d+)\.(\d+)\.(\d+)(?:\s|$|[-+])/.exec(userAgent);
  return atLeast(match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null, CODEX_APPROVAL_MIN_VERSION);
}

export function parseCodexApprovalMode(value: unknown, harness: string | undefined): typeof CODEX_APPROVAL_MODES[number] | undefined {
  if (value === undefined) return undefined;
  if (harness !== "codex") throw new Error("Codex approval mode requires the Codex harness");
  if (value === "ask") throw new Error("Human approval is not yet supported by this Cohub Runtime");
  if (typeof value !== "string" || !CODEX_APPROVAL_MODES.includes(value as typeof CODEX_APPROVAL_MODES[number])) throw new Error("Invalid Codex approval mode; use inherit|read_only|auto|full_access");
  return value as typeof CODEX_APPROVAL_MODES[number];
}

type ApprovalOptions = { thread: JsonRecord; turn: JsonRecord; inherited?: JsonRecord };

export async function codexApprovalOptions(input: RuntimeTurnInput, codex: CodexChannel, cwd: string): Promise<ApprovalOptions> {
  const selected = parseCodexApprovalMode(input.codexApprovalMode, input.harness);
  if (selected === "inherit" && input.accessMode !== "read_only") return await inheritApprovalOptions(codex, cwd);
  // Legacy read-only also needs a Turn override when rejoining a live thread.
  if (selected === undefined) return input.accessMode === "read_only"
    ? { thread: { sandbox: "read-only" }, turn: { sandboxPolicy: { type: "readOnly", networkAccess: false } } }
    : { thread: {}, turn: {} };
  const mode = input.accessMode === "read_only" ? "read_only" : selected;
  const approval = { approvalPolicy: mode === "auto" ? "on-request" : "never", approvalsReviewer: mode === "auto" ? "auto_review" : "user" };
  const sandbox = mode === "full_access" ? "danger-full-access" : mode === "read_only" ? "read-only" : "workspace-write";
  const sandboxPolicy = mode === "full_access" ? { type: "dangerFullAccess" }
    : mode === "read_only" ? { type: "readOnly", networkAccess: false }
      : { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  return { thread: { sandbox, ...approval }, turn: { sandboxPolicy, ...approval } };
}


/** Resolve defaults in Codex itself; reading config alone cannot resolve profiles or policy constraints. */
async function inheritApprovalOptions(codex: CodexChannel, cwd: string): Promise<ApprovalOptions> {
  const resolved = await codex.request("thread/start", { cwd, ephemeral: true, config: { "features.hooks": false } });
  const threadId = record(resolved.thread).id;
  if (typeof threadId !== "string" || !threadId) throw new Error("Codex did not provide a temporary thread for resolving local approval settings");
  try {
    const { approvalPolicy, approvalsReviewer } = resolved;
    const granular = record(record(approvalPolicy).granular);
    const validApproval = typeof approvalPolicy === "string" && ["untrusted", "on-request", "never"].includes(approvalPolicy)
      || ["sandbox_approval", "rules", "skill_approval", "request_permissions", "mcp_elicitations"].every((key) => typeof granular[key] === "boolean");
    if (!validApproval || typeof approvalsReviewer !== "string" || !["user", "auto_review", "guardian_subagent"].includes(approvalsReviewer)) throw new Error("Codex returned invalid local approval settings");
    const sandbox = record(resolved.sandbox);
    const validSandbox = sandbox.type === "dangerFullAccess"
      || sandbox.type === "externalSandbox" && typeof sandbox.networkAccess === "string" && ["restricted", "enabled"].includes(sandbox.networkAccess)
      || sandbox.type === "readOnly" && typeof sandbox.networkAccess === "boolean"
      || sandbox.type === "workspaceWrite" && Array.isArray(sandbox.writableRoots) && sandbox.writableRoots.every((root) => typeof root === "string")
        && ["networkAccess", "excludeTmpdirEnvVar", "excludeSlashTmp"].every((key) => typeof sandbox[key] === "boolean");
    if (!validSandbox) throw new Error("Codex returned unsupported or incomplete local sandbox settings");
    const approval = { approvalPolicy, approvalsReviewer };
    const profile = record(resolved.activePermissionProfile);
    if (resolved.activePermissionProfile !== null) {
      if (typeof profile.id !== "string" || !profile.id) throw new Error("Codex did not provide a valid local permissions profile");
      return { thread: { ...approval, permissions: profile.id }, turn: { ...approval, permissions: profile.id }, inherited: resolved };
    }
    // A new thread inherits the complete local policy. Reducing it to a SandboxMode
    // can discard network and filesystem details; existing threads receive it via settings/update.
    return { thread: approval, turn: { ...approval, sandboxPolicy: sandbox }, inherited: resolved };
  } finally {
    await codex.request("thread/unsubscribe", { threadId });
  }
}

export function confirmCodexApprovalOptions(opened: JsonRecord, approval: ApprovalOptions): void {
  const expectedSandbox = approval.inherited?.sandbox ?? approval.turn.sandboxPolicy;
  if (!isDeepStrictEqual(opened.approvalPolicy, approval.thread.approvalPolicy)
    || opened.approvalsReviewer !== approval.thread.approvalsReviewer
    || !isDeepStrictEqual(opened.sandbox, expectedSandbox)
    || !isDeepStrictEqual(opened.activePermissionProfile, approval.inherited?.activePermissionProfile ?? null)
  ) throw new Error("Codex did not confirm the selected approval mode; no Turn was started");
}
