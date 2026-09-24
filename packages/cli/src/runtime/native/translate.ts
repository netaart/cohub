import type { ContentBlock, NativeTurnProgress, RuntimeExecutionEvent, RuntimeMessage } from "@neta-art/cohub";
import { codexItemContent, piContent } from "../harness.js";
import { codexTokenTotals, codexUsage, subtractCodexTokens, type CodexTokenTotals } from "../codex-usage.js";
import { record, type JsonRecord } from "../json-rpc.js";

const text = (value: unknown) => typeof value === "string" ? value : "";
const identifiable = (value: unknown) => typeof value === "string" && value.length > 0;
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

/** Harness events mapped onto Cohub's streaming protocol. */
export type Translator = {
  push(event: JsonRecord): boolean;
  last(): RuntimeMessage;
};

/** Pi emits the same event shapes to its extensions as over RPC. */
export function piTranslator(emit: (event: RuntimeExecutionEvent) => void): Translator {
  let ordinal = -1;
  let current: ContentBlock[] = [];
  let last: RuntimeMessage = { ordinal: 0, content: [] };
  return {
    last: () => last,
    push(event) {
      const type = text(event.type);
      const message = record(event.message);
      if (type === "message_start" && message.role === "assistant") { ordinal += 1; current = []; emit({ type: "message.start", ordinal }); }
      if (type === "message_end" && message.role === "assistant") {
        current = piContent(message.content);
        emit({ type: "content.replace", ordinal, content: current });
      }
      if (type === "tool_execution_start") {
        const id = text(event.toolCallId);
        if (identifiable(id) && identifiable(event.toolName) && !current.some((block) => block.type === "tool_use" && block.id === id)) current.push({ type: "tool_use", id, name: text(event.toolName), input: record(event.args), _meta: { toolStatus: "running" } });
        emit({ type: "content.replace", ordinal, content: [...current] });
      }
      if (type === "tool_execution_update" || type === "tool_execution_end") {
        const id = text(event.toolCallId);
        const raw = type === "tool_execution_end" ? event.result : event.partialResult;
        const resultContent = typeof raw === "string" ? raw : piContent(record(raw).content);
        if (identifiable(id)) {
          current = current.filter((block) => block.type !== "tool_result" || block.tool_use_id !== id);
          current.push({ type: "tool_result", tool_use_id: id, content: resultContent, is_error: Boolean(event.isError), _meta: { toolStatus: type === "tool_execution_end" ? "done" : "running" } });
        }
        emit({ type: "content.replace", ordinal, content: [...current] });
      }
      if (type === "message_update") {
        const delta = record(event.assistantMessageEvent);
        if (delta.type === "text_delta" || delta.type === "thinking_delta") emit({ type: "text.delta", ordinal, index: Number(delta.contentIndex ?? 0), kind: delta.type === "text_delta" ? "text" : "thinking", delta: text(delta.delta) });
      }
      if (type === "turn_end") {
        const content = piContent(message.content);
        for (const value of list(event.toolResults)) {
          const result = record(value);
          if (!identifiable(result.toolCallId)) continue;
          content.push({ type: "tool_result", tool_use_id: text(result.toolCallId), content: typeof result.content === "string" ? result.content : piContent(result.content), is_error: Boolean(result.isError) });
        }
        const stopReason = text(message.stopReason);
        last = { ordinal: Math.max(0, ordinal), content, provider: text(message.provider) || null, model: text(message.model) || null, usage: message.usage as RuntimeMessage["usage"], stopReason: stopReason === "toolUse" ? "tool_use" : stopReason || "stop", errorMessage: text(message.errorMessage) || null };
        emit({ type: "content.replace", ordinal: last.ordinal, content });
        if (last.stopReason === "tool_use") emit({ type: "message.commit", message: last });
      }
      // The run ends when Pi settles: an automatic retry or compaction continues after `agent_end`,
      // and extensions are not told whether one follows.
      return type === "agent_settled" || type === "agent_end" && event.willRetry === false;
    },
  };
}

