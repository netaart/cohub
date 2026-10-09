import { createLogger } from "@cohub/infra/logging";
import { getCurrentRequestId } from "@cohub/infra/tracing";
import type { BoardDiagnostic } from "@cohub/protocol";
import { BoardError } from "@cohub/core/board";

const logger = createLogger({ serviceName: "cohub-api" });

export type BoardErrorResponse = {
  status: number;
  code: string;
  message: string;
  diagnostics?: BoardDiagnostic[];
  requestId?: string;
};

export function boardInputDiagnostics(
  error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] },
  prefix = "input",
): BoardDiagnostic[] {
  return error.issues.slice(0, 32).map((issue) => ({
    severity: "error",
    code: "INVALID_BOARD_INPUT",
    message: issue.message,
    path: [prefix, ...issue.path].map(String).join("."),
  }));
}

export function boardErrorResponse(error: unknown): BoardErrorResponse {
  if (error instanceof BoardError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      ...(error.diagnostics.length ? { diagnostics: error.diagnostics.slice(0, 32) } : {}),
    };
  }
  if (
    error instanceof Error &&
    error.name === "SpaceFsError" &&
    "status" in error && typeof error.status === "number" &&
    "code" in error && typeof error.code === "string"
  ) {
    return { status: error.status, code: error.code, message: error.message };
  }
  const requestId = getCurrentRequestId() ?? undefined;
  logger.error("[Board] unexpected operation failure", { error, requestId });
  return {
    status: 500,
    code: "BOARD_OPERATION_FAILED",
    message: "Could not complete the Board operation.",
    ...(requestId ? { requestId } : {}),
  };
}

export function boardErrorBody(response: BoardErrorResponse) {
  return {
    code: response.code,
    message: response.message,
    ...(response.diagnostics?.length ? { diagnostics: response.diagnostics } : {}),
    ...(response.requestId ? { requestId: response.requestId } : {}),
  };
}
