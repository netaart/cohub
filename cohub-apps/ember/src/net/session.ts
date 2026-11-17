import type {
  AppRoom,
  AppRoomEvent,
  AppRoomRtc,
  AppRtcChannel,
  AppRtcLocalTrack,
  AppRtcRemoteTrack,
  CohubClient,
  RealtimeRoomMember,
} from "@neta-art/cohub";
import type { CameraQuality, MediaCandidate } from "./media-policy.ts";
import { type CampEvent, readColor, readText, ROOM_MAX_PARTICIPANTS, SIGNALS, SPIRIT_ROLE } from "../camp/protocol.ts";
import { decodePose, encodePose, type Pose, POSE_HZ, POSE_IDLE_MS, poseFromRelay, poseToRelay } from "./pose.ts";

export type Transport = "connecting" | "peer" | "relay";

export type Member = {
  participantId: string;
  joinedAt: string;
  kind: "user" | "agent" | "cli";
  name: string;
  color: string;
  spirit: boolean;
  thinking: boolean;
  mic: boolean;
  x: number;
  y: number;
  placed: boolean;
  self: boolean;
};

export type Presence = { name: string; color: string; mic: boolean; x: number; y: number };

export type DragSignal = { id: string; x: number; y: number; end?: boolean };
export type StrokeSignal = { id: string; color: string; size: number; points: string; end?: boolean };
export type WaveSignal = { kind: "wave" | "spark" | "heart" };

export type RemoteTrack = {
  participantId: string;
  name: string;
  kind: "audio" | "video";
  track: MediaStreamTrack;
  setQuality(quality: CameraQuality): Promise<void>;
};

export type SessionHandlers = {
  onEvent(event: CampEvent & { participantId: string; self: boolean; clientEventId: string | null }): void;
  onResync(events: CampEvent[]): Promise<void>;
  onMembers(members: Member[]): void;
  onPose(participantId: string, pose: Pose): void;
  onDrag(participantId: string, drag: DragSignal): void;
  onStroke(participantId: string, stroke: StrokeSignal): void;
  onWave(participantId: string, wave: WaveSignal): void;
  onTracks(tracks: RemoteTrack[]): void;
  onTransport(transport: Transport): void;
  onNotice(notice: "reconnecting" | "no-rtc"): void;
};

type Signals = Record<string, unknown>;

const HISTORY_PAGE = 200;
const HISTORY_PAGES = 6;
const RELAY_POSE_MS = 250;
const RELAY_DRAG_MS = 120;
const MEDIA_INTERVAL_MS = 700;
const DEFAULT_COLOR = "#f4a261";

const isMissingRoom = (error: unknown) => {
  const code = (error as { code?: unknown })?.code;
  if (code === "ROOM_NOT_FOUND" || code === "ROOM_EXPIRED") return true;
  return /not found|expired/i.test(String((error as Error)?.message ?? ""));
};

const toCampEvent = (event: AppRoomEvent<unknown>): CampEvent => ({
  type: event.type,
  data: event.data,
  sequence: event.sequence,
  at: event.timestamp,
});

const isSignal = (type: string) => (Object.values(SIGNALS) as string[]).includes(type);

export class CampSession {
  readonly code: string;
  private readonly client: CohubClient;
  private readonly handlers: SessionHandlers;
  private room: AppRoom<Signals> | null = null;
  private rtc: AppRoomRtc | null = null;
  private peerConnected = false;
  private channels: { pose: AppRtcChannel; drag: AppRtcChannel; stroke: AppRtcChannel; wave: AppRtcChannel } | null = null;
  private readonly offs: Array<() => unknown> = [];
  private readonly timers: Array<ReturnType<typeof setInterval>> = [];
  private readonly local = new Map<string, AppRtcLocalTrack>();
  private presence: Presence;
  private backlog: AppRoomEvent<unknown>[] | null = null;
  private peered = new Set<string>();
  private relayNeeded = false;
  private lastPose: Pose | null = null;
  private poseAt = Number.NEGATIVE_INFINITY;
  private relayPoseAt = Number.NEGATIVE_INFINITY;
  private relayDragAt = Number.NEGATIVE_INFINITY;
  private mediaPlan: (candidates: readonly MediaCandidate[]) => Set<string> = () => new Set();
  private selection: string | null = null;
  private disposed = false;
  private resyncing = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 500;
  private backlogOverflow = false;

  constructor(client: CohubClient, code: string, presence: Presence, handlers: SessionHandlers) {
    this.client = client;
    this.code = code;
    this.presence = presence;
    this.handlers = handlers;
  }

