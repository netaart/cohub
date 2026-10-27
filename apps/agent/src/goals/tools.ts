import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { SessionGoalError, advanceSessionGoalAfterTurn, updateSessionGoal } from "@cohub/core/sessions";
import { createToolFailure } from "../runtime/tools/index.js";
import { getCurrentToolExecutionContext } from "../tool-context.js";
import { db } from "../db.js";

const goalFailure = (message: string): AgentToolResult<unknown> => ({
  content: [{ type: "text", text: message }],
  details: { ...createToolFailure(message, { retryable: false }), error: message },
});

const updateGoalParameters = Type.Object({
  status: Type.Union([Type.Literal("complete"), Type.Literal("blocked")], {
    description: "complete: every explicit requirement was verified against current evidence. blocked: the same blocking condition repeated and no safe action remains.",
  }),
});

const updateGoalTool: AgentTool = {
  name: "update_goal",
  label: "update_goal",
  description: "Finish the active goal. Set complete only after auditing every requirement; set blocked only when no safe action remains.",
  parameters: updateGoalParameters,
  async execute(_toolCallId, rawParams): Promise<AgentToolResult<unknown>> {
    const context = getCurrentToolExecutionContext();
    if (!context?.sessionId || !context.goalId) return goalFailure("Goal tools require an active goal turn.");
    if (context.promptAuthType === "app_session" || context.promptAuthType === "delegated_prompt" || (context.executionScopes?.length ?? 0) > 0) {
      return goalFailure("Goals can only be changed from a user session.");
    }
    try {
      const goal = await updateSessionGoal(db, context.sessionId, { status: (rawParams as Static<typeof updateGoalParameters>).status }, context.goalId);
      return { content: [{ type: "text", text: JSON.stringify({ goal }, null, 2) }], details: { goal } };
    } catch (error) {
      return goalFailure(error instanceof SessionGoalError ? error.message : "Goal update failed.");
    }
  },
};

export function createGoalTools(): AgentTool[] {
  return [updateGoalTool];
}

export async function handleGoalAfterTurn(input: { spaceId: string; sessionId: string; turnId: string }) {
  const result = await advanceSessionGoalAfterTurn(db, input);
  return { createdTurnId: result.continuation?.id ?? null };
}
