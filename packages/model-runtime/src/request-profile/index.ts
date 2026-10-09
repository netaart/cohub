import type {
  Api,
  AssistantMessageEventStream,
  Model,
  ProviderStreams,
  StreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ModelRequestProfile } from "@cohub/infra/config-runtime/models";
import { claudeCodeOverrides, restoreClaudeCodeToolNames } from "./claude-code.js";
import { codexOverrides } from "./codex.js";

export type ProfiledModel = Model<Api> & { requestProfile?: ModelRequestProfile };

/** Stream options plus Cohub hints, consumed by `applyRequestProfile` and never sent to the provider. */
export type ProfileStreamOptions = StreamOptions & {
  /** Conversation thread when it differs from `sessionId` (a forked session keeps its parent's affinity). */
  threadId?: unknown;
};

export type RequestProfileOverrides = Pick<StreamOptions, "headers" | "onPayload">;

/** Makes a request look like the client a model's upstream expects. Explicitly configured headers always win. */
export type RequestProfile = (model: Model<Api>, options: ProfileStreamOptions) => RequestProfileOverrides;

/** Maps what a profile's upstream returns back onto what Cohub declared. */
export type ResponseProfile = (
  model: Model<Api>,
  context: TranscriptContext,
  stream: AssistantMessageEventStream,
) => AssistantMessageEventStream;

const PROFILES: Record<ModelRequestProfile, RequestProfile> = {
  codex: codexOverrides,
  "claude-code": claudeCodeOverrides,
};

const RESPONSE_PROFILES: Partial<Record<ModelRequestProfile, ResponseProfile>> = {
  "claude-code": restoreClaudeCodeToolNames,
};

export function applyRequestProfile<T extends ProfileStreamOptions>(
  model: Model<Api>,
  options?: T,
): Omit<T, "threadId" | keyof RequestProfileOverrides> & RequestProfileOverrides {
  const { threadId: _threadId, ...streamOptions } = options ?? ({} as T);
  const name = (model as ProfiledModel).requestProfile;
  const overrides = name ? PROFILES[name]?.(model, options ?? {}) : undefined;
  return { ...streamOptions, ...overrides } as ReturnType<typeof applyRequestProfile<T>>;
}

export function applyResponseProfile(
  model: Model<Api>,
  context: TranscriptContext,
  stream: AssistantMessageEventStream,
): AssistantMessageEventStream {
  const name = (model as ProfiledModel).requestProfile;
  const profile = name ? RESPONSE_PROFILES[name] : undefined;
  return profile ? profile(model, context, stream) : stream;
}

export function withRequestProfiles(streams: ProviderStreams): ProviderStreams {
  return {
    ...streams,
    stream: (model, context, options) =>
      applyResponseProfile(model, context, streams.stream(model, context, applyRequestProfile(model, options))),
    streamSimple: (model, context, options) =>
      applyResponseProfile(model, context, streams.streamSimple(model, context, applyRequestProfile(model, options))),
  };
}
