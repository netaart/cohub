import type { SpacePublicEndpoints } from "@cohub/protocol/ports";
import type { ContentBlock } from "@cohub/protocol/core";
import { BoardAuthoringItemSchema, SPACE_HOOK_WEBHOOK_SECRET_HEADER } from "@cohub/protocol";
import type {
  PublicFileCreateUploadInput,
  PublicFileCreateUploadResponse,
  PublicFileListResponse,
  PublicFileUrlResponse,
  SpaceWebhookListItem,
  SpaceWebhookTriggerResponse,
} from "@cohub/protocol";
import {
  getRealtimeBoardRoom,
  getRealtimeSpaceRoom,
  type BoardAwarenessUpdatedEvent as ProtocolBoardAwarenessUpdatedEvent,
  type BoardChangedEvent as ProtocolBoardChangedEvent,
  type BoardPlaybackChangedEvent as ProtocolBoardPlaybackChangedEvent,
} from "@cohub/protocol/realtime/types";
import type { BoardAwarenessUpdate } from "@cohub/protocol/realtime";
import { ensureRealtimeConnected } from "../realtime.js";
import type { WebsocketClient, WebsocketEventPayload } from "../websocket.js";
import { HttpError, type HttpTransport, type Fetch } from "../transport.js";
import {
  SessionPatchReducer,
  type SessionPatchApplyInput,
  type SessionPatchApplyResult,
} from "../session-patch-reducer.js";
import {
  SessionGenerationStreamClient,
  type GenerationStreamSubscribeOptions,
  type GenerationStreamSubscriptionHandlers,
} from "../session-generation-stream.js";
import type {
  CheckpointDiffFileResponse,
  CheckpointDiffSummary,
  CheckpointRecord,
  SessionForkRecord,
  SessionMessageResponse,
  SessionMessagesPaginatedResponse,
  SessionMessagesResponse,
  SessionTurnResponse,
  SessionTurnRecord,
  SessionTurnStreamSnapshotResponse,
  SessionTurnIndexResponse,
  SessionTurnWindowResponse,
  SessionTurnsPaginatedResponse,
  SessionTurnSignedUrlsResponse,
  MessageToolCallsFile,
  StoredIntermediateMessage,
  StoredToolCall,
  TurnIntermediateMessagesFile,
  SessionRecord,
  SpaceAccessPolicy,
  SpaceCheckpointDetailResponse,
  SpaceCreateResponse,
  SpacePendingDiffFileResponse,
  SpacePendingDiffSummary,
  SpacePresenceSnapshot,
  SpaceDefaultResponse,
  CreateSpacePromptInput,
  CreateSpacePromptResponse,
  CreateSpaceCompletionInput,
  SpaceCompletionResult,
  SpaceCompletionStreamEvent,
  SpaceEnvInput,
  SpaceFsCompleteUploadInput,
  SpaceFsCompleteUploadResponse,
  SpaceFsCreateUploadInput,
  SpaceFsCreateUploadResponse,
  SpaceFsFileResponse,
  SpaceFsPreparingFile,
  SpaceFsReadFilesResponse,
  SpaceFsMoveInput,
  SpaceFsTreeResponse,
  SpaceFsUploadResponse,
  SpaceUsageResponse,
  SpaceActivityResponse,
  SpaceStartupResponse,
  SpaceFsWriteFileInput,
  LabelItemsResponse,
  LabelAssignmentRecord,
  LabelListItem,
  LabelResourceType,
  PatchResourceLabelsInput,
  PatchResourceLabelsResponse,
  SpaceModListItem,
  SpaceMember,
  SpaceRecord,
  SpaceRole,
  SpaceSessionsResponse,
  SpaceTurnAuthorFilter,
  SpaceTurnsResponse,
  CreateSpaceSessionInput,
  CreateSpaceInput,
  SpaceConfigInput,
  SpaceConfigResponse,
  SpaceConfigUpdateResponse,
  BoardAuthoringReadInput,
  BoardAuthoringSnapshot,
  BoardCapabilities,
  BoardCreateInput,
  BoardMutationReceipt,
  BoardPlaybackCommand,
  BoardPlaybackSnapshot,
  BoardSemanticMutation,
  BoardSummary,
  BoardTransactionsPage,
  BoardTransactionsReadInput,
  ChannelConfig,
  ChannelHealth,
} from "../types.js";
import { SpaceInvitationsApi } from "./invitations.js";


