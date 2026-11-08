import {
  DISPLAY_CONTROL_CHANNEL,
  DISPLAY_CURSOR_INTERVAL_MS,
  DISPLAY_INPUT_CHANNEL,
  DISPLAY_PING_INTERVAL_MS,
  type DisplayAgentPointer,
  type DisplayControlMessage,
  type DisplayCursor,
  type DisplayFocus,
  type DisplayInfo,
  type DisplayInputEvent,
  type DisplayViewerMessage,
} from "@cohub/protocol";
import type { SpaceDisplaysApi } from "./apis/displays.js";
import { type DisplayConnectionStats, type DisplayStatsCounters, readDisplayStats } from "./display-stats.js";
import { waitForIceGathering } from "./rtc/index.js";

export type { DisplayConnectionStats } from "./display-stats.js";

export type DisplayConnectionState = "connecting" | "connected" | "closed";

type Events = {
  state: DisplayConnectionState;
  display: DisplayInfo;
  focus: DisplayFocus | null;
  pointer: DisplayAgentPointer;
  cursors: DisplayCursor[];
  error: { code: string; message: string };
};

export type ConnectDisplayOptions = {
  control?: boolean;
  signal?: AbortSignal;
  gatherTimeoutMs?: number;
  connectTimeoutMs?: number;
};

const DEFAULT_GATHER_TIMEOUT_MS = 2_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;
const INPUT_BACKLOG_BYTES = 64 * 1024;

export class DisplayConnection {
  readonly stream = new MediaStream();
  private currentState: DisplayConnectionState = "connecting";
  private currentDisplay: DisplayInfo | null = null;
  private currentFocus: DisplayFocus | null = null;
  private reason: string | null = null;
  private sessionId: string | null = null;
  private readonly listeners = new Map<keyof Events, Set<(value: never) => void>>();
  private readonly controlChannel: RTCDataChannel;
  private readonly inputChannel: RTCDataChannel | null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingId = 0;
  private lastPingAt = 0;
  private rtt: number | null = null;
  private counters: DisplayStatsCounters | null = null;
  private isPaused = false;
  private cursorAt: { x: number; y: number } | null = null;
  private cursorSent = 0;
  private cursorTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(
    private readonly api: SpaceDisplaysApi,
    readonly displayId: string,
    readonly control: boolean,
    private readonly pc: RTCPeerConnection,
  ) {
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.ontrack = (event) => {
      const receiver = event.receiver as RTCRtpReceiver & { jitterBufferTarget?: number | null };
      if ("jitterBufferTarget" in receiver) receiver.jitterBufferTarget = 0;
      this.stream.addTrack(event.track);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") this.setState("connected");
      else if (pc.connectionState === "failed") this.close("failed");
    };
    this.controlChannel = pc.createDataChannel(DISPLAY_CONTROL_CHANNEL);
    this.controlChannel.onmessage = (event) => this.onControl(event.data);
    this.controlChannel.onopen = () => {
      if (this.isPaused) this.sendControl({ type: "pause" });
      this.startPings();
    };
    this.controlChannel.onclose = () => this.close(this.reason ?? "closed");
    this.inputChannel = control ? pc.createDataChannel(DISPLAY_INPUT_CHANNEL) : null;
  }

  static async open(api: SpaceDisplaysApi, displayId: string, options: ConnectDisplayOptions = {}): Promise<DisplayConnection> {
    const { iceServers } = await api.iceServers({ signal: options.signal });
    const pc = new RTCPeerConnection({ iceServers, bundlePolicy: "max-bundle" });
    const connection = new DisplayConnection(api, displayId, options.control ?? true, pc);
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await waitForIceGathering(pc, options.gatherTimeoutMs ?? DEFAULT_GATHER_TIMEOUT_MS, options.signal);
      const offer = pc.localDescription?.sdp;
      if (!offer) throw new Error("The browser produced no offer");
      const session = await api.openSession(displayId, { offer, control: connection.control }, { signal: options.signal });
      connection.sessionId = session.sessionId;
      await pc.setRemoteDescription({ type: "answer", sdp: session.answer });
      connection.connectTimer = setTimeout(() => connection.close("connect_timeout"), options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
      return connection;
    } catch (error) {
      connection.close("failed");
      throw error;
    }
  }

  get state(): DisplayConnectionState {
    return this.currentState;
  }

  get display(): DisplayInfo | null {
    return this.currentDisplay;
  }

  get focus(): DisplayFocus | null {
    return this.currentFocus;
  }

  get closeReason(): string | null {
    return this.currentState === "closed" ? this.reason : null;
  }

