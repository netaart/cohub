import type { Agent, AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { Agent as PiAgent } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, AssistantMessage } from "@earendil-works/pi-ai";
import { trace } from "@opentelemetry/api";
import { recordRetryWait } from "../metrics.js";
import { logger } from "../logger.js";
import type { SessionManager } from "./local-session-manager.js";
import type { CohubModel, CohubModelRegistry } from "./model-registry.js";
import { normalizeThinkingLevel, resolveInitialThinkingLevel, resolveThinkingLevelForModel } from "./thinking-level.js";
import { buildCohubSystemPrompt, type LocalPromptWorkspace } from "./system-prompt-builder.js";
import { getCurrentToolExecutionContext, runWithToolExecutionContext, type ToolExecutionContext } from "../tool-context.js";
import { applyRoundBoundaryAbort } from "../active-turns.js";
import { isToolFailureDetails } from "./tools/index.js";
import { clampContextWindow } from "@cohub/infra/config-runtime/models";
import type { ImageToTextConfig } from "@cohub/infra/config-runtime/model-tasks";
import { ModelUnavailableError } from "@cohub/core/sessions";
import type { SpaceModListItem } from "@cohub/core/space-mods";
import {
  EMPTY_TOOL_CALL_LOOP_GUARD_STATE,
  observeToolCallBatch,
  TOOL_CALL_LOOP_GUARD_PROMPT,
  TOOL_CALL_LOOP_GUARD_THRESHOLD,
} from "./tool-call-loop-guard.js";
import { type StreamRuntime, type ToolLike, createStreamFn } from "./assistant-stream.js";
import { toLlmMessages } from "./llm-messages.js";
import { AGENT_RETRY_BASE_DELAY_MS, AGENT_RETRY_MAX_RETRIES, getAssistantRetryOutcome, isRetryableAssistantFailure, logAssistantRetry, recordAssistantRetrySpanAttributes, shouldResetAssistantRetryState } from "./assistant-retry.js";

export type CohubAgentSessionEvent = AgentEvent;

export type CohubAgentSession = {
  agent: Agent;
  modelRegistry: CohubModelRegistry;
  sessionManager: SessionManager;
  isStreaming: boolean;
  isRetrying: boolean;
  shouldDeferErrorPersistence(message: Record<string, unknown>): boolean;
  /** Consume one-shot force-compact flag set after a context-overflow failure. */
  consumePendingForcedCompaction(): boolean;
  prompt(text: string, options?: { images?: ImageContent[] }): Promise<void>;
  promptMessages(messages: AgentMessage[]): Promise<void>;
  steer(text: string, images?: ImageContent[]): Promise<void>;
  enqueueSteer(text: string, images?: ImageContent[]): void;
  waitForIdle(): Promise<void>;
  setModel(model: Model<Api>): Promise<void>;
  configureRuntimeIdentity(input: { userId?: string | null; spaceOwnerUserId?: string | null; modelRegistry: CohubModelRegistry; imageToTextConfig?: ImageToTextConfig | null; requestedModel?: { provider: string; id: string }; requestedThinkingLevel?: string | null; requestedContextWindow?: number | null }): Promise<void>;
  configureTools(tools: ToolLike[]): Promise<void>;
  reload(): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  subscribe(listener: (event: CohubAgentSessionEvent) => void | Promise<void>): () => void;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type CreateCohubAgentSessionOptions = {
  cwd: string;
  userId?: string | null;
  spaceOwnerUserId?: string | null;
  sessionManager: SessionManager;
  modelRegistry: CohubModelRegistry;
  tools: ToolLike[];
  spaceMods?: SpaceModListItem[];
  localWorkspace?: LocalPromptWorkspace;
  imageToTextConfig?: ImageToTextConfig | null;
  model?: Model<Api>;
  /** Latest thinking level the user explicitly selected; read only when the session file lost its record. */
  loadSelectedThinkingLevel?: () => Promise<string | null>;
  /** Latest context window requested by a prompt in this session; read once per handle. */
  loadSelectedContextWindow?: () => Promise<number | null>;
};

function normalizeUserId(userId?: string | null) {
  return userId?.trim() || null;
}

function toolsStateKey(tools: ToolLike[]) {
  return tools.map((tool) => tool.name).join("\0");
}

function shouldIncludeUserSkills(userId: string | null, spaceOwnerUserId: string | null) {
  return Boolean(userId && spaceOwnerUserId && userId === spaceOwnerUserId);
}

function createUserMessage(text: string, images?: ImageContent[], meta?: Record<string, unknown>): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }, ...(images ?? [])],
    timestamp: Date.now(),
    ...(meta ? { meta } : {}),
  } as AgentMessage;
}