async function fetchTurnObject<T>(url: string, fetchImpl: Fetch = globalThis.fetch, signal?: AbortSignal): Promise<T> {
  const response = await fetchImpl(url, { signal });
  if (!response.ok) throw new Error(`Failed to fetch turn object: HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

function extractToolCalls(content: ContentBlock[]): StoredToolCall[] {
  const byId = new Map<string, StoredToolCall>();
  for (const block of content) {
    if (block.type === "tool_use") {
      byId.set(block.id, { id: block.id, name: block.name, input: block.input, meta: block._meta ?? null, result: null });
    }
  }
  for (const block of content) {
    if (block.type !== "tool_result") continue;
    const existing = byId.get(block.tool_use_id);
    if (existing) byId.set(block.tool_use_id, {
      ...existing,
      result: { content: block.content, isError: Boolean(block.is_error), meta: block._meta ?? null },
    });
  }
  return [...byId.values()];
}

const getFilenameFromContentDisposition = (value: string | null) => {
  if (!value) return null;

  const encodedMatch = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (encodedMatch?.[1]) {
    try {
      return decodeURIComponent(encodedMatch[1]);
    } catch {
      return encodedMatch[1];
    }
  }

  const plainMatch = value.match(/filename="?([^";]+)"?/i);
  return plainMatch?.[1] ?? null;
};

/**
 * Identifier for a client-authored Board entity (connection id, transaction id).
 *
 * `crypto.randomUUID` is used where available and falls back to a random string
 * otherwise, so the SDK works in a plain browser, a worker and Node without
 * pulling in a polyfill.
 */
function randomBoardId(): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef && typeof cryptoRef.randomUUID === "function") return cryptoRef.randomUUID();
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
export type BoardChangedEvent = ProtocolBoardChangedEvent;
export type BoardAwarenessUpdatedEvent = ProtocolBoardAwarenessUpdatedEvent;
export type BoardPlaybackChangedEvent = ProtocolBoardPlaybackChangedEvent;
export type BoardEventName = "changed" | "awareness" | "playback";
export type BoardSubscriptionHandlers = {
  changed?: (event: BoardChangedEvent) => void;
  awareness?: (event: BoardAwarenessUpdatedEvent) => void;
  playback?: (event: BoardPlaybackChangedEvent) => void;
  event?: (event: BoardChangedEvent | BoardAwarenessUpdatedEvent | BoardPlaybackChangedEvent) => void;
};

export type SessionSubscriptionHandlers = {
  patch?: (event: WebsocketEventPayload) => void;
  /** @deprecated Use `session.subscribeGeneration({ state })`. */
  patchState?: (result: SessionPatchApplyResult) => void;
  turnUpdated?: (event: WebsocketEventPayload) => void;
  turnFinalized?: (event: WebsocketEventPayload) => void;
  /** A failed turn, or a rejected subscription (`system.subscribe.error`). */
  error?: (event: WebsocketEventPayload) => void;
  persisted?: (event: WebsocketEventPayload) => void;
  event?: (event: WebsocketEventPayload) => void;
};

export type SessionEventName = "created" | "updated" | "turn.created" | "turn.patch" | "turn.lifecycle" | "turn.updated" | "turn.finalized" | "turn.error" | "message.persisted";
export type SpaceEventName = SessionEventName | "fs.changed" | "ports.changed" | "presence.updated" | "board.changed" | "board.playback.changed" | "app.version.published" | "task.created" | "task.updated" | "event";

const toSessionEventName = (type: WebsocketEventPayload["type"]): SessionEventName | null => {
  switch (type) {
    case "session.created":
      return "created";
    case "session.updated":
      return "updated";
    case "session.turn.created":
      return "turn.created";
    case "session.turn.patch":
      return "turn.patch";
    case "session.turn.error":
      return "turn.error";
    case "session.turn.lifecycle":
      return "turn.lifecycle";
    case "session.turn.updated":
      return "turn.updated";
    case "session.turn.finalized":
      return "turn.finalized";
    case "session.message.persisted":
      return "message.persisted";
    default:
      return null;
  }
};

const isAssistantFinalPersistedEvent = (event: WebsocketEventPayload) => {
  if (event.type !== "session.message.persisted") return false;
  const message = event.payload.message;
  if (!message || typeof message !== "object") return false;
  const record = message as {
    role?: unknown;
    meta?: Record<string, unknown> | null;
  };
  return record.role === "assistant" && (record.meta?.messageKind === "assistant_final" || record.meta?.messageKind === "assistant_error");
};

const isAssistantIntermediatePersistedEvent = (event: WebsocketEventPayload) => {
  if (event.type !== "session.message.persisted") return false;
  const message = event.payload.message;
  if (!message || typeof message !== "object") return false;
  const record = message as {
    role?: unknown;
    meta?: Record<string, unknown> | null;
  };
  return record.role === "assistant" && record.meta?.messageKind === "assistant_intermediate";
};

const getPersistedMessageTurnId = (event: WebsocketEventPayload) => {
  if (event.type !== "session.message.persisted") return null;
  const message = event.payload.message;
  if (!message || typeof message !== "object") return null;
  const meta = (message as { meta?: Record<string, unknown> | null }).meta;
  return typeof meta?.turnId === "string" ? meta.turnId : null;
};

export class SpacesApi {
  constructor(private readonly transport: HttpTransport) {}

  list(customFetch?: Fetch) {
    return this.transport.request<SpaceRecord[]>("/api/spaces", {
      method: "GET",
      fetch: customFetch,
    });
  }

  /**
   * Resolve the user's default space (owned/member home, else most recent).
   * When the account has no accessible space, the API creates a blank Home
   * space (`slug=home`) and returns it.
   */
  getDefault(customFetch?: Fetch) {
    return this.transport.request<SpaceDefaultResponse>("/api/spaces/default", {
      method: "GET",
      fetch: customFetch,
    });
  }

  get(spaceId: string, customFetch?: Fetch) {
    return this.transport.request<SpaceRecord>(`/api/spaces/${spaceId}`, {
      fetch: customFetch,
    });
  }

  getBySlug(username: string, slug: string, customFetch?: Fetch) {
    return this.transport.request<SpaceRecord>(
      `/api/spaces/by-slug/${encodeURIComponent(username)}/${encodeURIComponent(slug)}`,
      { fetch: customFetch },
    );
  }

  create(
    input: CreateSpaceInput,
    headers?: Record<string, string>,
  ) {
    return this.transport.request<SpaceCreateResponse>("/api/spaces", {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    });
  }
}

export type SpaceFileUrlPurpose = "preview" | "playback";

export type ResolveSpaceFileUrlOptions = {
  /** Playback only accepts a streamable URL; previews may fall back to a data URL. */
  purpose?: SpaceFileUrlPurpose;
  /** Maximum time to wait while CDN delivery is being prepared. */
  timeoutMs?: number;
  signal?: AbortSignal;
  fetch?: Fetch;
};

function inlineFileDataUrl(file: SpaceFsFileResponse) {
  const mimeType = file.mimeType ?? "application/octet-stream";
  return file.encoding === "base64"
    ? `data:${mimeType};base64,${file.content}`
    : `data:${mimeType};charset=utf-8,${encodeURIComponent(file.content)}`;
}

function spaceFileAbortReason(signal: AbortSignal) {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function waitForSpaceFileRetry(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.reject(spaceFileAbortReason(signal));
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(finish, ms);
    const onAbort = () => {
      if (signal) finish(spaceFileAbortReason(signal));
    };
    function finish(error?: unknown) {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (error !== undefined) reject(error);
      else resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function createSpaceFileDeadlineSignal(signal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => {
    if (signal) controller.abort(spaceFileAbortReason(signal));
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => {
    if (controller.signal.aborted) return;
    timedOut = true;
    controller.abort(new DOMException("Space file URL resolution timed out", "TimeoutError"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

export class SpacePublicFilesApi {
  constructor(
    private readonly transport: HttpTransport,
    private readonly spaceId: string,
  ) {}

  createUpload(input: PublicFileCreateUploadInput, options: { signal?: AbortSignal } = {}) {
    return this.transport.request<PublicFileCreateUploadResponse>(
      `/api/spaces/${this.spaceId}/public/uploads`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: options.signal,
      },
    );
  }

  list(path = "", options: {
    recursive?: boolean;
    limit?: number;
    cursor?: string;
    fetch?: Fetch;
  } = {}) {
    const params = new URLSearchParams();
    if (path) params.set("path", path);
    if (options.recursive) params.set("recursive", "true");
    if (options.limit != null) params.set("limit", String(options.limit));
    if (options.cursor) params.set("cursor", options.cursor);
    const query = params.toString();
    return this.transport.request<PublicFileListResponse>(
      `/api/spaces/${this.spaceId}/public${query ? `?${query}` : ""}`,
      { fetch: options.fetch },
    );
  }

  url(path: string, customFetch?: Fetch) {
    const params = new URLSearchParams({ path });
    return this.transport.request<PublicFileUrlResponse>(
      `/api/spaces/${this.spaceId}/public/url?${params.toString()}`,
      { fetch: customFetch },
    );
  }
}

export class SpaceFilesApi {
  constructor(
    private readonly transport: HttpTransport,
    private readonly spaceId: string,
  ) {}

  list(path = "", customFetch?: Fetch) {
    const params = new URLSearchParams();
    if (path) params.set("path", path);
    const query = params.toString();
    return this.transport.request<SpaceFsTreeResponse>(
      `/api/spaces/${this.spaceId}/fs/tree${query ? `?${query}` : ""}`,
      { fetch: customFetch },
    );
  }

  read(path: string, customFetch?: Fetch, signal?: AbortSignal) {
    const params = new URLSearchParams({ path });
    return this.transport.request<SpaceFsFileResponse | SpaceFsPreparingFile>(
      `/api/spaces/${this.spaceId}/fs/file?${params.toString()}`,
      { fetch: customFetch, signal },
    );
  }

  /** Resolve a browser-ready file URL, waiting for CDN delivery when necessary. */
  async resolveUrl(path: string, options: ResolveSpaceFileUrlOptions = {}) {
    const purpose = options.purpose ?? "preview";
    const requestedTimeoutMs = options.timeoutMs ?? 15_000;
    const timeoutMs = Number.isFinite(requestedTimeoutMs)
      ? Math.max(0, requestedTimeoutMs)
      : 15_000;
    const deadlineAt = Date.now() + timeoutMs;
    const deadline = createSpaceFileDeadlineSignal(options.signal, timeoutMs);
    try {
      while (true) {
        const file = await this.read(path, options.fetch, deadline.signal);
        if (deadline.timedOut()) return null;
        if ("content" in file) {
          if (file.delivery === "url" && file.url) return file.url;
          return purpose === "preview" ? inlineFileDataUrl(file) : null;
        }
        const remainingMs = deadlineAt - Date.now();
        if (remainingMs <= 0) return null;
        const retryAfterMs = Math.max(250, Math.min(file.retryAfterMs, 2_000));
        await waitForSpaceFileRetry(Math.min(retryAfterMs, remainingMs), deadline.signal);
      }
    } catch (error) {
      if (deadline.timedOut()) return null;
      throw error;
    } finally {
      deadline.dispose();
    }
  }

  /** Pending workspace changes vs the space head checkpoint. */
  diff(customFetch?: Fetch) {
    return this.transport.request<SpacePendingDiffSummary>(
      `/api/spaces/${this.spaceId}/fs/diff`,
      { fetch: customFetch },
    );
  }

  /** Per-file pending workspace diff vs the space head checkpoint. */
  diffFile(path: string, customFetch?: Fetch) {
    const params = new URLSearchParams({ path });
    return this.transport.request<SpacePendingDiffFileResponse>(
      `/api/spaces/${this.spaceId}/fs/diff/file?${params.toString()}`,
      { fetch: customFetch },
    );
  }

  readMany(paths: string[], customFetch?: Fetch) {
    return this.transport.request<SpaceFsReadFilesResponse>(
      `/api/spaces/${this.spaceId}/fs/files`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths }),
        fetch: customFetch,
      },
    );
  }

  /**
   * Build a direct download URL. For private files, prefer `download()` so the
   * SDK can attach authorization headers.
   */
  getDownloadUrl(path: string) {
    const params = new URLSearchParams({ path });
    return `/api/spaces/${this.spaceId}/fs/download?${params.toString()}`;
  }

  createPreviewSession(customFetch?: Fetch) {
    return this.transport.request<{ token: string; expiresIn: number }>(
      `/api/spaces/${this.spaceId}/preview-session`,
      { method: "POST", fetch: customFetch },
    );
  }

	async download(path: string, customFetch?: Fetch) {
		const params = new URLSearchParams({ path });
		const raw = await this.transport.raw(
			`/api/spaces/${this.spaceId}/fs/download?${params.toString()}`,
			{ fetch: customFetch },
		);
		if (raw.response.status === 202) {
			throw new HttpError(
				"File is being prepared. Please retry shortly.",
				202,
				await raw.json().catch(() => null),
			);
		}
		const blob = await raw.blob();
		const filename =
			getFilenameFromContentDisposition(
				raw.response.headers.get("content-disposition"),
			) ??
			path.split("/").pop() ??
			"download";
		const mimeType =
			raw.response.headers.get("content-type") ??
			blob.type ??
			"application/octet-stream";

		return { blob, filename, mimeType };
	}

  write(input: SpaceFsWriteFileInput) {
    return this.transport.request<{ ok: true; path: string; size: number; mtimeMs: number }>(
      `/api/spaces/${this.spaceId}/fs/file`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }

  createDir(path: string, mutationId?: string) {
    return this.transport.request<{ ok: true; path: string; size: number; mtimeMs: number }>(
      `/api/spaces/${this.spaceId}/fs/dir`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, ...(mutationId ? { mutationId } : {}) }),
      },
    );
  }

  delete(path: string, recursive = false, mutationId?: string) {
    const params = new URLSearchParams({ path });
    if (recursive) params.set("recursive", "true");
    if (mutationId) params.set("mutationId", mutationId);
    return this.transport.request<{ ok: true; path: string }>(
      `/api/spaces/${this.spaceId}/fs/node?${params.toString()}`,
      { method: "DELETE" },
    );
  }

  move(input: SpaceFsMoveInput) {
    return this.transport.request<{ ok: true; fromPath: string; toPath: string }>(
      `/api/spaces/${this.spaceId}/fs/move`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }

  upload(files: File[], dir = "") {
    const params = new URLSearchParams();
    if (dir) params.set("dir", dir);
    const query = params.toString();
    const formData = new FormData();
    for (const file of files) formData.append("files", file);
    return this.transport.request<SpaceFsUploadResponse>(
      `/api/spaces/${this.spaceId}/fs/upload${query ? `?${query}` : ""}`,
      {
        method: "POST",
        body: formData,
      },
    );
  }

  createUpload(input: SpaceFsCreateUploadInput, options: { signal?: AbortSignal } = {}) {
    return this.transport.request<SpaceFsCreateUploadResponse>(
      `/api/spaces/${this.spaceId}/fs/uploads`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: options.signal,
      },
    );
  }

  completeUpload(uploadId: string, input: SpaceFsCompleteUploadInput) {
    return this.transport.request<SpaceFsCompleteUploadResponse>(
      `/api/spaces/${this.spaceId}/fs/uploads/${uploadId}/complete`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }
}

class SessionMessagesClient {
  constructor(
    private readonly transport: HttpTransport,
    private readonly sessionId: string,
  ) {}

  list(customFetch?: Fetch) {
    return this.transport.request<SessionMessagesResponse>(
      `/api/sessions/${this.sessionId}/messages`,
      {
        fetch: customFetch,
      },
    );
  }

  get(
    messageId: string,
    optionsOrFetch?: { detail?: "summary" | "full" } | Fetch,
    customFetch?: Fetch,
  ) {
    const options = typeof optionsOrFetch === "function" ? undefined : optionsOrFetch;
    const fetch = typeof optionsOrFetch === "function" ? optionsOrFetch : customFetch;
    const params = new URLSearchParams();
    if (options?.detail) params.set("detail", options.detail);
    const query = params.toString();
    return this.transport.request<SessionMessageResponse>(
      `/api/sessions/${this.sessionId}/messages/${messageId}${query ? `?${query}` : ""}`,
      {
        fetch,
      },
    );
  }

  listPaginated(
    options?: {
      cursor?: number;
      limit?: number;
      direction?: "older" | "newer";
    },
    customFetch?: Fetch,
  ) {
    const params = new URLSearchParams();
    if (options?.cursor !== undefined) params.set("cursor", String(options.cursor));
    if (options?.limit !== undefined) params.set("limit", String(options.limit));
    if (options?.direction) params.set("direction", options.direction);
    const query = params.toString();
    return this.transport.request<SessionMessagesPaginatedResponse>(
      `/api/sessions/${this.sessionId}/messages${query ? `?${query}` : ""}`,
      {
        fetch: customFetch,
      },
    );
  }

}

class SessionTurnsClient {
  readonly intermediate: {
    get: (turnId: string, messagesObjectKey?: string | null, options?: { fetch?: Fetch; signal?: AbortSignal }) => Promise<TurnIntermediateMessagesFile | null>;
    getToolCalls: (turnId: string, message: StoredIntermediateMessage, options?: { fetch?: Fetch; signal?: AbortSignal }) => Promise<MessageToolCallsFile | null>;
  };

  constructor(
    private readonly transport: HttpTransport,
    private readonly sessionId: string,
    private readonly spaceId: string,
  ) {
    this.intermediate = {
      get: (turnId, messagesObjectKey, options) => this.getIntermediate(turnId, messagesObjectKey, options),
      getToolCalls: (turnId, message, options) => this.getToolCalls(turnId, message, options),
    };
  }

  private async getIntermediate(turnId: string, messagesObjectKey?: string | null, options?: { fetch?: Fetch; signal?: AbortSignal }) {
    const objectKey = messagesObjectKey === undefined
      ? (await this.get(turnId, options)).turn.intermediateIndex?.messagesObjectKey
      : messagesObjectKey;
    if (!objectKey) return null;
    const { urls } = await this.signedUrls(turnId, [objectKey], options);
    const url = urls[objectKey];
    if (!url) throw new Error("Missing signed URL for intermediate messages");
    return fetchTurnObject<TurnIntermediateMessagesFile>(url, options?.fetch, options?.signal);
  }

  private async getToolCalls(turnId: string, message: StoredIntermediateMessage, options?: { fetch?: Fetch; signal?: AbortSignal }) {
    if (!message.toolCallsObjectKey) {
      const toolCalls = extractToolCalls(message.content);
      return toolCalls.length === 0 ? null : {
        version: 1 as const,
        spaceId: this.spaceId,
        sessionId: this.sessionId,
        turnId,
        messageId: message.id,
        toolCalls,
      };
    }
    const { urls } = await this.signedUrls(turnId, [message.toolCallsObjectKey], options);
    const url = urls[message.toolCallsObjectKey];
    if (!url) throw new Error("Missing signed URL for tool calls");
    return fetchTurnObject<MessageToolCallsFile>(url, options?.fetch, options?.signal);
  }

  listPaginated(
    options?: {
      cursor?: number;
      limit?: number;
      direction?: "older" | "newer";
    },
    request?: Fetch | { fetch?: Fetch; signal?: AbortSignal },
  ) {
    const customFetch = typeof request === "function" ? request : request?.fetch;
    const signal = typeof request === "function" ? undefined : request?.signal;
    const params = new URLSearchParams();
    if (options?.cursor !== undefined) params.set("cursor", String(options.cursor));
    if (options?.limit !== undefined) params.set("limit", String(options.limit));
    if (options?.direction) params.set("direction", options.direction);
    const query = params.toString();
    return this.transport.request<SessionTurnsPaginatedResponse>(
      `/api/sessions/${this.sessionId}/turns${query ? `?${query}` : ""}`,
      { fetch: customFetch, signal },
    );
  }

  index(
    options?: {
      cursor?: number;
      limit?: number;
    },
    customFetch?: Fetch,
  ) {
    const params = new URLSearchParams();
    if (options?.cursor !== undefined) params.set("cursor", String(options.cursor));
    if (options?.limit !== undefined) params.set("limit", String(options.limit));
    const query = params.toString();
    return this.transport.request<SessionTurnIndexResponse>(
      `/api/sessions/${this.sessionId}/turns/index${query ? `?${query}` : ""}`,
      { fetch: customFetch },
    );
  }

  window(
    options: {
      sequence?: number;
      turnId?: string;
      before?: number;
      after?: number;
    },
    customFetch?: Fetch,
  ) {
    const params = new URLSearchParams();
    if (options.sequence !== undefined) params.set("sequence", String(options.sequence));
    if (options.turnId) params.set("turnId", options.turnId);
    if (options.before !== undefined) params.set("before", String(options.before));
    if (options.after !== undefined) params.set("after", String(options.after));
    const query = params.toString();
    return this.transport.request<SessionTurnWindowResponse>(
      `/api/sessions/${this.sessionId}/turns/window${query ? `?${query}` : ""}`,
      { fetch: customFetch },
    );
  }

  streamSnapshot(customFetch?: Fetch) {
    return this.transport.request<SessionTurnStreamSnapshotResponse>(
      `/api/sessions/${this.sessionId}/turns/stream-snapshot`,
      { fetch: customFetch },
    );
  }

  get(turnId: string, request?: Fetch | { fetch?: Fetch; signal?: AbortSignal }) {
    const customFetch = typeof request === "function" ? request : request?.fetch;
    const signal = typeof request === "function" ? undefined : request?.signal;
    return this.transport.request<SessionTurnResponse>(
      `/api/sessions/${this.sessionId}/turns/${turnId}`,
      { fetch: customFetch, signal },
    );
  }

  signedUrls(turnId: string, objectKeys: string[], request?: Fetch | { fetch?: Fetch; signal?: AbortSignal }) {
    const customFetch = typeof request === "function" ? request : request?.fetch;
    const signal = typeof request === "function" ? undefined : request?.signal;
    return this.transport.request<SessionTurnSignedUrlsResponse>(
      `/api/sessions/${this.sessionId}/turns/${turnId}/signed-urls`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ objectKeys }),
        fetch: customFetch,
        signal,
      },
    );
  }
}

/**
 * Routes a rejected subscription for `room` (for example a missing
 * `space.view` permission) to `onRejected`. Without this an unauthorized
 * subscriber would simply never receive events, with no way to tell.
 */
const onRoomRejected = (
  websocketClient: WebsocketClient,
  room: string,
  onRejected: (event: WebsocketEventPayload) => void,
) =>
  websocketClient.on("event", (event) => {
    if (event.type !== "system.subscribe.error") return;
    const rejected = (event.payload as { rejected?: Array<{ room?: string }> }).rejected;
    if (rejected?.some((entry) => entry.room === room)) onRejected(event);
  });

class SessionRealtimeClient {
  private readonly patchReducer = new SessionPatchReducer();

  constructor(
    private readonly websocketClient: WebsocketClient | null,
    private readonly spaceId: string,
    private readonly sessionId: string,
  ) {}

  subscribe(handlers: SessionSubscriptionHandlers) {
    if (!this.websocketClient) {
      throw new Error("realtime transport is not configured for this client");
    }
    ensureRealtimeConnected(this.websocketClient);
    const room = getRealtimeSpaceRoom(this.spaceId);
    const releaseRoom = this.websocketClient.retainRooms([room]);
    const offRejected = onRoomRejected(this.websocketClient, room, (event) => {
      handlers.event?.(event);
      handlers.error?.(event);
    });
    const unsubscribe = this.websocketClient.on("event", (event) => {
      if (event.spaceId !== this.spaceId || event.sessionId !== this.sessionId) return;
      handlers.event?.(event);
      const eventName = toSessionEventName(event.type);
      if (eventName === "turn.patch") {
        handlers.patch?.(event);
        if (event.type === "session.turn.patch") {
          const payload = event.payload;
          if (
            typeof payload.seq === "number" &&
            typeof payload.baseSeq === "number" &&
            Array.isArray(payload.ops)
          ) {
            handlers.patchState?.(
              this.patchReducer.applyPatch({
                spaceId: this.spaceId,
                sessionId: this.sessionId,
                turnId: typeof payload.turnId === "string" ? payload.turnId : null,
                seq: payload.seq,
                baseSeq: payload.baseSeq,
                ops: payload.ops as SessionPatchApplyInput["ops"],
                anchorUserMessageId:
                  typeof payload.anchorUserMessageId === "string"
                    ? payload.anchorUserMessageId
                    : null,
              }),
            );
          }
        }
      }
      if (eventName === "turn.error") {
        this.patchReducer.fail({
          spaceId: this.spaceId,
          sessionId: this.sessionId,
        });
        handlers.error?.(event);
      }
      if (eventName === "message.persisted") {
        handlers.persisted?.(event);
        if (isAssistantIntermediatePersistedEvent(event)) {
          this.patchReducer.reset({
            spaceId: this.spaceId,
            sessionId: this.sessionId,
          });
        }
      }
      if (eventName === "turn.updated") handlers.turnUpdated?.(event);
      if (eventName === "turn.finalized") {
        this.patchReducer.complete({
          spaceId: this.spaceId,
          sessionId: this.sessionId,
          turnId: typeof event.payload.turn === "object" && event.payload.turn && "id" in event.payload.turn ? String(event.payload.turn.id) : null,
        });
        handlers.turnFinalized?.(event);
      }
      if (isAssistantFinalPersistedEvent(event)) {
        this.patchReducer.complete({
          spaceId: this.spaceId,
          sessionId: this.sessionId,
          turnId: getPersistedMessageTurnId(event),
        });
      }
    });
    return () => {
      unsubscribe();
      offRejected();
      releaseRoom();
    };
  }

  on(type: SessionEventName, handler: (event: WebsocketEventPayload) => void) {
    return this.subscribe({
      event: (event) => {
        if (toSessionEventName(event.type) === type) handler(event);
      },
    });
  }
}

export class SessionClient {
  readonly messages: SessionMessagesClient;
  readonly turns: SessionTurnsClient;
  readonly realtime: SessionRealtimeClient;
  readonly generation: SessionGenerationStreamClient;

  constructor(
    readonly spaceId: string,
    readonly id: string,
    private readonly transport: HttpTransport,
    websocketClient: WebsocketClient | null,
  ) {
    this.messages = new SessionMessagesClient(transport, id);
    this.turns = new SessionTurnsClient(transport, id, spaceId);
    this.realtime = new SessionRealtimeClient(websocketClient, spaceId, id);
    this.generation = new SessionGenerationStreamClient(
      websocketClient,
      spaceId,
      id,
      () => this.turns.streamSnapshot(),
    );
  }

  get(customFetch?: Fetch) {
    return this.transport.request<{ space: SpaceRecord; session: SessionRecord }>(
      `/api/sessions/${this.id}`,
      {
        fetch: customFetch,
      },
    );
  }

  rename(title: string | null, customFetch?: Fetch) {
    return this.transport.request<{ session: SessionRecord }>(
      `/api/sessions/${this.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ title }),
        fetch: customFetch,
      },
    );
  }

  steerTurn(turnId: string, customFetch?: Fetch) {
    return this.transport.request<{ ok: true; turn: SessionTurnRecord; affectedTurns: SessionTurnRecord[] }>(
      `/api/spaces/${this.spaceId}/sessions/${this.id}/turns/${turnId}/steer`,
      { method: "POST", fetch: customFetch },
    );
  }

  cancelTurn(turnId: string, customFetch?: Fetch) {
    return this.transport.request<{ ok: true; turn: SessionTurnRecord }>(
      `/api/spaces/${this.spaceId}/sessions/${this.id}/turns/${turnId}/cancel`,
      { method: "POST", fetch: customFetch },
    );
  }

  abort(optionsOrFetch?: { turnId?: string | null } | Fetch, customFetch?: Fetch) {
    const options = typeof optionsOrFetch === "function" ? undefined : optionsOrFetch;
    const fetch = typeof optionsOrFetch === "function" ? optionsOrFetch : customFetch;
    return this.transport.request<{ ok: true }>(
      `/api/sessions/${this.id}/abort`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turnId: options?.turnId ?? null }),
        fetch,
      },
    );
  }

  turn(turnId: string) {
    return {
      fork: (input: { title?: string | null } = {}) => this.transport.request<{ session: SessionRecord; fork: SessionForkRecord }>(
        `/api/sessions/${this.id}/turns/${turnId}/fork`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
      ),
    };
  }

  subscribe(handlers: SessionSubscriptionHandlers) {
    return this.realtime.subscribe(handlers);
  }

  subscribeGeneration(
    handlers: GenerationStreamSubscriptionHandlers,
    options?: GenerationStreamSubscribeOptions,
  ) {
    return this.generation.subscribe(handlers, options);
  }

  on(type: SessionEventName, handler: (event: WebsocketEventPayload) => void) {
    return this.realtime.on(type, handler);
  }
}