/** Codex app-server notifications for one Turn of one thread. */
export function codexTranslator(emit: (event: RuntimeExecutionEvent) => void, identity: { provider: string | null; model: string | null }): Translator {
  let ordinal = -1;
  const items = new Map<string, JsonRecord>();
  const ordinals = new Map<string, number>();
  const outputs = new Map<string, string>();
  const completed = new Set<string>();
  let pending: RuntimeMessage | null = null;
  let final: RuntimeMessage = { ordinal: 0, content: [] };
  let usage: RuntimeMessage["usage"];
  let baseline: CodexTokenTotals | undefined;
  const { provider, model } = identity;
  const latest = (): RuntimeMessage => {
    if (pending && pending.ordinal >= ordinal) return pending;
    const item = [...items.entries()].find(([id]) => ordinals.get(id) === ordinal)?.[1];
    return { ordinal: Math.max(0, ordinal), content: item ? codexItemContent(item) : [] };
  };
  return {
    last: () => usage ? { ...final, usage } : final,
    push(event) {
      const method = text(event.method);
      const params = record(event.params);
      if (method === "thread/tokenUsage/updated") {
        const tokenUsage = record(params.tokenUsage);
        const total = codexTokenTotals(tokenUsage.total);
        baseline ??= subtractCodexTokens(total, codexTokenTotals(tokenUsage.last));
        usage = codexUsage(subtractCodexTokens(total, baseline));
      }
      if (method === "item/started") {
        const item = record(params.item);
        if (item.type === "userMessage" || completed.has(text(item.id))) return false;
        const existing = ordinals.get(text(item.id));
        if (pending && (existing == null || existing > pending.ordinal)) { emit({ type: "message.commit", message: pending }); pending = null; }
        if (existing != null) {
          items.set(text(item.id), item);
          if (item.type === "agentMessage" && text(item.text)) emit({ type: "content.replace", ordinal: existing, content: codexItemContent(item) });
          return false;
        }
        ordinal += 1;
        ordinals.set(text(item.id), ordinal);
        items.set(text(item.id), item);
        emit({ type: "message.start", ordinal });
        if (!["agentMessage", "reasoning", "plan"].includes(text(item.type))) emit({ type: "content.replace", ordinal, content: codexItemContent(item).filter((block) => block.type !== "tool_result") });
      }
      if (method === "item/agentMessage/delta" || method === "item/reasoning/textDelta" || method === "item/reasoning/summaryTextDelta") {
        const id = text(params.itemId);
        if (completed.has(id)) return false;
        const itemOrdinal = ordinals.get(id);
        const item = items.get(id);
        if (item) {
          if (method === "item/agentMessage/delta") item.text = text(item.text) + text(params.delta);
          else { const key = method.includes("summary") ? "summary" : "content"; item[key] = [list(item[key]).map(text).join("\n") + text(params.delta)]; }
        }
        if (itemOrdinal != null) emit({ type: "text.delta", ordinal: itemOrdinal, index: 0, kind: method === "item/agentMessage/delta" ? "text" : "thinking", delta: text(params.delta) });
      }
      if (method === "item/commandExecution/outputDelta") {
        const id = text(params.itemId);
        const item = items.get(id);
        const itemOrdinal = ordinals.get(id);
        if (item && itemOrdinal != null) {
          const output = (outputs.get(id) ?? "") + text(params.delta);
          outputs.set(id, output);
          item.aggregatedOutput = output;
          emit({ type: "content.replace", ordinal: itemOrdinal, content: codexItemContent(item) });
        }
      }
      if (method === "item/completed") {
        const item = record(params.item);
        if (item.type === "userMessage" || completed.has(text(item.id))) return false;
        completed.add(text(item.id));
        const itemOrdinal = ordinals.get(text(item.id)) ?? ++ordinal;
        if (!ordinals.has(text(item.id))) { ordinals.set(text(item.id), itemOrdinal); emit({ type: "message.start", ordinal: itemOrdinal }); }
        items.set(text(item.id), item);
        const message: RuntimeMessage = { ordinal: itemOrdinal, content: codexItemContent(item), provider, model, stopReason: "stop" };
        emit({ type: "content.replace", ordinal: itemOrdinal, content: message.content });
        if (pending && pending.ordinal > itemOrdinal) emit({ type: "message.commit", message });
        else {
          if (pending && pending.ordinal !== itemOrdinal) emit({ type: "message.commit", message: pending });
          pending = message;
        }
      }
      if (method === "turn/completed") {
        const turn = record(params.turn);
        final = { ...latest(), provider, model, stopReason: turn.status === "interrupted" ? "aborted" : turn.status === "failed" ? "error" : "stop", errorMessage: text(record(turn.error).message) || null };
        return true;
      }
      return false;
    },
  };
}

