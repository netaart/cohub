import {
  type BoardAwarenessUpdatedEvent as ProtocolBoardAwarenessUpdatedEvent,
  type BoardChangedEvent as ProtocolBoardChangedEvent,
  type BoardPlaybackChangedEvent as ProtocolBoardPlaybackChangedEvent,
  getRealtimeBoardRoom,
} from "@cohub/protocol/realtime/types";
import { isSpaceFsSymlink } from "@cohub/protocol/fs";
import type { BoardAwarenessPlayback, BoardAwarenessUpdate } from "@cohub/protocol/realtime";
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
  SpaceFsFileResponse,
  SpaceFsPreparingFile,
  SpaceFsSymlink,
} from "../../types.js";
import type { WebsocketClient } from "../../websocket.js";
import type { ResolvedFile, ResolveFileOptions } from "../../media.js";
import { type BoardAssetSource, type BoardDocument, isBoardPath, parseBoardManifest, readBoardDocument } from "../model/index.js";
import { type BoardReplayEntry, createBoardReplayPlayer } from "../model/replay.js";
import { type BoardElementChange, diffBoardVersions } from "../model/version-diff.js";
import { createBoardEntityId } from "../model/items/id.js";
import type { BoardRemote } from "../replica/index.js";
import { type BoardReplicaLease, type BoardReplicaLeaseOptions, captureBoardPlaybackResponse, leaseBoardReplica } from "./replicas.js";

export { type BoardReplicaLease, type BoardReplicaLeaseOptions, claimBoardCaches } from "./replicas.js";

export type BoardChangedEvent = ProtocolBoardChangedEvent;
export type BoardAwarenessUpdatedEvent = ProtocolBoardAwarenessUpdatedEvent;
export type BoardPlaybackChangedEvent = ProtocolBoardPlaybackChangedEvent;
export type BoardEventName = "changed" | "awareness" | "playback";
export type BoardSubscriptionHandlers = {
  changed?: (event: BoardChangedEvent) => void;
  awareness?: (event: BoardAwarenessUpdatedEvent) => void;
  playback?: (event: BoardPlaybackChangedEvent) => void;
  event?: (event: BoardChangedEvent | BoardAwarenessUpdatedEvent | BoardPlaybackChangedEvent) => void;
  resync?: () => void;
};

export type BoardViewer = {
  connectionId: string;
  actorId: string;
  actorName: string;
  playback: Omit<BoardAwarenessPlayback, "type"> | null;
};

type BoardPlaybackStart = Extract<BoardPlaybackCommand, { type: "play" | "seek" }>;

const ROOM_WAIT_MS = 3000;
const REPORT_GRACE_MS = 500;
const VIEWERS_LISTEN_MS = 2500;

function within(ms: number, until?: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); });
  return Promise.race(until ? [until, elapsed] : [elapsed]).then(() => clearTimeout(timer));
}

export type BoardSyncResult = Pick<BoardReadResult, "id" | "title" | "version" | "updatedAt" | "playback"> & {
  document: BoardDocument;
  changed: boolean;
};

export type BoardClientOptions = {
  http: HttpTransport;
  websocket: WebsocketClient | null;
  boardId: string;
};

class BoardRealtimeClient {
  constructor(
    private readonly websocketClient: WebsocketClient | null,
    private readonly boardId: string,
  ) {}

