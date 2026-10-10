import {
  type BoardAwarenessUpdatedEvent as ProtocolBoardAwarenessUpdatedEvent,
  type BoardChangedEvent as ProtocolBoardChangedEvent,
  type BoardPlaybackChangedEvent as ProtocolBoardPlaybackChangedEvent,
  getRealtimeBoardRoom,
  getRealtimeSpaceRoom,
} from "@cohub/protocol/realtime/types";
import type { BoardAwarenessUpdate } from "@cohub/protocol/realtime";
import { ensureRealtimeConnected } from "../../realtime.js";
import type { Fetch, HttpTransport } from "../../transport.js";
import type {
  BoardApplyInput,
  BoardApplyResult,
  BoardCreateInput,
  BoardHistoryInput,
  BoardHistoryPage,
  BoardPatch,
  BoardPlaybackCommand,
  BoardPlaybackSnapshot,
  BoardReadInput,
  BoardReadResult,
} from "../../types.js";
import type { WebsocketClient } from "../../websocket.js";
import { createBoardEntityId } from "../model/items/id.js";
import type { BoardRemote } from "../replica/index.js";

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

export type BoardClientOptions = {
  http: HttpTransport;
  websocket: WebsocketClient | null;
  spaceId: string;
  boardId: string;
};

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

export class BoardClient implements BoardRemote {
  readonly spaceId: string;
  readonly id: string;
  readonly realtime: BoardRealtimeClient;
  private readonly http: HttpTransport;
  private readonly websocket: WebsocketClient | null;

  constructor(options: BoardClientOptions) {
    this.spaceId = options.spaceId;
    this.id = options.boardId;
    this.http = options.http;
    this.websocket = options.websocket;
    this.realtime = new BoardRealtimeClient(options.websocket, options.spaceId, options.boardId);
  }

  private get path() {
    return `/api/spaces/${this.spaceId}/boards/${this.id}`;
  }

  /** Read the Board, or part of it. Every value is complete, defaults included. */
  get(input: BoardReadInput = {}, customFetch?: Fetch) {
    const params = new URLSearchParams();
    if (input.only?.length) params.set("only", input.only.join(","));
    if (input.rect) params.set("rect", [input.rect.x, input.rect.y, input.rect.width, input.rect.height].join(","));
    if (input.within) params.set("within", input.within);
    if (input.items?.length) params.set("items", input.items.join(","));
    if (input.animations?.length) params.set("animations", input.animations.join(","));
    if (input.limit !== undefined) params.set("limit", String(input.limit));
    if (input.cursor) params.set("cursor", input.cursor);
    const query = params.toString();
    return this.http.request<BoardReadResult>(`${this.path}${query ? `?${query}` : ""}`, { fetch: customFetch });
  }

  /** Merge a patch into the Board: fields merge, `null` deletes. */
  apply(patch: BoardPatch, options: Omit<BoardApplyInput, "patch"> = {}) {
    return this.http.request<BoardApplyResult>(`${this.path}/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...options, patch, mutationId: options.mutationId ?? createBoardEntityId() }),
    });
  }

  /** Transactions newest first, each with the before/after state of what it changed. */
  history(input: BoardHistoryInput = {}, customFetch?: Fetch) {
    const params = new URLSearchParams();
    if (input.before !== undefined) params.set("before", String(input.before));
    if (input.limit !== undefined) params.set("limit", String(input.limit));
    const query = params.toString();
    return this.http.request<BoardHistoryPage>(`${this.path}/history${query ? `?${query}` : ""}`, { fetch: customFetch });
  }

  /** Return the Board to an earlier version as a new write. */
  restore(version: number) {
    return this.http.request<BoardApplyResult>(`${this.path}/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version }),
    });
  }

  private playback(command: BoardPlaybackCommand) {
    return this.http
      .request<{ playback: BoardPlaybackSnapshot | null }>(`${this.path}/playback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      })
      .then((response) => response.playback);
  }

  /** Shared playback: every viewer follows the same clock. */
  play(animationId: string, options: { position?: number; timeScale?: number; seed?: string } = {}) {
    return this.playback({ commandId: createBoardEntityId(), type: "play", animationId, ...options });
  }

  pause() {
    return this.playback({ commandId: createBoardEntityId(), type: "pause" });
  }

  resume() {
    return this.playback({ commandId: createBoardEntityId(), type: "resume" });
  }

  seek(position: number) {
    return this.playback({ commandId: createBoardEntityId(), type: "seek", position });
  }

  /** Continue past the marker a presentation is holding at. */
  next() {
    return this.playback({ commandId: createBoardEntityId(), type: "next" });
  }

  stop() {
    return this.playback({ commandId: createBoardEntityId(), type: "stop" });
  }

  updateAwareness(seq: number, update: BoardAwarenessUpdate) {
    if (!this.websocket) return Promise.resolve();
    return this.websocket.updateBoardAwareness({ spaceId: this.spaceId, boardId: this.id, seq, update });
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
    if (type === "changed") return this.realtime.on("changed", handler as (event: BoardChangedEvent) => void);
    if (type === "awareness") return this.realtime.on("awareness", handler as (event: BoardAwarenessUpdatedEvent) => void);
    return this.realtime.on("playback", handler as (event: BoardPlaybackChangedEvent) => void);
  }
}

export class SpaceBoardsApi {
  constructor(
    private readonly http: HttpTransport,
    private readonly spaceId: string,
    private readonly websocket: WebsocketClient | null,
  ) {}

  byId(boardId: string) {
    return new BoardClient({ http: this.http, websocket: this.websocket, spaceId: this.spaceId, boardId });
  }

  /** Create a `.board` file and its Board, optionally with an initial document. */
  create(input: BoardCreateInput) {
    return this.http.request<BoardReadResult>(`/api/spaces/${this.spaceId}/boards`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }
}
