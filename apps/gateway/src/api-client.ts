import type { AuthUserProfile } from "@cohub/identity";
import { AuthorizationError, verifyUserAccessToken } from "@cohub/identity";
import { buildTraceHeaders, getTraceResponseHeaders, type TraceIdentifiers } from "@cohub/infra/tracing";
import type { ContentBlock } from "@cohub/protocol/core";
import type { RealtimeRoom, RealtimeRoomDescriptor } from "@cohub/protocol/realtime";
import type { BillingPayload } from "@cohub/protocol";
import type { GatewayAuthUser } from "./config.js";
import { gatewayConfig } from "./config.js";
import { verifyLocalSandboxAccessToken } from "./local-sandbox-auth.js";

const parseJson = async <T>(response: Response): Promise<T | null> => {
  return response.json().catch(() => null) as Promise<T | null>;
};

export type RealtimeAuthResult =
  | {
      ok: true;
      user: GatewayAuthUser & { uuid: string };
    }
  | {
      ok: false;
      status: 401 | 403;
      error: {
        message: string;
        type: "authentication_error";
      };
    };

export type SessionAuthorizationResult =
  | {
      ok: true;
      user: GatewayAuthUser & { uuid: string };
      spaceId: string;
      sessionId: string;
    }
  | {
      ok: false;
      status: 401 | 403 | 404;
      error: {
        message: string;
        type: "authentication_error" | "invalid_request_error";
      };
    };

export const authenticateRealtimeToken = async (input: { token: string }): Promise<RealtimeAuthResult> => {
  let user: AuthUserProfile;
  try {
    user = await verifyUserAccessToken({ token: input.token, logtoEndpoint: gatewayConfig.logtoEndpoint });
    return {
      ok: true,
      user,
    };
  } catch (error) {
    const status = error instanceof AuthorizationError ? error.status : 401;
    if (status === 403) {
      return {
        ok: false,
        status,
        error: {
          message: "Forbidden",
          type: "authentication_error",
        },
      };
    }
  }

  const response = await fetch(`${gatewayConfig.apiBaseUrl}/api/me`, {
    headers: {
      authorization: `Bearer ${input.token}`,
      ...buildTraceHeaders(),
    },
  }).catch(() => null);
  if (!response?.ok) {
    return {
      ok: false,
      status: response?.status === 403 ? 403 : 401,
      error: {
        message: response?.status === 403 ? "Forbidden" : "Unauthorized",
        type: "authentication_error",
      },
    };
  }
  const data = await parseJson<{ uuid?: string; profile?: { displayName?: string | null; avatarUrl?: string | null } }>(response);
  if (!data?.uuid) {
    return {
      ok: false,
      status: 401,
      error: {
        message: "Unauthorized",
        type: "authentication_error",
      },
    };
  }
  return {
    ok: true,
    user: {
      uuid: data.uuid,
      nick_name: data.profile?.displayName ?? undefined,
      avatar_url: data.profile?.avatarUrl ?? undefined,
    },
  };
};

export const requestGatewayChannelReconcile = async (): Promise<{ stats: unknown }> => {
  const response = await fetch(`${gatewayConfig.apiBaseUrl}/internal/gateway/reconcile-channels`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-worker-secret": gatewayConfig.workerSecret,
      ...buildTraceHeaders(),
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Gateway channel reconcile failed ${response.status}: ${text}`);
  }
  const data = await parseJson<{ ok?: boolean; stats?: unknown }>(response);
  if (!data?.ok) throw new Error("Gateway channel reconcile returned an invalid response");
  return { stats: data.stats };
};

export const notifySpacePresenceUpdated = async (spaceId: string): Promise<void> => {
  const response = await fetch(`${gatewayConfig.apiBaseUrl}/internal/gateway/space-presence-updated`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-worker-secret": gatewayConfig.workerSecret,
      ...buildTraceHeaders(),
    },
    body: JSON.stringify({ spaceId }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Space presence update failed ${response.status}: ${text}`);
  }
};

