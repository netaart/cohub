import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import type { UploadSource } from "@neta-art/cohub";

export async function localUploadSource(filePath: string, size: number): Promise<UploadSource> {
  filePath = await realpath(filePath);
  const original = await lstat(filePath);
  const unchanged = (current: typeof original) =>
    current.isFile() && current.dev === original.dev && current.ino === original.ino &&
    current.size === size && current.mtimeMs === original.mtimeMs && current.ctimeMs === original.ctimeMs;
  const assertUnchanged = (current: typeof original) => {
    if (!unchanged(current)) throw new Error(`File changed during upload: ${filePath}`);
  };
  assertUnchanged(original);
  return {
    size,
    validate: async () => assertUnchanged(await lstat(filePath)),
    async slice(start, end) {
      const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        assertUnchanged(await file.stat());
        const bytes = new Uint8Array(end - start);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, start + offset);
          if (!bytesRead) throw new Error(`File changed during upload: ${filePath}`);
          offset += bytesRead;
        }
        assertUnchanged(await file.stat());
        assertUnchanged(await lstat(filePath));
        return new Blob([bytes]);
      } finally {
        await file.close();
      }
    },
  };
}