  on<K extends keyof Events>(event: K, listener: (value: Events[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as (value: never) => void);
    return () => set.delete(listener as (value: never) => void);
  }

  private emit<K extends keyof Events>(event: K, value: Events[K]) {
    for (const listener of this.listeners.get(event) ?? []) (listener as (value: Events[K]) => void)(value);
  }

  private setState(state: DisplayConnectionState) {
    if (this.currentState === state || this.currentState === "closed") return;
    this.currentState = state;
    if (state === "connected" && this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    this.emit("state", state);
  }

  sendInput(events: DisplayInputEvent[]): boolean {
    const channel = this.inputChannel;
    if (channel?.readyState !== "open" || events.length === 0) return false;
    if (channel.bufferedAmount > INPUT_BACKLOG_BYTES && events.every((event) => event.type === "pointer" && event.action === "move")) return false;
    channel.send(JSON.stringify({ events }));
    return true;
  }

  sendCursor(point: { x: number; y: number } | null) {
    const changed = point ? this.cursorAt?.x !== point.x || this.cursorAt?.y !== point.y : this.cursorAt !== null;
    if (!changed) return;
    this.cursorAt = point;
    if (this.cursorTimer) return;
    const wait = this.cursorSent + DISPLAY_CURSOR_INTERVAL_MS - performance.now();
    if (!point || wait <= 0) return this.flushCursor();
    this.cursorTimer = setTimeout(() => this.flushCursor(), wait);
  }

  private flushCursor() {
    if (this.cursorTimer) clearTimeout(this.cursorTimer);
    this.cursorTimer = null;
    this.cursorSent = performance.now();
    this.sendControl(this.cursorAt ? { type: "cursor", ...this.cursorAt } : { type: "cursor" });
  }

  requestKeyframe() {
    this.sendControl({ type: "keyframe" });
  }

  get paused(): boolean {
    return this.isPaused;
  }

  pause() {
    if (this.isPaused) return;
    this.isPaused = true;
    this.sendControl({ type: "pause" });
  }

  resume() {
    if (!this.isPaused) return;
    this.isPaused = false;
    this.counters = null;
    this.sendControl({ type: "resume" });
  }

  async stats(): Promise<DisplayConnectionStats> {
    const { stats, counters } = readDisplayStats(await this.pc.getStats(), this.counters, this.rtt);
    this.counters = counters;
    return stats;
  }

  close(reason = "closed") {
    if (this.currentState === "closed") return;
    this.reason = reason;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.cursorTimer) clearTimeout(this.cursorTimer);
    if (this.sessionId) void this.api.closeSession(this.displayId, this.sessionId).catch(() => undefined);
    this.sessionId = null;
    for (const track of this.stream.getTracks()) track.stop();
    this.pc.close();
    this.currentState = "closed";
    this.emit("state", "closed");
  }

  private setFocus(focus: DisplayFocus | undefined) {
    const next = focus ?? null;
    if (sameFocus(this.currentFocus, next)) return;
    this.currentFocus = next;
    this.emit("focus", next);
  }

  private startPings() {
    const ping = () => {
      this.pingId += 1;
      this.lastPingAt = performance.now();
      this.sendControl({ type: "ping", id: this.pingId });
    };
    ping();
    this.pingTimer = setInterval(ping, DISPLAY_PING_INTERVAL_MS);
  }

  private sendControl(message: DisplayViewerMessage) {
    if (this.controlChannel.readyState === "open") this.controlChannel.send(JSON.stringify(message));
  }

  private onControl(data: unknown) {
    if (typeof data !== "string") return;
    let message: DisplayControlMessage;
    try {
      message = JSON.parse(data) as DisplayControlMessage;
    } catch {
      return;
    }
    switch (message.type) {
      case "ready":
      case "display":
        this.currentDisplay = message.display;
        this.emit("display", message.display);
        if (message.type === "ready") this.setFocus(message.focus);
        break;
      case "focus":
        this.setFocus(message.focus);
        break;
      case "agent":
        if (message.pointer) this.emit("pointer", message.pointer);
        break;
      case "cursors":
        this.emit("cursors", message.cursors ?? []);
        break;
      case "pong":
        if (message.id === this.pingId) this.rtt = Math.round(performance.now() - this.lastPingAt);
        break;
      case "error":
        this.emit("error", { code: message.code, message: message.message });
        break;
      case "closed":
        this.sessionId = null;
        this.close(message.reason);
        break;
    }
  }
}

function sameFocus(a: DisplayFocus | null, b: DisplayFocus | null) {
  if (!a || !b) return a === b;
  return a.password === b.password && a.bounds.every((value, index) => value === b.bounds[index]);
}

export function connectDisplay(api: SpaceDisplaysApi, displayId: string, options?: ConnectDisplayOptions) {
  return DisplayConnection.open(api, displayId, options);
}
