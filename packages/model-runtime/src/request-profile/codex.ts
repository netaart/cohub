import type { ProviderHeaders } from "@earendil-works/pi-ai";
import { mergeHeaders } from "@cohub/infra/config-runtime/models";
import type { RequestProfile } from "./index.js";

const MAX_AFFINITY_ID_LENGTH = 64;

/** Route a session's requests to one upstream backend by sending its `session-id` and `thread-id`. */
export const codexOverrides: RequestProfile = (_model, options) => {
  if (!options.sessionId) return {};

  const threadId = typeof options.threadId === "string" ? options.threadId : options.sessionId;
  const affinityHeaders: ProviderHeaders = {
    "session-id": options.sessionId.slice(0, MAX_AFFINITY_ID_LENGTH),
    "thread-id": threadId.slice(0, MAX_AFFINITY_ID_LENGTH),
  };
  return { headers: mergeHeaders(affinityHeaders, options.headers) };
};
