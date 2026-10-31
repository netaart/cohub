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
import { createLocalWorkspaces, type LocalWorkspace, type LocalWorkspaces } from "../local-workspace.js";
import { IceServerCache } from "../rtc/index.js";
import type { HttpTransport } from "../transport.js";

export class SpaceDisplaysApi {
  private readonly ice = new IceServerCache((signal) =>
    this.transport.request<RtcIceServers>(`/api/spaces/${this.spaceId}/rtc/ice-servers`, { signal }),
  );

  constructor(
    private readonly transport: HttpTransport,
    readonly spaceId: string,
    private readonly workspaces: LocalWorkspaces = createLocalWorkspaces(),
  ) {}

  private serve<T>(mode: "read" | "write", local: (workspace: LocalWorkspace) => Promise<T>, remote: () => Promise<T>): Promise<T> {
    return this.workspaces.run(this.spaceId, mode, local, remote);
  }

  private path(displayId: string, suffix = "") {
    return `/api/spaces/${this.spaceId}/displays/${encodeURIComponent(displayId)}${suffix}`;
  }

  list(options: { signal?: AbortSignal } = {}) {
    return this.serve(
      "read",
      (workspace) => workspace.call("display.list", {}, options.signal),
      () => this.transport.request<DisplayList>(`/api/spaces/${this.spaceId}/displays`, { signal: options.signal }),
    );
  }

  startVirtual(params: DisplayVirtualStart = {}) {
    return this.serve("write", (workspace) => workspace.call("display.start", params), () =>
      this.transport.request<DisplayList>(`/api/spaces/${this.spaceId}/displays/virtual`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      }));
  }

  stopVirtual() {
    return this.serve("write", (workspace) => workspace.call("display.stop", {}), () =>
      this.transport.request<DisplayList>(`/api/spaces/${this.spaceId}/displays/virtual`, { method: "DELETE" }));
  }

  tree(displayId: string, params: DisplayTreeParams = {}, options: { signal?: AbortSignal } = {}) {
    const query = new URLSearchParams();
    if (params.maxElements) query.set("maxElements", String(params.maxElements));
    if (params.actionable) query.set("actionable", "true");
    const search = query.size ? `?${query}` : "";
    return this.serve(
      "read",
      (workspace) => workspace.call("display.tree", { ...params, display: displayId }, options.signal),
      () => this.transport.request<DisplayTree>(this.path(displayId, `/tree${search}`), { signal: options.signal }),
    );
  }

  capture(displayId: string, params: DisplayCaptureParams = {}, options: { signal?: AbortSignal } = {}) {
    const query = new URLSearchParams();
    if (params.format) query.set("format", params.format);
    if (params.quality) query.set("quality", String(params.quality));
    if (params.maxSize) query.set("maxSize", String(params.maxSize));
    const search = query.size ? `?${query}` : "";
    return this.serve(
      "read",
      (workspace) => workspace.call("display.capture", { ...params, display: displayId }, options.signal),
      () => this.transport.request<DisplayCapture>(this.path(displayId, `/capture${search}`), { signal: options.signal }),
    );
  }

  input(displayId: string, events: DisplayInputEvent[], options: { signal?: AbortSignal } = {}) {
    return this.serve("write", (workspace) => workspace.call("display.input", { events, display: displayId }, options.signal), () =>
      this.transport.request<{ applied: number }>(this.path(displayId, "/input"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events }),
        signal: options.signal,
      }));
  }

  iceServers(options: { signal?: AbortSignal } = {}): Promise<RtcIceServers> {
    return this.ice.get(options.signal);
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
