/** Family names are provider-owned strings. Keep only the active family as a
 * constant; new families should not require a protocol-package release. */
export const WORKSPACE_CANDIDATE_INDEX_FAMILY = "workspace.candidates";
export type SearchIndexFamily = string;
export type SearchDocumentType = string;

/** Stable identity shared by all search providers. `id` is a path for files and
 * an application UUID or durable key for database-backed resources. */
export type SearchDocumentRef = {
  type: SearchDocumentType;
  spaceId: string;
  id: string;
};

export type SearchMutationOperation = "upsert" | "delete";

/** Durable source change contract for asynchronous indexers. */
export type SearchMutation = {
  operation: SearchMutationOperation;
  family: SearchIndexFamily;
  document: SearchDocumentRef;
  /** Monotonic or content-derived source version used for idempotency. */
  revision: string;
  /** Optional durable cursor from the source stream or database outbox. */
  cursor?: string;
  fields?: SearchField[];
};

export type SearchField =
  | { name: string; type: "text" | "keyword"; value: string | string[] }
  | { name: string; type: "number"; value: number }
  | { name: string; type: "boolean"; value: boolean }
  | { name: string; type: "date"; value: string };

export type SearchIndexState = "building" | "ready" | "stale" | "error";
export type SearchIndexCoverage = "complete" | "partial" | "stale";

export type SearchIndexStatus = {
  family: SearchIndexFamily;
  generation: string;
  schemaVersion: number;
  analyzerVersion?: string;
  state: SearchIndexState;
  coverage: SearchIndexCoverage;
  documentCount: number;
  sourceCursor?: string;
  lastBuildAt?: string;
  lastAppliedAt?: string;
  lastError?: string;
};