  get participantId() {
    return this.room?.participantId ?? "";
  }

  get peerReady() {
    return this.rtc !== null;
  }

  async join(): Promise<CampEvent[]> {
    const realtime = this.client.app.realtime;
    const room = await realtime.joinRoom<Signals>({ code: this.code }).catch((error: unknown) => {
      if (!isMissingRoom(error)) throw error;
      return realtime.createRoom<Signals>({ code: this.code, maxParticipants: ROOM_MAX_PARTICIPANTS, seatPerUser: true });
    });
    this.room = room;
    if (this.disposed) {
      await room.leave();
      throw new Error("Camp join was cancelled.");
    }
    this.backlog = [];
    this.offs.push(
      room.subscribeAll((event) => {
        if (!this.backlog || isSignal(event.type)) {
          this.receive(event);
          return;
        }
        if (this.backlog.length >= 1000) {
          this.backlog.shift();
          this.backlogOverflow = true;
        }
        this.backlog.push(event);
      }),
      room.onMembersChanged((members) => this.absorb(members)),
      room.onStateChange((state) => {
        if (state === "reconnecting") this.handlers.onNotice("reconnecting");
      }),
      room.onOutOfSync(() => void this.resync().catch(() => this.handlers.onNotice("reconnecting"))),
    );
    await this.setPresence({});
    this.absorb(room.members);
    const history = await this.readHistory();
    if (this.disposed) throw new Error("Camp join was cancelled.");
    void this.openPeer();
    this.timers.push(setInterval(() => this.reconcileMedia(), MEDIA_INTERVAL_MS));
    return history;
  }

  resume() {
    this.flushBacklog();
  }

  private async readHistory(): Promise<CampEvent[]> {
    const room = this.room;
    if (!room) return [];
    const events: CampEvent[] & { truncated?: boolean } = [];
    let after = 0;
    for (let page = 0; page < HISTORY_PAGES && !this.disposed; page += 1) {
      const result = await room.history({ after, limit: HISTORY_PAGE });
      events.truncated ||= result.truncated;
      for (const event of result.events) if (!isSignal(event.type)) events.push(toCampEvent(event));
      if (result.events.length < HISTORY_PAGE) break;
      after = result.cursor;
    }
    return events;
  }

  private flushBacklog() {
    const backlog = this.backlog ?? [];
    this.backlog = null;
    for (const event of backlog.sort((a, b) => a.sequence - b.sequence)) this.receive(event);
  }

  refresh() {
    return this.resync();
  }