export type SpaceTurnListOptions = {
  author?: SpaceTurnAuthorFilter;
  after?: string | null;
  before?: string | null;
  cursor?: string | null;
  limit?: number;
  sessionId?: string | null;
};

export class SpaceTurnsApi {
  constructor(
    private readonly transport: HttpTransport,
    private readonly spaceId: string,
  ) {}

  list(options: SpaceTurnListOptions = {}, customFetch?: Fetch) {
    const params = new URLSearchParams();
    if (options.author) params.set("author", options.author);
    if (options.after) params.set("after", options.after);
    if (options.before) params.set("before", options.before);
    if (options.cursor) params.set("cursor", options.cursor);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.sessionId) params.set("sessionId", options.sessionId);
    const query = params.toString();
    return this.transport.request<SpaceTurnsResponse>(
      `/api/spaces/${this.spaceId}/turns${query ? `?${query}` : ""}`,
      { fetch: customFetch },
    );
  }
}

export class SpaceSessionsApi {
  constructor(
    private readonly transport: HttpTransport,
    private readonly spaceId: string,
    private readonly websocketClient: WebsocketClient | null,
  ) {}

  create(input?: CreateSpaceSessionInput) {
    return this.transport.request<{ ok: true; session: SessionRecord }>(
      `/api/spaces/${this.spaceId}/sessions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input ?? {}),
      },
    );
  }

  list(
    optionsOrFetch?: { limit?: number; cursor?: string | null; includeForks?: boolean } | Fetch,
    customFetch?: Fetch,
  ) {
    const options = typeof optionsOrFetch === "function" ? undefined : optionsOrFetch;
    const fetch = typeof optionsOrFetch === "function" ? optionsOrFetch : customFetch;
    const params = new URLSearchParams();
    if (options?.limit !== undefined) params.set("limit", String(options.limit));
    if (options?.cursor) params.set("cursor", options.cursor);
    if (options?.includeForks) params.set("includeForks", "1");
    const query = params.toString();
    return this.transport.request<SpaceSessionsResponse>(
      `/api/spaces/${this.spaceId}/sessions${query ? `?${query}` : ""}`,
      {
        fetch,
      },
    );
  }

  byId(sessionId: string) {
    return new SessionClient(this.spaceId, sessionId, this.transport, this.websocketClient);
  }
}

export type WebSocketConnectionState = {
  state: "connecting" | "reconnecting" | "open" | "closed" | "error";
  willReconnect: boolean;
  connectionId?: string | null;
  attempt?: number;
  delayMs?: number;
  recoverable?: boolean;
};

export class SpacePresenceApi {
  constructor(
    private readonly transport: HttpTransport,
    private readonly spaceId: string,
  ) {}

  get(customFetch?: Fetch) {
    return this.transport.request<SpacePresenceSnapshot>(
      `/api/spaces/${this.spaceId}/presence`,
      { fetch: customFetch },
    );
  }
}

export class SpaceEventsApi {
  constructor(
    private readonly websocketClient: WebsocketClient | null,
    private readonly spaceId: string,
  ) {}

  subscribe(handler: (event: WebsocketEventPayload) => void) {
    if (!this.websocketClient) {
      throw new Error("realtime transport is not configured for this client");
    }
    ensureRealtimeConnected(this.websocketClient);
    const room = getRealtimeSpaceRoom(this.spaceId);
    const releaseRoom = this.websocketClient.retainRooms([room]);
    const offRejected = onRoomRejected(this.websocketClient, room, handler);
    const offEvent = this.websocketClient.on("event", (event) => {
      if (event.spaceId !== this.spaceId) return;
      handler(event);
    });
    return () => {
      offEvent();
      offRejected();
      releaseRoom();
    };
  }

  on(type: SpaceEventName, handler: (event: WebsocketEventPayload) => void) {
    return this.subscribe((event) => {
      if (type === "event") {
        handler(event);
        return;
      }
      if (type === "fs.changed" && event.type === "space.fs.changed") {
        handler(event);
        return;
      }
      if (type === "ports.changed" && event.type === "space.ports.changed") {
        handler(event);
        return;
      }
      if (type === "presence.updated" && event.type === "space.presence.updated") {
        handler(event);
        return;
      }
      if (type === "board.changed" && event.type === "board.changed") {
        handler(event);
        return;
      }
      if (type === "board.playback.changed" && event.type === "board.playback.changed") {
        handler(event);
        return;
      }
      if (type === "app.version.published" && event.type === "app.version.published") {
        handler(event);
        return;
      }
      if (type === "task.created" && event.type === "task.created") {
        handler(event);
        return;
      }
      if (type === "task.updated" && event.type === "task.updated") {
        handler(event);
        return;
      }
      if (toSessionEventName(event.type) === type) handler(event);
    });
  }
}

export class SpaceMembersApi {
  constructor(
    private readonly transport: HttpTransport,
    private readonly spaceId: string,
  ) {}

  list() {
    return this.transport.request<{ items: SpaceMember[] }>(
      `/api/spaces/${this.spaceId}/members`,
    );
  }

  update(userId: string, role: SpaceRole) {
    return this.transport.request<SpaceMember>(
      `/api/spaces/${this.spaceId}/members`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, role }),
      },
    );
  }

  remove(userId: string) {
    return this.transport.request<{ ok: true }>(
      `/api/spaces/${this.spaceId}/members`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      },
    );
  }
}

export class SpaceAccessApi {
  constructor(
    private readonly transport: HttpTransport,
    private readonly spaceId: string,
  ) {}

  get() {
    return this.transport.request<SpaceAccessPolicy>(
      `/api/spaces/${this.spaceId}/access`,
    );
  }

  set(body: { signed_in_user?: SpaceRole | null; anonymous_user?: SpaceRole | null }) {
    return this.transport.request<SpaceAccessPolicy>(
      `/api/spaces/${this.spaceId}/access`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  }
}

export class SpaceUsageApi {
  constructor(
    private readonly transport: HttpTransport,
    private readonly spaceId: string,
  ) {}

  get(days = 30, customFetch?: Fetch) {
    const params = new URLSearchParams({ days: String(days) });
    return this.transport.request<SpaceUsageResponse>(
      `/api/spaces/${this.spaceId}/usage?${params.toString()}`,
      { fetch: customFetch },
    );
  }
}

export class SpaceActivityApi {
  constructor(
    private readonly transport: HttpTransport,
    private readonly spaceId: string,
  ) {}

  get(days = 30, customFetch?: Fetch) {
    const params = new URLSearchParams({ days: String(days) });
    return this.transport.request<SpaceActivityResponse>(
      `/api/spaces/${this.spaceId}/activity?${params.toString()}`,
      { fetch: customFetch },
    );
  }
}

export type SpaceChannelBindingRecord = {
  id: string;
  spaceId: string;
  channelId: string;
  config: ChannelConfig | null;
  createdAt: string;
  channel: {
    id: string;
    userUuid: string;
    provider: string;
    name: string;
    status: string;
    createdAt: string;
    updatedAt: string;
  } | null;
  health?: ChannelHealth | null;
};

export class SpaceChannelsApi {

  constructor(
    private readonly transport: HttpTransport,
    private readonly spaceId: string,
  ) {}

  list() {
    return this.transport.request<SpaceChannelBindingRecord[]>(
      `/api/spaces/${this.spaceId}/channels`,
    );
  }

  bind(channelId: string, config?: ChannelConfig | null) {
    return this.transport.request<SpaceChannelBindingRecord>(
      `/api/spaces/${this.spaceId}/channels/${channelId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: config ?? null }),
      },
    );
  }

  updateConfig(channelId: string, config?: ChannelConfig | null) {
    return this.transport.request<SpaceChannelBindingRecord>(
      `/api/spaces/${this.spaceId}/channels/${channelId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: config ?? null }),
      },
    );
  }

  unbind(channelId: string) {
    return this.transport.request<{ ok: true }>(
      `/api/spaces/${this.spaceId}/channels/${channelId}`,
      { method: "DELETE" },
    );
  }
}

export class SpaceModsApi {
  constructor(
    private readonly transport: HttpTransport,
    private readonly spaceId: string,
  ) {}

  list() {
    return this.transport.request<{ items: SpaceModListItem[] }>(
      `/api/spaces/${this.spaceId}/mods`,
    );
  }

  create(input: { modSpaceId: string; name?: string | null; mountSlug?: string | null }) {
    return this.transport.request<{ item: SpaceModListItem; sandboxRestarting: boolean }>(
      `/api/spaces/${this.spaceId}/mods`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }

  update(modId: string, input: { name?: string | null; mountSlug?: string; enabled?: boolean; sortOrder?: number }) {
    return this.transport.request<{ item: SpaceModListItem; sandboxRestarting: boolean }>(
      `/api/spaces/${this.spaceId}/mods/${modId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }

  remove(modId: string) {
    return this.transport.request<{ ok: true; sandboxRestarting: boolean }>(
      `/api/spaces/${this.spaceId}/mods/${modId}`,
      { method: "DELETE" },
    );
  }

  reorder(ids: string[]) {
    return this.transport.request<{ items: SpaceModListItem[]; sandboxRestarting: boolean }>(
      `/api/spaces/${this.spaceId}/mods/reorder`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      },
    );
  }
}