type PreviewMessage = { content: ContentBlock[]; provider: string | null; model: string | null };
/** Where progress goes; `null` while the Turn is not yet recorded, so nothing can be sent yet. */
export type ProgressSink = (progress: NativeTurnProgress) => Promise<unknown> | null;

/**
 * Revisions only grow, across every preview of this process: the server keeps the highest one, so a
 * preview restarted within the same millisecond, or after the clock stepped back, still lands.
 */
let lastRevision = 0;
const nextRevision = () => (lastRevision = Math.max(Date.now(), lastRevision + 1));

/**
 * The live preview of a Turn a terminal user runs: harness events folded into messages and sent as
 * ephemeral progress, at most once per interval and only from the first message that changed.
 */
export class LiveProgress {
  private messages: PreviewMessage[] = [];
  private dirtyFrom = Number.POSITIVE_INFINITY;
  private synced = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private disposed = false;

  constructor(private readonly sink: ProgressSink, private readonly intervalMs: number) {}

  apply(event: RuntimeExecutionEvent): void {
    const ordinal = event.type === "message.start" || event.type === "content.replace" || event.type === "text.delta" ? event.ordinal
      : event.type === "message.commit" || event.type === "turn.end" ? event.message.ordinal : null;
    if (ordinal === null) return;
    const target = this.at(ordinal);
    if (event.type === "content.replace") target.content = event.content;
    if (event.type === "message.commit" || event.type === "turn.end") Object.assign(target, { content: event.message.content, provider: event.message.provider ?? null, model: event.message.model ?? null });
    if (event.type === "text.delta") {
      const block = target.content[event.index];
      if (event.kind === "text") target.content[event.index] = block?.type === "text" ? { ...block, text: block.text + event.delta } : { type: "text", text: event.delta };
      else target.content[event.index] = block?.type === "thinking" ? { ...block, thinking: block.thinking + event.delta } : { type: "thinking", thinking: event.delta };
    }
    this.touched(ordinal);
  }

  replace(messages: PreviewMessage[]): void {
    const first = messages.findIndex((message, index) => JSON.stringify(message) !== JSON.stringify(this.messages[index]));
    if (first < 0 && messages.length === this.messages.length) return;
    this.messages = messages.map((message) => ({ ...message, content: [...message.content] }));
    this.touched(first < 0 ? messages.length : first);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private touched(ordinal: number): void {
    this.dirtyFrom = Math.min(this.dirtyFrom, ordinal);
    this.schedule();
  }

  private schedule(): void {
    if (this.disposed || this.inFlight) return;
    this.timer ??= setTimeout(() => { this.timer = null; this.flush(); }, this.intervalMs);
    this.timer.unref?.();
  }

  private flush(): void {
    if (this.disposed || !Number.isFinite(this.dirtyFrom)) return;
    const from = this.synced ? Math.min(this.dirtyFrom, this.messages.length) : 0;
    const sent = this.sink({ revision: nextRevision(), from, messages: this.messages.slice(from) });
    // Not yet recorded: stay dirty, the next event tries again.
    if (!sent) return;
    this.dirtyFrom = Number.POSITIVE_INFINITY;
    this.synced = true;
    this.inFlight = true;
    void sent.then((result) => {
      const outcome = result as { accepted?: boolean; resync?: boolean } | undefined;
      if (outcome?.accepted === false || outcome?.resync) this.synced = false;
    }, () => { this.synced = false; }).finally(() => {
      this.inFlight = false;
      // Whatever changed meanwhile goes next; after a refusal, the next send is a full one.
      if (Number.isFinite(this.dirtyFrom)) this.schedule();
    });
  }

  private at(ordinal: number): PreviewMessage {
    for (let index = this.messages.length; index <= ordinal; index += 1) this.messages[index] = { content: [], provider: null, model: null };
    return this.messages[ordinal] as PreviewMessage;
  }
}
