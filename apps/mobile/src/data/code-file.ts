import type { SpaceFsFileResponse } from "@neta-art/cohub";

/** Editing happens in a single native TextInput, so very large files stay read-only. */
export const MAX_EDITABLE_CODE_BYTES = 512 * 1024;

export function isEditableTextFile(file: SpaceFsFileResponse | null | undefined): boolean {
  if (!file) return false;
  return file.kind === "text" &&
    file.encoding === "utf-8" &&
    file.delivery !== "url" &&
    file.size <= MAX_EDITABLE_CODE_BYTES;
}

/** Classify a failed optimistic save against the content it started from. */
export function classifySaveConflict(
  fresh: SpaceFsFileResponse | null | undefined,
  baseContent: string,
  attemptedContent: string,
): "already-saved" | "retry" | "conflict" {
  if (!fresh || fresh.kind !== "text" || fresh.delivery === "url") return "conflict";
  if (fresh.content === attemptedContent) return "already-saved";
  if (fresh.content === baseContent) return "retry";
  return "conflict";
}

export function isFileConflictError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { status?: unknown; code?: unknown };
  return candidate.status === 409 || candidate.code === "file_conflict";
}