/**
 * Inbound webhooks declared by `.cohub/hooks/<name>.yml` with `on.event: webhook`.
 * The trigger endpoint is unauthenticated; the hook's optional `on.secret` is the credential.
 */
export class SpaceWebhooksApi {
  constructor(
    private readonly transport: HttpTransport,
    private readonly spaceId: string,
  ) {}

  list(customFetch?: Fetch) {
    return this.transport.request<{ items: SpaceWebhookListItem[] }>(
      `/api/spaces/${this.spaceId}/webhooks`,
      { fetch: customFetch },
    );
  }

  /** Path a caller POSTs to; prefix with the API origin. */
  path(name: string) {
    return `/api/spaces/${this.spaceId}/webhooks/${encodeURIComponent(name)}`;
  }

  trigger(name: string, body: unknown = null, options: { secret?: string | null } = {}) {
    return this.transport.request<SpaceWebhookTriggerResponse>(this.path(name), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(options.secret ? { [SPACE_HOOK_WEBHOOK_SECRET_HEADER]: options.secret } : {}),
      },
      body: JSON.stringify(body ?? null),
      skipUnauthorizedHandler: true,
    });
  }
}

export class SpaceEnvApi {
  constructor(
    private readonly transport: HttpTransport,
    private readonly spaceId: string,
  ) {}

