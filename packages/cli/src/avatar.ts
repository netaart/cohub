import { readFile } from "node:fs/promises";
import type { CohubHttpClient, PublicAssetPurpose } from "@neta-art/cohub";

const loadSharp = async () => (await import("sharp")).default;

const AVATAR_SIZE = 1024;
const AVATAR_QUALITY = 86;

type PreparedAvatar = {
  body: Buffer;
  mimeType: "image/webp" | "image/jpeg" | "image/png" | "image/gif";
  extension: "webp" | "jpg" | "png" | "gif";
};

const detectAvatarFormat = (body: Buffer): Omit<PreparedAvatar, "body"> | null => {
  if (body.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return { mimeType: "image/jpeg", extension: "jpg" };
  }
  if (body.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return { mimeType: "image/png", extension: "png" };
  }
  if (body.subarray(0, 6).toString("ascii") === "GIF87a" || body.subarray(0, 6).toString("ascii") === "GIF89a") {
    return { mimeType: "image/gif", extension: "gif" };
  }
  if (body.subarray(0, 4).toString("ascii") === "RIFF" && body.subarray(8, 12).toString("ascii") === "WEBP") {
    return { mimeType: "image/webp", extension: "webp" };
  }
  return null;
};

export async function normalizeAvatarFile(path: string): Promise<PreparedAvatar> {
  const original = await readFile(path);
  const originalFormat = detectAvatarFormat(original);
  if (!originalFormat) throw new Error("Avatar must be a JPEG, PNG, GIF, or WebP image");
  if (originalFormat.mimeType === "image/gif") return { body: original, ...originalFormat };

  try {
    const sharp = await loadSharp();
    const body = await sharp(original)
      .rotate()
      .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover", position: "centre" })
      .webp({ quality: AVATAR_QUALITY })
      .toBuffer();
    return { body, mimeType: "image/webp", extension: "webp" };
  } catch {
    return { body: original, ...originalFormat };
  }
}

export async function uploadAvatarAsset(input: {
  client: CohubHttpClient;
  purpose: PublicAssetPurpose;
  path: string;
  spaceId?: string;
}) {
  const avatar = await normalizeAvatarFile(input.path);
  return input.client.publicAssets.upload({
    purpose: input.purpose,
    spaceId: input.spaceId,
    file: new Blob([new Uint8Array(avatar.body)], { type: avatar.mimeType }),
    mimeType: avatar.mimeType,
    filename: `avatar.${avatar.extension}`,
  });
}

const CHAT_IMAGE_MAX_EDGE = 1984;
const CHAT_IMAGE_QUALITY = 86;

export async function normalizeChatImageFile(path: string): Promise<Buffer> {
  const sharp = await loadSharp();
  return sharp(path)
    .rotate()
    .resize(CHAT_IMAGE_MAX_EDGE, CHAT_IMAGE_MAX_EDGE, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: CHAT_IMAGE_QUALITY })
    .toBuffer();
}

export async function uploadChatImageAsset(input: {
  client: CohubHttpClient;
  spaceId?: string;
  sessionId?: string;
  path: string;
}) {
  const body = await normalizeChatImageFile(input.path);
  const asset = await input.client.publicAssets.uploadChatImageAttachment({
    spaceId: input.spaceId,
    sessionId: input.sessionId,
    file: new Blob([new Uint8Array(body)], { type: "image/webp" }),
    mimeType: "image/webp",
    filename: "image.webp",
  });
  return { ...asset, size: body.byteLength };
}
