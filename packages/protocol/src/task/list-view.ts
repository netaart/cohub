const INLINE_KEYS = ["data", "base64", "contentBase64"] as const;
const MEDIA_TYPES = new Set(["image", "video", "audio"]);

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

/** Drop inline payload strings, marking the holder so readers fetch the detail. */
function withoutInline(holder: JsonRecord): JsonRecord {
  if (!INLINE_KEYS.some((key) => typeof holder[key] === "string" && holder[key])) return holder;
  const next: JsonRecord = { ...holder, deferredBase64: true };
  for (const key of INLINE_KEYS) {
    if (typeof next[key] === "string" && next[key]) delete next[key];
  }
  return next;
}

function stripBlock(value: unknown): unknown {
  const block = record(value);
  if (!block || !MEDIA_TYPES.has(block.type as string)) return value;
  const next = withoutInline(block);
  const source = record(next.source);
  const nextSource = source ? withoutInline(source) : null;
  if (next === block && nextSource === source) return value;
  return nextSource && nextSource !== source ? { ...next, source: nextSource } : next;
}

/** Media blocks without inline base64; the same array when nothing changes. */
export function stripInlineMedia(blocks: unknown): unknown {
  if (!Array.isArray(blocks)) return blocks;
  const next = blocks.map(stripBlock);
  return next.some((block, index) => block !== blocks[index]) ? next : blocks;
}

function stripAt(root: unknown, key: string): unknown {
  const holder = record(root);
  if (!holder) return root;
  const value = stripInlineMedia(holder[key]);
  return value === holder[key] ? root : { ...holder, [key]: value };
}

/** Generation payloads keep their input blocks at `data.content` (or `content`). */
function stripPayload(payload: unknown): unknown {
  const root = record(payload);
  const data = record(root?.data);
  if (!root || !data) return stripAt(payload, "content");
  const next = stripAt(data, "content");
  return next === data ? payload : { ...root, data: next };
}

/**
 * List views never carry inline media: generation inputs and outputs keep URLs
 * and gain `deferredBase64` markers. The detail endpoint returns the full run.
 */
export function sanitizeTaskRunForList<T extends { taskType: string; payload: unknown; result: unknown }>(run: T): T {
  if (run.taskType !== "generation") return run;
  const payload = stripPayload(run.payload);
  const result = stripAt(run.result, "output");
  return payload === run.payload && result === run.result ? run : { ...run, payload, result };
}
