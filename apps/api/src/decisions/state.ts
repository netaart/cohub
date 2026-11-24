import { fetchRemoteImage } from "@cohub/infra/safe-fetch";
import { normalizeImage, normalizeJevImage } from "@cohub/media";
import type { DecisionState, DecisionStateImage } from "@cohub/protocol";
import { mapWithConcurrency } from "../lib/concurrency.js";
import { RequestError } from "../lib/request-error.js";

const IMAGE_CONCURRENCY = 4;
const IMAGE_TIMEOUT_MS = 15_000;
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const UPSTREAM_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const JEV_MODELS = new Set(["jev-latest", "~typesafe/jev-latest", "typesafe/jev-1.13", "typesafe/jev-1.14"]);

type UpstreamImage = { type: "image_url"; image_url: { url: string } };
export type UpstreamDecisionState = string | Record<string, unknown> | Array<string | UpstreamImage>;

const imageUrlOf = (part: DecisionStateImage) =>
  typeof part.image_url === "string" ? part.image_url : part.image_url.url;

export const countStateImages = (state: DecisionState) =>
  Array.isArray(state) ? state.filter((part) => typeof part !== "string").length : 0;

// The upstream Decisions API requires inline data URLs.
export async function prepareDecisionState(
  state: DecisionState,
  options: { model: string; signal?: AbortSignal },
): Promise<UpstreamDecisionState> {
  if (!Array.isArray(state)) return state;
  return mapWithConcurrency(state, IMAGE_CONCURRENCY, async (part) => {
    if (typeof part === "string") return part;
    const url = imageUrlOf(part);
    const jev = JEV_MODELS.has(options.model);
    if (url.startsWith("data:") && !jev) return { type: "image_url" as const, image_url: { url } };
    return { type: "image_url" as const, image_url: { url: await inlineImage(url, jev, options.signal) } };
  });
}

async function inlineImage(url: string, jev: boolean, signal?: AbortSignal): Promise<string> {
  const inline = url.startsWith("data:");
  if (!inline && !/^https?:\/\//i.test(url)) {
    throw new RequestError(400, "invalid_decision_request", "Image URLs must be https or data URLs.", { url });
  }
  let image: { data: Buffer; mimeType: string };
  try {
    if (inline) {
      const response = await fetch(url, { signal });
      image = await normalizeJevImage(Buffer.from(await response.arrayBuffer()));
    } else {
      const remote = await fetchRemoteImage({ url, maxBytes: IMAGE_MAX_BYTES, timeoutMs: IMAGE_TIMEOUT_MS, signal });
      image = jev ? await normalizeJevImage(remote.data) : await normalizeImage(remote.data, remote.mimeType);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new RequestError(400, "decision_image_unavailable", `Image could not be loaded: ${reason}`, inline ? undefined : { url });
  }
  if (!UPSTREAM_IMAGE_TYPES.has(image.mimeType)) {
    throw new RequestError(400, "decision_image_unsupported", `Unsupported image type ${image.mimeType}; use PNG, JPEG or WebP.`, { url });
  }
  return `data:${image.mimeType};base64,${image.data.toString("base64")}`;
}
