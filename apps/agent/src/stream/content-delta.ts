import type { ContentBlock } from "@cohub/protocol/core";

function getStreamIndex(block: ContentBlock): number | null {
  const value = block._meta?.streamIndex;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function buildBlockIdentity(block: ContentBlock, fallbackIndex: number): string {
  if (block.type === "tool_use") return `tool_use:${block.id}`;
  if (block.type === "tool_result") return `tool_result:${block.tool_use_id}`;
  const streamIndex = getStreamIndex(block);
  return `${block.type}:${streamIndex ?? fallbackIndex}`;
}

function shallowRecordEqual(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined) {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.hasOwn(b, key)) return false;
    const av = a[key];
    const bv = b[key];
    if (av === bv) continue;
    if (Array.isArray(av) || Array.isArray(bv)) return false;
    if (av && bv && typeof av === "object" && typeof bv === "object") return false;
    return false;
  }
  return true;
}

function contentEqual(a: unknown, b: unknown) {
  if (a === b) return true;
  if (typeof a === "string" || typeof b === "string") return a === b;
  // Tool results are usually strings. Keep rare structured results correct via a fallback.
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Compute the minimal delta between the current full content and the last-sent snapshot. */
export function computeDelta(full: ContentBlock[], last: ContentBlock[]): ContentBlock[] {
  const delta: ContentBlock[] = [];
  const lastByIdentity = new Map(last.map((block, index) => [buildBlockIdentity(block, index), block]));

  for (let index = 0; index < full.length; index += 1) {
    const block = full[index];
    if (!block) continue;
    const prev = lastByIdentity.get(buildBlockIdentity(block, index));

    if (block.type === "text") {
      const prevText = prev?.type === "text" ? prev.text : null;
      if (prevText == null) {
        delta.push(block);
      } else if (block.text.length > prevText.length) {
        const suffix = block.text.slice(prevText.length);
        if (suffix) {
          delta.push({
            type: "text",
            text: suffix,
            ...(block._meta ? { _meta: block._meta } : {}),
          });
        }
      }
    } else if (block.type === "thinking") {
      const prevThinking = prev?.type === "thinking" ? prev.thinking : null;
      if (prevThinking == null) {
        delta.push(block);
      } else if (block.thinking.length > prevThinking.length) {
        const suffix = block.thinking.slice(prevThinking.length);
        if (suffix) {
          delta.push({
            type: "thinking",
            thinking: suffix,
            ...(block.signature ? { signature: block.signature } : {}),
            ...(block._meta ? { _meta: block._meta } : {}),
          });
        }
      }
    } else if (block.type === "tool_use") {
      if (
        prev?.type !== "tool_use" ||
        !shallowRecordEqual(prev._meta, block._meta) ||
        !contentEqual(prev.input, block.input) ||
        prev.name !== block.name
      ) {
        delta.push(block);
      }
    } else if (block.type === "tool_result") {
      if (
        prev?.type !== "tool_result" ||
        !contentEqual(prev.content, block.content) ||
        prev.is_error !== block.is_error
      ) {
        delta.push(block);
      }
    } else {
      if (!prev || JSON.stringify(prev) !== JSON.stringify(block)) {
        delta.push(block);
      }
    }
  }

  return delta;
}
