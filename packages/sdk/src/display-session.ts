import {
  DISPLAY_CONTROL_CHANNEL,
  DISPLAY_INPUT_CHANNEL,
  DISPLAY_PING_INTERVAL_MS,
  type DisplayControlMessage,
  type DisplayInfo,
  type DisplayInputEvent,
  type DisplayViewerMessage,
} from "@cohub/protocol";
import type { SpaceDisplaysApi } from "./apis/displays.js";
import { type DisplayConnectionStats, type DisplayStatsCounters, readDisplayStats } from "./display-stats.js";

export type { DisplayConnectionStats } from "./display-stats.js";

export type DisplayConnectionState = "connecting" | "connected" | "closed";

type Events = {
  state: DisplayConnectionState;
  display: DisplayInfo;
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
      await gathered(pc, options.gatherTimeoutMs ?? DEFAULT_GATHER_TIMEOUT_MS, options.signal);
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
    if (this.sessionId) void this.api.closeSession(this.displayId, this.sessionId).catch(() => undefined);
    this.sessionId = null;
    for (const track of this.stream.getTracks()) track.stop();
    this.pc.close();
    this.currentState = "closed";
    this.emit("state", "closed");
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

function gathered(pc: RTCPeerConnection, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", check);
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    const abort = () => {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", check);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(done, timeoutMs);
    pc.addEventListener("icegatheringstatechange", check);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export function connectDisplay(api: SpaceDisplaysApi, displayId: string, options?: ConnectDisplayOptions) {
  return DisplayConnection.open(api, displayId, options);
}
