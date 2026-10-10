import { createHash } from "node:crypto";
import sharp from "sharp";

export const IMAGE_MAX_EDGE = 1984;
export const IMAGE_MAX_INPUT_BYTES = 32 * 1024 * 1024;
export const IMAGE_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const IMAGE_MAX_INPUT_PIXELS = 64_000_000;

export type ImageProfile = { maxEdge: number; quality: number };

export const STORED_IMAGE: ImageProfile = { maxEdge: IMAGE_MAX_EDGE, quality: 86 };

const FALLBACK_EDGES = [1600, 1280, 1024];
const QUALITY_STEP = 8;

const encodeAttempts = ({ maxEdge, quality }: ImageProfile) =>
  [maxEdge, ...FALLBACK_EDGES.filter((edge) => edge < maxEdge)].flatMap((edge, index) =>
    [0, 1].map((step) => ({ edge, quality: quality - QUALITY_STEP * (index + step) })));

const PASSTHROUGH_FORMATS: Record<string, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

const KEPT_FORMATS = new Set(["webp", "gif"]);

export type NormalizedImage = {
  data: Buffer;
  mimeType: string;
  changed: boolean;
  width: number | null;
  height: number | null;
  original: {
    mimeType: string | null;
    size: number;
    width: number | null;
    height: number | null;
    sha256: string;
  };
};

export async function normalizeImage(data: Buffer, mimeType?: string | null, profile: ImageProfile = STORED_IMAGE): Promise<NormalizedImage> {
  if (data.byteLength === 0) throw new Error("Image is empty");
  if (data.byteLength > IMAGE_MAX_INPUT_BYTES) throw new Error(`Image exceeds ${IMAGE_MAX_INPUT_BYTES} bytes`);

  const options = { animated: false, limitInputPixels: IMAGE_MAX_INPUT_PIXELS } as const;
  const metadata = await sharp(data, options).metadata();
  const passthroughMimeType = metadata.format ? PASSTHROUGH_FORMATS[metadata.format] : undefined;
  const original = {
    mimeType: passthroughMimeType ?? (metadata.format ? `image/${metadata.format}` : mimeType ?? null),
    size: data.byteLength,
    width: metadata.width ?? null,
    height: metadata.height ?? null,
    sha256: createHash("sha256").update(data).digest("hex"),
  };

  const upright = !metadata.orientation || metadata.orientation === 1;
  const fits = (metadata.width ?? Infinity) <= profile.maxEdge && (metadata.height ?? Infinity) <= profile.maxEdge;
  const passthrough: NormalizedImage | null = passthroughMimeType && upright && fits && data.byteLength <= IMAGE_MAX_OUTPUT_BYTES
    ? { data, mimeType: passthroughMimeType, changed: false, width: original.width, height: original.height, original }
    : null;
  if (passthrough && KEPT_FORMATS.has(metadata.format)) return passthrough;

  for (const attempt of encodeAttempts(profile)) {
    const output = await sharp(data, options)
      .rotate()
      .resize(attempt.edge, attempt.edge, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: attempt.quality })
      .toBuffer({ resolveWithObject: true });
    if (passthrough && output.data.byteLength >= data.byteLength) return passthrough;
    if (output.data.byteLength <= IMAGE_MAX_OUTPUT_BYTES) {
      return { data: output.data, mimeType: "image/webp", changed: true, width: output.info.width, height: output.info.height, original };
    }
  }
  throw new Error(`Image does not fit ${IMAGE_MAX_OUTPUT_BYTES} bytes after compression`);
}
