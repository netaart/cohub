import { createImageUploadPlan } from "./api.js";
import { publicAssetObjectKeyFromUrl } from "./public-asset-storage.js";
import { getCurrentToolExecutionContext } from "./tool-context.js";

export async function uploadPublicAssetImage(image: { data: Buffer; mimeType: string }, userId?: string | null, signal?: AbortSignal): Promise<string> {
  const context = getCurrentToolExecutionContext();
  const owner = userId?.trim() || context?.actorUserId?.trim();
  if (!owner) throw new Error("Image upload requires an authenticated user");
  const turnSignal = signal ?? context?.abortSignal;
  turnSignal?.throwIfAborted();
  const timeout = AbortSignal.timeout(10_000);
  const uploadSignal = turnSignal ? AbortSignal.any([turnSignal, timeout]) : timeout;
  const { asset } = await createImageUploadPlan({ userId: owner, file: { size: image.data.byteLength, mimeType: image.mimeType } }, uploadSignal);
  if (!publicAssetObjectKeyFromUrl(asset.publicUrl) || asset.uploadMethod !== "PUT" || new URL(asset.uploadUrl).protocol !== "https:") {
    throw new Error("Invalid image upload plan");
  }
  const response = await fetch(asset.uploadUrl, {
    method: "PUT", headers: asset.uploadHeaders, body: new Uint8Array(image.data), redirect: "error", signal: uploadSignal,
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`Image upload failed ${response.status}`);
  turnSignal?.throwIfAborted();
  return asset.publicUrl;
}
