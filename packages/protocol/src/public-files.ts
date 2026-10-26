import type { MultipartUploadPlan, UploadProtocol, UploadStrategy } from "./upload.js";
import type { MediaFacts } from "./core/media.js";

export type PublicFileUploadEntryInput = {
  id: string;
  relativePath: string;
  size: number;
  mimeType?: string | null;
  media?: MediaFacts;
};

export type PublicFileCreateUploadInput = {
  uploadProtocol?: UploadProtocol;
  upload?: Partial<UploadStrategy>;
  uploadRequestId?: string;
  entries: PublicFileUploadEntryInput[];
  overwrite?: boolean;
};

export type PublicFileUploadPlanEntry = {
  multipart?: MultipartUploadPlan;
  id: string;
  path: string;
  uploadUrl: string;
  publicUrl: string;
  headers?: Record<string, string>;
};

export type PublicFileCreateUploadResponse = {
  entries: PublicFileUploadPlanEntry[];
};

export type PublicFileListEntry = {
  path: string;
  name: string;
  kind: "file" | "directory";
  size: number | null;
  updatedAt: string | null;
  publicUrl: string | null;
};

export type PublicFileListResponse = {
  path: string;
  entries: PublicFileListEntry[];
  nextCursor: string | null;
};

export type PublicFileUrlResponse = {
  path: string;
  url: string;
};
