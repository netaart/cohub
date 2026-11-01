import type {
  DisplayActParams,
  DisplayActResult,
  DisplayApps,
  DisplayCapture,
  DisplayCaptureParams,
  DisplayHandoverParams,
  DisplayHandoverResult,
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
    ).then((list) => ({ ...list, displays: list.displays ?? [] }));
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
    if (params.compact) query.set("compact", "true");
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

  act(displayId: string, params: DisplayActParams, options: { signal?: AbortSignal } = {}) {
    return this.serve("write", (workspace) => workspace.call("display.act", { ...params, display: displayId }, options.signal), () =>
      this.transport.request<DisplayActResult>(this.path(displayId, "/act"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
        signal: options.signal,
      }));
  }

  interrupt(displayId: string) {
    return this.serve("write", async (workspace) => {
      const { activity } = await workspace.call("display.interrupt", { display: displayId });
      if (!activity?.sessionId) return;
      await this.transport.request<void>(`/api/sessions/${activity.sessionId}/abort`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turnId: activity.turnId ?? null }),
      });
    }, () => this.transport.request<void>(this.path(displayId, "/interrupt"), { method: "POST" }));
  }

  handover(displayId: string, params: DisplayHandoverParams, options: { signal?: AbortSignal } = {}) {
    return this.serve("write", (workspace) => workspace.call("display.handover", { ...params, display: displayId }, options.signal), () =>
      this.transport.request<DisplayHandoverResult>(this.path(displayId, "/handover"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
        signal: options.signal,
      }));
  }

  handback(displayId: string) {
    return this.serve("write", (workspace) => workspace.call("display.handback", { display: displayId }).then(() => undefined), () =>
      this.transport.request<void>(this.path(displayId, "/handover"), { method: "DELETE" }));
  }

  apps(displayId: string, options: { signal?: AbortSignal } = {}) {
    return this.serve(
      "read",
      (workspace) => workspace.call("display.apps", { display: displayId }, options.signal),
      () => this.transport.request<DisplayApps>(this.path(displayId, "/apps"), { signal: options.signal }),
    );
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
