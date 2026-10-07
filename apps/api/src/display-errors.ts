import { SandboxRpcError } from "@cohub/sandbox-client";

export type DisplayErrorResponse = {
  status: 400 | 404 | 409 | 429 | 501 | 503 | 504;
  code: string;
  message: string;
};

const RPC_ERRORS: Record<string, Pick<DisplayErrorResponse, "status" | "code">> = {
  BAD_REQUEST: { status: 400, code: "invalid_request" },
  NOT_FOUND: { status: 404, code: "display_not_found" },
  UNAVAILABLE: { status: 409, code: "display_unavailable" },
  PREEMPTED: { status: 409, code: "display_preempted" },
  BUSY: { status: 429, code: "display_busy" },
  UNSUPPORTED_METHOD: { status: 501, code: "display_unsupported" },
  TIMEOUT: { status: 504, code: "display_timeout" },
};

export function displayErrorResponse(error: unknown): DisplayErrorResponse | null {
  // Matched by name like space-fs, so this stays free of the RPC pool's side effects.
  if (error instanceof Error && error.name === "SandboxOfflineError") {
    return { status: 503, code: "sandbox_offline", message: "The machine serving this Space is offline." };
  }
  if (!(error instanceof SandboxRpcError)) return null;
  const mapped = RPC_ERRORS[error.rpcErrorCode];
  if (!mapped) return null;
  const message = mapped.code === "display_unsupported" ? "This machine runs an older sandbox: restart the sandbox, or update the Cohub runtime." : error.message;
  return { ...mapped, message };
}
