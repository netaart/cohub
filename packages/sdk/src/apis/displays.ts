import type {
  DisplayCapture,
  DisplayCaptureParams,
  DisplayInputEvent,
  DisplayList,
  DisplaySession,
  DisplayTree,
  DisplayTreeParams,
  DisplayVirtualStart,
  RtcIceServers,
} from "@cohub/protocol";
import { type ConnectDisplayOptions, connectDisplay } from "../display-session.js";
import type { HttpTransport } from "../transport.js";

const ICE_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export class SpaceDisplaysApi {
  private ice: { value: RtcIceServers; refreshAt: number } | null = null;

  constructor(
    private readonly transport: HttpTransport,
    readonly spaceId: string,
  ) {}

  private path(displayId: string, suffix = "") {
    return `/api/spaces/${this.spaceId}/displays/${encodeURIComponent(displayId)}${suffix}`;
  }

  list(options: { signal?: AbortSignal } = {}) {
    return this.transport.request<DisplayList>(`/api/spaces/${this.spaceId}/displays`, { signal: options.signal });
  }

  startVirtual(params: DisplayVirtualStart = {}) {
    return this.transport.request<DisplayList>(`/api/spaces/${this.spaceId}/displays/virtual`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
  }

  stopVirtual() {
    return this.transport.request<DisplayList>(`/api/spaces/${this.spaceId}/displays/virtual`, { method: "DELETE" });
  }

  tree(displayId: string, params: DisplayTreeParams = {}, options: { signal?: AbortSignal } = {}) {
    const search = params.maxElements ? `?maxElements=${params.maxElements}` : "";
    return this.transport.request<DisplayTree>(this.path(displayId, `/tree${search}`), { signal: options.signal });
  }

  capture(displayId: string, params: DisplayCaptureParams = {}, options: { signal?: AbortSignal } = {}) {
    const query = new URLSearchParams();
    if (params.format) query.set("format", params.format);
    if (params.quality) query.set("quality", String(params.quality));
    if (params.maxSize) query.set("maxSize", String(params.maxSize));
    const search = query.size ? `?${query}` : "";
    return this.transport.request<DisplayCapture>(this.path(displayId, `/capture${search}`), { signal: options.signal });
  }

  input(displayId: string, events: DisplayInputEvent[], options: { signal?: AbortSignal } = {}) {
    return this.transport.request<{ applied: number }>(this.path(displayId, "/input"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events }),
      signal: options.signal,
    });
  }

  async iceServers(options: { signal?: AbortSignal } = {}): Promise<RtcIceServers> {
    if (this.ice && this.ice.refreshAt > Date.now()) return this.ice.value;
    const value = await this.transport.request<RtcIceServers>(`/api/spaces/${this.spaceId}/rtc/ice-servers`, { signal: options.signal });
    this.ice = { value, refreshAt: Date.parse(value.expiresAt) - ICE_REFRESH_MARGIN_MS };
    return value;
  }

  connect(displayId: string, options?: ConnectDisplayOptions) {
    return connectDisplay(this, displayId, options);
  }

  openSession(displayId: string, body: { offer: string; control?: boolean }, options: { signal?: AbortSignal } = {}) {
    return this.transport.request<DisplaySession>(this.path(displayId, "/sessions"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  }

  closeSession(displayId: string, sessionId: string) {
    return this.transport.request<{ closed: boolean }>(this.path(displayId, `/sessions/${sessionId}`), { method: "DELETE" });
  }
}
