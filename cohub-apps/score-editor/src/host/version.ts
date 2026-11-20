/** The version a Space file is known at; the SDK reports both halves on every read and write. */
export type FileVersion = { readonly mtimeMs: number; readonly size: number };

/** Versions are the host's opaque strings; `mtimeMs:size` is the pair the SDK gives and expects. */
export function versionString(version: FileVersion): string {
  return `${Math.trunc(version.mtimeMs)}:${version.size}`;
}

export function parseFileVersion(version: string): FileVersion | null {
  const match = /^(\d+):(\d+)$/.exec(version);
  if (!match) return null;
  const mtimeMs = Number(match[1]);
  const size = Number(match[2]);
  if (!Number.isSafeInteger(mtimeMs) || !Number.isSafeInteger(size)) return null;
  return { mtimeMs, size };
}
