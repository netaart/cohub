import type { ContentBlock, NativeTurnMessage } from "@neta-art/cohub";
import { record } from "../json-rpc.js";
import { iso, type NativeTranscript, type NativeTranscriptTurn } from "../native/transcript.js";
import { chainBranch, extendTurn, readChainedLines, startTurn } from "./chained-transcript.js";
import { array, text } from "./process.js";
import { streamContent, streamUsage } from "./stream-json.js";

const COMMAND = /^<command-name>\s*([^<]*)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
const BASH_INPUT = /^<bash-input>([\s\S]*?)<\/bash-input>/;
/** Output of a local command or `!` shell, recorded as a user message but never sent as a prompt. */
const LOCAL_OUTPUT = /^<(?:local-command-(?:stdout|stderr|caveat)|bash-(?:stdout|stderr))>/;
const INTERRUPTED = "[Request interrupted by user";
export const CLAUDE_REPLY_ENDED = ["end_turn", "stop_sequence", "max_tokens", "refusal", "aborted", "error"];

const nonEmpty = (block: ContentBlock) => !(block.type === "text" && !block.text) && !(block.type === "thinking" && !block.thinking);

/** A local `/command` or `!shell` is shown as typed; one that never reached the model is no Turn. */
function prompt(value: unknown): { content: ContentBlock[]; local: boolean } | null {
  const content = typeof value === "string" ? [{ type: "text" as const, text: value }] : streamContent(value).filter((block) => block.type === "text" || block.type === "image");
  const first = content.find((block) => block.type === "text")?.text.trimStart() ?? "";
  if (LOCAL_OUTPUT.test(first) || first.startsWith(INTERRUPTED)) return null;
  const command = COMMAND.exec(first);
  if (command) return { content: [{ type: "text", text: `${command[1]?.trim() ?? ""} ${COMMAND_ARGS.exec(first)?.[1]?.trim() ?? ""}`.trim() }], local: true };
  const bash = BASH_INPUT.exec(first);
  if (bash) return { content: [{ type: "text", text: `!${bash[1] ?? ""}` }], local: true };
  const visible = content.filter(nonEmpty);
  return visible.length ? { content: visible, local: false } : null;
}

/**
 * Claude Code appends one record per content block, linked by `parentUuid` (`logicalParentUuid`
 * across a compaction). A Turn starts at a prompt; its tool results and an interruption share the
 * prompt's `promptId`. Interactive sessions record each end (`turn_duration`), `-p` sessions do not.
 */
export async function readClaudeTranscript(path: string, nativeSessionId: string, signal?: AbortSignal): Promise<NativeTranscript> {
  const read = await readChainedLines(path, signal);
  const branch = chainBranch(read.lines, (value) => value.isSidechain === true ? "" : text(value.uuid), (value) => text(value.parentUuid) || text(value.logicalParentUuid));
  const turns: NativeTranscriptTurn[] = [];
  const owners = new Map<string, NativeTurnMessage>();
  const messageIds = new Map<NativeTurnMessage, string>();
  let cwd = "", cloudSessionId = "";
  let current: NativeTranscriptTurn | null = null;
  let promptId = "", local = false, interrupted = false, completedAt = "";
  const finish = () => {
    if (!current) return;
    // A local command that never reached the model is not a conversation Turn.
    if (local && !current.messages.length) { current = null; return; }
    const last = current.messages.at(-1);
    const status = interrupted || !last || last.stopReason === "tool_use" ? "interrupted" : last.stopReason === "error" ? "failed" : "completed";
    current.result = { messages: current.messages, completedAt: completedAt || current.startedAt, status };
    turns.push(current);
    current = null;
  };
  for (const line of branch) {
    const value = line.value;
    cwd ||= text(value.cwd);
    if (value.type === "user") {
      const message = record(value.message);
      const results = array(message.content).map(record).filter((block) => block.type === "tool_result");
      const opened = value.isMeta === true || value.isCompactSummary === true || results.length ? null : prompt(message.content);
      if (opened && !(current && text(value.promptId) && text(value.promptId) === promptId)) {
        finish();
        const cohub = record(value.cohub);
        cloudSessionId ||= text(cohub.sessionId);
        // Cohub sends its Turn id as the prompt's record id; a projected record names its Turn.
        current = startTurn(line, text(value.uuid), turns.at(-1)?.key ?? null, opened.content, text(cohub.turnId) || text(value.uuid));
        promptId = text(value.promptId); local = opened.local; interrupted = false; completedAt = current.startedAt;
        owners.clear(); messageIds.clear();
        continue;
      }
      if (!current) continue;
      for (const block of results) {
        const id = text(block.tool_use_id);
        const owner = owners.get(id);
        if (!owner) continue;
        owner.content.push({ type: "tool_result", tool_use_id: id, content: typeof block.content === "string" ? block.content : streamContent(block.content), is_error: block.is_error === true });
      }
      if (array(message.content).some((block) => text(record(block).text).startsWith(INTERRUPTED)) || text(message.content).startsWith(INTERRUPTED)) {
        interrupted = true;
        current.ended = true;
      }
      completedAt = iso(value.timestamp);
      extendTurn(current, line, true);
      continue;
    }
    if (!current) continue;
    if (value.type === "assistant") {
      const native = record(value.message);
      const id = text(native.id);
      let target = current.messages.at(-1);
      if (!target || !id || messageIds.get(target) !== id) {
        target = { content: [], provider: null, model: null, stopReason: null, errorMessage: null };
        current.messages.push(target);
        messageIds.set(target, id);
      }
      const content = streamContent(native.content).filter(nonEmpty);
      for (const block of content) {
        const index = block.type === "tool_use" ? target.content.findIndex((existing) => existing.type === "tool_use" && existing.id === block.id) : -1;
        if (index >= 0) target.content[index] = block; else target.content.push(block);
        if (block.type === "tool_use") owners.set(block.id, target);
      }
      const model = text(native.model);
      if (model && model !== "<synthetic>") target.model = model;
      if (text(native.stop_reason)) target.stopReason = text(native.stop_reason);
      const usage = streamUsage(native.usage, undefined);
      if (usage) target.usage = usage;
      if (value.isApiErrorMessage === true) {
        target.stopReason = "error";
        target.errorMessage = content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n") || "API error";
      }
      completedAt = iso(value.timestamp);
      extendTurn(current, line, true);
      continue;
    }
    if (value.type === "system" && value.subtype === "turn_duration") current.ended = true;
    extendTurn(current, line, false);
  }
  finish();
  return { nativeSessionId, cwd, ...(cloudSessionId ? { cloudSessionId } : {}), turns, prefixes: read.prefixes };
}
