/** The document engine has no registry of business types or index families. */
export const SEARCH_DOCUMENT_PROTOCOL_VERSION = 1;
export const WORKSPACE_CANDIDATE_INDEX_FAMILY = "workspace.candidates";
export type SearchIndexFamily = string;
export type SearchDocumentType = string;

/** All values are strings. The schema chooses how each string is indexed. */
export type SearchField = {
  kind: "text" | "keyword" | "trigram";
  stored?: boolean;
};

export type SearchIndexDefinition = {
  family: SearchIndexFamily;
  schemaVersion: number;
  fields: Record<string, SearchField>;
};

/** Identity is scoped by all three components; an id is not necessarily a path. */
export type SearchDocumentRef = {
  type: SearchDocumentType;
  spaceId: string;
  id: string;
};

export type SearchMutationOperation = "upsert" | "delete";
export type SearchMutation =
  | { operation: "upsert"; document: SearchDocumentRef; fields: Record<string, string> }
  | { operation: "delete"; document: SearchDocumentRef };

export type SearchIndexCoverage = "complete" | "partial" | "stale";
export type SearchIndexState = "building" | "ready" | "stale" | "error";

/**
 * One ordered producer per index. expectedCursor is the last acknowledged
 * checkpoint (null for an empty index), and cursor is a new opaque batch id.
 * An exact retry of the last batch is idempotent; stale or conflicting writes
 * receive HTTP 409. Persist the batch before sending if it must be replayed.
 */
export type SearchMutationBatch = {
  expectedCursor: string | null;
  cursor: string;
  changes: SearchMutation[];
  coverage: SearchIndexCoverage;
};

export type SearchIndexStatus = {
  protocolVersion: typeof SEARCH_DOCUMENT_PROTOCOL_VERSION;
  family: SearchIndexFamily;
  generation: string;
  schemaVersion: number;
  state: SearchIndexState;
  coverage: SearchIndexCoverage;
  documentCount: number;
  sourceCursor: string | null;
};

export type SearchQuery = {
  /** All terms and filters are ANDed. An empty query lists documents. */
  terms?: Array<{ field: string; value: string }>;
  /** _id, _type and _space are built-in keyword fields. */
  filters?: Array<{ field: string; operation: "equal" | "prefix" | "glob"; value: string }>;
  limit?: number;
  offset?: number;
  /** Reuse the previous response token when paginating; a changed index returns 409. */
  snapshot?: string;
};

export type SearchHit = {
  document: SearchDocumentRef;
  fields: Record<string, string>;
  score: number;
};

export type SearchQueryResult = SearchIndexStatus & {
  hits: SearchHit[];
  truncated: boolean;
  snapshot: string;
};
