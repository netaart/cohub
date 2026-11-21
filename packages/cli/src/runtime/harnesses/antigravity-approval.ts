import { APPROVAL_DECISIONS, APPROVAL_MODES, type ApprovalMode, type RuntimeTurnInput } from "@neta-art/cohub";
import { record, type JsonRecord } from "../json-rpc.js";
import type { ApprovalBroker, ApprovalRequest } from "../native/approvals.js";
import type { SessionGrants } from "./claude-approval.js";
import { array, text } from "./process.js";

const ACP_MODES: Record<ApprovalMode, string> = {
  inherit: "default",
  auto: "auto",
  full_access: "auto",
  read_only: "plan",
};

const COMMAND_TOOLS = new Set(["run_command", "bash", "shell", "execute_command", "command"]);
const EDIT_TOOLS = new Set([
  "edit_file",
  "write_file",
  "multi_edit",
  "replace_file_content",
  "multi_replace_file_content",
  "write_to_file",
]);

/** Modes this Antigravity installation can enforce based on ACP `modes.availableModes`. */
export function antigravityApprovalModes(availableModes: readonly string[]): ApprovalMode[] {
  const choices = new Set(availableModes);
  if (!choices.size) return [];
  return APPROVAL_MODES.filter((mode) => {
    if (mode === "inherit") return true;
    if (mode === "full_access") return true;
    return choices.has(ACP_MODES[mode]);
  });
}

/** Platform read-only access always wins over any requested approval mode. */
export function antigravityApprovalMode(input: RuntimeTurnInput, modes: readonly ApprovalMode[]): ApprovalMode | null {
  if (input.accessMode === "read_only" && input.approvalMode && input.approvalMode !== "read_only") {
    throw new Error("The approval mode conflicts with read-only access");
  }
  if (input.accessMode === "read_only") return "read_only";
  if (!input.approvalMode) return modes.includes("inherit") ? "inherit" : null;
  if (modes.includes(input.approvalMode)) return input.approvalMode;
  throw new Error(`This Antigravity CLI does not support the ${input.approvalMode} approval mode; update Antigravity and restart the Runtime`);
}

export const antigravityAcpMode = (mode: ApprovalMode | null): string => (mode ? ACP_MODES[mode] : "default");

const clip = (value: unknown, max: number) => typeof value === "string" && value ? value.slice(0, max) : undefined;
/** What a card cannot show in full is not shown at all: a person approves exactly what runs. */
const whole = (value: unknown, max: number) => typeof value === "string" && value.length > max ? null : text(value) || undefined;

/** Select an ACP permission option matching allow or reject. */
export function antigravityPermissionOption(options: readonly unknown[], allow: boolean): string | null {
  const parsed = options.map(record);
  const preferred = allow ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const kind of preferred) {
    const match = parsed.find((option) => text(option.kind) === kind && text(option.optionId));
    if (match) return text(match.optionId);
  }
  const fallback = parsed.find((option) => {
    const kind = text(option.kind).toLowerCase();
    const id = text(option.optionId).toLowerCase();
    return allow ? (kind.includes("allow") || id.includes("allow")) : (kind.includes("reject") || kind.includes("deny") || id.includes("deny") || id.includes("reject"));
  });
  return fallback ? text(fallback.optionId) || null : null;
}

/**
 * Translate an ACP `session/request_permission` payload into a Cohub approval card and session-grant keys.
 * Unknown tools or oversized commands/paths return `null` and are declined without a card.
 */
export function antigravityApprovalRequest(params: JsonRecord): { card: ApprovalRequest; grants: string[] } | null {
  const toolCall = record(params.toolCall);
  const name = text(toolCall.name);
  const kind = text(toolCall.kind);
  const rawInput = record(toolCall.rawInput);
  const args = Object.keys(rawInput).length ? rawInput : record(toolCall.args);
  const reason = clip(text(args.toolSummary) || text(args.description) || text(toolCall.title), 4096);
  const card = (cardKind: ApprovalRequest["kind"], grants: string[], fields: Partial<ApprovalRequest>) => ({
    grants,
    card: {
      kind: cardKind,
      decisions: APPROVAL_DECISIONS.filter((decision) => decision !== "accept_for_session" || grants.length > 0),
      ...fields,
      ...(reason ? { reason } : {}),
    },
  });

  if (kind === "execute" || COMMAND_TOOLS.has(name)) {
    const command = whole(args.CommandLine ?? args.command ?? toolCall.title, 16_384);
    const cwd = clip(args.Cwd ?? args.cwd, 4096);
    return command === null ? null : card("command", command ? [`command:${command}`] : [], { ...(command ? { command } : {}), ...(cwd ? { cwd } : {}) });
  }

  if (kind === "edit" || EDIT_TOOLS.has(name)) {
    const firstLocation = record(array(toolCall.locations)[0]);
    const path = whole(args.Path ?? args.TargetFile ?? args.file_path ?? args.path ?? firstLocation.path, 4096);
    return path === null ? null : card("file_change", path ? [`file:${path}`] : [], path ? { paths: [path] } : {});
  }

  return null;
}

function outcomeResult(optionId: string | null): JsonRecord {
  if (!optionId) return { outcome: { outcome: "cancelled" } };
  return { outcome: { outcome: "selected", optionId } };
}

/**
 * Answer an ACP `session/request_permission` request.
 * Platform read-only Turns are never widened; full_access auto-allows; inherit/auto show approval cards.
 */
export async function answerAntigravityApproval(
  params: JsonRecord,
  input: RuntimeTurnInput,
  mode: ApprovalMode | null,
  approvals: ApprovalBroker,
  grants: SessionGrants,
  signal: AbortSignal,
): Promise<JsonRecord> {
  const options = array(params.options);
  const allow = () => outcomeResult(antigravityPermissionOption(options, true));
  const deny = () => outcomeResult(antigravityPermissionOption(options, false));

  if (signal.aborted) return { outcome: { outcome: "cancelled" } };
  if (input.accessMode === "read_only" || mode === "read_only") return deny();
  if (mode === "full_access") return allow();

  const asked = antigravityApprovalRequest(params);
  if (!asked || !approvals.available) return deny();
  if (grants.covers(input.sessionId, asked.grants)) return allow();

  const decision = await approvals.request(input.sessionId, input.turnId, asked.card, signal);
  if (signal.aborted) return { outcome: { outcome: "cancelled" } };
  if (decision === "decline") return deny();
  if (decision === "accept_for_session") grants.add(input.sessionId, asked.grants);
  return allow();
}
