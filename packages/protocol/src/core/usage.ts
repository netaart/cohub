export type Usage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  /** Latest model context snapshot. These counts are never added across requests. */
  contextTokens?: number;
  contextWindow?: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  } | null;
};
