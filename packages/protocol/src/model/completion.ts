import type { ContentBlock, Usage } from "../core/index.js";

export type CompletionMessageRole = "user" | "assistant" | "system";

/** Raw completion message. Reuses session ContentBlock content shape. */
export type CompletionMessage = {
  role: CompletionMessageRole;
  content: ContentBlock[];
};

export type CompletionImageInput =
  | { type: "image_url"; image_url: string | { url: string; detail?: string } }
  | { type: "input_image"; image_url: string; detail?: string };

export type CompletionMessageInput = {
  role: CompletionMessageRole;
  content: string | Array<ContentBlock | CompletionImageInput>;
};

/**
 * Unified thinking level across completions, session prompts, and model config.
 * `off` disables reasoning; `minimal`–`high` use provider defaults;
 * `xhigh`/`max` are opt-in and require an explicit `thinkingLevelMap` entry.
 */
export type ModelThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** @deprecated Use {@link ModelThinkingLevel} — kept for SDK compatibility. */
export type CompletionThinkingLevel = ModelThinkingLevel;

export type CreateSpaceCompletionInput = {
  /** Optional provider. Defaults to the first available model provider. */
  provider?: string | null;
  /** Optional model id. Defaults to the first available model. */
  model?: string | null;
  /**
   * Optional space-relative markdown/text path used as system prompt.
   * Omitted/null/empty → empty system prompt.
   */
  systemPromptPath?: string | null;
  /** Full conversation history controlled by the caller. */
  messages: CompletionMessageInput[];
  temperature?: number | null;
  maxTokens?: number | null;
  thinkingLevel?: CompletionThinkingLevel | null;
  /** When true, respond with SSE. Default false (JSON). */
  stream?: boolean | null;
};

export type CompletionUsage = Usage;

export type CompletionAssistantMessage = {
  role: "assistant";
  content: ContentBlock[];
  stopReason: "stop" | "length" | "error" | "aborted";
  errorMessage?: string | null;
};

export type CompletionImageDescriptionFallback = {
  type: "image_description";
  messageIndex: number;
  imageIndex: number;
  provider: string;
  model: string;
  status: "succeeded" | "failed";
  description?: {
    text: string;
    provider: string;
    model: string;
    generatedAt: string;
  };
  usage: CompletionUsage | null;
  durationMs: number;
  error?: string;
};

export type SpaceCompletionResult = {
  completionId: string;
  provider: string;
  model: string;
  systemPromptPath: string | null;
  message: CompletionAssistantMessage;
  usage: CompletionUsage | null;
  /** Newly generated fallbacks. Persist successful descriptions in the source image `_meta` for reuse. */
  contextFallbacks?: CompletionImageDescriptionFallback[];
};

export type SpaceCompletionStreamEvent =
  | {
      type: "meta";
      completionId: string;
      provider: string;
      model: string;
      systemPromptPath: string | null;
    }
  | {
      type: "delta";
      text: string;
    }
  | {
      type: "thinking_delta";
      text: string;
    }
  | {
      type: "usage";
      usage: CompletionUsage;
    }
  | {
      type: "done";
      completionId: string;
      message: CompletionAssistantMessage;
      usage: CompletionUsage | null;
      contextFallbacks?: CompletionImageDescriptionFallback[];
    }
  | {
      type: "error";
      code: string;
      message: string;
      completionId?: string | null;
    };
