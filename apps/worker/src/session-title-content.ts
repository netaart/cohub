import { imageBlockToPi, type ContentBlock } from "@cohub/protocol/core";
import type { ImageContent } from "@earendil-works/pi-ai";

export type SessionTitleInputPart = { type: "text"; text: string } | ImageContent;

export function unwrapGenerationRequest(content: ContentBlock[]): ContentBlock[] {
  const text = content.find((block) => block.type === "text")?.text;
  if (!text) return content;
  try {
    const parsed = JSON.parse(text) as { type?: unknown; content?: unknown };
    return parsed.type === "generation.request" && Array.isArray(parsed.content)
      ? parsed.content as ContentBlock[]
      : content;
  } catch {
    return content;
  }
}

export function buildSessionTitleContent(content: ContentBlock[], includeImages: boolean) {
  const source = unwrapGenerationRequest(content);
  const parts: SessionTitleInputPart[] = [];
  for (const block of source) {
    if (block.type === "text" && block.text.trim()) {
      parts.push({ type: "text", text: block.text });
    } else if (includeImages && block.type === "image") {
      const image = imageBlockToPi(block);
      if (image) parts.push(image);
    }
  }
  return {
    parts,
    hasImages: source.some((block) => block.type === "image"),
  };
}