  private async resync() {
    if (this.resyncing || !this.room || this.disposed) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.resyncing = true;
    this.backlog ??= [];
    this.backlogOverflow = false;
    try {
      const history = await this.readHistory();
      if (this.disposed) return;
      if (this.backlogOverflow) throw new Error("Camp changed too quickly during recovery.");
      await this.handlers.onResync(history);
      if (this.disposed) return;
      if (this.backlogOverflow) throw new Error("Camp changed too quickly during recovery.");
      this.flushBacklog();
      this.retryDelay = 500;
    } catch (error) {
      if (!this.disposed) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          void this.resync().catch(() => this.handlers.onNotice("reconnecting"));
        }, this.retryDelay);
        this.retryDelay = Math.min(10_000, this.retryDelay * 2);
      }
      throw error;
    } finally {
      this.resyncing = false;
    }
  }

  async setPresence(patch: Partial<Presence>) {
    this.presence = { ...this.presence, ...patch };
    await this.room?.setPresence({ role: "camper", ...this.presence }).catch(() => undefined);
  }

  publish(type: string, data: unknown, clientEventId?: string) {
    if (!this.room) return Promise.reject(new Error("not in a room"));
    return this.room.publish(type, data, clientEventId ? { clientEventId } : undefined);
  }

  async invite(expiresInSeconds = 900) {
    if (!this.room) throw new Error("not in a room");
    return this.room.invite({ expiresInSeconds });
  }

  private get relaying() {
    return !this.peerConnected || this.relayNeeded;
  }

  sendPose(pose: Pose) {
    this.lastPose = pose;
    const now = performance.now();
    const moving = pose.walking || pose.level > 0.05;
    if (this.channels && this.peerConnected && now - this.poseAt >= (moving ? 1000 / POSE_HZ : POSE_IDLE_MS)) {
      this.poseAt = now;
      this.channels.pose.send(encodePose(pose));
    }
    if (this.relaying && now - this.relayPoseAt >= (moving ? RELAY_POSE_MS : POSE_IDLE_MS)) {
      this.relayPoseAt = now;
      this.room?.send(SIGNALS.pose, poseToRelay(pose));
    }
  }

  sendDrag(drag: DragSignal) {
    if (this.peerConnected) this.channels?.drag.send(drag);
    const now = performance.now();
    if (this.relaying && (drag.end || now - this.relayDragAt >= RELAY_DRAG_MS)) {
      this.relayDragAt = now;
      this.room?.send(SIGNALS.drag, drag);
    }
  }

  sendStroke(stroke: StrokeSignal) {
    if (this.peerConnected) this.channels?.stroke.send(stroke);
    if (this.relaying && (stroke.end || stroke.points.length < 600)) this.room?.send(SIGNALS.stroke, stroke);
  }

  sendWave(wave: WaveSignal) {
    if (this.peerConnected) this.channels?.wave.send(wave);
    if (this.relaying) this.room?.send(SIGNALS.wave, wave);
  }

  async publishMic(track: MediaStreamTrack) {
    if (!this.rtc) throw new Error("voice unavailable");
    const handles = await this.rtc.publish({ mic: track });
    if (this.disposed || track.readyState === "ended") {
      await Promise.all(Object.values(handles).map((handle) => handle.stop()));
      return;
    }
    for (const [name, handle] of Object.entries<AppRtcLocalTrack>(handles)) this.local.set(name, handle);
  }

  async publishCamera(track: MediaStreamTrack) {
    if (!this.rtc || this.disposed) throw new Error("Video unavailable.");
    const handles = await this.rtc.publish({ cam: { track, simulcast: true } });
    if (this.disposed || track.readyState === "ended") {
      await Promise.all(Object.values(handles).map((handle) => handle.stop()));
      return;
    }
    this.local.set("cam", handles.cam);
  }

  async stopCamera() {
    const handle = this.local.get("cam");
    this.local.delete("cam");
    await handle?.stop().catch(() => undefined);
  }

  async stopMic() {
    const handle = this.local.get("mic");
    this.local.delete("mic");
    await handle?.stop().catch(() => undefined);
  }

  selectMedia(plan: (candidates: readonly MediaCandidate[]) => Set<string>) {
    this.mediaPlan = plan;
    this.reconcileMedia();
  }

  private reconcileMedia() {
    const rtc = this.rtc;
    if (!rtc) return;
    const chosen = [...this.mediaPlan(rtc.candidates)].sort();
    const key = chosen.join("|");
    if (key === this.selection) return;
    this.selection = key;
    const set = new Set(chosen);
    rtc.select((candidate) => set.has(`${candidate.participantId}:${candidate.name}`));
  }

  async leave() {
    const room = this.room;
    this.dispose();
    await room?.leave().catch(() => undefined);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.backlog = null;
    for (const off of this.offs.splice(0)) off();
    for (const timer of this.timers.splice(0)) clearInterval(timer);
    this.rtc?.close();
    this.rtc = null;
    this.peerConnected = false;
    this.channels = null;
  }

  private absorb(members: RealtimeRoomMember[]) {
    const own = this.room?.participantId ?? "";
    const people = members.filter((member) => member.participantId !== own && (member.kind ?? "user") === "user");
    this.peered = new Set(people.filter(hasPeerChannels).map((member) => member.participantId));
    this.relayNeeded = people.some((member) => !this.peered.has(member.participantId));
    this.handlers.onMembers(members.map((member) => toMember(member, own)));
    this.reconcileMedia();
  }

  private receive(event: AppRoomEvent<unknown>) {
    const from = event.sender.participantId;
    if (isSignal(event.type)) {
      if (event.self || (this.peerConnected && this.peered.has(from))) return;
      this.signal(event.type, from, event.data);
      return;
    }
    this.handlers.onEvent({ ...toCampEvent(event), participantId: from, self: event.self, clientEventId: event.clientEventId });
  }

  private signal(type: string, from: string, data: unknown) {
    if (type === SIGNALS.pose) {
      const pose = poseFromRelay(data);
      if (pose) this.handlers.onPose(from, pose);
    } else if (type === SIGNALS.drag) {
      const drag = readDrag(data);
      if (drag) this.handlers.onDrag(from, drag);
    } else if (type === SIGNALS.stroke) {
      const stroke = readStroke(data);
      if (stroke) this.handlers.onStroke(from, stroke);
    } else if (type === SIGNALS.wave) {
      const wave = readWave(data);
      if (wave) this.handlers.onWave(from, wave);
    }
  }

  private async openPeer() {
    if (typeof RTCPeerConnection === "undefined" || !this.room) {
      this.handlers.onTransport("relay");
      this.handlers.onNotice("no-rtc");
      return;
    }
    try {
      const rtc = await this.room.rtc();
      if (this.disposed) return rtc.close();
      this.rtc = rtc;
      this.selection = null;
      this.reconcileMedia();
      const channels = {
        pose: rtc.channel(SIGNALS.pose, { delivery: "latest" }),
        drag: rtc.channel(SIGNALS.drag, { delivery: "latest" }),
        stroke: rtc.channel(SIGNALS.stroke, { delivery: "latest" }),
        wave: rtc.channel(SIGNALS.wave),
      };
      this.channels = channels;
      this.offs.push(
        rtc.onStateChange((state) => {
          this.peerConnected = state === "connected";
          this.handlers.onTransport(this.peerConnected ? "peer" : "relay");
          if (state === "reconnecting") this.handlers.onNotice("reconnecting");
        }),
        rtc.onTracksChanged((tracks) => this.handlers.onTracks(tracks.map(toRemoteTrack))),
        channels.pose.onMessage(({ from, data }) => {
          const pose = data instanceof ArrayBuffer ? decodePose(data) : null;
          if (pose) this.handlers.onPose(from, pose);
        }),
        channels.drag.onMessage(({ from, data }) => {
          const drag = readDrag(data);
          if (drag) this.handlers.onDrag(from, drag);
        }),
        channels.stroke.onMessage(({ from, data }) => {
          const stroke = readStroke(data);
          if (stroke) this.handlers.onStroke(from, stroke);
        }),
        channels.wave.onMessage(({ from, data }) => {
          const wave = readWave(data);
          if (wave) this.handlers.onWave(from, wave);
        }),
      );
      this.peerConnected = rtc.state === "connected";
      this.handlers.onTransport(this.peerConnected ? "peer" : "relay");
      if (this.lastPose) channels.pose.send(encodePose(this.lastPose));
      this.reconcileMedia();
    } catch {
      this.peerConnected = false;
      this.handlers.onTransport("relay");
      this.handlers.onNotice("no-rtc");
    }
  }
}

