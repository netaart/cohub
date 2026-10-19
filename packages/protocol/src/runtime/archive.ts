import { z } from "zod";
import { LOCAL_HARNESS_SPECS, LOCAL_HARNESSES, localHarnessSchema } from "./harnesses.js";

const nativeFormats = LOCAL_HARNESSES.map((harness) => LOCAL_HARNESS_SPECS[harness].nativeFormat) as [string, ...string[]];

export const RUNTIME_ARCHIVE_SEGMENT_BYTES = 4 * 1024 * 1024;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const runtimeArchiveSegmentSchema = z.object({
  offset: z.number().int().safe().nonnegative(),
  sizeBytes: z.number().int().min(1).max(RUNTIME_ARCHIVE_SEGMENT_BYTES),
  sha256: digest,
  md5: z.string().regex(/^[a-f0-9]{32}$/),
}).strict();
export const harnessArchiveSchema = z.object({
  sessionId: z.string().uuid(), turnId: z.string().uuid(), harness: localHarnessSchema,
}).strict();
export const harnessArchiveIndexSchema = harnessArchiveSchema.extend({
  version: z.literal(1), nativeFormat: z.enum(nativeFormats),
  nativeSessionId: z.string().min(1).max(255),
  parentTurnId: z.string().uuid().nullable(),
  sizeBytes: z.number().int().safe().positive(), sha256: digest,
  segments: z.array(runtimeArchiveSegmentSchema).max(256),
}).strict().refine((value) => value.nativeFormat === LOCAL_HARNESS_SPECS[value.harness].nativeFormat, "Native format mismatch");
export type HarnessArchive = z.infer<typeof harnessArchiveSchema>;
export type HarnessArchiveIndex = z.infer<typeof harnessArchiveIndexSchema>;
export type RuntimeArchiveSegment = z.infer<typeof runtimeArchiveSegmentSchema>;
export type RuntimeArchiveUpload = { segment: RuntimeArchiveSegment; uploadUrl: string; headers?: Record<string, string> };
export type RuntimeArchivePage = { index: HarnessArchiveIndex; segments: Array<{ segment: RuntimeArchiveSegment; downloadUrl: string }> };

export function validateArchiveBoundary(index: HarnessArchiveIndex, parent: HarnessArchiveIndex | null) {
  if (index.parentTurnId !== (parent?.turnId ?? null)) throw new Error("Archive parent mismatch");
  if (parent && (parent.sessionId !== index.sessionId || parent.harness !== index.harness || parent.nativeSessionId !== index.nativeSessionId)) throw new Error("Archive identity mismatch");
  let offset = parent?.sizeBytes ?? 0;
  for (const segment of index.segments) {
    if (segment.offset !== offset) throw new Error("Archive segments are not contiguous");
    offset += segment.sizeBytes;
  }
  if (offset !== index.sizeBytes || !parent && !index.segments.length) throw new Error("Archive is incomplete");
  if (!index.segments.length && parent?.sha256 !== index.sha256) throw new Error("Unchanged archive checksum mismatch");
}