export const authorizeAppRoom = async (input: {
  authToken: string;
  roomId: string;
  ticket: string;
}): Promise<{ room: RealtimeRoomDescriptor; participantId: string; userKey: string }> => {
  const response = await fetch(`${gatewayConfig.apiBaseUrl}/internal/gateway/authorize-app-room`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-worker-secret": gatewayConfig.workerSecret,
      authorization: `Bearer ${input.authToken}`,
      ...buildTraceHeaders(),
    },
    body: JSON.stringify({ roomId: input.roomId, ticket: input.ticket }),
  });
  const data = await parseJson<{ ok?: boolean; room?: RealtimeRoomDescriptor; participantId?: string; userKey?: string; message?: string }>(response);
  if (!response.ok || !data?.ok || !data.room || !data.participantId || !data.userKey) {
    throw new Error(data?.message || `App room authorization failed ${response.status}`);
  }
  return { room: data.room, participantId: data.participantId, userKey: data.userKey };
};

export const authorizeBoardAwareness = async (input: {
  authToken: string;
  boardId: string;
  spaceId: string;
  permission: "view" | "edit";
}): Promise<boolean> => {
  const response = await fetch(`${gatewayConfig.apiBaseUrl}/internal/gateway/authorize-board-awareness`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-worker-secret": gatewayConfig.workerSecret,
      authorization: `Bearer ${input.authToken}`,
      ...buildTraceHeaders(),
    },
    body: JSON.stringify({
      boardId: input.boardId,
      spaceId: input.spaceId,
      permission: input.permission,
    }),
  });
  return response.ok;
};

