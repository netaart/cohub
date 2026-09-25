import type {
  ChannelPromptContext,
  PromptAccessMode,
  PromptHarness,
  PromptSource,
  PromptTemplateUsageMeta,
  PublicApiPromptContext,
  ScheduledTaskPromptContext,
  SubmitSessionPromptContext,
  SubmitSessionPromptError,
  SubmitSessionPromptHooks,
  SubmitSessionPromptInput,
  SubmitSessionPromptOptions,
  SubmitSessionPromptResult,
  WebAppPromptContext,
  WebsocketPromptContext,
} from "@cohub/core/sessions";
import type { ContentBlock } from "@cohub/protocol/core";
import { getSessionDomainServices } from "./session-services.js";

export type {
  ChannelPromptContext,
  PromptAccessMode,
  PromptSource,
  PromptTemplateUsageMeta,
  PublicApiPromptContext,
  ScheduledTaskPromptContext,
  SubmitSessionPromptContext,
  SubmitSessionPromptError,
  SubmitSessionPromptHooks,
  SubmitSessionPromptInput,
  SubmitSessionPromptOptions,
  SubmitSessionPromptResult,
  WebAppPromptContext,
  WebsocketPromptContext,
};

export const expandPromptContent = async (input: {
  content: ContentBlock[];
  userId: string;
  spaceId: string;
  sessionId?: string | null;
  harness?: PromptHarness | null;
  sandboxSemantics?: boolean;
}) => getSessionDomainServices().expandPromptContent(input);

export const submitSessionPrompt = async (
  input: SubmitSessionPromptInput,
  hooks: SubmitSessionPromptHooks = {},
  options: SubmitSessionPromptOptions = {},
): Promise<SubmitSessionPromptResult> => getSessionDomainServices().submitPrompt(input, {
  ...hooks,
  beforeEnqueue: hooks.beforeEnqueue,
}, options);