function toolSnippets(toolName: string): string | undefined {
  switch (toolName) {
    case "read": return "Read file contents";
    case "bash": return "Execute bash commands";
    case "edit": return "Read the target first, copy oldText verbatim, and use unique surrounding context for precise edits";
    case "write": return "Create or overwrite files";
    case "grep": return "Search file contents";
    case "find": return "Search files by glob pattern";
    case "ls": return "List directory contents";
    default: return undefined;
  }
}

export async function createCohubAgentSession(options: CreateCohubAgentSessionOptions): Promise<{ session: CohubAgentSession }> {
  const sessionContext = options.sessionManager.buildSessionContext();
  let runtimeUserId = normalizeUserId(options.userId);
  let runtimeSpaceOwnerUserId = normalizeUserId(options.spaceOwnerUserId);
  let runtimeModelRegistry = options.modelRegistry;
  let runtimeImageToTextConfig = options.imageToTextConfig ?? null;
  let runtimeTools = options.tools;
  let runtimeSystemPrompt = "";
  // undefined: not loaded yet; null: no prompt has set one.
  let selectedContextWindow: number | null | undefined;
  let systemPromptStateKey: string | null = null;
  const sessionAffinity = options.sessionManager.getSessionAffinity();
  const getRuntime = (): StreamRuntime => ({
    modelRegistry: runtimeModelRegistry,
    imageToTextConfig: runtimeImageToTextConfig,
    sessionManager: options.sessionManager,
    userId: runtimeUserId,
    threadId: sessionAffinity.threadId,
    systemPrompt: runtimeSystemPrompt,
    tools: runtimeTools,
  });
  const model = options.model ?? (sessionContext.model ? runtimeModelRegistry.find(sessionContext.model.provider, sessionContext.model.modelId) : undefined) ?? runtimeModelRegistry.getDefault();
  if (!model) {
    throw new Error("No model available. Check platform models.json");
  }

  const resumed = sessionContext.messages.length > 0;
  const initialThinkingLevel = await resolveInitialThinkingLevel(model, {
    recorded: sessionContext.thinkingLevel,
    resumed,
    loadSelected: options.loadSelectedThinkingLevel,
  });

  if (!resumed) options.sessionManager.appendModelChange(model.provider, model.id);
  // Record the level whenever the file has none (new session or lost record),
  // so later loads and compactions carry it instead of resolving it again.
  if (!normalizeThinkingLevel(sessionContext.thinkingLevel)) options.sessionManager.appendThinkingLevelChange(initialThinkingLevel);

  const systemPromptStateKeyFor = (userId: string | null, spaceOwnerUserId: string | null, tools: ToolLike[]) => `${userId ?? ""}\0${shouldIncludeUserSkills(userId, spaceOwnerUserId) ? "user-skills" : "no-user-skills"}\0${toolsStateKey(tools)}`;

  const buildSystemPromptForTools = (tools: ToolLike[], input?: { userId?: string | null; spaceOwnerUserId?: string | null }) => {
    const userId = input && "userId" in input ? normalizeUserId(input.userId) : runtimeUserId;
    const spaceOwnerUserId = input && "spaceOwnerUserId" in input ? normalizeUserId(input.spaceOwnerUserId) : runtimeSpaceOwnerUserId;
    return buildCohubSystemPrompt({
      cwd: options.cwd,
      userId,
      selectedTools: tools.map((tool) => tool.name),
      toolSnippets: Object.fromEntries(tools.map((tool) => [tool.name, toolSnippets(tool.name)]).filter((entry): entry is [string, string] => Boolean(entry[1]))),
      spaceMods: options.spaceMods ?? [],
      includeUserSkills: shouldIncludeUserSkills(userId, spaceOwnerUserId),
      localWorkspace: options.localWorkspace,
    });
  };

  runtimeSystemPrompt = await buildSystemPromptForTools(runtimeTools);
  systemPromptStateKey = systemPromptStateKeyFor(runtimeUserId, runtimeSpaceOwnerUserId, runtimeTools);

  const agent = new PiAgent({
    initialState: {
      model,
      thinkingLevel: initialThinkingLevel,
      tools: runtimeTools as never,
      messages: sessionContext.messages,
    },
    steeringMode: "all",
    sessionId: sessionAffinity.sessionId,
    convertToLlm: toLlmMessages,
    streamFn: createStreamFn(getRuntime, (message) => getAssistantRetryOutcome(message, retryAttempt).shouldRetry),
    getApiKey: (provider: string) => runtimeModelRegistry.getApiKey(provider),
    prepareRequest() {
      const turnId = getCurrentToolExecutionContext()?.turnId;
      if (turnId) applyRoundBoundaryAbort(turnId);
    },
    async afterToolCall({ result }) {
      if (isToolFailureDetails(result.details)) return { isError: true };
      const details = result.details as Record<string, unknown> | undefined;
      const termination = details?.termination as Record<string, unknown> | undefined;
      if (termination?.reason === "timed_out" || termination?.reason === "aborted" || details?.outputTruncated === true || termination?.outputTruncated === true) return { isError: true };
      return undefined;
    },
  });

  const configureToolsState = async (tools: ToolLike[], options?: { force?: boolean }) => {
    const nextKey = systemPromptStateKeyFor(runtimeUserId, runtimeSpaceOwnerUserId, tools);
    if (!options?.force && systemPromptStateKey === nextKey) {
      runtimeTools = tools;
      agent.state.tools = tools as never;
      return;
    }
    const nextSystemPrompt = await buildSystemPromptForTools(tools);
    runtimeTools = tools;
    runtimeSystemPrompt = nextSystemPrompt;
    systemPromptStateKey = nextKey;
    agent.state.tools = tools as never;
  };

  let lastAssistantMessage: AssistantMessage | undefined;
  let retryAttempt = 0;
  let retryCancelled = false;
  let retryPending = false;
  let retryInProgress = false;
  let retryRunPromise: Promise<void> | null = null;
  let retryContext: ToolExecutionContext | null = null;
  let retryDelayMs = AGENT_RETRY_BASE_DELAY_MS;
  let forcedCompactionPending = false;
  let toolCallLoopGuardState = EMPTY_TOOL_CALL_LOOP_GUARD_STATE;

  const clearRetryState = () => {
    retryAttempt = 0;
    retryPending = false;
    retryInProgress = false;
    retryRunPromise = null;
    retryCancelled = false;
    retryContext = null;
    retryDelayMs = AGENT_RETRY_BASE_DELAY_MS;
    forcedCompactionPending = false;
  };

  const getRecentMessageRoles = () => agent.state.messages.slice(-8).map((message) => message.role).join(",");

  const runPendingRetries = async () => {
    if (retryRunPromise) return retryRunPromise;
    if (!retryPending) return;

    retryRunPromise = (async () => {
      while (retryPending) {
        const attempt = retryAttempt;
        const contextSnapshot = retryContext ?? getCurrentToolExecutionContext();
        const delayMs = retryDelayMs;
        retryPending = false;
        retryInProgress = true;

        const waitStarted = performance.now();
        if (delayMs > 0) await sleep(delayMs);
        await recordRetryWait(contextSnapshot?.turnId, Math.max(0, performance.now() - waitStarted));
        if (retryCancelled) {
          clearRetryState();
          return;
        }

        const run = async () => {
          logger.info(`[AgentRetry] continue:start sessionId=${getCurrentToolExecutionContext()?.sessionId ?? "unknown"} turnId=${getCurrentToolExecutionContext()?.turnId ?? "unknown"} attempt=${attempt} forceCompact=${forcedCompactionPending} roles=${getRecentMessageRoles()}`);
          await agent.continue();
          await agent.waitForIdle();
        };

        try {
          if (contextSnapshot) {
            await runWithToolExecutionContext(contextSnapshot, run);
          } else {
            await run();
          }
        } catch (error) {
          const normalized = error instanceof Error ? error : new Error(String(error));
          logger.error("[AgentRetry] continue:failed", {
            sessionId: contextSnapshot?.sessionId ?? getCurrentToolExecutionContext()?.sessionId ?? "unknown",
            turnId: contextSnapshot?.turnId ?? getCurrentToolExecutionContext()?.turnId ?? null,
            retryAttempt: attempt,
            retryCancelled,
            agentIsStreaming: agent.state.isStreaming,
            recentRoles: getRecentMessageRoles(),
            errorName: normalized.name,
            errorMessage: normalized.message,
            stack: normalized.stack,
          });
          clearRetryState();
          throw normalized;
        } finally {
          retryInProgress = false;
        }
      }
    })();

    try {
      await retryRunPromise;
    } finally {
      retryRunPromise = null;
    }
  };

  const unsubscribe = agent.subscribe((event: AgentEvent) => {
    if (event.type === "message_end") {
      const message = event.message as { role?: string };
      if (message.role === "assistant") {
        const assistantMessage = event.message as AssistantMessage;
        lastAssistantMessage = assistantMessage;
        const toolContext = getCurrentToolExecutionContext();
        const loopGuard = observeToolCallBatch(toolCallLoopGuardState, {
          turnId: toolContext?.turnId ?? null,
          message: assistantMessage,
        });
        toolCallLoopGuardState = loopGuard.state;
        if (loopGuard.shouldIntervene) {
          logger.warn("[ToolCallLoopGuard] repeated tool-call batch detected", {
            sessionId: toolContext?.sessionId ?? "unknown",
            turnId: toolContext?.turnId ?? null,
            threshold: TOOL_CALL_LOOP_GUARD_THRESHOLD,
          });
          agent.steer(createUserMessage(TOOL_CALL_LOOP_GUARD_PROMPT, undefined, {
            internal: true,
            source: "tool_call_loop_guard",
          }));
        }
        const retryOutcome = getAssistantRetryOutcome(assistantMessage, retryAttempt);
        const sessionId = getCurrentToolExecutionContext()?.sessionId ?? "unknown";
        const turnId = getCurrentToolExecutionContext()?.turnId ?? undefined;
        logAssistantRetry(sessionId, turnId, retryOutcome);
        recordAssistantRetrySpanAttributes(trace.getActiveSpan(), retryOutcome);
        if (!retryOutcome.shouldRetry) {
          const entryId = options.sessionManager.appendMessage(event.message as never);
          (event.message as unknown as Record<string, unknown>).sessionEntryId = entryId;
        }
        if (shouldResetAssistantRetryState(assistantMessage)) {
          clearRetryState();
        }
      } else if (message.role === "user" || message.role === "toolResult") {
        if (message.role === "user") {
          toolCallLoopGuardState = EMPTY_TOOL_CALL_LOOP_GUARD_STATE;
        }
        const entryId = options.sessionManager.appendMessage(event.message as never);
        (event.message as unknown as Record<string, unknown>).sessionEntryId = entryId;
      }
      return;
    }

    if (event.type === "agent_end" && lastAssistantMessage) {
      const assistantMessage = lastAssistantMessage;
      lastAssistantMessage = undefined;
      const retryOutcome = getAssistantRetryOutcome(assistantMessage, retryAttempt);
      if (retryOutcome.shouldRetry) {
        retryAttempt = retryOutcome.retryAttempt;
        retryDelayMs = retryOutcome.retryDelayMs ?? AGENT_RETRY_BASE_DELAY_MS;
        if (retryOutcome.forceCompaction) forcedCompactionPending = true;
        retryPending = true;
        const currentContext = getCurrentToolExecutionContext();
        retryContext = currentContext ? { ...currentContext } : retryContext;

        const messages = agent.state.messages;
        if (messages.length > 0 && messages[messages.length - 1]?.role === "assistant") {
          agent.state.messages = messages.slice(0, -1);
        }
        return;
      }

      clearRetryState();
    }
  });

  const session: CohubAgentSession = {
    agent,
    get modelRegistry() {
      return runtimeModelRegistry;
    },
    sessionManager: options.sessionManager,
    get isStreaming() {
      return agent.state.isStreaming;
    },
    get isRetrying() {
      return retryPending || retryInProgress || retryRunPromise !== null;
    },
    shouldDeferErrorPersistence(message) {
      const assistantMessage = message as unknown as AssistantMessage;
      return isRetryableAssistantFailure(assistantMessage)
        && retryAttempt < AGENT_RETRY_MAX_RETRIES;
    },
    consumePendingForcedCompaction() {
      if (!forcedCompactionPending) return false;
      forcedCompactionPending = false;
      return true;
    },
    async prompt(text, inputOptions) {
      await agent.prompt(text, inputOptions?.images);
      await agent.waitForIdle();
      await runPendingRetries();
      await agent.waitForIdle();
    },
    async promptMessages(messages) {
      await agent.prompt(messages);
      await agent.waitForIdle();
      await runPendingRetries();
      await agent.waitForIdle();
    },
    async steer(text, images) {
      agent.steer(createUserMessage(text, images));
      await agent.waitForIdle();
    },
    enqueueSteer(text, images) {
      agent.steer(createUserMessage(text, images));
    },
    async waitForIdle() {
      await agent.waitForIdle();
      await runPendingRetries();
      await agent.waitForIdle();
    },
    async setModel(nextModel) {
      const nextThinkingLevel = resolveThinkingLevelForModel(nextModel as CohubModel, agent.state.thinkingLevel);
      agent.state.model = nextModel;
      agent.state.thinkingLevel = nextThinkingLevel;
      options.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
      options.sessionManager.appendThinkingLevelChange(nextThinkingLevel);
    },
    async configureRuntimeIdentity(input) {
      const nextUserId = normalizeUserId(input.userId);
      const nextSpaceOwnerUserId = normalizeUserId(input.spaceOwnerUserId) ?? runtimeSpaceOwnerUserId;
      const currentModel = agent.state.model;
      const requested = input.requestedModel
        ? input.modelRegistry.find(input.requestedModel.provider, input.requestedModel.id)
        : undefined;
      if (input.requestedModel && !requested) {
        throw new ModelUnavailableError(input.requestedModel.provider, input.requestedModel.id);
      }
      const target = requested
        ?? input.modelRegistry.find(currentModel.provider, currentModel.id)
        ?? input.modelRegistry.getDefault();
      if (!target) throw new Error("No model available. Check platform models.json");

      const nextKey = systemPromptStateKeyFor(nextUserId, nextSpaceOwnerUserId, runtimeTools);
      const nextSystemPrompt = systemPromptStateKey === nextKey
        ? runtimeSystemPrompt
        : await buildSystemPromptForTools(runtimeTools, { userId: nextUserId, spaceOwnerUserId: nextSpaceOwnerUserId });
      const shouldChangeModel = target.provider !== currentModel.provider || target.id !== currentModel.id;
      const hasRequestedThinkingLevel = input.requestedThinkingLevel !== undefined && input.requestedThinkingLevel !== null;
      const nextThinkingLevel = hasRequestedThinkingLevel
        ? resolveThinkingLevelForModel(target as CohubModel, input.requestedThinkingLevel)
        : shouldChangeModel
          ? resolveThinkingLevelForModel(target as CohubModel, agent.state.thinkingLevel)
          : agent.state.thinkingLevel;

      runtimeUserId = nextUserId;
      runtimeSpaceOwnerUserId = nextSpaceOwnerUserId;
      runtimeModelRegistry = input.modelRegistry;
      runtimeImageToTextConfig = input.imageToTextConfig ?? null;
      runtimeSystemPrompt = nextSystemPrompt;
      systemPromptStateKey = nextKey;
      const shouldChangeThinkingLevel = nextThinkingLevel !== agent.state.thinkingLevel;
      // IDs can stay the same while credentials, headers and endpoints change.
      // Bind the model and its auth registry to the same runtime configuration.
      // Like thinking level, a prompt's window sticks to the session until another prompt changes it.
      if (input.requestedContextWindow) selectedContextWindow = input.requestedContextWindow;
      else if (selectedContextWindow === undefined) selectedContextWindow = (await options.loadSelectedContextWindow?.()) ?? null;
      const promptContextWindow = clampContextWindow(selectedContextWindow ?? undefined, (target as CohubModel).contextWindowLimit);
      agent.state.model = promptContextWindow
        ? { ...target, contextWindow: promptContextWindow, contextWindowSource: "prompt" } as CohubModel
        : target;
      if (shouldChangeModel) {
        options.sessionManager.appendModelChange(target.provider, target.id);
      }
      if (shouldChangeModel || shouldChangeThinkingLevel) {
        agent.state.thinkingLevel = nextThinkingLevel;
        options.sessionManager.appendThinkingLevelChange(nextThinkingLevel);
      }
      agent.state.tools = runtimeTools as never;
    },
    async configureTools(tools) {
      await configureToolsState(tools);
    },
    async reload() {
      await configureToolsState(options.tools, { force: true });
    },
    async abort() {
      retryCancelled = true;
      retryPending = false;
      agent.abort();
      await agent.waitForIdle();
      clearRetryState();
    },
    dispose() {
      unsubscribe();
      retryCancelled = true;
      retryPending = false;
      retryContext = null;
      retryAttempt = 0;
      retryInProgress = false;
      agent.abort();
    },
    subscribe(listener) {
      return agent.subscribe((event: AgentEvent) => {
        return listener(event);
      });
    },
  };

  return { session };
}
