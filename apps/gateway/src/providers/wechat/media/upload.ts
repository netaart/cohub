import crypto from "node:crypto";
import { UPLOAD_MAX_FILE_BYTES } from "@cohub/protocol";
import type { GatewayMediaItem } from "@cohub/protocol/gateway";
import {
  base64ToTempMediaFile,
  hashTempMediaFile,
  readTempMediaHead,
  responseToTempMediaFile,
} from "../../../media/temp-media-file.js";
import { getWeChatUploadUrl } from "../api.js";
import { WeChatMessageItemType, WeChatUploadMediaType, type WeChatMessageItem } from "../types.js";
import { uploadWeChatCdnFile } from "./cdn.js";
import { aesEcbPaddedSize } from "./crypto.js";
import { detectImageMimeType } from "./mime.js";
import { safeFetch } from "./url.js";

export const WECHAT_OUTBOUND_ATTACHMENT_MAX_BYTES = UPLOAD_MAX_FILE_BYTES;
const LARGE_MEDIA_TIMEOUT_MS = 10 * 60 * 1000;

const mediaUploadType = (kind: GatewayMediaItem["kind"]) => {
  if (kind === "image") return WeChatUploadMediaType.IMAGE;
  if (kind === "video") return WeChatUploadMediaType.VIDEO;
  if (kind === "voice") return WeChatUploadMediaType.VOICE;
  return WeChatUploadMediaType.FILE;
};

const messageItemType = (kind: GatewayMediaItem["kind"]) => {
  if (kind === "image") return WeChatMessageItemType.IMAGE;
  if (kind === "video") return WeChatMessageItemType.VIDEO;
  if (kind === "voice") return WeChatMessageItemType.VOICE;
  return WeChatMessageItemType.FILE;
};

const sanitizeFilename = (value: string | undefined, fallback: string) => {
  const invalidChars = new Set(["<", ">", ":", "\"", "/", "\\", "|", "?", "*"]);
  const cleaned = Array.from(value || fallback)
    .map((char) => invalidChars.has(char) || char.charCodeAt(0) <= 0x1f ? "_" : char)
    .join("")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 180);
  return cleaned || fallback;
};

async function fetchMediaSource(source: GatewayMediaItem["source"]) {
  if (source.type === "base64") {
    return base64ToTempMediaFile(source.data, WECHAT_OUTBOUND_ATTACHMENT_MAX_BYTES, "wechat-outbound-base64");
  }

  const response = await safeFetch({
    url: source.url,
    label: "wechat outbound media",
    timeoutMs: LARGE_MEDIA_TIMEOUT_MS,
  });
  if (!response.ok) throw new Error(`WeChat outbound media download failed ${response.status}`);
  return responseToTempMediaFile(response, WECHAT_OUTBOUND_ATTACHMENT_MAX_BYTES, "wechat-outbound-media");
}

export async function uploadWeChatMediaItem(params: {
  item: GatewayMediaItem;
  baseUrl: string;
  cdnBaseUrl: string;
  token: string;
  to: string;
}) {
  const file = await fetchMediaSource(params.item.source);
  try {
    if (file.size === 0) throw new Error("WeChat outbound media is empty");
    if (params.item.kind === "image" && !detectImageMimeType(await readTempMediaHead(file, 32))) {
      throw new Error("WeChat outbound image type is unsupported");
    }

    const filekey = crypto.randomBytes(16).toString("hex");
    const aesKey = crypto.randomBytes(16);
    const rawFileMd5 = await hashTempMediaFile(file, "md5");
    const encryptedSize = aesEcbPaddedSize(file.size);
    const uploadUrl = await getWeChatUploadUrl({
      baseUrl: params.baseUrl,
      token: params.token,
      filekey,
      mediaType: mediaUploadType(params.item.kind),
      toUserId: params.to,
      rawSize: file.size,
      rawFileMd5,
      fileSize: encryptedSize,
      aesKeyHex: aesKey.toString("hex"),
    });
    const uploaded = await uploadWeChatCdnFile({
      file,
      uploadFullUrl: uploadUrl.upload_full_url,
      uploadParam: uploadUrl.upload_param,
      filekey,
      cdnBaseUrl: params.cdnBaseUrl,
      aesKey,
      label: `wechat:${params.to}:${params.item.kind}-upload`,
    });
    const media = {
      encrypt_query_param: uploaded.downloadParam,
      aes_key: Buffer.from(aesKey.toString("hex")).toString("base64"),
      encrypt_type: 1,
    };

    if (params.item.kind === "image") {
      return { type: WeChatMessageItemType.IMAGE, image_item: { media, mid_size: uploaded.ciphertextSize } } satisfies WeChatMessageItem;
    }
    if (params.item.kind === "video") {
      return { type: WeChatMessageItemType.VIDEO, video_item: { media, video_size: file.size, video_md5: rawFileMd5 } } satisfies WeChatMessageItem;
    }
    if (params.item.kind === "voice") {
      return { type: WeChatMessageItemType.VOICE, voice_item: { media } } satisfies WeChatMessageItem;
    }

    return {
      type: messageItemType(params.item.kind),
      file_item: {
        media,
        file_name: sanitizeFilename(params.item.filename, "cohub-file"),
        md5: rawFileMd5,
        len: String(file.size),
      },
    } satisfies WeChatMessageItem;
  } finally {
    await file.cleanup();
  }
}
