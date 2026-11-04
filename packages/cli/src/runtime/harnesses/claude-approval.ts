import { APPROVAL_DECISIONS, APPROVAL_MODES, type ApprovalMode, type RuntimeTurnInput } from "@neta-art/cohub";
import { record, type JsonRecord } from "../json-rpc.js";
import type { ApprovalBroker, ApprovalRequest } from "../native/approvals.js";
import { text } from "./process.js";

const PERMISSION_MODES: Record<ApprovalMode, string | null> = { inherit: null, auto: "auto", full_access: "bypassPermissions", read_only: "plan" };
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Cards answer Claude Code's permission prompts, so without `--permission-prompt-tool stdio` no mode is offered. */
export function claudeApprovalModes(help: string): ApprovalMode[] {
  const start = help.search(/--permission-mode\b/);
  const option = start < 0 ? "" : help.slice(start).split(/\n\s*-/)[0] ?? "";
  const choices = new Set([...(/\(choices:([^)]*)\)/.exec(option)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1]));
  return APPROVAL_MODES.filter((mode) => mode === "inherit" || choices.has(PERMISSION_MODES[mode] ?? ""));
}

/**
 * The platform's read-only access always wins. No mode follows local settings, as the picker shows;
 * a CLI that cannot ask (no modes) keeps `acceptEdits` (`null`), since its prompts would be denied.
 */
export function claudeApprovalMode(input: RuntimeTurnInput, modes: readonly ApprovalMode[]): ApprovalMode | null {
  if (input.accessMode === "read_only" && input.approvalMode && input.approvalMode !== "read_only") {
    throw new Error("The approval mode conflicts with read-only access");
  }
  if (input.accessMode === "read_only") return "read_only";
  if (!input.approvalMode) return modes.includes("inherit") ? "inherit" : null;
  if (modes.includes(input.approvalMode)) return input.approvalMode;
  throw new Error(`This Claude Code does not support the ${input.approvalMode} approval mode; update Claude Code and restart the Runtime`);
}

export const claudePermissionMode = (mode: Exclude<ApprovalMode, "read_only"> | null) => mode ? PERMISSION_MODES[mode] : "acceptEdits";

const clip = (value: unknown, max: number) => typeof value === "string" && value ? value.slice(0, max) : undefined;
/** What a card cannot show in full is not shown at all: a person approves exactly what runs. */
const whole = (value: unknown, max: number) => typeof value === "string" && value.length > max ? null : text(value) || undefined;

/**
 * A `can_use_tool` request shown on a card, and what Allow for this chat remembers; other tools are denied.
 * Claude Code reports no working directory: its shell keeps the last `cd`, so none is guessed.
 */
export function claudeApprovalRequest(request: JsonRecord): { card: ApprovalRequest; grants: string[] } | null {
  const tool = text(request.tool_name), input = record(request.input);
  const reason = clip(tool === "Bash" ? text(input.description) || request.decision_reason : request.decision_reason, 4096);
  const card = (kind: ApprovalRequest["kind"], grants: string[], fields: Partial<ApprovalRequest>) => ({
    grants,
    card: { kind, decisions: APPROVAL_DECISIONS.filter((decision) => decision !== "accept_for_session" || grants.length > 0), ...fields, ...(reason ? { reason } : {}) },
  });
  if (tool === "Bash") {
    const command = whole(input.command, 16_384);
    return command === null ? null : card("command", command ? [`command:${command}`] : [], command ? { command } : {});
  }
  if (!EDIT_TOOLS.has(tool)) return null;
  const path = whole(input.file_path ?? input.notebook_path, 4096);
  return path === null ? null : card("file_change", path ? [`file:${path}`] : [], path ? { paths: [path] } : {});
}

const MAX_SESSIONS = 200;
const MAX_GRANTS = 200;
const GRANT_IDLE_MS = 24 * 60 * 60_000;

/**
 * Allow for this chat, kept by the Runtime per Cohub Session: each Turn starts a new Claude Code
 * process, and Claude's own settings are never written. Bounded and forgotten after a day unused.
 */
export class SessionGrants {
  private readonly sessions = new Map<string, { keys: Set<string>; usedAt: number }>();

  constructor(private readonly now = Date.now) {}

  covers(sessionId: string, keys: string[]): boolean {
    const entry = this.live(sessionId);
    if (!entry || !keys.length || !keys.every((key) => entry.keys.has(key))) return false;
    this.touch(sessionId, entry);
    return true;
  }

  add(sessionId: string, keys: string[]): void {
    if (!keys.length) return;
    const entry = this.live(sessionId) ?? { keys: new Set<string>(), usedAt: 0 };
    for (const key of keys) { entry.keys.delete(key); entry.keys.add(key); }
    for (const key of entry.keys) { if (entry.keys.size <= MAX_GRANTS) break; entry.keys.delete(key); }
    this.touch(sessionId, entry);
    for (const oldest of this.sessions.keys()) { if (this.sessions.size <= MAX_SESSIONS) break; this.sessions.delete(oldest); }
  }

  private live(sessionId: string) {
    const entry = this.sessions.get(sessionId);
    if (entry && this.now() - entry.usedAt > GRANT_IDLE_MS) this.sessions.delete(sessionId);
    return this.sessions.get(sessionId);
  }

  private touch(sessionId: string, entry: { keys: Set<string>; usedAt: number }) {
    entry.usedAt = this.now();
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, entry);
  }
}

const DENIED = "Approval requires an interactive local client";

/** The `can_use_tool` answer: a card for Bash and file edits, a denial for anything else or without a card. */
export async function answerClaudeApproval(request: JsonRecord, input: RuntimeTurnInput, approvals: ApprovalBroker, grants: SessionGrants, signal: AbortSignal): Promise<JsonRecord> {
  const allow = { behavior: "allow", updatedInput: record(request.input) };
  const asked = claudeApprovalRequest(request);
  // A platform read-only Turn is never widened, whoever approves.
  if (!asked || input.accessMode === "read_only" || !approvals.available || signal.aborted) return { behavior: "deny", message: DENIED };
  if (grants.covers(input.sessionId, asked.grants)) return allow;
  const decision = await approvals.request(input.sessionId, input.turnId, asked.card, signal);
  // A Turn that ended meanwhile grants nothing, not even to later Turns.
  if (signal.aborted) return { behavior: "deny", message: DENIED };
  if (decision === "decline") return { behavior: "deny", message: "The user declined this tool use" };
  if (decision === "accept_for_session") grants.add(input.sessionId, asked.grants);
  return allow;
}