  list() {
    return this.transport.request<{ env: SpaceEnvInput[] }>(
      `/api/spaces/${this.spaceId}/env`,
    );
  }

  create(input: SpaceEnvInput) {
    return this.transport.request<{ env: SpaceEnvInput[] }>(
      `/api/spaces/${this.spaceId}/env`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }

  update(name: string, value: string) {
    return this.transport.request<{ env: SpaceEnvInput[] }>(
      `/api/spaces/${this.spaceId}/env/${encodeURIComponent(name)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      },
    );
  }

  remove(name: string) {
    return this.transport.request<{ env: SpaceEnvInput[] }>(
      `/api/spaces/${this.spaceId}/env/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    );
  }
}

export type SpaceSandboxRecord = {
  provider?: "cloud" | "local";
  status: string | null;
  runtimeStatus?: string | null;
  podName?: string | null;
  desiredImage?: string | null;
  reportedImageVersion?: string | null;
  lastHeartbeatAt?: string | null;
  lastActivityAt?: string | null;
  reportedAt?: string | null;
  stoppedAt?: string | null;
  stopReason?: string | null;
  meta?: Record<string, unknown> | null;
};

export class SpaceSandboxApi {
  constructor(
    private readonly transport: HttpTransport,
    private readonly spaceId: string,
  ) {}

  get() {
    return this.transport.request<{ sandbox: SpaceSandboxRecord | null }>(
      `/api/spaces/${this.spaceId}/sandbox`,
    );
  }

  ports() {
    return this.transport.request<{ endpoints: SpacePublicEndpoints }>(
      `/api/spaces/${this.spaceId}/sandbox/ports`,
    );
  }

  recreate() {
    return this.transport.request<{
      ok: boolean;
      status?: string;
      verified?: boolean;
      checks?: Record<string, boolean> | null;
      message?: string;
    }>(`/api/spaces/${this.spaceId}/sandbox/recreate`, {
      method: "POST",
    });
  }
}

export type SpaceRunCommandResponse = { taskRunId: string };

export class SpaceLabelsApi {
  constructor(
    private readonly transport: HttpTransport,
    private readonly spaceId: string,
  ) {}

  list() {
    return this.transport.request<{ labels: LabelListItem[] }>(
      `/api/spaces/${this.spaceId}/labels`,
    );
  }

  create(labelRef: string) {
    return this.transport.request<{ labels: LabelListItem[] }>(
      `/api/spaces/${this.spaceId}/labels`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labelRef }),
      },
    );
  }

  update(labelRef: string, input: { name?: string; parentRef?: string | null; rank?: number }) {
    return this.transport.request<{ label: LabelListItem }>(
      `/api/spaces/${this.spaceId}/labels/by-ref`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labelRef, ...input }),
      },
    );
  }

  delete(labelRef: string) {
    const params = new URLSearchParams({ ref: labelRef });
    return this.transport.request<{ ok: true }>(
      `/api/spaces/${this.spaceId}/labels/by-ref?${params.toString()}`,
      { method: "DELETE" },
    );
  }

  reorder(labelRefs: string[]) {
    return this.transport.request<{ labels: LabelListItem[] }>(
      `/api/spaces/${this.spaceId}/labels/reorder`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labelRefs }),
      },
    );
  }

  listItems(labelRef: string, input?: { limit?: number; cursor?: string | null }) {
    const params = new URLSearchParams({ ref: labelRef });
    if (input?.limit) params.set("limit", String(input.limit));
    if (input?.cursor) params.set("cursor", input.cursor);
    return this.transport.request<LabelItemsResponse>(
      `/api/spaces/${this.spaceId}/labels/items?${params.toString()}`,
    );
  }

  attach(labelRef: string, input: { resourceType: LabelResourceType; resourceRef: string }) {
    return this.transport.request<{ assignment: LabelAssignmentRecord }>(
      `/api/spaces/${this.spaceId}/labels/attach`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labelRef, ...input }),
      },
    );
  }

  detach(labelRef: string, input: { resourceType: LabelResourceType; resourceRef: string }) {
    return this.transport.request<{ ok: true }>(
      `/api/spaces/${this.spaceId}/labels/detach`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labelRef, ...input }),
      },
    );
  }

  getResourceLabels(resourceType: LabelResourceType, resourceRef: string) {
    const params = new URLSearchParams({ resourceRef });
    return this.transport.request<{ labels: LabelListItem[]; assignments: LabelAssignmentRecord[] }>(
      `/api/spaces/${this.spaceId}/resources/${resourceType}/labels?${params.toString()}`,
    );
  }

  patchResourceLabels(resourceType: LabelResourceType, resourceRef: string, input: PatchResourceLabelsInput) {
    const params = new URLSearchParams({ resourceRef });
    return this.transport.request<PatchResourceLabelsResponse>(
      `/api/spaces/${this.spaceId}/resources/${resourceType}/labels?${params.toString()}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }

  setResourceLabels(resourceType: LabelResourceType, resourceRef: string, labelRefs: string[]) {
    const params = new URLSearchParams({ resourceRef });
    return this.transport.request<{ labels: LabelListItem[]; assignments: LabelAssignmentRecord[] }>(
      `/api/spaces/${this.spaceId}/resources/${resourceType}/labels?${params.toString()}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labelRefs }),
      },
    );
  }
}

export class SpaceCommerceApi {
  constructor(
    private readonly transport: HttpTransport,
    private readonly spaceId: string,
  ) {}

