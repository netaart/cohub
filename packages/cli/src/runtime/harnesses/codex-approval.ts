import { APPROVAL_DECISIONS, APPROVAL_MODES, type ApprovalDecision, type ApprovalMode, type RuntimeTurnInput } from "@neta-art/cohub";
import type { ApprovalRequest } from "../native/approvals.js";
import { record, type JsonRecord } from "../json-rpc.js";
import type { CodexChannel } from "../native/codex-link.js";
import { atLeast, type Version } from "../native/version.js";

/** First app-server whose thread and Turn approval overrides Cohub has verified. */
export const CODEX_APPROVAL_MIN_VERSION: Version = [0, 162, 1];

export const codexApprovalModes = (version: Version | null): ApprovalMode[] =>
  atLeast(version, CODEX_APPROVAL_MIN_VERSION) ? [...APPROVAL_MODES] : [];

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

/** Overrides for opening the thread and for `turn/start`, which a loaded thread keeps for later Turns. */
export type CodexApproval = { thread: JsonRecord; turn: JsonRecord };

const PRESETS: Record<Exclude<ApprovalMode, "inherit">, { sandbox: string; sandboxPolicy: JsonRecord; approvalPolicy: string; approvalsReviewer: string }> = {
  // Like Codex's own Read Only; Cohub refuses the approvals it would ask for.
  read_only: { sandbox: "read-only", sandboxPolicy: { type: "readOnly", networkAccess: false }, approvalPolicy: "on-request", approvalsReviewer: "user" },
  auto: {
    sandbox: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "auto_review",
    sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  },
  full_access: { sandbox: "danger-full-access", sandboxPolicy: { type: "dangerFullAccess" }, approvalPolicy: "never", approvalsReviewer: "user" },
};

/**
 * `inherit` sends the machine's own settings, so an existing thread drops what an earlier mode set;
 * a new thread starts with them anyway. Only Codex resolves them (profiles, requirements).
 */
export async function resolveCodexApproval(mode: ApprovalMode, codex: CodexChannel, cwd: string, existing: boolean): Promise<CodexApproval> {
  if (mode !== "inherit") {
    const { sandbox, sandboxPolicy, ...approval } = PRESETS[mode];
    return { thread: { sandbox, ...approval }, turn: { sandboxPolicy, ...approval } };
  }
  if (!existing) return { thread: {}, turn: {} };
  const probe = await codex.request("thread/start", { cwd, ephemeral: true, config: { "features.hooks": false } });
  const probeId = record(probe.thread).id;
  if (typeof probeId === "string" && probeId) await codex.request("thread/unsubscribe", { threadId: probeId }).catch(() => undefined);
  const sandbox = record(probe.sandbox);
  if (probe.approvalPolicy == null || typeof probe.approvalsReviewer !== "string" || !sandbox.type) throw new Error("Codex did not report its local approval settings");
  const approval = { approvalPolicy: probe.approvalPolicy, approvalsReviewer: probe.approvalsReviewer };
  const profile = record(probe.activePermissionProfile).id;
  // A named profile carries more than its sandbox policy; built-in ones are exactly it.
  return { thread: {}, turn: typeof profile === "string" && profile && !profile.startsWith(":") ? { ...approval, permissions: profile } : { ...approval, sandboxPolicy: probe.sandbox } };
}

const CODEX_DECISIONS: Record<ApprovalDecision, string> = { accept: "accept", accept_for_session: "acceptForSession", decline: "decline" };
export const codexDecision = (decision: ApprovalDecision) => ({ decision: CODEX_DECISIONS[decision] });

const clip = (value: unknown, max: number) => typeof value === "string" && value ? value.slice(0, max) : undefined;

/** A Codex request a person can answer on a card; others are refused as before. */
export function codexApprovalRequest(method: string, params: JsonRecord, paths: string[] | undefined): ApprovalRequest | null {
  if (method !== "item/commandExecution/requestApproval" && method !== "item/fileChange/requestApproval") return null;
  // Codex may leave `decline` out of its list but accepts it; a card can always say no.
  const offered = Array.isArray(params.availableDecisions) ? params.availableDecisions : null;
  const decisions = APPROVAL_DECISIONS.filter((decision) => decision === "decline" || !offered || offered.includes(CODEX_DECISIONS[decision]));
  const reason = clip(params.reason, 4096);
  if (method === "item/fileChange/requestApproval") {
    const changed = [...paths ?? [], ...typeof params.grantRoot === "string" ? [params.grantRoot] : []].slice(0, 100).map((path) => path.slice(0, 4096));
    return { kind: "file_change", decisions, ...(reason ? { reason } : {}), ...(changed.length ? { paths: changed } : {}) };
  }
  const command = clip(params.command, 16_384);
  const cwd = clip(params.cwd, 4096);
  return { kind: "command", decisions, ...(command ? { command } : {}), ...(cwd ? { cwd } : {}), ...(reason ? { reason } : {}) };
}
