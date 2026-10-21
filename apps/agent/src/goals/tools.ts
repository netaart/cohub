import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { SessionGoal, SessionGoalStatus } from "@cohub/protocol/model";
import {
  SessionGoalError,
  advanceSessionGoalAfterTurn,
  getSessionGoal,
  setSessionGoal,
  updateSessionGoal,
} from "@cohub/core/sessions";
import { createToolFailure } from "../runtime/tools/index.js";
import { getCurrentToolExecutionContext } from "../tool-context.js";
import { db } from "../db.js";
import { logger } from "../logger.js";
import { publishSessionGoalUpdated } from "./events.js";

const goalJson = (goal: SessionGoal | null) => JSON.stringify({ goal }, null, 2);

const goalResult = (goal: SessionGoal | null): AgentToolResult<unknown> => ({
  content: [{ type: "text", text: goalJson(goal) }],
  details: { goal },
});

const goalFailure = (message: string): AgentToolResult<unknown> => ({
  content: [{ type: "text", text: message }],
  details: { ...createToolFailure(message, { retryable: false }), error: message },
});

const resolveContext = () => {
  const context = getCurrentToolExecutionContext();
  if (!context?.spaceId || !context.sessionId) return null;
  return context;
};

const describeGoalError = (error: unknown) =>
  error instanceof SessionGoalError ? error.message : error instanceof Error ? error.message : "Goal operation failed.";

const publishIfPossible = async (spaceId: string, sessionId: string, goal: SessionGoal | null) => {
  if (!goal) return;
  await publishSessionGoalUpdated({ spaceId, sessionId, goal }).catch((error) => {
    logger.warn("[Goal] failed to publish goal update", error);
  });
};

const getGoalTool: AgentTool = {
  name: "get_goal",
  label: "get_goal",
  description:
    "Read the current goal for this session: objective, status, token budget, tokens used, elapsed time, and the executor model. Returns { goal: null } when the session has no goal.",
  parameters: Type.Object({}),
  async execute(): Promise<AgentToolResult<unknown>> {
    const context = resolveContext();
    if (!context) return goalFailure("Goal tools require an active session turn.");
    return goalResult(await getSessionGoal(db, context.sessionId));
  },
};

const createGoalParameters = Type.Object({
  objective: Type.String({
    description:
      "Required. The concrete objective to pursue. Create a goal only when the user explicitly asks for one; do not infer goals from ordinary tasks.",
  }),
  token_budget: Type.Optional(Type.Number({
    description:
      "Positive token budget for the goal. Omit unless the user explicitly requested a budget.",
  })),
});

const createGoalTool: AgentTool = {
  name: "create_goal",
  label: "create_goal",
  description:
    "Create a persistent goal for this session. Use only when the user explicitly requests a goal. Fails when the session already has an unfinished goal. The current turn counts toward the new goal.",
  parameters: createGoalParameters,
  async execute(_toolCallId, rawParams): Promise<AgentToolResult<unknown>> {
    const context = resolveContext();
    if (!context) return goalFailure("Goal tools require an active session turn.");
    const params = rawParams as Static<typeof createGoalParameters>;
    try {
      const goal = await setSessionGoal(db, {
        sessionId: context.sessionId,
        objective: params.objective,
        tokenBudget: params.token_budget,
        createdBy: context.actorUserId ?? null,
        includeTurnSequence: context.turnSeq ?? null,
        provider: context.model?.provider ?? null,
        model: context.model?.id ?? null,
        accessMode: context.accessMode ?? "full_access",
        thinkingLevel: (context.thinkingLevel as SessionGoal["thinkingLevel"]) ?? null,
      });
      await publishIfPossible(context.spaceId, context.sessionId, goal);
      return goalResult(goal);
    } catch (error) {
      return goalFailure(describeGoalError(error));
    }
  },
};

const updateGoalParameters = Type.Object({
  status: Type.Union([
    Type.Literal("complete"),
    Type.Literal("blocked"),
    Type.Literal("paused"),
  ], {
    description:
      "Required. complete: the objective is achieved and every explicit requirement has been verified against current evidence. blocked: the same blocking condition has repeated for at least three consecutive goal turns and no safe action remains. paused: only when the user explicitly asked to pause this goal.",
  }),
});

const updateGoalTool: AgentTool = {
  name: "update_goal",
  label: "update_goal",
  description: [
    "Update the existing goal status.",
    "Set complete only when the objective has actually been achieved and no required work remains. Audit every explicit requirement against the current workspace and external state first; uncertain or indirect evidence means keep working.",
    "Set blocked only when the same blocking condition has repeated for at least three consecutive goal turns, counting the user-triggered turn and automatic continuations, and no safe action remains. A resumed goal starts a fresh blocked audit.",
    "Set paused only at the user's explicit request. Never pause on your own.",
    "Do not mark a goal complete because its budget is nearly exhausted or because you are stopping work.",
    "When completing a budgeted goal, report the final token usage from the tool result to the user.",
  ].join(" "),
  parameters: updateGoalParameters,
  async execute(_toolCallId, rawParams): Promise<AgentToolResult<unknown>> {
    const context = resolveContext();
    if (!context) return goalFailure("Goal tools require an active session turn.");
    const params = rawParams as Static<typeof updateGoalParameters>;
    try {
      const goal = await updateSessionGoal(db, context.sessionId, {
        status: params.status as SessionGoalStatus,
      });
      await publishIfPossible(context.spaceId, context.sessionId, goal);
      return goalResult(goal);
    } catch (error) {
      return goalFailure(describeGoalError(error));
    }
  },
};

export function createGoalTools(): AgentTool[] {
  return [getGoalTool, createGoalTool, updateGoalTool];
}

/** Apply a settled turn to its goal and create the next continuation when due. */
export async function handleGoalAfterTurn(input: {
  spaceId: string;
  sessionId: string;
  turnId: string;
}): Promise<{ createdTurnId: string | null; goalChanged: boolean }> {
  const result = await advanceSessionGoalAfterTurn(db, input);
  if (result.goal) {
    await publishIfPossible(input.spaceId, input.sessionId, result.goal);
  }
  return {
    createdTurnId: result.continuation?.id ?? null,
    goalChanged: result.goalChanged,
  };
}