  setup() {
    return this.transport.request<{ businessKey: string }>(
      `/api/spaces/${this.spaceId}/commerce/setup`,
      { method: "POST" },
    );
  }

  listProducts() {
    return this.transport.request<{ products: import("../types.js").SpaceCommerceProduct[]; businessKey: string }>(
      `/api/spaces/${this.spaceId}/commerce/products`,
    );
  }

  createProduct(input: {
    key?: string;
    name: string;
    description?: string;
    amountUsd: number;
    cohubBalanceUsd?: number;
    status?: "draft" | "active";
    visibility?: "public" | "private";
  }) {
    return this.transport.request<{ product: import("../types.js").SpaceCommerceProduct; businessKey: string }>(
      `/api/spaces/${this.spaceId}/commerce/products`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }

  updateProduct(productKey: string, input: {
    name?: string;
    description?: string | null;
    status?: "draft" | "active" | "archived";
    visibility?: "public" | "private";
  }) {
    return this.transport.request<{ product: import("../types.js").SpaceCommerceProduct; businessKey: string }>(
      `/api/spaces/${this.spaceId}/commerce/products/${encodeURIComponent(productKey)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }

  listBenefits() {
    return this.transport.request<{ benefits: import("../types.js").SpaceCommerceBenefit[]; businessKey: string }>(
      `/api/spaces/${this.spaceId}/commerce/benefits`,
    );
  }

  createBenefit(input: {
    key?: string;
    name: string;
    description?: string;
    type?: "feature" | "credits";
    metadata?: Record<string, string | number | boolean>;
    amount?: number;
    expiresInDays?: number;
  }) {
    return this.transport.request<{ benefit: import("../types.js").SpaceCommerceBenefit; businessKey: string }>(
      `/api/spaces/${this.spaceId}/commerce/benefits`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }

  updateBenefit(benefitKey: string, input: {
    name?: string;
    description?: string | null;
    status?: "active" | "archived";
    metadata?: Record<string, string | number | boolean>;
  }) {
    return this.transport.request<{ benefit: import("../types.js").SpaceCommerceBenefit; businessKey: string }>(
      `/api/spaces/${this.spaceId}/commerce/benefits/${encodeURIComponent(benefitKey)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }

  listProductBenefits() {
    return this.transport.request<{ productBenefits: import("../types.js").SpaceCommerceProductBenefitBinding[]; businessKey: string }>(
      `/api/spaces/${this.spaceId}/commerce/product-benefits`,
    );
  }

  bindProductBenefit(input: { productKey: string; benefitKey: string }) {
    return this.transport.request<{ productBenefit: import("../types.js").SpaceCommerceProductBenefitBinding; businessKey: string }>(
      `/api/spaces/${this.spaceId}/commerce/product-benefits`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }

  unbindProductBenefit(input: { productKey: string; benefitKey: string }) {
    const params = new URLSearchParams({ productKey: input.productKey, benefitKey: input.benefitKey });
    return this.transport.request<{ ok: true; businessKey: string }>(
      `/api/spaces/${this.spaceId}/commerce/product-benefits?${params.toString()}`,
      { method: "DELETE" },
    );
  }

  listOrders(input?: { page?: number; limit?: number }) {
    const params = new URLSearchParams();
    if (input?.page) params.set("page", String(input.page));
    if (input?.limit) params.set("limit", String(input.limit));
    return this.transport.request<{ orders: import("../types.js").SpaceCommerceOrder[]; pagination: { hasMore: boolean; nextPage: number | null }; businessKey: string }>(
      `/api/spaces/${this.spaceId}/commerce/orders${params.toString() ? `?${params.toString()}` : ""}`,
    );
  }
}

class BoardRealtimeClient {
  constructor(
    private readonly websocketClient: WebsocketClient | null,
    private readonly spaceId: string,
    private readonly boardId: string,
  ) {}

  subscribe(handlers: BoardSubscriptionHandlers) {
    if (!this.websocketClient) {
      throw new Error("realtime transport is not configured for this client");
    }
    ensureRealtimeConnected(this.websocketClient);
    const releaseRoom = this.websocketClient.retainRooms([
      getRealtimeSpaceRoom(this.spaceId),
      getRealtimeBoardRoom(this.boardId),
    ]);
    const unsubscribe = this.websocketClient.on("event", (event) => {
      if (event.spaceId !== this.spaceId) return;
      if (event.type === "board.changed" && event.payload.boardId === this.boardId) {
        const changedEvent = event as BoardChangedEvent;
        handlers.event?.(changedEvent);
        handlers.changed?.(changedEvent);
      }
      if (event.type === "board.awareness.updated" && event.payload.boardId === this.boardId) {
        const awarenessEvent = event as BoardAwarenessUpdatedEvent;
        if (awarenessEvent.payload.connectionId !== this.websocketClient?.connectionId) {
          handlers.event?.(awarenessEvent);
          handlers.awareness?.(awarenessEvent);
        }
      }
      if (event.type === "board.playback.changed" && event.payload.boardId === this.boardId) {
        const playbackEvent = event as BoardPlaybackChangedEvent;
        handlers.event?.(playbackEvent);
        handlers.playback?.(playbackEvent);
      }
    });
    return () => {
      unsubscribe();
      releaseRoom();
    };
  }

  on(type: "changed", handler: (event: BoardChangedEvent) => void): () => void;
  on(type: "awareness", handler: (event: BoardAwarenessUpdatedEvent) => void): () => void;
  on(type: "playback", handler: (event: BoardPlaybackChangedEvent) => void): () => void;
  on(
    type: BoardEventName,
    handler:
      | ((event: BoardChangedEvent) => void)
      | ((event: BoardAwarenessUpdatedEvent) => void)
      | ((event: BoardPlaybackChangedEvent) => void),
  ) {
    if (type === "changed") {
      return this.subscribe({ changed: handler as (event: BoardChangedEvent) => void });
    }
    if (type === "awareness") {
      return this.subscribe({ awareness: handler as (event: BoardAwarenessUpdatedEvent) => void });
    }
    return this.subscribe({ playback: handler as (event: BoardPlaybackChangedEvent) => void });
  }
}

export class BoardClient {
  readonly realtime: BoardRealtimeClient;
  private readonly boards: SpaceBoardsApi;

  constructor(
    readonly spaceId: string,
    readonly id: string,
    transport: HttpTransport,
    private readonly websocketClient: WebsocketClient | null,
  ) {
    this.boards = new SpaceBoardsApi(transport, spaceId, websocketClient);
    this.realtime = new BoardRealtimeClient(websocketClient, spaceId, id);
  }

  capabilities(customFetch?: Fetch) {
    return this.boards.capabilities(this.id, customFetch);
  }

  summary(customFetch?: Fetch) {
    return this.boards.summary(this.id, customFetch);
  }

  authoring(input: BoardAuthoringReadInput = {}, customFetch?: Fetch) {
    return this.boards.authoring(this.id, input, customFetch);
  }

  /** Read-only transaction log, newest first; the first page carries the current rows. */
  transactions(input: BoardTransactionsReadInput = {}, customFetch?: Fetch) {
    return this.boards.transactions(this.id, input, customFetch);
  }

  mutateSemantic(
    input: Omit<BoardSemanticMutation, "mutationId" | "dryRun"> & {
      mutationId?: string;
      dryRun?: boolean;
    },
  ) {
    return this.boards.mutateSemantic(this.id, {
      ...input,
      mutationId: input.mutationId ?? randomBoardId(),
      dryRun: input.dryRun ?? false,
    });
  }

  updateAwareness(seq: number, update: BoardAwarenessUpdate) {
    if (!this.websocketClient) return Promise.resolve();
    return this.websocketClient.updateBoardAwareness({
      spaceId: this.spaceId,
      boardId: this.id,
      seq,
      update,
    });
  }

  play(command: Omit<Extract<BoardPlaybackCommand, { type: "play" }>, "shared"> & { shared?: true }) {
    return this.boards.play(this.id, command);
  }

  pause(command: Extract<BoardPlaybackCommand, { type: "pause" }>) {
    return this.boards.pause(this.id, command);
  }

  seek(command: Extract<BoardPlaybackCommand, { type: "seek" }>) {
    return this.boards.seek(this.id, command);
  }

  stop(command: Extract<BoardPlaybackCommand, { type: "stop" }>) {
    return this.boards.stop(this.id, command);
  }

  subscribe(handlers: BoardSubscriptionHandlers) {
    return this.realtime.subscribe(handlers);
  }

  on(type: "changed", handler: (event: BoardChangedEvent) => void): () => void;
  on(type: "awareness", handler: (event: BoardAwarenessUpdatedEvent) => void): () => void;
  on(type: "playback", handler: (event: BoardPlaybackChangedEvent) => void): () => void;
  on(
    type: BoardEventName,
    handler:
      | ((event: BoardChangedEvent) => void)
      | ((event: BoardAwarenessUpdatedEvent) => void)
      | ((event: BoardPlaybackChangedEvent) => void),
  ) {
    if (type === "changed") {
      return this.realtime.on("changed", handler as (event: BoardChangedEvent) => void);
    }
    if (type === "awareness") {
      return this.realtime.on("awareness", handler as (event: BoardAwarenessUpdatedEvent) => void);
    }
    return this.realtime.on("playback", handler as (event: BoardPlaybackChangedEvent) => void);
  }
}

export class SpaceBoardsApi {
  constructor(
    private readonly transport: HttpTransport,
    private readonly spaceId: string,
    private readonly websocketClient: WebsocketClient | null,
  ) {}

  byId(boardId: string) {
    return new BoardClient(this.spaceId, boardId, this.transport, this.websocketClient);
  }

  async create(input: BoardCreateInput) {
    for (const item of input.items ?? []) BoardAuthoringItemSchema.parse(item);
    return this.transport.request<BoardAuthoringSnapshot>(
      `/api/spaces/${this.spaceId}/boards`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }

  authoring(boardId: string, input: BoardAuthoringReadInput = {}, customFetch?: Fetch) {
    if (input.include?.length === 0) throw new Error("Board authoring include must not be empty.");
    const params = new URLSearchParams();
    for (const section of input.include ?? []) params.append("include", section);
    if (input.itemIds?.length) params.set("itemIds", input.itemIds.join(","));
    if (input.connectionIds?.length) params.set("connectionIds", input.connectionIds.join(","));
    if (input.effectIds?.length) params.set("effectIds", input.effectIds.join(","));
    if (input.compositionIds?.length) params.set("compositionIds", input.compositionIds.join(","));
    if (input.viewport) params.set("viewport", JSON.stringify(input.viewport));
    const query = params.toString();
    return this.transport.request<BoardAuthoringSnapshot>(
      `/api/spaces/${this.spaceId}/boards/${boardId}/authoring${query ? `?${query}` : ""}`,
      { fetch: customFetch },
    );
  }

  mutateSemantic(boardId: string, mutation: BoardSemanticMutation) {
    return this.transport.request<BoardMutationReceipt>(
      `/api/spaces/${this.spaceId}/boards/${boardId}/mutations`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mutation),
      },
    );
  }

  summary(boardId: string, customFetch?: Fetch) {
    return this.transport.request<BoardSummary>(
      `/api/spaces/${this.spaceId}/boards/${boardId}/summary`,
      { fetch: customFetch },
    );
  }

  capabilities(boardId: string, customFetch?: Fetch) {
    return this.transport.request<BoardCapabilities>(
      `/api/spaces/${this.spaceId}/boards/${boardId}/capabilities`,
      { fetch: customFetch },
    );
  }

  transactions(boardId: string, input: BoardTransactionsReadInput = {}, customFetch?: Fetch) {
    const params = new URLSearchParams();
    if (input.before !== undefined) params.set("before", String(input.before));
    if (input.limit !== undefined) params.set("limit", String(input.limit));
    if (input.snapshot !== undefined) params.set("snapshot", String(input.snapshot));
    const query = params.toString();
    return this.transport.request<BoardTransactionsPage>(
      `/api/spaces/${this.spaceId}/boards/${boardId}/transactions${query ? `?${query}` : ""}`,
      { fetch: customFetch },
    );
  }

  private playback(boardId: string, command: BoardPlaybackCommand) {
    return this.transport.request<BoardPlaybackSnapshot>(
      `/api/spaces/${this.spaceId}/boards/${boardId}/playback`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      },
    );
  }

  play(
    boardId: string,
    command: Omit<Extract<BoardPlaybackCommand, { type: "play" }>, "shared"> & { shared?: true },
  ) {
    return this.playback(boardId, command);
  }

  pause(boardId: string, command: Extract<BoardPlaybackCommand, { type: "pause" }>) {
    return this.playback(boardId, command);
  }

  seek(boardId: string, command: Extract<BoardPlaybackCommand, { type: "seek" }>) {
    return this.playback(boardId, command);
  }

  stop(boardId: string, command: Extract<BoardPlaybackCommand, { type: "stop" }>) {
    return this.playback(boardId, command);
  }

}

export class SpaceCheckpointFilesApi {
  constructor(
    private readonly transport: HttpTransport,
    private readonly spaceId: string,
    private readonly checkpointId: string,
  ) {}

  list(path = "", customFetch?: Fetch) {
    const params = new URLSearchParams();
    if (path) params.set("path", path);
    const query = params.toString();
    return this.transport.request<SpaceFsTreeResponse>(
      `/api/spaces/${this.spaceId}/checkpoints/${this.checkpointId}/fs/tree${query ? `?${query}` : ""}`,
      { fetch: customFetch },
    );
  }

  read(path: string, customFetch?: Fetch) {
    const params = new URLSearchParams({ path });
    return this.transport.request<SpaceFsFileResponse>(
      `/api/spaces/${this.spaceId}/checkpoints/${this.checkpointId}/fs/file?${params.toString()}`,
      { fetch: customFetch },
    );
  }
}

async function hydrateCheckpointDiffSummary(
  summary: CheckpointDiffSummary,
  customFetch?: Fetch,
): Promise<CheckpointDiffSummary> {
  if (summary.delivery !== "url" || !summary.url) {
    return { ...summary, delivery: summary.delivery ?? "inline" };
  }
  const fetchImpl = customFetch ?? fetch;
  const response = await fetchImpl(summary.url);
  if (!response.ok) {
    throw new HttpError(`Failed to load checkpoint diff (${response.status})`, response.status, null);
  }
  const body = (await response.json()) as CheckpointDiffSummary;
  return {
    ...body,
    // Preserve envelope metadata from the API response.
    delivery: "inline",
    url: summary.url,
    precomputed: summary.precomputed ?? body.precomputed ?? true,
    headCheckpointId: body.headCheckpointId || summary.headCheckpointId,
    headCommitHash: body.headCommitHash || summary.headCommitHash,
    baseCheckpointId: body.baseCheckpointId ?? summary.baseCheckpointId,
    baseCommitHash: body.baseCommitHash ?? summary.baseCommitHash,
  };
}

async function hydrateCheckpointDiffFile(
  file: CheckpointDiffFileResponse,
  customFetch?: Fetch,
): Promise<CheckpointDiffFileResponse> {
  if (file.delivery !== "url" || !file.url) {
    return { ...file, delivery: file.delivery ?? "inline" };
  }
  // Precomputed non-text markers never put lines on OSS — keep the envelope as-is.
  if (file.kind !== "text") {
    return { ...file, delivery: file.delivery ?? "url" };
  }
  const fetchImpl = customFetch ?? fetch;
  const response = await fetchImpl(file.url);
  if (!response.ok) {
    throw new HttpError(`Failed to load file diff (${response.status})`, response.status, null);
  }
  const body = (await response.json()) as CheckpointDiffFileResponse;
  return {
    ...body,
    // Prefer hydrated patch body; keep envelope metadata as fallback.
    path: body.path || file.path,
    oldPath: body.oldPath ?? file.oldPath ?? null,
    status: body.status ?? file.status,
    kind: body.kind ?? file.kind,
    delivery: "inline",
    url: file.url,
  };
}

export class SpaceCheckpointDiffApi {
  constructor(
    private readonly transport: HttpTransport,
    private readonly spaceId: string,
    private readonly checkpointId: string,
  ) {}

  async summary(options?: { base?: string | null }, customFetch?: Fetch) {
    const params = new URLSearchParams();
    if (options?.base) params.set("base", options.base);
    const query = params.toString();
    const summary = await this.transport.request<CheckpointDiffSummary>(
      `/api/spaces/${this.spaceId}/checkpoints/${this.checkpointId}/fs/diff${query ? `?${query}` : ""}`,
      { fetch: customFetch },
    );
    return hydrateCheckpointDiffSummary(summary, customFetch);
  }

  async file(path: string, options?: { base?: string | null }, customFetch?: Fetch) {
    const params = new URLSearchParams({ path });
    if (options?.base) params.set("base", options.base);
    const file = await this.transport.request<CheckpointDiffFileResponse>(
      `/api/spaces/${this.spaceId}/checkpoints/${this.checkpointId}/fs/diff/file?${params.toString()}`,
      { fetch: customFetch },
    );
    return hydrateCheckpointDiffFile(file, customFetch);
  }
}

export class SpaceCheckpointApi {
  readonly files: SpaceCheckpointFilesApi;
  readonly diff: SpaceCheckpointDiffApi;

  constructor(
    private readonly transport: HttpTransport,
    private readonly spaceId: string,
    readonly id: string,
  ) {
    this.files = new SpaceCheckpointFilesApi(transport, spaceId, id);
    this.diff = new SpaceCheckpointDiffApi(transport, spaceId, id);
  }

  get(customFetch?: Fetch) {
    return this.transport.request<SpaceCheckpointDetailResponse>(
      `/api/spaces/${this.spaceId}/checkpoints/${this.id}`,
      { fetch: customFetch },
    );
  }
}

export type CheckpointListPageInfo = { hasMore: boolean; nextCursor: string | null };
export type CheckpointListOptions = { limit?: number; cursor?: string | null };
export type CheckpointListResponse = { checkpoints: CheckpointRecord[]; pageInfo?: CheckpointListPageInfo };

export type SpaceCheckpointsApi = ((checkpointId: string) => SpaceCheckpointApi) & {
  checkpoint: (checkpointId: string) => SpaceCheckpointApi;
  latest: () => SpaceCheckpointApi;
  create: (description?: string | null) => Promise<{ ok: true; taskRunId: string; existing?: boolean }>;
  list: (options?: CheckpointListOptions) => Promise<CheckpointListResponse>;
  get: (checkpointId: string, customFetch?: Fetch) => Promise<SpaceCheckpointDetailResponse>;
};

function createSpaceCheckpointsApi(transport: HttpTransport, spaceId: string): SpaceCheckpointsApi {
  const checkpoint = (checkpointId: string) => new SpaceCheckpointApi(transport, spaceId, checkpointId);
  return Object.assign(checkpoint, {
    checkpoint,
    latest: () => checkpoint("latest"),
    create: (description?: string | null) => transport.request<{ ok: true; taskRunId: string; existing?: boolean }>(
      `/api/spaces/${spaceId}/checkpoints`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: description ?? null }),
      },
    ),
    list: (options?: CheckpointListOptions) => {
      const params = new URLSearchParams();
      if (options?.limit !== undefined) params.set("limit", String(options.limit));
      if (options?.cursor) params.set("cursor", options.cursor);
      const query = params.toString();
      return transport.request<CheckpointListResponse>(
        `/api/spaces/${spaceId}/checkpoints${query ? `?${query}` : ""}`,
      );
    },
    get: (checkpointId: string, customFetch?: Fetch) => checkpoint(checkpointId).get(customFetch),
  });
}

