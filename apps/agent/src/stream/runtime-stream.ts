import type { ContentBlock } from "@cohub/protocol/core";
import type { RuntimeExecutionEvent } from "@cohub/protocol";
import type { SessionStreamEvent } from "@cohub/protocol/realtime";

/** Both cloud and local use sendOutput for snapshots, patches and SDK stream identity. */
export function createRuntimeStream(
  identity: { spaceId: string; sessionId: string; turnId: string; userMessageId: string },
  publish: (event: SessionStreamEvent) => Promise<void>,
  onError: (error: unknown) => void = () => {},
) {
  const messages = new Map<number, { sequence: number; blocks: Map<number, ContentBlock>; dirty: boolean; replace: boolean; resync: boolean }>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain = Promise.resolve();
  function flush() {
    if (timer) clearTimeout(timer);
    timer = null;
    for (const [ordinal, message] of messages) {
      if (!message.dirty) continue;
      message.dirty = false;
      const content = [...message.blocks].sort(([a], [b]) => a - b).map(([, block]) => block);
      const replace = message.replace;
      message.replace = false;
      chain = chain.then(async () => {
        const sequence = ++message.sequence;
        const event: SessionStreamEvent = {
          type: "stream_update", ...identity,
          messageId: `turn:${identity.turnId}:assistant:${ordinal}`, messageOrdinal: ordinal,
          seq: sequence, baseSeq: message.resync ? 0 : sequence - 1, sourceMessageId: identity.userMessageId,
          anchorUserMessageId: identity.userMessageId, content, snapshotContent: content, replaceContent: replace || message.resync, timestamp: Date.now(),
        };
        try {
          await publish(event);
          message.resync = false;
        } catch (error) {
          // Delivery can fail after publishing. Advance sequence; retry as a full keyframe.
          message.resync = true;
          message.dirty = true;
          try { onError(error); } catch { /* Diagnostics cannot block durable results. */ }
        }
      });
    }
    return chain;
  }
  function apply(event: RuntimeExecutionEvent) {
    if (event.type === "message.start") {
      if (!messages.has(event.ordinal)) messages.set(event.ordinal, { sequence: 0, blocks: new Map(), dirty: false, replace: false, resync: false });
      return;
    }
    if (event.type !== "text.delta" && event.type !== "content.replace") return;
    const message = messages.get(event.ordinal);
    if (!message) throw new Error("Runtime stream message was not started");
    if (event.type === "text.delta") {
      const previous = message.blocks.get(event.index);
      if (!event.delta && previous?.type === (event.kind === "text" ? "text" : "thinking")) return;
      const text = previous?.type === "text" ? previous.text : previous?.type === "thinking" ? previous.thinking : "";
      const block: ContentBlock = event.kind === "text"
        ? { type: "text", text: text + event.delta, _meta: { streamIndex: event.index } }
        : { type: "thinking", thinking: text + event.delta, _meta: { streamIndex: event.index } };
      message.blocks.set(event.index, block);
    } else {
      message.replace = true;
      message.blocks = new Map(event.content.map((block, index) => [index, { ...block, _meta: { ...block._meta, streamIndex: index } }]));
    }
    message.dirty = true;
    timer ??= setTimeout(() => { void flush(); }, 40);
  }
  return { apply, flush, async commit(ordinal: number) { await flush(); messages.delete(ordinal); }, dispose() { if (timer) clearTimeout(timer); timer = null; messages.clear(); } };
}
