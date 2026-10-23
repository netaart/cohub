import type { BoardNodeRenderer } from "@neta-art/cohub/board/export/node";

export const BOARD_EXPORT_IMAGE_MEMORY_MIB = 256;

export class BoardExportResourceError extends Error {}

export type BoardExportDecodeImage = (bytes: Uint8Array, mimeType?: string, maxEdge?: number) => ReturnType<BoardNodeRenderer["decodeImage"]>;

/** Decodes within `maxBytes`, first scaling images down to `maxEdge` on their long edge. */
export function createBoardExportImageBudget(renderer: BoardNodeRenderer, maxBytes: number) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Image memory budget must be a positive integer.");
  let usedBytes = 0;
  const decodeImage: BoardExportDecodeImage = async (input, mimeType, maxEdge = Number.POSITIVE_INFINITY) => {
    const { default: sharp } = await import("sharp");
    let bytes = input;
    let { width, height } = await sharp(bytes, { limitInputPixels: false }).metadata();
    if (Math.max(width ?? 0, height ?? 0) > maxEdge) {
      const resized = await sharp(bytes, { limitInputPixels: false })
        .resize({ width: maxEdge, height: maxEdge, fit: "inside" })
        .png({ compressionLevel: 0 })
        .toBuffer({ resolveWithObject: true });
      ({ width, height } = resized.info);
      bytes = new Uint8Array(resized.data);
      mimeType = "image/png";
    }
    const required = (width ?? 0) * (height ?? 0) * 4;
    if (!Number.isSafeInteger(required) || required <= 0) throw new Error("Image dimensions could not be read.");
    if (required > maxBytes - usedBytes) {
      throw new BoardExportResourceError(
        `Image ${width}x${height} needs ${Math.ceil(required / 1024 ** 2)} MiB; ` +
        `${Math.ceil(usedBytes / 1024 ** 2)} MiB is already reserved against the ${Math.floor(maxBytes / 1024 ** 2)} MiB image budget. ` +
        "Use smaller source images, export a smaller region, or increase --image-memory if enough memory is available.",
      );
    }
    usedBytes += required;
    try {
      const texture = await renderer.decodeImage(bytes, mimeType);
      const destroy = texture.destroy.bind(texture);
      let released = false;
      texture.destroy = (destroySource) => {
        if (destroySource && !released) {
          released = true;
          usedBytes -= required;
        }
        destroy(destroySource);
      };
      return texture;
    } catch (error) {
      usedBytes -= required;
      throw error;
    }
  };
  return { decodeImage, get usedBytes() { return usedBytes; } };
}
