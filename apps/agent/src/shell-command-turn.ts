import { randomUUID } from "node:crypto";
import type { ContentBlock } from "@cohub/protocol/core";
import { persistAssistantMessage } from "./persistence.js";
import type { createSandboxCodingTools } from "./sandbox/tools.js";
import type { CohubModel } from "./runtime/model-registry.js";
import { setCurrentSessionExecutionAuth } from "./runtime/session-execution-auth.js";
import { removePendingUserMessage, type SessionHandle } from "./session-handle.js";
import { sendOutput } from "./redis.js";
import { logger } from "./logger.js";
import type { getPromptAuthScopes } from "@cohub/core/sessions";
import { type TurnUserMessage, appendAndPersistUserMessage, clearActiveTurnContext, normalizeTurnUserMeta, setActiveTurnContext } from "./turn-context.js";

export function getShellCommandBlock(content: ContentBlock[]): Extract<ContentBlock, { type: "shell_command" }> | null {
  if (content.length !== 1) return null;
  const block = content[0];
  return block?.type === "shell_command" ? block : null;
}

function extractToolResultText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const record = result as Record<string, unknown>;
  const details = record.details && typeof record.details === "object" && !Array.isArray(record.details)
    ? record.details as Record<string, unknown>
    : null;
  if (typeof details?.rawOutput === "string") return details.rawOutput;
  if (Array.isArray(record.content)) {
    return record.content
      .map((item) => item && typeof item === "object" && (item as Record<string, unknown>).type === "text"
        ? String((item as Record<string, unknown>).text ?? "")
        : "")
      .join("");
  }
  return typeof record.content === "string" ? record.content : "";
}

function formatShellCommandResultForLlm(input: {
  command: string;
  output: string;
  exitCode?: number | null;
  cancelled?: boolean;
  timedOut?: boolean;
  timeoutSecs?: number | null;
}) {
  let text = `Ran \`${input.command}\``;
  text += input.output ? `\n\`\`\`\n${input.output}\n\`\`\`` : "\n(no output)";
  if (input.timedOut) {
    text += `\n\n(command timed out${input.timeoutSecs ? ` after ${input.timeoutSecs}s` : ""})`;
  } else if (input.cancelled) {
    text += "\n\n(command cancelled)";
  } else if (input.exitCode != null && input.exitCode !== 0) {
    text += `\n\nCommand exited with code ${input.exitCode}`;
  }
  return text;
}