export class SpaceClient {
  readonly files: SpaceFilesApi;
  readonly publicFiles: SpacePublicFilesApi;
  readonly sessions: SpaceSessionsApi;
  readonly turns: SpaceTurnsApi;
  readonly members: SpaceMembersApi;
  readonly presence: SpacePresenceApi;
  readonly access: SpaceAccessApi;
  readonly checkpoints: SpaceCheckpointsApi;
  readonly usage: SpaceUsageApi;
  readonly activity: SpaceActivityApi;
  readonly channels: SpaceChannelsApi;
  readonly mods: SpaceModsApi;
  readonly webhooks: SpaceWebhooksApi;
  readonly env: SpaceEnvApi;
  readonly sandbox: SpaceSandboxApi;
  readonly invitations: SpaceInvitationsApi;
  readonly labels: SpaceLabelsApi;
  readonly boards: SpaceBoardsApi;
  readonly commerce: SpaceCommerceApi;

  constructor(
    readonly id: string,
    private readonly transport: HttpTransport,
    private readonly websocketClient: WebsocketClient | null,
  ) {
    this.files = new SpaceFilesApi(transport, id);
    this.publicFiles = new SpacePublicFilesApi(transport, id);
    this.sessions = new SpaceSessionsApi(transport, id, websocketClient);
    this.turns = new SpaceTurnsApi(transport, id);
    this.members = new SpaceMembersApi(transport, id);
    this.presence = new SpacePresenceApi(transport, id);
    this.access = new SpaceAccessApi(transport, id);
    this.checkpoints = createSpaceCheckpointsApi(transport, id);
    this.usage = new SpaceUsageApi(transport, id);
    this.activity = new SpaceActivityApi(transport, id);
    this.channels = new SpaceChannelsApi(transport, id);
    this.mods = new SpaceModsApi(transport, id);
    this.webhooks = new SpaceWebhooksApi(transport, id);
    this.env = new SpaceEnvApi(transport, id);
    this.sandbox = new SpaceSandboxApi(transport, id);
    this.invitations = new SpaceInvitationsApi(transport, id);
    this.labels = new SpaceLabelsApi(transport, id);
    this.boards = new SpaceBoardsApi(transport, id, websocketClient);
    this.commerce = new SpaceCommerceApi(transport, id);
  }