const hasPeerChannels = (member: RealtimeRoomMember) =>
  (member.publications ?? []).some((publication) => publication.kind === "data" && publication.name === SIGNALS.pose);

const toMember = (member: RealtimeRoomMember, own: string): Member => {
  const presence = (member.presence ?? {}) as Record<string, unknown>;
  const kind = member.kind === "agent" || member.kind === "cli" ? member.kind : "user";
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && Math.abs(value) < 4000 ? value : null);
  const x = number(presence.x);
  const y = number(presence.y);
  return {
    participantId: member.participantId,
    joinedAt: member.joinedAt,
    kind,
    name: readText(presence.name, 24),
    color: readColor(presence.color, DEFAULT_COLOR),
    spirit: presence.role === SPIRIT_ROLE && kind !== "user",
    thinking: presence.thinking === true,
    mic: presence.mic === true,
    x: x ?? 0,
    y: y ?? 240,
    placed: x !== null && y !== null,
    self: member.participantId === own,
  };
};

const toRemoteTrack = (track: AppRtcRemoteTrack): RemoteTrack => ({
  participantId: track.participantId, name: track.name, kind: track.kind, track: track.track,
  setQuality: (quality) => track.setQuality(quality),
});

const ID_RE = /^[A-Za-z0-9_]{4,32}$/;

const readDrag = (value: unknown): DragSignal | null => {
  const raw = value as Partial<DragSignal> | null;
  if (!raw || typeof raw.id !== "string" || !ID_RE.test(raw.id)) return null;
  if (typeof raw.x !== "number" || typeof raw.y !== "number" || !Number.isFinite(raw.x) || !Number.isFinite(raw.y)) return null;
  return { id: raw.id, x: raw.x, y: raw.y, ...(raw.end === true ? { end: true } : {}) };
};

const readStroke = (value: unknown): StrokeSignal | null => {
  const raw = value as Partial<StrokeSignal> | null;
  if (!raw || typeof raw.id !== "string" || !ID_RE.test(raw.id) || typeof raw.points !== "string" || raw.points.length > 8000) return null;
  const size = typeof raw.size === "number" && Number.isFinite(raw.size) ? Math.min(14, Math.max(2, raw.size)) : 4;
  return { id: raw.id, color: readColor(raw.color), size, points: raw.points, ...(raw.end === true ? { end: true } : {}) };
};

const readWave = (value: unknown): WaveSignal | null => {
  const kind = (value as Partial<WaveSignal> | null)?.kind;
  return kind === "wave" || kind === "spark" || kind === "heart" ? { kind } : null;
};