export async function runDirectShellCommandTurn(input: {
  handle: SessionHandle;
  tools: ReturnType<typeof createSandboxCodingTools>;
  spaceId: string;
  sessionId: string;
  user: TurnUserMessage;
  command: string;
  rawText: string;
  actorUserId: string | null;
  executionToken: string | null;
  executionScopes?: ReturnType<typeof getPromptAuthScopes>;
  turnMetrics: { llmRoundCount: number; toolCallCount: number };
  abortSignal?: AbortSignal;
}) {
  const { user } = input;
  const userMessageId = user.userMessageId;

  const bashTool = input.tools.find((tool) => tool.name === "bash");
  if (!bashTool) throw new Error("bash tool is not available");

  const handle = input.handle;
  setActiveTurnContext(handle, {
    turnId: user.turnId,
    turnSeq: user.turnSeq,
    userMessageId,
    userMeta: user.meta,
    llmRound: 0,
  });
  handle.currentAssistantMessageOrdinal = 0;
  handle.currentStreamMessageId = `turn:${user.turnId}:assistant:0`;

  setCurrentSessionExecutionAuth({
    sessionId: input.sessionId,
    turnId: user.turnId,
    actorUserId: input.actorUserId,
    executionToken: input.executionToken,
    executionScopes: input.executionScopes ?? [],
  });

  let cleanupParentAbort: (() => void) | null = null;

  try {
    const userMeta = normalizeTurnUserMeta(user, {
      intent: "shell_command",
      llm: false,
      rawText: input.rawText,
      command: input.command,
    });
    handle.currentUserMessageMeta = userMeta;
    await appendAndPersistUserMessage({
      handle,
      spaceId: input.spaceId,
      sessionId: input.sessionId,
      user,
      meta: userMeta,
    });

    const toolUseId = `direct_shell_${randomUUID()}`;
    const toolStartedAt = new Date().toISOString();
    const abortController = new AbortController();
    const abortFromParent = () => abortController.abort();
    if (input.abortSignal?.aborted) {
      abortFromParent();
    } else {
      input.abortSignal?.addEventListener("abort", abortFromParent, { once: true });
      cleanupParentAbort = () => input.abortSignal?.removeEventListener("abort", abortFromParent);
    }
    handle.activeDirectShellCommand = { turnId: user.turnId, abortController };

    const toolUseBlock: ContentBlock = {
      type: "tool_use",
      id: toolUseId,
      name: "bash",
      input: { command: input.command },
      _meta: { direct: true, source: "shell_command", toolStatus: "running", timing: { startedAt: toolStartedAt } },
    };
    let patchSeq = 0;
    let latestOutput = "";
    let publishChain = Promise.resolve();

    const publish = async (blocks: ContentBlock[], final = false) => {
      patchSeq += 1;
      handle.currentTurnPatchSeq = patchSeq;
      await sendOutput({
        type: "stream_update",
        spaceId: input.spaceId,
        sessionId: input.sessionId,
        turnId: user.turnId,
        seq: patchSeq,
        baseSeq: Math.max(0, patchSeq - 1),
        content: blocks,
        snapshotContent: blocks,
        messageId: handle.currentStreamMessageId,
        messageOrdinal: 0,
        sourceMessageId: userMessageId,
        anchorUserMessageId: userMessageId,
        timestamp: Date.now(),
        ...(final ? { turnEnd: true } : {}),
      });
    };

    await publish([toolUseBlock]);

    let exitCode: number | null | undefined;
    let cancelled = false;
    let timedOut = false;
    let termination: Record<string, unknown> | null = null;
    let truncated = false;
    let outputTruncated = false;
    let executionFailed = false;
    let errorMessage: string | null = null;
    try {
      const result = await bashTool.execute(
        toolUseId,
        { command: input.command } as never,
        abortController.signal,
        (partialResult: unknown) => {
          const partialText = extractToolResultText(partialResult);
          if (partialText) latestOutput = partialText;
          const partialBlocks: ContentBlock[] = [
            toolUseBlock,
            {
              type: "tool_result",
              tool_use_id: toolUseId,
              content: latestOutput,
              is_error: false,
              _meta: { direct: true, source: "shell_command", partial: true, toolStatus: "running" },
            },
          ];
          publishChain = publishChain
            .then(() => publish(partialBlocks))
            .catch((error) => {
              logger.error(`[Agent] Failed to publish shell command update for session ${input.sessionId}:`, error);
            });
        },
      );
      latestOutput = extractToolResultText(result);
      const details = result && typeof result === "object" ? (result as unknown as Record<string, unknown>).details as Record<string, unknown> | undefined : undefined;
      exitCode = typeof details?.exitCode === "number" ? details.exitCode : null;
      termination = details?.termination && typeof details.termination === "object" && !Array.isArray(details.termination)
        ? details.termination as Record<string, unknown>
        : null;
      timedOut = termination?.reason === "timed_out";
      cancelled = termination?.reason === "aborted" || abortController.signal.aborted;
      outputTruncated = details?.outputTruncated === true || termination?.outputTruncated === true;
      truncated = Boolean(details?.truncation) || outputTruncated;
    } catch (error) {
      executionFailed = true;
      cancelled = abortController.signal.aborted;
      errorMessage = error instanceof Error ? error.message : String(error);
      latestOutput = latestOutput ? `${latestOutput}\n\n${errorMessage}` : errorMessage;
      exitCode = null;
      if (!cancelled) {
        logger.error(`[Agent] Direct shell command failed sessionId=${input.sessionId}:`, error);
      }
    }

    const isError = executionFailed || cancelled || timedOut || outputTruncated || (exitCode != null && exitCode !== 0);
    const toolCompletedAt = new Date().toISOString();
    const toolDurationMs = Math.max(0, new Date(toolCompletedAt).getTime() - new Date(toolStartedAt).getTime());
    const toolTiming = { startedAt: toolStartedAt, completedAt: toolCompletedAt, durationMs: toolDurationMs };
    const finalToolUseBlock: ContentBlock = {
      ...toolUseBlock,
      _meta: { direct: true, source: "shell_command", toolStatus: isError ? "failed" : "done", timing: toolTiming },
    };
    const finalToolResultBlock: ContentBlock = {
      type: "tool_result",
      tool_use_id: toolUseId,
      content: latestOutput,
      is_error: isError,
      _meta: {
        direct: true,
        source: "shell_command",
        partial: false,
        toolStatus: isError ? "failed" : "done",
        exitCode: exitCode ?? null,
        termination,
        timedOut,
        cancelled,
        truncated,
        outputTruncated,
        executionFailed,
        timing: toolTiming,
        ...(errorMessage ? { errorMessage } : {}),
      },
    };
    const assistantContent: ContentBlock[] = [finalToolUseBlock, finalToolResultBlock];
    await publishChain;
    await publish(assistantContent, true);

    const model = handle.session.agent.state.model;
    const assistantMessage = {
      role: "assistant",
      content: assistantContent,
      timestamp: Date.now(),
      stopReason: cancelled ? "aborted" : "end",
      provider: model.provider,
      model: model.id,
      meta: {
        messageKind: "shell_command_result",
        executionKind: "shell_command_result",
        llm: false,
        command: input.command,
        rawText: input.rawText,
        exitCode: exitCode ?? null,
        termination,
        timedOut,
        cancelled,
        truncated,
        outputTruncated,
        executionFailed,
        ...(errorMessage ? { errorMessage } : {}),
        llmContextText: formatShellCommandResultForLlm({
          command: input.command,
          output: latestOutput,
          exitCode,
          cancelled,
          timedOut,
          timeoutSecs: typeof termination?.timeoutSecs === "number" ? termination.timeoutSecs : null,
        }),
      },
    } as never;
    handle.session.agent.state.messages.push(assistantMessage);
    const entryId = handle.sessionManager.appendMessage(assistantMessage);
    (assistantMessage as unknown as Record<string, unknown>).sessionEntryId = entryId;

    const completedAt = new Date().toISOString();

    await persistAssistantMessage({
      spaceId: input.spaceId,
      spaceSessionId: input.sessionId,
      userMessageId,
      event: {
        type: "turn_end",
        message: assistantMessage as Record<string, unknown>,
        toolResults: [{
          toolCallId: toolUseId,
          toolName: "bash",
          input: { command: input.command },
          content: latestOutput,
          isError,
          _meta: finalToolResultBlock._meta,
        }],
      },
      userId: input.actorUserId,
      turnId: user.turnId,
      startedAt: toolStartedAt,
      completedAt,
      thinkingLevel: handle.session.agent.state.thinkingLevel,
      contextWindow: handle.session.agent.state.model.contextWindow,
      contextWindowSource: (handle.session.agent.state.model as CohubModel).contextWindowSource,
    });

    input.turnMetrics.toolCallCount += 1;
    removePendingUserMessage(handle, userMessageId);
  } finally {
    cleanupParentAbort?.();
    handle.activeDirectShellCommand = null;
    clearActiveTurnContext(handle, input.sessionId);
  }
}