export const authorizeRealtimeRooms = async (input: {
  authToken: string;
  rooms: string[];
}): Promise<{ rooms: RealtimeRoom[]; rejected: Array<{ room: string; code: "BAD_ROOM" | "FORBIDDEN"; message: string }> }> => {
  const response = await fetch(`${gatewayConfig.apiBaseUrl}/internal/gateway/authorize-realtime-rooms`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-worker-secret": gatewayConfig.workerSecret,
      authorization: `Bearer ${input.authToken}`,
      ...buildTraceHeaders(),
    },
    body: JSON.stringify({ rooms: input.rooms }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Realtime room authorization failed ${response.status}: ${text}`);
  }
  const data = await parseJson<{ ok?: boolean; rooms?: string[]; rejected?: Array<{ room: string; code: "BAD_ROOM" | "FORBIDDEN"; message: string }> }>(response);
  if (!data?.ok || !Array.isArray(data.rooms)) throw new Error("Realtime room authorization returned an invalid response");
  return {
    rooms: data.rooms as RealtimeRoom[],
    rejected: Array.isArray(data.rejected) ? data.rejected : [],
  };
};

/** Carries a standard billing error body from the internal prompt API. */
export class InternalPromptError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly billing: BillingPayload | null,
  ) {
    super(message);
    this.name = "InternalPromptError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isBillingErrorBody(value: unknown): value is { code: string; message?: string; billing: BillingPayload } {
  if (!isRecord(value)) return false;
  return typeof value.code === "string" && isRecord(value.billing);
}

export const submitInternalSessionPrompt = async (input: {
  spaceId: string;
  sessionId: string;
  userId: string;
  authToken?: string | null;
  clientMessageId: string;
  content: ContentBlock[];
  source: string;
  model?: string | null;
  provider?: string | null;
  harness?: "cohub" | "pi" | "codex";
  thinkingLevel?: string | null;
  context?: Record<string, unknown> | null;
}): Promise<{ ok: true; turnId: string; userMessageId: string; trace: TraceIdentifiers }> => {
  const requestId = typeof input.context?.requestId === "string" ? input.context.requestId : null;
  const response = await fetch(`${gatewayConfig.apiBaseUrl}/internal/spaces/${input.spaceId}/sessions/${input.sessionId}/prompt`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-worker-secret": gatewayConfig.workerSecret,
      ...buildTraceHeaders({ requestId }),
    },
    body: JSON.stringify({
      content: input.content,
      userId: input.userId,
      authToken: input.authToken ?? null,
      clientMessageId: input.clientMessageId,
      source: input.source,
      model: input.model ?? null,
      provider: input.provider ?? null,
      harness: input.harness ?? "cohub",
      thinkingLevel: input.thinkingLevel ?? null,
      context: input.context ?? null,
    }),
  });

  if (!response.ok) {
    const body = await parseJson<unknown>(response);
    if (isBillingErrorBody(body)) {
      throw new InternalPromptError(body.message ?? "prompt blocked", body.code, body.billing);
    }
    const message = isRecord(body) && typeof body.message === "string" ? body.message : null;
    throw new Error(message ?? `Internal prompt submit failed ${response.status}`);
  }
  const data = await parseJson<{ ok?: boolean; turnId?: string; userMessageId?: string }>(response);
  if (!data?.ok || !data.turnId || !data.userMessageId) {
    throw new Error("Internal prompt submit returned an invalid response");
  }
  return { ok: true, turnId: data.turnId, userMessageId: data.userMessageId, trace: getTraceResponseHeaders(response) };
};

export const authorizeSessionAccess = async (input: {
  token: string;
  spaceId: string;
  sessionId: string;
}): Promise<SessionAuthorizationResult> => {
  const sessionResponse = await fetch(`${gatewayConfig.apiBaseUrl}/api/sessions/${input.sessionId}`, {
    headers: {
      authorization: `Bearer ${input.token}`,
      ...buildTraceHeaders(),
    },
  });

  if (sessionResponse.status === 401 || sessionResponse.status === 403) {
    return {
      ok: false,
      status: sessionResponse.status,
      error: {
        message: sessionResponse.status === 403 ? "Forbidden" : "Unauthorized",
        type: "authentication_error",
      },
    };
  }

  if (sessionResponse.status === 404) {
    return {
      ok: false,
      status: 404,
      error: {
        message: "Session not found",
        type: "invalid_request_error",
      },
    };
  }

  if (!sessionResponse.ok) {
    const text = await sessionResponse.text().catch(() => "");
    throw new Error(`Session authorization failed ${sessionResponse.status}: ${text}`);
  }

  const data = await parseJson<{
    space?: { id?: string };
    session?: { id?: string };
    user?: GatewayAuthUser;
  }>(sessionResponse);

  if (!data?.space?.id || !data?.session?.id) {
    return {
      ok: false,
      status: 404,
      error: {
        message: "Session not found",
        type: "invalid_request_error",
      },
    };
  }

  if (data.space.id !== input.spaceId || data.session.id !== input.sessionId) {
    return {
      ok: false,
      status: 404,
      error: {
        message: "Session does not belong to space",
        type: "invalid_request_error",
      },
    };
  }

  const user = data.user;
  if (!user?.uuid) {
    return {
      ok: false,
      status: 401,
      error: {
        message: "Unauthorized",
        type: "authentication_error",
      },
    };
  }

  return {
    ok: true,
    user: user as GatewayAuthUser & { uuid: string },
    spaceId: data.space.id,
    sessionId: data.session.id,
  };
};

export type LocalSandboxAuthorizeResult =
  | { ok: true; spaceId: string; userId: string }
  | { ok: false; status: number; message: string };

// Authorize a local sandbox runner's control connection. The user's access
// token is verified locally first so expired leftovers never hit the API, then
// forwarded so the API can check sandbox.manage on the target space.
export const authorizeLocalSandbox = async (input: {
  authToken: string;
  spaceId: string;
}): Promise<LocalSandboxAuthorizeResult> => {
  const local = await verifyLocalSandboxAccessToken(input.authToken);
  if (!local.ok) return local;

  const response = await fetch(`${gatewayConfig.apiBaseUrl}/internal/gateway/local-sandbox/authorize`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-worker-secret": gatewayConfig.workerSecret,
      authorization: `Bearer ${input.authToken}`,
      ...buildTraceHeaders(),
    },
    body: JSON.stringify({ spaceId: input.spaceId }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await parseJson<{ ok?: boolean; spaceId?: string; userId?: string; message?: string }>(response);
  if (!response.ok || !data?.ok || !data.spaceId || !data.userId) {
    return { ok: false, status: response.status, message: data?.message ?? "authorization failed" };
  }
  return { ok: true, spaceId: data.spaceId, userId: data.userId };
};

// Report a local sandbox connection state transition (ready on connect,
// stopped on disconnect). The gateway is the sole reporter for local sandboxes.
export const reportLocalSandboxStatus = async (input: {
  spaceId: string;
  status: "ready" | "stopped";
  wsEndpoint?: string | null;
  hostname?: string | null;
  gatewayNodeId?: string | null;
  runtimeId?: string | null;
  connectionId?: string;
}): Promise<void> => {
  const response = await fetch(`${gatewayConfig.apiBaseUrl}/internal/gateway/local-sandbox/status`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-worker-secret": gatewayConfig.workerSecret,
      ...buildTraceHeaders(),
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Local sandbox status report failed ${response.status}: ${text}`);
  }
};
