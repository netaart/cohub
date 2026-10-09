import { UPLOAD_MAX_FILE_BYTES } from "@cohub/protocol";
import { WeChatMessageItemType, type WeChatCdnMedia, type WeChatMessageItem } from "../types.js";
import { downloadWeChatCdnFile } from "./cdn.js";

export const WECHAT_INBOUND_FILE_MAX_BYTES = UPLOAD_MAX_FILE_BYTES;
export const WECHAT_INBOUND_FILE_MAX_COUNT = 8;

const extensionMimeTypes: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  silk: "audio/silk",
  zip: "application/zip",
};

function sanitizeFilename(value: string | undefined, fallback = "wechat-file") {
  const invalidChars = new Set(["<", ">", ":", "\"", "/", "\\", "|", "?", "*"]);
  const cleaned = Array.from(value || fallback)
    .map((char) => invalidChars.has(char) || char.charCodeAt(0) <= 0x1f ? "_" : char)
    .join("")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 180);
  return cleaned || fallback;
}

function inferMimeType(filename: string, fallback = "application/octet-stream") {
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  return extensionMimeTypes[extension] ?? fallback;
}

function attachmentFromItem(item: WeChatMessageItem): { media?: WeChatCdnMedia; filename: string; mimeType: string } | null {
  if (item.type === WeChatMessageItemType.FILE) {
    const filename = sanitizeFilename(item.file_item?.file_name, "wechat-file");
    return { media: item.file_item?.media, filename, mimeType: inferMimeType(filename) };
  }

  if (item.type === WeChatMessageItemType.VIDEO) {
    const filename = sanitizeFilename(`wechat-video-${item.msg_id ?? Date.now()}.mp4`, "wechat-video.mp4");
    return { media: item.video_item?.media, filename, mimeType: "video/mp4" };
  }

  if (item.type === WeChatMessageItemType.VOICE) {
    const extension = item.voice_item?.encode_type === 7 ? "mp3" : item.voice_item?.encode_type === 8 ? "ogg" : "silk";
    const filename = sanitizeFilename(`wechat-voice-${item.msg_id ?? Date.now()}.${extension}`, `wechat-voice.${extension}`);
    return { media: item.voice_item?.media, filename, mimeType: inferMimeType(filename, "audio/silk") };
  }

  return null;
}

export async function downloadAttachmentItem(params: {
  item: WeChatMessageItem;
  cdnBaseUrl: string;
  channelId: string;
  externalMessageId: string;
}) {
  const attachment = attachmentFromItem(params.item);
  const media = attachment?.media;
  if (!attachment || (!media?.encrypt_query_param && !media?.full_url) || !media?.aes_key) return null;

  const file = await downloadWeChatCdnFile({
    cdnBaseUrl: params.cdnBaseUrl,
    encryptedQueryParam: media.encrypt_query_param,
    fullUrl: media.full_url,
    aesKeyBase64: media.aes_key,
    maxBytes: WECHAT_INBOUND_FILE_MAX_BYTES,
    label: `wechat:${params.channelId}:${params.externalMessageId}:attachment`,
  });
  return {
    filePath: file.path,
    size: file.size,
    cleanup: file.cleanup,
    filename: attachment.filename,
    relativePath: attachment.filename,
    mediaType: attachment.mimeType,
  };
}
