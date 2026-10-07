import {
  IMAGE_URL_MIME_TYPE,
  parseBase64DataUrl,
  sniffBase64ImageMimeType,
  type ContentBlock,
  type ImageBlock,
} from "@cohub/protocol/core";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const cleanMeta = (value: unknown) => isRecord(value) ? value : undefined;

const readString = (record: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
};

const IMAGE_BLOCK_TYPES = new Set(["image", "image_url", "input_image"]);

const imageUrlOf = (block: Record<string, unknown>, source: Record<string, unknown> | null) => {
  if (source?.type === "url" && typeof source.url === "string") return source.url.trim();
  const imageUrl = block.image_url;
  if (typeof imageUrl === "string") return imageUrl.trim();
  if (isRecord(imageUrl) && typeof imageUrl.url === "string") return imageUrl.url.trim();
  if (block.mimeType === IMAGE_URL_MIME_TYPE && typeof block.data === "string") return block.data.trim();
  return readString(block, ["uri", "url"])?.trim() ?? "";
};

const base64Image = (data: string, declaredMediaType: string | null, meta: Record<string, unknown> | undefined): ImageBlock => {
  const dataUrl = parseBase64DataUrl(data);
  const payload = dataUrl?.data ?? data.trim();
  const declared = dataUrl?.mediaType ?? declaredMediaType?.trim().toLowerCase();
  const mediaType = declared && declared !== "application/octet-stream"
    ? declared
    : sniffBase64ImageMimeType(payload) ?? declared ?? "application/octet-stream";
  return { type: "image", source: { type: "base64", media_type: mediaType, data: payload }, ...(meta ? { _meta: meta } : {}) };
};

const normalizeImageBlock = (block: Record<string, unknown>): ImageBlock => {
  const source = isRecord(block.source) ? block.source : null;
  const meta = cleanMeta(block._meta);

  const url = imageUrlOf(block, source);
  if (url) {
    if (parseBase64DataUrl(url)) return base64Image(url, null, meta);
    if (!/^https?:\/\//i.test(url)) throw new Error("Invalid image content: image URLs must use HTTP(S)");
    return { type: "image", source: { type: "url", url }, ...(meta ? { _meta: meta } : {}) };
  }

  const record = source ?? block;
  const data = readString(record, source?.type === "base64" ? ["data"] : ["data", "base64", "contentBase64"]);
  if (data) return base64Image(data, readString(record, ["media_type", "mediaType", "mimeType"]), meta);

  throw new Error("Invalid image content: expected an image URL or base64 data");
};

export const normalizeContentBlockStrict = (block: ContentBlock | Record<string, unknown>): ContentBlock => {
  if (!isRecord(block) || typeof block.type !== "string") {
    throw new Error("Invalid content block: missing type");
  }

  if (IMAGE_BLOCK_TYPES.has(block.type)) return normalizeImageBlock(block);
  if (block.type === "input_text" && typeof block.text === "string") {
    const meta = cleanMeta(block._meta);
    return { type: "text", text: block.text, ...(meta ? { _meta: meta } : {}) };
  }

  if (block.type === "tool_result" && Array.isArray(block.content)) {
    return {
      ...(block as Extract<ContentBlock, { type: "tool_result" }>),
      content: normalizeContentBlocksStrict(block.content as Array<ContentBlock | Record<string, unknown>>),
    };
  }

  // This normalizer intentionally only canonicalizes image aliases and nested
  // tool_result content. Full protocol validation lives at API/schema edges.
  return block as ContentBlock;
};

export const normalizeContentBlocksStrict = (blocks: Array<ContentBlock | Record<string, unknown>>): ContentBlock[] =>
  blocks.map((block) => normalizeContentBlockStrict(block));

export type NormalizeContentBlockIssue = {
  message: string;
  block: unknown;
};

export type NormalizeContentBlockSafeOptions = {
  onInvalid?: (issue: NormalizeContentBlockIssue) => void;
};

const reportInvalid = (options: NormalizeContentBlockSafeOptions | undefined, issue: NormalizeContentBlockIssue) => {
  options?.onInvalid?.(issue);
};

export const normalizeContentBlockSafe = (
  block: ContentBlock | Record<string, unknown> | unknown,
  options?: NormalizeContentBlockSafeOptions,
): ContentBlock | null => {
  try {
    return normalizeContentBlockStrict(block as ContentBlock | Record<string, unknown>);
  } catch (error) {
    reportInvalid(options, {
      message: error instanceof Error ? error.message : String(error),
      block,
    });
    return null;
  }
};

export const normalizeContentBlocksSafe = (
  blocks: unknown[],
  options?: NormalizeContentBlockSafeOptions,
): ContentBlock[] => blocks
  .map((block) => normalizeContentBlockSafe(block, options))
  .filter((block): block is ContentBlock => Boolean(block));

export const normalizeContentBlock = normalizeContentBlockStrict;
export const normalizeContentBlocks = normalizeContentBlocksStrict;
