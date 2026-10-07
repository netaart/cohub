import crypto from "node:crypto";
import type { ContentBlock } from "@cohub/protocol/core";
import { getWeChatUploadUrl } from "../api.js";
import { WeChatMessageItemType, WeChatUploadMediaType, type WeChatImageItem, type WeChatMessageItem } from "../types.js";
import { aesEcbPaddedSize } from "./crypto.js";
import { downloadWeChatCdnImage, uploadWeChatCdnBuffer } from "./cdn.js";
import { detectImageMimeType } from "./mime.js";
import { safeFetch } from "@cohub/infra/safe-fetch";

export const WECHAT_INBOUND_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const WECHAT_INBOUND_IMAGE_MAX_COUNT = 4;
export const WECHAT_OUTBOUND_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const BASE64_MAX_CHARS = Math.ceil(WECHAT_OUTBOUND_IMAGE_MAX_BYTES / 3) * 4 + 4;

function inboundImageAesKey(image: WeChatImageItem) {
  if (image.aeskey?.trim()) return Buffer.from(image.aeskey.trim(), "hex").toString("base64");
  return image.media?.aes_key?.trim() || undefined;
}

export async function downloadImageItem(params: {
  item: WeChatMessageItem;
  cdnBaseUrl: string;
  channelId: string;
  externalMessageId: string;
}) {
  const image = params.item.image_item;
  const media = image?.media;
  if (!image || (!media?.encrypt_query_param && !media?.full_url)) return null;

  const buffer = await downloadWeChatCdnImage({
    cdnBaseUrl: params.cdnBaseUrl,
    encryptedQueryParam: media.encrypt_query_param,
    fullUrl: media.full_url,
    aesKeyBase64: inboundImageAesKey(image),
    maxBytes: WECHAT_INBOUND_IMAGE_MAX_BYTES,
    label: `wechat:${params.channelId}:${params.externalMessageId}:image`,
  });
  const mediaType = detectImageMimeType(buffer);
  if (!mediaType) throw new Error("WeChat inbound image type is unsupported");
  return { buffer, mediaType, encryptedQueryParam: media.encrypt_query_param ?? null };
}

async function fetchImageSource(source: Extract<ContentBlock, { type: "image" }>["source"]) {
  if (source.type === "base64") {
    if (source.data.length > BASE64_MAX_CHARS) throw new Error(`WeChat outbound image exceeds ${WECHAT_OUTBOUND_IMAGE_MAX_BYTES} bytes`);
    return Buffer.from(source.data, "base64");
  }

  const response = await safeFetch({ url: source.url, label: "wechat outbound image" });
  if (!response.ok) throw new Error(`WeChat outbound image download failed ${response.status}`);
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > WECHAT_OUTBOUND_IMAGE_MAX_BYTES) throw new Error(`WeChat outbound image exceeds ${WECHAT_OUTBOUND_IMAGE_MAX_BYTES} bytes`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > WECHAT_OUTBOUND_IMAGE_MAX_BYTES) throw new Error(`WeChat outbound image exceeds ${WECHAT_OUTBOUND_IMAGE_MAX_BYTES} bytes`);
  return buffer;
}

export async function uploadImageContentBlock(params: {
  block: Extract<ContentBlock, { type: "image" }>;
  baseUrl: string;
  cdnBaseUrl: string;
  token: string;
  to: string;
}) {
  const buffer = await fetchImageSource(params.block.source);
  if (buffer.length === 0) throw new Error("WeChat outbound image is empty");
  if (buffer.length > WECHAT_OUTBOUND_IMAGE_MAX_BYTES) throw new Error(`WeChat outbound image exceeds ${WECHAT_OUTBOUND_IMAGE_MAX_BYTES} bytes`);
  if (!detectImageMimeType(buffer)) throw new Error("WeChat outbound image type is unsupported");

  const filekey = crypto.randomBytes(16).toString("hex");
  const aesKey = crypto.randomBytes(16);
  const rawFileMd5 = crypto.createHash("md5").update(buffer).digest("hex");
  const fileSize = aesEcbPaddedSize(buffer.length);

  const uploadUrl = await getWeChatUploadUrl({
    baseUrl: params.baseUrl,
    token: params.token,
    filekey,
    mediaType: WeChatUploadMediaType.IMAGE,
    toUserId: params.to,
    rawSize: buffer.length,
    rawFileMd5,
    fileSize,
    aesKeyHex: aesKey.toString("hex"),
  });

  const uploaded = await uploadWeChatCdnBuffer({
    buffer,
    uploadFullUrl: uploadUrl.upload_full_url,
    uploadParam: uploadUrl.upload_param,
    filekey,
    cdnBaseUrl: params.cdnBaseUrl,
    aesKey,
    label: `wechat:${params.to}:image-upload`,
  });

  return {
    type: WeChatMessageItemType.IMAGE,
    image_item: {
      media: {
        encrypt_query_param: uploaded.downloadParam,
        aes_key: Buffer.from(aesKey.toString("hex")).toString("base64"),
        encrypt_type: 1,
      },
      mid_size: uploaded.ciphertextSize,
    },
  } satisfies WeChatMessageItem;
}