  subscribe(handlers: BoardSubscriptionHandlers) {
    if (!this.websocketClient) {
      throw new Error("realtime transport is not configured for this client");
    }
    ensureRealtimeConnected(this.websocketClient);
    const room = getRealtimeBoardRoom(this.boardId);
    const releaseRoom = this.websocketClient.retainRooms([room]);
    const unsubscribe = this.websocketClient.on("event", (event) => {
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
    const resync = handlers.resync;
    const stopResync = resync
      ? [
          this.websocketClient.on("subscribed", ({ rooms }) => {
            if (rooms.includes(room)) resync();
          }),
          this.websocketClient.on("subscribeError", ({ rejected }) => {
            if (rejected.some((entry) => entry.room === room && entry.code !== "UNAVAILABLE")) resync();
          }),
        ]
      : [];
    return () => {
      unsubscribe();
      for (const stop of stopResync) stop();
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
  readonly id: string;
  readonly realtime: BoardRealtimeClient;
  private readonly http: HttpTransport;
  private readonly websocket: WebsocketClient | null;

  get connectionId(): string | null {
    return this.websocket?.connectionId ?? null;
  }

  constructor(options: BoardClientOptions) {
    this.id = options.boardId;
    this.http = options.http;
    this.websocket = options.websocket;
    this.realtime = new BoardRealtimeClient(options.websocket, options.boardId);
  }

  private get path() {
    return `/api/boards/${this.id}`;
  }

  /** Read the Board, or part of it. Every value is complete, defaults included. */
  get(input: BoardReadInput = {}, customFetch?: Fetch) {
    const params = new URLSearchParams();
    if (input.only) params.set("only", input.only.join(","));
    if (input.rect) params.set("rect", [input.rect.x, input.rect.y, input.rect.width, input.rect.height].join(","));
    if (input.within) params.set("within", input.within);
    if (input.items?.length) params.set("items", input.items.join(","));
    if (input.animations?.length) params.set("animations", input.animations.join(","));
    if (input.limit !== undefined) params.set("limit", String(input.limit));
    if (input.cursor) params.set("cursor", input.cursor);
    if (input.since !== undefined) params.set("since", String(input.since));
    const query = params.toString();
    return this.http.request<BoardReadResult>(`${this.path}${query ? `?${query}` : ""}`, { fetch: customFetch });
  }

  /** Bring a cached document up to date in one request that carries only what changed since its version. */
  async sync(cached?: { version: number; document: BoardDocument } | null, customFetch?: Fetch): Promise<BoardSyncResult> {
    const result = await this.get(cached ? { since: cached.version } : {}, customFetch);
    const document = readBoardDocument(result, cached?.document);
    const { id, title, version, updatedAt, playback } = result;
    return { id, title, version, updatedAt, playback, document, changed: document !== cached?.document || version !== cached.version };
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

  async diff(from: number, to?: number): Promise<{ from: number; to: number; versions: BoardReplayEntry[]; changes: BoardElementChange[] }> {
    for (let attempt = 0; ; attempt++) {
      const live = await this.sync();
      let page = await this.history({ limit: 500 });
      if (page.version !== live.version) {
        if (attempt < 2) continue;
        throw new Error("The Board kept changing while reading its history; try again.");
      }
      const target = to ?? live.version;
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(target) || from < 0 || from >= target || target > live.version)
        throw new Error(`Versions must satisfy 0 ≤ from < to ≤ ${live.version}.`);
      const player = createBoardReplayPlayer(live.document, page);
      while (player.floor > from && page.nextBefore) {
        page = await this.history({ before: page.nextBefore, limit: 500 });
        player.prepend(page);
      }
      if (player.floor > from) throw new Error(`History before version ${player.floor} is not available.`);
      const after = player.documentAt(target);
      const before = player.documentAt(from);
      return {
        from,
        to: target,
        versions: player.entries.filter(({ version }) => version > from && version <= target),
        changes: diffBoardVersions(before, after),
      };
    }
  }

  /** Return the Board to an earlier version as a new write. */
  restore(version: number) {
    return this.http.request<BoardApplyResult>(`${this.path}/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version }),
    });
  }

  replica(options: BoardReplicaLeaseOptions = {}): BoardReplicaLease {
    return leaseBoardReplica(this.http, this.id, this, options);
  }

  async control(command: BoardPlaybackCommand) {
    const receive = captureBoardPlaybackResponse(this.http, this.id);
    const { playback } = await this.http.request<{ playback: BoardPlaybackSnapshot | null }>(`${this.path}/playback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
    });
    receive(playback);
    return playback;
  }

  /** Shared playback: every viewer follows the same clock. `preroll` holds the first frame until every screen is ready, at most that many ms. */
  play(animationId: string, options: { position?: number; timeScale?: number; seed?: string; preroll?: number } = {}) {
    return this.start({ commandId: createBoardEntityId(), type: "play", animationId, ...options });
  }

  pause() {
    return this.control({ commandId: createBoardEntityId(), type: "pause" });
  }

  resume() {
    return this.control({ commandId: createBoardEntityId(), type: "resume" });
  }

  seek(position: number, options: { preroll?: number } = {}) {
    return this.start({ commandId: createBoardEntityId(), type: "seek", position, ...options });
  }

  private async start(command: BoardPlaybackStart) {
    if (!command.preroll || !this.websocket) return this.control(command);
    const ready = new Map<string, boolean>();
    let heard = () => {};
    const listening = await this.listen((payload) => {
      const { update } = payload;
      if (update.type !== "playback" || update.commandId !== command.commandId) return;
      ready.set(payload.connectionId, update.ready || update.hidden);
      heard();
    });
    try {
      const sentAt = Date.now();
      const playback = await this.control(command);
      if (!listening.live || playback?.commandId !== command.commandId || playback.status !== "playing") return playback;
      const deadline = sentAt + command.preroll;
      await within(deadline - Date.now(), new Promise<void>((resolve) => {
        const check = () => {
          if (Date.now() - sentAt >= REPORT_GRACE_MS && [...ready.values()].every(Boolean)) resolve();
        };
        heard = check;
        void within(REPORT_GRACE_MS).then(check);
      }));
      if (Date.now() >= deadline) return playback;
      return await this.control({ commandId: createBoardEntityId(), type: "resume", ifCommand: command.commandId });
    } finally {
      listening.stop();
    }
  }

  async viewers(): Promise<BoardViewer[]> {
    const viewers = new Map<string, BoardViewer>();
    const listening = await this.listen(({ connectionId, actorId, actorName, update }) => {
      const { type, ...report } = update;
      const playback = type === "playback" ? (report as BoardViewer["playback"]) : (viewers.get(connectionId)?.playback ?? null);
      viewers.set(connectionId, { connectionId, actorId, actorName, playback });
    });
    try {
      if (!listening.live) throw new Error("The Board's realtime room is not available.");
      await within(VIEWERS_LISTEN_MS);
      return [...viewers.values()];
    } finally {
      listening.stop();
    }
  }

  private async listen(receive: (payload: BoardAwarenessUpdatedEvent["payload"]) => void) {
    const websocket = this.websocket;
    if (!websocket) throw new Error("realtime transport is not configured for this client");
    const room = getRealtimeBoardRoom(this.id);
    let joined = () => {};
    const stop = this.realtime.subscribe({ awareness: (event) => receive(event.payload), resync: () => joined() });
    if (!websocket.isRoomLive(room)) await within(ROOM_WAIT_MS, new Promise<void>((resolve) => { joined = resolve; }));
    return { live: websocket.isRoomLive(room), stop };
  }

  /** Continue past the marker a presentation is holding at. */
  next() {
    return this.control({ commandId: createBoardEntityId(), type: "next" });
  }

  stop() {
    return this.control({ commandId: createBoardEntityId(), type: "stop" });
  }

  updateAwareness(update: BoardAwarenessUpdate): Promise<void>;
  /** @deprecated The SDK orders updates itself; `seq` is ignored. */
  updateAwareness(seq: number, update: BoardAwarenessUpdate): Promise<void>;
  updateAwareness(...args: [BoardAwarenessUpdate] | [number, BoardAwarenessUpdate]) {
    const update = args.length === 2 ? args[1] : args[0];
    if (!this.websocket) return Promise.resolve();
    return this.websocket.updateBoardAwareness({ boardId: this.id, update });
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

type BoardFiles = {
  read(path: string, customFetch?: Fetch): Promise<SpaceFsFileResponse | SpaceFsPreparingFile | SpaceFsSymlink>;
  resolve(path: string, options?: ResolveFileOptions): Promise<ResolvedFile | null>;
  onUrlChange(listener: (path: string) => void): () => void;
};

async function fileText(file: SpaceFsFileResponse, customFetch: Fetch = fetch): Promise<string> {
  if (!file.content && file.delivery === "url" && file.url) {
    const response = await customFetch(file.url);
    if (!response.ok) throw new Error(`${file.path} could not be read (${response.status})`);
    return response.text();
  }
  if (file.encoding !== "base64") return file.content;
  return new TextDecoder().decode(Uint8Array.from(atob(file.content), (char) => char.charCodeAt(0)));
}

export async function readBoardId(files: Pick<BoardFiles, "read">, path: string, customFetch?: Fetch): Promise<string> {
  const file = await files.read(path, customFetch);
  if (isSpaceFsSymlink(file)) throw new Error(`${path} is a symbolic link to ${file.target}.`);
  if (!("content" in file)) throw new Error(`${path} is being prepared; try again shortly.`);
  return parseBoardManifest(await fileText(file, customFetch)).boardId;
}

export class BoardsApi {
  constructor(
    protected readonly http: HttpTransport,
    protected readonly websocket: WebsocketClient | null,
  ) {}

  byId(boardId: string) {
    return new BoardClient({ http: this.http, websocket: this.websocket, boardId });
  }
}

export class SpaceBoardsApi extends BoardsApi {
  constructor(
    http: HttpTransport,
    private readonly spaceId: string,
    websocket: WebsocketClient | null,
    private readonly files: BoardFiles,
  ) {
    super(http, websocket);
  }

  assetSource(): BoardAssetSource {
    return {
      resolveFile: (path, options) => this.files.resolve(path, options),
      subscribe: (listener) => this.files.onUrlChange(listener),
    };
  }

  async open(target: string, customFetch?: Fetch) {
    return this.byId(isBoardPath(target) ? await this.resolveId(target, customFetch) : target);
  }

  resolveId(path: string, customFetch?: Fetch): Promise<string> {
    return readBoardId(this.files, path, customFetch);
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
