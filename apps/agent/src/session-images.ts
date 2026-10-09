import { normalizeImage, type NormalizedImage } from "@cohub/media";
import { IMAGE_UNAVAILABLE_TEXT, imageUrlContent, type PiImageContent } from "@cohub/protocol/core";
import { createSessionImageUpload } from "./api.js";
import { logger } from "./logger.js";
import { getCurrentSessionExecutionAuth } from "./runtime/session-execution-auth.js";
import { getCurrentToolExecutionContext } from "./tool-context.js";

type ToolImageContent = PiImageContent | { type: "text"; text: string };

async function hostSessionImage(image: NormalizedImage) {
  const context = getCurrentToolExecutionContext();
  if (!context?.turnId) throw new Error("Session image needs a turn context");
  const executionToken = context.executionToken ?? getCurrentSessionExecutionAuth(context.sessionId, context.turnId)?.executionToken;
  if (!executionToken) throw new Error("Session image needs an execution token");
  const asset = await createSessionImageUpload({
    executionToken,
    spaceId: context.spaceId,
    sessionId: context.sessionId,
    size: image.data.byteLength,
    mimeType: image.mimeType,
  });
  const response = await fetch(asset.uploadUrl, { method: "PUT", headers: asset.uploadHeaders, body: new Uint8Array(image.data), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Session image upload failed ${response.status}`);
  return asset.publicUrl;
}

export async function prepareToolImage(input: { data: Buffer; mimeType: string; label?: string }): Promise<ToolImageContent> {
  const image = await normalizeImage(input.data, input.mimeType).catch((error: unknown) => {
    logger.warn(`[ToolImage] failed to process image label=${input.label ?? "unknown"}:`, error);
    return null;
  });
  if (!image) return { type: "text", text: IMAGE_UNAVAILABLE_TEXT };
  const url = await hostSessionImage(image).catch((error: unknown) => {
    logger.warn(`[ToolImage] hosting failed; sending inline label=${input.label ?? "unknown"}:`, error);
    return null;
  });
  return url ? imageUrlContent(url) : { type: "image", data: image.data.toString("base64"), mimeType: image.mimeType };
}
