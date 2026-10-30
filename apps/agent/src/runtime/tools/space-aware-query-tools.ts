import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { getCurrentToolExecutionContext, runWithToolExecutionContext } from "../../tool-context.js";
import type { AgentFileVisibility } from "../workspace-visibility.js";
import { assertCrossSpaceQueryPathAllowed } from "./query-path-policy.js";
import { querySpaceIdParameter, resolveQuerySpaceId } from "./query-space-id.js";

type AccessCheck = (spaceId: string) => Promise<AgentFileVisibility>;
type SandboxProvider = "cloud" | "local";
type SandboxProviderResolver = (spaceId: string) => Promise<SandboxProvider>;

type SpaceAwareToolOptions = {
  sandboxTool: AgentTool;
  crossSpaceTool: AgentTool;
  checkAccess: AccessCheck;
  resolveSandboxProvider: SandboxProviderResolver;
};

function getRequestedSpaceId(params: unknown) {
  if (!params || typeof params !== "object") return undefined;
  return (params as Record<string, unknown>).space_id;
}

function getQueryPath(params: unknown) {
  if (!params || typeof params !== "object") return undefined;
  return (params as Record<string, unknown>).path;
}

function withoutSpaceId(input: unknown) {
  if (!input || typeof input !== "object") return input;
  const { space_id: _spaceId, ...rest } = input as Record<string, unknown>;
  return rest;
}

function routeExecute(options: SpaceAwareToolOptions) {
  const { sandboxTool, crossSpaceTool, checkAccess } = options;
  return async (toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: AgentToolUpdateCallback<unknown>) => {
    const ctx = getCurrentToolExecutionContext();
    if (!ctx?.spaceId) {
      throw new Error("Tool execution context is missing spaceId");
    }

    const targetSpaceId = resolveQuerySpaceId(getRequestedSpaceId(params), ctx.spaceId);
    const isCrossSpace = targetSpaceId !== ctx.spaceId;
    let tool = sandboxTool;
    let visibility = ctx.fileVisibility;

    if (isCrossSpace) {
      assertCrossSpaceQueryPathAllowed(getQueryPath(params));
      visibility = await checkAccess(targetSpaceId);
      const provider = await options.resolveSandboxProvider(targetSpaceId);
      if (provider === "local") {
        if (visibility === "filtered") {
          throw new Error("Filtered file access is not available for local sandboxes.");
        }
      } else {
        tool = crossSpaceTool;
      }
    }

    return runWithToolExecutionContext({
      ...ctx,
      spaceId: targetSpaceId,
      ...(visibility ? { fileVisibility: visibility } : {}),
    }, () => tool.execute(toolCallId, withoutSpaceId(params), signal, onUpdate));
  };
}

export function createSpaceAwareReadTool(options: SpaceAwareToolOptions): AgentTool {
  return {
    ...options.sandboxTool,
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
      offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
      space_id: querySpaceIdParameter,
    }),
    execute: routeExecute(options),
  };
}

export function createSpaceAwareLsTool(options: SpaceAwareToolOptions): AgentTool {
  return {
    ...options.sandboxTool,
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default: 500)" })),
      space_id: querySpaceIdParameter,
    }),
    execute: routeExecute(options),
  };
}

export function createSpaceAwareFindTool(options: SpaceAwareToolOptions): AgentTool {
  return {
    ...options.sandboxTool,
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
      pattern: Type.String({ description: "Glob pattern to match files" }),
      limit: Type.Optional(Type.Number({ description: "Maximum number of results" })),
      space_id: querySpaceIdParameter,
    }),
    execute: routeExecute(options),
  };
}

export function createSpaceAwareGrepTool(options: SpaceAwareToolOptions): AgentTool {
  return {
    ...options.sandboxTool,
    parameters: Type.Object({
      pattern: Type.String({ description: "Search pattern" }),
      path: Type.Optional(Type.String({ description: "Directory or file to search" })),
      glob: Type.Optional(Type.String({ description: "File glob filter" })),
      ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search" })),
      literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string" })),
      context: Type.Optional(Type.Number({ description: "Context lines" })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of matches" })),
      space_id: querySpaceIdParameter,
    }),
    execute: routeExecute(options),
  };
}
