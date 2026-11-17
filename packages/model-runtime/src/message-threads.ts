import type { Api, Model, ProviderStreams } from "@earendil-works/pi-ai";

/**
 * pi-ai 1.5.1+ sends Anthropic requests with a sessionId to api.anthropic.com as message
 * threads (a beta: only new messages are sent and Anthropic continues server-side). Cohub sends
 * full requests until it opts in; a model whose `compat.supportsMessageThreads` is set decides.
 */
function withoutDefaultThreads(model: Model<Api>): Model<Api> {
  const compat = model.compat as { supportsMessageThreads?: boolean } | undefined;
  if (compat?.supportsMessageThreads !== undefined) return model;
  return { ...model, compat: { ...compat, supportsMessageThreads: false } } as Model<Api>;
}

export function withoutMessageThreads(streams: ProviderStreams): ProviderStreams {
  return {
    ...streams,
    stream: (model, context, options) => streams.stream(withoutDefaultThreads(model), context, options),
    streamSimple: (model, context, options) => streams.streamSimple(withoutDefaultThreads(model), context, options),
  };
}