  get(customFetch?: Fetch) {
    return this.transport.request<SpaceRecord>(`/api/spaces/${this.id}`, {
      fetch: customFetch,
    });
  }

  prepareRuntimeArchive(index: import("@cohub/protocol").HarnessArchiveIndex, options: { signal?: AbortSignal } = {}) {
    return this.transport.request<{ uploads: import("@cohub/protocol").RuntimeArchiveUpload[] }>(`/api/spaces/${this.id}/runtime/archives/prepare`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(index), signal: options.signal,
    });
  }

  commitRuntimeArchive(index: import("@cohub/protocol").HarnessArchiveIndex, options: { signal?: AbortSignal } = {}) {
    return this.transport.request<{ ready: true }>(`/api/spaces/${this.id}/runtime/archives/commit`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(index), signal: options.signal,
    });
  }

  getRuntimeArchive(sessionId: string, turnId: string, options: { signal?: AbortSignal } = {}) {
    return this.transport.request<import("@cohub/protocol").RuntimeArchivePage>(
      `/api/spaces/${this.id}/runtime/archives/${sessionId}/${turnId}`, { signal: options.signal },
    );
  }

  getRuntime(customFetch?: Fetch, options: { signal?: AbortSignal } = {}) {
    return this.transport.request<import("@cohub/protocol").RuntimeStatus>(
      `/api/spaces/${this.id}/runtime`, { fetch: customFetch, signal: options.signal },
    );
  }

  getSessionRuntime(sessionId: string, customFetch?: Fetch) {
    return this.transport.request<import("@cohub/protocol").RuntimeSessionRecoveryStatus>(
      `/api/spaces/${this.id}/sessions/${sessionId}/runtime`, { fetch: customFetch },
    );
  }

  confirmRuntimeStopped(sessionId: string, confirmation: import("@cohub/protocol").RuntimeStopConfirmation) {
    return this.transport.request<{ accepted: true }>(`/api/spaces/${this.id}/sessions/${sessionId}/runtime/confirm-stopped`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(confirmation) });
  }

  getStartup(customFetch?: Fetch) {
    return this.transport.request<SpaceStartupResponse>(
      `/api/spaces/${this.id}/startup`,
      { fetch: customFetch },
    );
  }

  prompt(input: CreateSpacePromptInput) {
    return this.transport.request<CreateSpacePromptResponse>(
      `/api/spaces/${this.id}/prompt`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }

  /**
   * Raw LLM completion. Caller fully controls messages and optional system prompt file.
   * Non-streaming JSON response. Use `streamCompletion` for SSE.
   */
  completion(input: Omit<CreateSpaceCompletionInput, "stream"> & { stream?: false | null }) {
    return this.transport.request<SpaceCompletionResult>(
      `/api/spaces/${this.id}/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, stream: false }),
      },
    );
  }

  /** Raw LLM completion with SSE events. Yields deltas; returns the final aggregated result. */
  async *streamCompletion(
    input: Omit<CreateSpaceCompletionInput, "stream">,
    options?: { signal?: AbortSignal },
  ): AsyncGenerator<SpaceCompletionStreamEvent, SpaceCompletionResult> {
    const signal = options?.signal;
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
    }

    const raw = await this.transport.raw(`/api/spaces/${this.id}/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ ...input, stream: true }),
      signal,
    });

    const contentType = raw.response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      const body = await raw.json().catch(() => null);
      if (body && typeof body === "object" && "completionId" in (body as object)) {
        const result = body as SpaceCompletionResult;
        yield {
          type: "done",
          completionId: result.completionId,
          message: result.message,
          usage: result.usage,
          ...(result.contextFallbacks ? { contextFallbacks: result.contextFallbacks } : {}),
        };
        return result;
      }
      const message = body && typeof body === "object" && typeof (body as { message?: unknown }).message === "string"
        ? (body as { message: string }).message
        : "Unexpected completion response";
      throw new HttpError(message, raw.response.status, body);
    }

    if (!raw.response.body) {
      throw new HttpError("Empty completion stream", 502, null);
    }

    const reader = raw.response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let result: SpaceCompletionResult | null = null;
    let meta: Extract<SpaceCompletionStreamEvent, { type: "meta" }> | null = null;
    let lastUsage: SpaceCompletionResult["usage"] = null;
    let readerReleased = false;

    const releaseReader = async () => {
      if (readerReleased) return;
      readerReleased = true;
      try {
        await reader.cancel();
      } catch {
        // ignore cancel races after normal completion/abort
      }
    };

    const onAbort = () => {
      void releaseReader();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const consume = (event: SpaceCompletionStreamEvent) => {
      if (event.type === "meta") meta = event;
      if (event.type === "usage") lastUsage = event.usage;
      if (event.type === "done") {
        result = {
          completionId: event.completionId,
          provider: meta?.provider ?? "",
          model: meta?.model ?? "",
          systemPromptPath: meta?.systemPromptPath ?? null,
          message: event.message,
          usage: event.usage ?? lastUsage,
          ...(event.contextFallbacks ? { contextFallbacks: event.contextFallbacks } : {}),
        };
      }
      if (event.type === "error") {
        throw new HttpError(event.message, 502, event);
      }
    };

    const parseDataLine = (chunk: string): SpaceCompletionStreamEvent | null => {
      const dataLine = chunk
        .split("\n")
        .map((line) => line.trimEnd())
        .find((line) => line.startsWith("data:"));
      if (!dataLine) return null;
      const payload = dataLine.slice(5).trim();
      if (!payload || payload === "[DONE]") return null;
      try {
        return JSON.parse(payload) as SpaceCompletionStreamEvent;
      } catch {
        return null;
      }
    };

    try {
      while (true) {
        if (signal?.aborted) {
          throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
        }
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
          const event = parseDataLine(chunk);
          if (!event) continue;
          consume(event);
          yield event;
        }
      }

      if (buffer.trim()) {
        const event = parseDataLine(buffer);
        if (event) {
          consume(event);
          yield event;
        }
      }

      if (!result) {
        throw new HttpError("Completion stream ended without a result", 502, null);
      }
      return result;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      await releaseReader();
    }
  }

  update(input: { name?: string; slug?: string | null }) {
    return this.transport.request<{ space: SpaceRecord }>(`/api/spaces/${this.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    });
  }

  rename(name: string) {
    return this.update({ name });
  }

  profile(body: { description?: string | null; avatarUrl?: string | null }) {
    return this.transport.request<{ space: SpaceRecord }>(
      `/api/spaces/${this.id}/profile`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  }

  runCommand(input: { command: string }) {
    return this.transport.request<SpaceRunCommandResponse>(
      `/api/spaces/${this.id}/commands`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }

  getConfig() {
    return this.transport.request<SpaceConfigResponse>(
      `/api/spaces/${this.id}/config`,
    );
  }

  updateConfig(input: SpaceConfigInput) {
    return this.transport.request<SpaceConfigUpdateResponse>(
      `/api/spaces/${this.id}/config`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }

  session(sessionId: string) {
    return new SessionClient(this.id, sessionId, this.transport, this.websocketClient);
  }

  board(boardId: string) {
    return new BoardClient(this.id, boardId, this.transport, this.websocketClient);
  }

  updatePresence(meta?: Record<string, unknown> | null) {
    if (!this.websocketClient) return Promise.resolve();
    return this.websocketClient.updatePresence({ spaceId: this.id, meta: meta ?? null });
  }

  subscribe(handler: (event: WebsocketEventPayload) => void) {
    return new SpaceEventsApi(this.websocketClient, this.id).subscribe(handler);
  }

  on(type: SpaceEventName, handler: (event: WebsocketEventPayload) => void) {
    return new SpaceEventsApi(this.websocketClient, this.id).on(type, handler);
  }
}
