import { SandboxRpcError } from "@cohub/sandbox-client";
import { displayRpcError, type DisplayErrorResponse } from "@cohub/protocol";

export type { DisplayErrorResponse };

export function displayErrorResponse(error: unknown): DisplayErrorResponse | null {
  // Matched by name like space-fs, so this stays free of the RPC pool's side effects.
  if (error instanceof Error && error.name === "SandboxOfflineError") {
    return { status: 503, code: "sandbox_offline", message: "The machine serving this Space is offline." };
  }
  return error instanceof SandboxRpcError ? displayRpcError(error.rpcErrorCode, error.message) : null;
}
