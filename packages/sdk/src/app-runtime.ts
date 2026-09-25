import { buildAppRuntimeCloseRequest, buildAppRuntimeReady, parseAppRuntimeAnnounce, buildAppRuntimeConfigureRequest, buildAppRuntimePointer, type AppAppearance, type AppRuntimeConfigureRequest, type AppRuntimeAnchor, type AppRuntimeRect } from "@cohub/protocol/app-runtime";

// Re-export configure types so tsdown can emit them in the DTS bundle.
export type { AppAppearance, AppRuntimeConfigureRequest, AppRuntimeAnchor, AppRuntimeRect };
import {
  buildAppNavigationOpenMessage,
  type AppNavigationOpenResponse,
  type AppNavigationTarget,
  type AppNavigationCall,
  parseAppNavigationOpenResponse,
} from "@cohub/protocol/app-navigation";
import { PERMISSIONS, type CreateSpaceInput, type Permission } from "./types.js";
import { appAuthorizationRequestSchema, appAuthorizationResultSchema, type AppAuthorizationRequest as ProtocolAuthorizationRequest, type AppAuthorizationResult } from "@cohub/protocol";
export type { AppAuthorizationResult } from "@cohub/protocol";
export type AppAuthorizationRequest = Omit<ProtocolAuthorizationRequest, "scopes"> & { scopes: Permission[] };

export class AppRuntimeError extends Error {
  readonly retryable: boolean;
  constructor(readonly code: string, message: string, readonly requestId?: string) {
    super(message);
    this.name = "AppRuntimeError";
    this.retryable = code === "host_timeout" || code === "login_timeout" || code === "request_failed";
  }
}

export type AppRuntimeInvocationContext = {
  surface: "page" | "app" | "overlay" | "background" | "broker";
  source?: "desktop_command" | "user" | "route" | "embed";
  spaceId?: string;
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
  /**
   * The App whose page embeds this one, when `source` is `embed`. Present only
   * when that App's published content is served from the embedding frame.
   */
  embedder?: { appId: string; slug: string };
  /** The file this open hands to the App, when the App opens files. */
  file?: { path: string };
  /** Unique per open: a new id means the host opened the App again. */
  id?: string;
};

/** Current navigation context supplied by the embedding Cohub shell. */
export type AppRuntimeShellContext = {
  surface: "workspace" | "background" | "broker" | "embed";
  space: { id: string; name?: string | null } | null;
  session: { id: string } | null;
  /** The Turn currently in view, not necessarily the Turn being generated. */
  turn: { id: string } | null;
};

export type AppRuntimeGrantSummary = {
  spaceId: string;
  scopes: Permission[];
};

export type AppRuntimeContext = {
  /** Host capabilities, independent of the viewer's granted permissions. */
  capabilities?: { authorization: 2; serverGrants: true };
  mode?: "bridge" | "broker";
  app: {
    id: string;
    slug: string;
    url?: string | null;
    /** The Space that owns the App. */
    homeSpace?: { id: string; name?: string | null };
  };
  /** @deprecated Use `app.homeSpace` for the App's home Space. */
  space: { id: string; name?: string | null };
  viewer?: { userUuid: string } | null;
  invocation?: AppRuntimeInvocationContext;
  shell?: AppRuntimeShellContext;
  /** BCP 47 locale the viewer reads the host in, e.g. `zh-CN`. */
  locale?: string;
  /** Theme and design tokens the viewer currently sees. */
  appearance?: AppAppearance;
  /** Whether the host is showing this App's surface right now. */
  window?: { visible: boolean };
  permissions?: {
    scopes: Permission[];
    appScopes: Permission[];
    viewerScopes: Permission[];
    /** Per-space viewer-consented grants. */
    viewerGrants?: AppRuntimeGrantSummary[];
  };
};

export type AppRuntimeCheckoutStatus = "success" | "failed" | "cancel" | null;

export type AppRuntimeCheckoutState = {
  status: AppRuntimeCheckoutStatus;
  orderId: string | null;
};

type RuntimeResponse =
  | { type: "cohub.app.context.result"; requestId: string; context: AppRuntimeContext }
  | { type: "cohub.app.token.result"; requestId: string; token: string | null }
  | { type: "cohub.app.authorize.result"; requestId: string; token: string | null }
  | { type: "cohub.app.purchase.result"; requestId: string; checkout: { providerKey: string | null; checkoutUrl: string | null; checkoutUsable: boolean; status: string | null; message: string | null; orderId: string; productKey: string } | null }
  | { type: "cohub.app.checkout-state.result"; requestId: string; status: AppRuntimeCheckoutStatus; orderId: string | null }
  | { type: "cohub.app.error"; requestId: string; message: string; code?: string };

/**
 * Options for a single app runtime transport request.
 */
export type AppRuntimeRequestOptions = {
  /** How long to wait for a matching response before resolving with null. */
  timeoutMs?: number;
  /** When set, re-posts the request on this interval until a response arrives. */
  retryIntervalMs?: number;
};

/**
 * Transport layer for {@link AppRuntimeApi}. Decoupled so the same API can run
 * over either the iframe parent bridge (bridge mode) or a popup broker window
 * (broker mode). The transport is responsible for posting the request and
 * resolving with the first matching response (or null on timeout).
 */
export type AppContextChangedListener = (context: AppRuntimeContext) => void;

/** A developer-facing diagnostic forwarded by the host. */
export type AppDiagnostic = {
  code: string;
  message: string;
  detail?: Record<string, unknown>;
};

export type AppDiagnosticListener = (diagnostic: AppDiagnostic) => void;

export interface AppRuntimeTransport {
  /** Broker transports never persist bearer tokens or consent caches. */
  readonly memoryOnly?: boolean;
  /** Current broker viewer, when the broker has completed a session exchange. */
  readonly getViewerIdentity?: () => string | null | undefined;
  request<T>(
    message: Record<string, unknown>,
    options?: AppRuntimeRequestOptions,
  ): Promise<T | null>;
  subscribeContextChanged?: (listener: AppContextChangedListener) => () => void;
  /** Subscribes to host diagnostics (developer-facing, non-blocking). */
  subscribeDiagnostics?: (listener: AppDiagnosticListener) => () => void;
  /** Whether this transport can address the embedding Cohub workspace. */
  supportsNavigation?: boolean;
  /** Posts a one-way message to the host; no reply is expected. */
  notify?: (message: Record<string, unknown>) => void;
  /** Subscribes to unsolicited runtime messages from the host (drags, close requests). */
  subscribeHostMessages?: (listener: (data: unknown) => void) => () => void;
  /** Whether a Cohub host has answered this runtime, proving it speaks the protocol. */
  isHostConnected?: () => boolean;
}

const isBrowser = () => typeof window !== "undefined" && typeof window.parent !== "undefined";
const hasParent = () => isBrowser() && window.parent !== window;
const getParentOrigin = () => {
  if (!isBrowser()) return null;
  const ancestorOrigin = window.location.ancestorOrigins?.[0];
  if (typeof ancestorOrigin === "string" && ancestorOrigin) return ancestorOrigin;
  try {
    return document.referrer ? new URL(document.referrer).origin : null;
  } catch {
    return null;
  }
};

const generateRequestId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/**
 * Bridge-mode transport: posts messages to `window.parent` (the Cohub host
 * embedding the app in an iframe) and listens for the matching reply.
 * Behaviorally identical to the previous module-level `request()` helper.
 */
export class ParentBridgeTransport implements AppRuntimeTransport {
  readonly supportsNavigation = true;
  private trustedParentOrigin: string | null = null;
  private readyAnnounced = false;
  private contextListeners = new Set<AppContextChangedListener>();
  private contextListener: ((event: MessageEvent) => void) | null = null;
  private diagnosticListeners = new Set<AppDiagnosticListener>();
  private diagnosticListener: ((event: MessageEvent) => void) | null = null;
  private hostListeners = new Set<(data: unknown) => void>();
  private hostListener: ((event: MessageEvent) => void) | null = null;
  private announceListener: ((event: MessageEvent) => void) | null = null;

  isHostConnected() {
    return this.trustedParentOrigin !== null;
  }

  private isFromParent(event: MessageEvent) {
    if (event.source !== window.parent) return false;
    const parentOrigin = this.trustedParentOrigin ?? getParentOrigin();
    return !parentOrigin || event.origin === parentOrigin;
  }

  subscribeHostMessages(listener: (data: unknown) => void) {
    if (!hasParent() || typeof window.addEventListener !== "function") return () => {};
    this.hostListeners.add(listener);
    this.announceReady();
    if (!this.hostListener) {
      this.hostListener = (event) => {
        if (!this.isFromParent(event)) return;
        for (const current of this.hostListeners) current(event.data);
      };
      window.addEventListener("message", this.hostListener);
    }
    return () => {
      this.hostListeners.delete(listener);
      if (this.hostListeners.size === 0 && this.hostListener) {
        window.removeEventListener("message", this.hostListener);
        this.hostListener = null;
      }
    };
  }

  /**
   * Tells the host the runtime is ready once, before any subscription. Hosts
   * gate unsolicited messages (context pushes, diagnostics) on this handshake,
   * so the diagnostic subscription must trigger it too — an app that never
   * subscribes to context still needs diagnostics to arrive.
   */
  private announceReady() {
    if (this.readyAnnounced || !hasParent()) return;
    const parentOrigin = this.trustedParentOrigin ?? getParentOrigin();
    if (!parentOrigin) return;
    try {
      window.parent.postMessage(buildAppRuntimeReady(), parentOrigin);
      this.readyAnnounced = true;
      this.answerAnnounceRequests();
    } catch {
      // The host may have been disposed during app startup.
    }
  }

  /** Says ready again when a reloaded host asks. */
  private answerAnnounceRequests() {
    if (this.announceListener || typeof window.addEventListener !== "function") return;
    this.announceListener = (event) => {
      if (!this.isFromParent(event) || !parseAppRuntimeAnnounce(event.data)) return;
      this.readyAnnounced = false;
      this.announceReady();
    };
    window.addEventListener("message", this.announceListener);
  }

  subscribeDiagnostics(listener: AppDiagnosticListener) {
    if (!hasParent() || typeof window.addEventListener !== "function") return () => {};
    this.diagnosticListeners.add(listener);
    this.announceReady();
    if (!this.diagnosticListener) {
      this.diagnosticListener = (event) => {
        if (event.source !== window.parent) return;
        const parentOrigin = this.trustedParentOrigin ?? getParentOrigin();
        if (parentOrigin && event.origin !== parentOrigin) return;
        const data = event.data as { type?: string; code?: unknown; message?: unknown; detail?: unknown };
        if (data?.type !== "cohub.app.diagnostic") return;
        if (typeof data.code !== "string" || typeof data.message !== "string") return;
        const diagnostic: AppDiagnostic = {
          code: data.code,
          message: data.message,
          ...(data.detail && typeof data.detail === "object"
            ? { detail: data.detail as Record<string, unknown> }
            : {}),
        };
        for (const current of this.diagnosticListeners) current(diagnostic);
      };
      window.addEventListener("message", this.diagnosticListener);
    }
    return () => {
      this.diagnosticListeners.delete(listener);
      if (this.diagnosticListeners.size === 0 && this.diagnosticListener) {
        window.removeEventListener("message", this.diagnosticListener);
        this.diagnosticListener = null;
      }
    };
  }

  subscribeContextChanged(listener: AppContextChangedListener) {
    if (!hasParent() || typeof window.addEventListener !== "function") return () => {};
    this.contextListeners.add(listener);
    if (!this.contextListener) {
      this.contextListener = (event) => {
        if (event.source !== window.parent) return;
        const parentOrigin = this.trustedParentOrigin ?? getParentOrigin();
        if (parentOrigin && event.origin !== parentOrigin) return;
        const data = event.data as { type?: string; context?: AppRuntimeContext };
        if (data?.type !== "cohub.app.context.changed" || !data.context) return;
        for (const current of this.contextListeners) current(data.context);
      };
      window.addEventListener("message", this.contextListener);
      this.announceReady();
    }
    return () => {
      this.contextListeners.delete(listener);
      if (this.contextListeners.size === 0 && this.contextListener) {
        window.removeEventListener("message", this.contextListener);
        this.contextListener = null;
      }
    };
  }

  notify(message: Record<string, unknown>) {
    if (!hasParent()) return;
    try {
      window.parent.postMessage(message, this.trustedParentOrigin ?? getParentOrigin() ?? "*");
    } catch {
      // The host may have been disposed.
    }
  }

  request<T>(
    message: Record<string, unknown>,
    options?: AppRuntimeRequestOptions,
  ): Promise<T | null> {
    const timeoutMs = options?.timeoutMs ?? 1_200;
    const retryIntervalMs = options?.retryIntervalMs;
    if (!hasParent()) return Promise.resolve(null);
    const requestId =
      typeof message.requestId === "string" && message.requestId
        ? message.requestId
        : generateRequestId();
    return new Promise((resolve, reject) => {
      let retryTimer: ReturnType<typeof setInterval> | null = null;
      const parentOrigin = this.trustedParentOrigin ?? getParentOrigin();
      const postRequest = () => {
        try {
          window.parent.postMessage({ ...message, requestId }, parentOrigin ?? "*");
        } catch {
          return;
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        if (retryTimer) clearInterval(retryTimer);
        window.removeEventListener("message", onMessage);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, timeoutMs);
      const onMessage = (event: MessageEvent<RuntimeResponse>) => {
        if (event.source !== window.parent) return;
        if (parentOrigin && event.origin !== parentOrigin) return;
        const data = event.data;
        if (!data || data.requestId !== requestId) return;
        cleanup();
        this.trustedParentOrigin = event.origin;
        if (data.type === "cohub.app.error") {
          reject(new AppRuntimeError(data.code ?? "request_failed", data.message, requestId));
          return;
        }
        resolve(data as T);
      };
      window.addEventListener("message", onMessage);
      postRequest();
      if (retryIntervalMs) retryTimer = setInterval(postRequest, retryIntervalMs);
    });
  }
}

/**
 * Broker-mode transport for standalone-deployed apps. Opens a popup window to
 * the Cohub auth broker page, performs a ready-handshake, sends the request via
 * postMessage, and resolves with the broker's response. The popup is closed
 * after a single request is fulfilled (one-shot, per §7.2 of the plan).
 *
 * Non-interactive messages (`context`, `checkout-state`) are answered locally
 * without opening a popup — the app already knows its own appId, and
 * checkout state is not available on the app's own origin in broker mode.
 */
export type AppRuntimeResolvedApp = {
  id: string;
  slug: string;
  url: string | null;
  homeSpace: { id: string; name: string | null };
  appScopes: Permission[];
};

export type AppRuntimeAppResolver = () => Promise<AppRuntimeResolvedApp | null>;

export class PopupBrokerTransport implements AppRuntimeTransport {
  readonly supportsNavigation = false;
  readonly memoryOnly = true;
  private readonly brokerOrigin: string;
  private readonly appId?: string;
  private readonly getAppId?: () => Promise<string | null>;
  private readonly app?: AppRuntimeResolvedApp;
  private readonly getApp?: AppRuntimeAppResolver;
  private viewerGrants: AppRuntimeGrantSummary[] = [];
  private viewerIdentity: string | null | undefined;

  getViewerIdentity() {
    return this.viewerIdentity;
  }

  private observeViewerIdentity(next: string | null | undefined) {
    if (next !== undefined && this.viewerIdentity !== undefined && next !== this.viewerIdentity) {
      this.viewerGrants = [];
    }
    if (next !== undefined) this.viewerIdentity = next;
  }

  constructor(config: {
    brokerOrigin: string;
    /** Explicit app id. When absent, {@link getAppId} is used to resolve it. */
    appId?: string;
    getAppId?: () => Promise<string | null>;
    /** Complete identity discovered from the standalone page origin. */
    app?: AppRuntimeResolvedApp;
    getApp?: AppRuntimeAppResolver;
  }) {
    this.brokerOrigin = config.brokerOrigin;
    this.appId = config.appId;
    this.getAppId = config.getAppId;
    this.app = config.app;
    this.getApp = config.getApp;
    // Warm origin/slug discovery while the page is idle. A later click can
    // then open the popup without losing the browser's user activation.
    if (!this.app && this.getApp) void this.getApp();
    else if (!this.appId && this.getAppId) void this.getAppId();
  }

  private async resolveApp(): Promise<AppRuntimeResolvedApp | null> {
    if (this.app) return this.app;
    const resolved = await this.getApp?.();
    if (resolved) return resolved;
    const appId = this.appId ?? await this.getAppId?.() ?? null;
    return appId
      ? { id: appId, slug: "", url: null, homeSpace: { id: "", name: null }, appScopes: [] }
      : null;
  }

  private async resolveAppId(): Promise<string | null> {
    return (await this.resolveApp())?.id ?? null;
  }

  async request<T>(
    message: Record<string, unknown>,
    options?: AppRuntimeRequestOptions,
  ): Promise<T | null> {
    // Non-interactive messages are answered locally to avoid popping up a
    // window for data the app already has (or cannot have).
    if (message.type === "cohub.app.context") {
      const app = await this.resolveApp();
      if (!app) return null;
      const viewerScopes = Array.from(new Set(this.viewerGrants.flatMap((grant) => grant.scopes)));
      return {
        type: "cohub.app.context.result",
        context: {
          capabilities: { authorization: 2, serverGrants: true },
          mode: "broker",
          app: {
            id: app.id,
            slug: app.slug,
            url: app.url,
            homeSpace: { ...app.homeSpace },
          },
          space: { id: app.homeSpace.id, name: app.homeSpace.name },
          ...(this.viewerIdentity !== undefined
            ? { viewer: this.viewerIdentity ? { userUuid: this.viewerIdentity } : null }
            : {}),
          invocation: { surface: "broker", source: "route" },
          shell: { surface: "broker", space: null, session: null, turn: null },
          permissions: {
            scopes: Array.from(new Set([...app.appScopes, ...viewerScopes])),
            appScopes: [...app.appScopes],
            viewerScopes,
            viewerGrants: this.viewerGrants.map((grant) => ({ ...grant, scopes: [...grant.scopes] })),
          },
        },
      } as T;
    }
    if (message.type === "cohub.app.checkout-state") {
      return {
        type: "cohub.app.checkout-state.result",
        status: null,
        orderId: null,
      } as T;
    }

    const timeoutMs = options?.timeoutMs ?? 120_000;
    const requestId = generateRequestId();

    // Resolve the appId before opening the popup. When warmed at construction
    // this is an already-settled promise, so the await is a microtask and the
    // popup still opens within the user-activation window.
    const appId = await this.resolveAppId();
    if (!appId) {
      throw new Error(
        "Unable to resolve the app id for broker mode. Provide `appId` or a valid slug triple (ownerUsername, spaceSlug, appSlug).",
      );
    }

    return new Promise<T | null>((resolve, reject) => {
      if (typeof window === "undefined" || typeof window.open !== "function") {
        resolve(null);
        return;
      }

      const appOrigin = window.location.origin;
      const brokerUrl = `${this.brokerOrigin}/app-auth?app=${encodeURIComponent(appId)}&origin=${encodeURIComponent(appOrigin)}`;

      const popup = window.open(brokerUrl, `cohub-app-auth-${appId}`, "popup,width=480,height=640");
      if (!popup) {
        reject(new Error("Failed to open authorization window. Please allow popups for this site."));
        return;
      }

      let ready = false;
      let loginPending = false;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let closeChecker: ReturnType<typeof setInterval> | null = null;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (closeChecker) clearInterval(closeChecker);
        window.removeEventListener("message", onMessage);
        try { popup.close(); } catch { /* ignore */ }
        fn();
      };

      timer = setTimeout(() => {
        finish(() => {
          if (!ready) reject(new Error("Authorization window did not respond in time."));
          else resolve(null);
        });
      }, timeoutMs);

      const onMessage = (event: MessageEvent<RuntimeResponse | { type: string; requestId?: string }>) => {
        if (event.source !== popup) return;
        if (event.origin !== this.brokerOrigin) return;
        const data = event.data;
        if (!data) return;

        if (data.type === "cohub.app.broker.progress" && !loginPending && !ready) {
          loginPending = true;
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => finish(() => reject(new AppRuntimeError("login_timeout", "Login did not complete in time."))), 600_000);
          return;
        }

        // Handshake: broker signals it's ready to receive the actual request.
        if (data.type === "cohub.app.broker.ready" && !ready) {
          const brokerViewer = (data as { viewer?: { userUuid?: unknown } | null }).viewer;
          this.observeViewerIdentity(
            brokerViewer === null
              ? null
              : typeof brokerViewer?.userUuid === "string"
                ? brokerViewer.userUuid
                : undefined,
          );
          if (message.type === "cohub.app.authorize.v2" && (data as { authorizationVersion?: number }).authorizationVersion !== 2) {
            finish(() => reject(new AppRuntimeError("unsupported", "This host does not support structured authorization.")));
            return;
          }
          ready = true;
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => finish(() => reject(new AppRuntimeError("host_timeout", "Authorization timed out."))), timeoutMs);
          try {
            popup.postMessage({ ...message, requestId }, this.brokerOrigin);
          } catch {
            finish(() => reject(new Error("Failed to send request to authorization window.")));
          }
          return;
        }

        // Response to our request.
        if (data.requestId !== requestId) return;
        finish(() => {
          if (data.type === "cohub.app.error") {
            reject(new AppRuntimeError((data as { code?: string }).code ?? "request_failed", (data as { message: string }).message, requestId));
            return;
          }

          const rawResult = (data as { result?: unknown }).result;
          if (message.type === "cohub.app.authorize.v2") {
            const parsedResult = appAuthorizationResultSchema.safeParse(rawResult);
            if (!parsedResult.success) {
              reject(new AppRuntimeError("invalid_response", "Invalid authorization result.", requestId));
              return;
            }
            const authorization = parsedResult.data;
            if (authorization.status === "granted") {
              const token = (data as { token?: unknown }).token;
              if (typeof token !== "string" || !token) {
                reject(new AppRuntimeError("invalid_response", "Authorization token is missing.", requestId));
                return;
              }
              const knownScopes = new Set<string>(PERMISSIONS);
              const scopes = authorization.grant.scopes.filter(
                (scope): scope is Permission => knownScopes.has(scope),
              );
              const existing = this.viewerGrants.filter((grant) => grant.spaceId !== authorization.grant.spaceId);
              this.viewerGrants = [...existing, { spaceId: authorization.grant.spaceId, scopes }];
            }
          }
          resolve(data as T);
        });
      };

      window.addEventListener("message", onMessage);

      // Safety: if the popup closes before responding, reject.
      closeChecker = setInterval(() => {
        if (popup.closed) {
          finish(() => {
            if (message.type === "cohub.app.authorize.v2") resolve({ result: { status: "cancelled" } } as T);
            else if (!ready) reject(new Error("Authorization window was closed."));
            else resolve(null);
          });
        }
      }, 500);
    });
  }
}

const TOKEN_STORAGE_PREFIX = "cohub:app-token";

const AUTHORIZED_GRANTS_STORAGE_PREFIX = "cohub:app-auth-grants";

/** Outcome of {@link AppRuntimeApi.requestSpaceAuthorization} / {@link AppRuntimeApi.requestCreateSpaceAuthorization}. */
export type AppRuntimeAuthorizationResult = {
  granted: boolean;
  /** Picked or created Space. Null on deny. Set with `granted: false` when create persisted but did not provision. */
  space: { id: string; name: string | null } | null;
};

/** A consent remembered client-side so token refreshes can re-authorize. */
export type AppRuntimeAuthorizedGrant = {
  /** Target space; omitted for the app's home space. */
  spaceId?: string;
  scopes: Permission[];
};

/** The space a server response actually granted, when it says so. */
const responseSpaceId = (value: unknown): string | undefined =>
  typeof value === "string" && value ? value : undefined;

/**
 * Records one consent, keyed by its space. Newer entries replace older ones
 * for the same space, so implicit home-space requests (no `spaceId`) and
 * explicit ones converge onto a single entry once the server echoes its
 * canonical space id back.
 */
function recordConsent(
  grants: AppRuntimeAuthorizedGrant[] | null | undefined,
  spaceId: string | undefined,
  scopes: Permission[],
): AppRuntimeAuthorizedGrant[] {
  const others = (grants ?? []).filter((grant) => grant.spaceId !== spaceId);
  return [...others, spaceId ? { spaceId, scopes } : { scopes }];
}

const isAuthorizedGrant = (value: unknown): value is AppRuntimeAuthorizedGrant => {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<AppRuntimeAuthorizedGrant>;
  return (
    (record.spaceId === undefined || typeof record.spaceId === "string") &&
    Array.isArray(record.scopes) &&
    record.scopes.every((scope) => typeof scope === "string")
  );
};

export class AppRuntimeApi {
  private token: string | null = null;
  private readonly transport: AppRuntimeTransport;
  private tokenStorageKey: string | null;
  private grantsStorageKey: string | null;
  private readonly appIdResolver?: AppIdResolver;
  /** Ensures storage keys are resolved (via slug lookup) at most once. */
  private storageKeysReady: Promise<void> | null;
  /** Consents previously granted via requestAuthorization, retained so token
   * refreshes can re-authorize (preserving viewer grants) instead of falling
   * back to a base session token that only carries app-side scopes. */
  private authorizedGrants: AppRuntimeAuthorizedGrant[] | null = null;

  /**
   * Rect input regions are hover-gated by the host, which needs to know when
   * the pointer leaves them. A cross-origin frame swallows those moves once
   * the host makes it interactive, so while a rect region is active we report
   * the pointer ourselves. `all`/`none` need no reporting: their state is
   * known without it.
   */
  private pointerListening = false;
  private pointerForwarding = false;
  private pointerDown = false;
  private pointerFrame: number | null = null;
  private pointerPending: { x: number; y: number } | null = null;
  /** Cleanup for the constructor's diagnostic subscription; cleared on dispose. */
  private diagnosticUnsubscribe: (() => void) | null;

  private readonly onPointerMove = (event: PointerEvent) => {
    if (!this.pointerForwarding) return;
    this.pointerDown = event.buttons !== 0;
    this.queuePointer(event.clientX, event.clientY);
  };

  private readonly onPointerDown = (event: PointerEvent) => {
    if (!this.pointerForwarding) return;
    this.pointerDown = true;
    this.flushPointer(event.clientX, event.clientY);
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    // Deliver the release even after forwarding stopped mid-press (the App
    // may have switched to `none`), or the host would keep the region hot.
    if (!this.pointerForwarding && !this.pointerDown) return;
    this.pointerDown = false;
    this.flushPointer(event.clientX, event.clientY);
  };

  private readonly onPointerCancel = (event: PointerEvent) => {
    if (!this.pointerForwarding && !this.pointerDown) return;
    this.pointerDown = false;
    this.flushPointer(event.clientX, event.clientY);
  };

  /** Coalesce moves to one message per frame; presses flush immediately. */
  private queuePointer(x: number, y: number) {
    this.pointerPending = { x, y };
    if (this.pointerFrame !== null) return;
    this.pointerFrame = requestAnimationFrame(() => {
      this.pointerFrame = null;
      const pending = this.pointerPending;
      this.pointerPending = null;
      if (pending && this.pointerForwarding) {
        this.reportPointer(pending.x, pending.y, this.pointerDown);
      }
    });
  }

  private flushPointer(x: number, y: number) {
    if (this.pointerFrame !== null) {
      cancelAnimationFrame(this.pointerFrame);
      this.pointerFrame = null;
    }
    this.pointerPending = null;
    this.reportPointer(x, y, this.pointerDown);
  }

  private reportPointer(x: number, y: number, down: boolean) {
    this.transport.notify?.(buildAppRuntimePointer({ x, y, down }));
  }

  private setPointerForwarding(on: boolean) {
    if (typeof window === "undefined" || !this.transport.notify) return;
    this.pointerForwarding = on;
    if (!on || this.pointerListening) return;
    // Listeners stay attached once a rect region has been declared, so an
    // in-flight release is still reported after the App opts out.
    this.pointerListening = true;
    window.addEventListener("pointermove", this.onPointerMove, { passive: true, capture: true });
    window.addEventListener("pointerdown", this.onPointerDown, true);
    window.addEventListener("pointerup", this.onPointerUp, true);
    window.addEventListener("pointercancel", this.onPointerCancel, true);
  }

  constructor(
    transport: AppRuntimeTransport = new ParentBridgeTransport(),
    appId?: string,
    appIdResolver?: AppIdResolver,
  ) {
    this.transport = transport;
    this.contextUnsubscribe = transport.subscribeContextChanged?.((context) => this.observeContext(context)) ?? null;
    this.appIdResolver = appIdResolver;
    // Surface host diagnostics (e.g. an app requesting a Space the viewer can't
    // access) to the app author's console. Non-blocking and viewer-invisible.
    // Kept so `dispose()` can release the window listener.
    this.diagnosticUnsubscribe =
      transport.subscribeDiagnostics?.((diagnostic) => {
        console.warn(
          `[cohub] ${diagnostic.message} (${diagnostic.code})`,
          diagnostic.detail ?? {},
        );
      }) ?? null;
    if (appId) {
      // appId known up-front — keys are immediately available.
      this.tokenStorageKey = `${TOKEN_STORAGE_PREFIX}:${appId}`;
      this.grantsStorageKey = `${AUTHORIZED_GRANTS_STORAGE_PREFIX}:${appId}`;
      this.storageKeysReady = Promise.resolve();
      // Broker must establish the current viewer before reusing a cached token.
      this.token = this.readStoredToken();
      this.authorizedGrants = this.readStoredGrants();
    } else if (appIdResolver) {
      // appId resolved lazily via slug reverse lookup. Storage keys — and any
      // cached token — become available only after the lookup completes.
      this.tokenStorageKey = null;
      this.grantsStorageKey = null;
      this.storageKeysReady = null;
    } else {
      this.tokenStorageKey = null;
      this.grantsStorageKey = null;
      this.storageKeysReady = Promise.resolve();
    }
  }

  /**
   * Resolves the localStorage keys once the appId is known. When the appId is
   * only available via slug reverse lookup, this performs the lookup on first
   * use and then restores any cached token/scopes for that appId.
   */
  private ensureStorageKeys(): Promise<void> {
    if (this.storageKeysReady) return this.storageKeysReady;
    this.storageKeysReady = (async () => {
      const appId = this.appIdResolver ? await this.appIdResolver() : null;
      if (appId) {
        this.tokenStorageKey = `${TOKEN_STORAGE_PREFIX}:${appId}`;
        this.grantsStorageKey = `${AUTHORIZED_GRANTS_STORAGE_PREFIX}:${appId}`;
        // Broker context is anonymous until it confirms the viewer. Never
        // hydrate a previous account's App token before that confirmation.
        const stored = this.readStoredToken();
        if (stored && !this.token) this.token = stored;
        const storedGrants = this.readStoredGrants();
        if (storedGrants && !this.authorizedGrants) this.authorizedGrants = storedGrants;
      }
    })();
    return this.storageKeysReady;
  }

  private readStoredToken(): string | null {
    if (this.transport.memoryOnly) {
      this.writeStoredToken(null);
      return null;
    }
    if (!this.tokenStorageKey || typeof localStorage === "undefined") return null;
    try {
      return localStorage.getItem(this.tokenStorageKey);
    } catch {
      return null;
    }
  }

  private writeStoredToken(token: string | null) {
    if (this.transport.memoryOnly) token = null;
    if (!this.tokenStorageKey || typeof localStorage === "undefined") return;
    try {
      if (token) localStorage.setItem(this.tokenStorageKey, token);
      else localStorage.removeItem(this.tokenStorageKey);
    } catch {
      // ignore storage failures (quota, privacy mode)
    }
  }

  private readStoredGrants(): AppRuntimeAuthorizedGrant[] | null {
    if (this.transport.memoryOnly) {
      if (this.grantsStorageKey && typeof localStorage !== "undefined") {
        try {
          localStorage.removeItem(this.grantsStorageKey);
        } catch {
          // ignore storage failures
        }
      }
      return null;
    }
    if (!this.grantsStorageKey || typeof localStorage === "undefined") return null;
    try {
      const raw = localStorage.getItem(this.grantsStorageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || !parsed.every(isAuthorizedGrant)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private writeStoredGrants(grants: AppRuntimeAuthorizedGrant[] | null) {
    if (this.transport.memoryOnly) return;
    if (!this.grantsStorageKey || typeof localStorage === "undefined") return;
    try {
      if (grants && grants.length > 0) localStorage.setItem(this.grantsStorageKey, JSON.stringify(grants));
      else localStorage.removeItem(this.grantsStorageKey);
    } catch {
      // ignore storage failures
    }
  }

  private serverGrants = false;
  private viewerIdentity: string | null | undefined;

  private observeTransportIdentity() {
    const viewer = this.transport.getViewerIdentity?.();
    if (viewer !== undefined) this.observeViewer(viewer);
  }

  private observeViewer(viewer: string | null) {
    if (this.viewerIdentity !== undefined && viewer !== this.viewerIdentity) {
      this.identityVersion++;
      this.token = null;
      this.authorizedGrants = null;
      this.writeStoredToken(null);
      this.writeStoredGrants(null);
    }
    this.viewerIdentity = viewer;
  }
  private identityVersion = 0;
  private contextUnsubscribe: (() => void) | null = null;

  private observeContext(context: AppRuntimeContext) {
    if (context.capabilities?.serverGrants) this.serverGrants = true;
    if (context.viewer === undefined) return;
    this.observeViewer(context.viewer?.userUuid ?? null);
  }

  async context() {
    this.observeTransportIdentity();
    const response = await this.transport.request<{ context: AppRuntimeContext }>(
      { type: "cohub.app.context" },
      { timeoutMs: 8_000, retryIntervalMs: 250 },
    );
    if (response?.context) this.observeContext(response.context);
    return response?.context ?? null;
  }

  onContextChanged(listener: AppContextChangedListener) {
    return this.transport.subscribeContextChanged?.(listener) ?? (() => {});
  }

  /** Subscribes to developer-facing host diagnostics. */
  onDiagnostic(listener: AppDiagnosticListener) {
    return this.transport.subscribeDiagnostics?.(listener) ?? (() => {});
  }

  /**
   * Releases listeners and any pending pointer frame this runtime registered.
   * Safe to call more than once.
   */
  dispose() {
    // Clear before invoking so an injected transport's non-idempotent cleanup
    // still runs exactly once.
    const unsubscribe = this.diagnosticUnsubscribe;
    this.diagnosticUnsubscribe = null;
    unsubscribe?.();
    this.contextUnsubscribe?.();
    this.contextUnsubscribe = null;
    this.pointerForwarding = false;
    this.pointerPending = null;
    if (this.pointerFrame !== null) {
      if (typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(this.pointerFrame);
      }
      this.pointerFrame = null;
    }
    if (this.pointerListening && typeof window !== "undefined") {
      window.removeEventListener("pointermove", this.onPointerMove, { capture: true });
      window.removeEventListener("pointerdown", this.onPointerDown, true);
      window.removeEventListener("pointerup", this.onPointerUp, true);
      window.removeEventListener("pointercancel", this.onPointerCancel, true);
      this.pointerListening = false;
    }
  }

  async navigationOpen(
    target: AppNavigationTarget,
    call?: AppNavigationCall,
  ): Promise<AppNavigationOpenResponse> {
    if (this.transport.supportsNavigation === false) {
      return {
        protocol: "cohub.app.navigation",
        version: 1,
        type: "open.result",
        requestId: "local",
        handled: false,
        reason: "unsupported",
      };
    }
    const requestId =
      globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    const response = await this.transport.request<unknown>(
      buildAppNavigationOpenMessage({
        requestId,
        target,
        ...(call ? { call } : {}),
      }),
      { timeoutMs: 8_000 },
    );
    const parsed = parseAppNavigationOpenResponse(response);
    return (
      (parsed && parsed.requestId === requestId ? parsed : null) ?? {
        protocol: "cohub.app.navigation",
        version: 1,
        type: "open.result",
        requestId,
        handled: false,
        reason: response === null ? "timeout" : "unsupported",
      }
    );
  }

  /**
   * Asks the host to close this App: a workspace tab closes, an embedded page
   * forwards the request to its embedder, a standalone page closes the tab.
   * No-op in broker mode, where the App owns its own window.
   */
  requestClose() {
    this.transport.notify?.(buildAppRuntimeCloseRequest());
  }

  /**
   * Requests the host to update the overlay's geometry or pointer hit regions.
   * Only meaningful when the App was opened as an `overlay` surface; the host
   * is free to clamp or ignore values that violate its layout policy.
   *
   * A non-empty rect `inputRegion` also starts reporting the pointer to the
   * host, which is how the host learns when it leaves the region.
   */
  requestConfigure(input: Omit<AppRuntimeConfigureRequest, "protocol" | "version" | "type">) {
    this.transport.notify?.(buildAppRuntimeConfigureRequest(input));
    if (input.inputRegion !== undefined) {
      this.setPointerForwarding(
        Array.isArray(input.inputRegion) && input.inputRegion.length > 0,
      );
    }
  }

  async getAccessToken(options?: { forceRefresh?: boolean }) {
    await this.ensureStorageKeys();
    this.observeTransportIdentity();
    const identityVersion = this.identityVersion;
    // Broker tokens are intentionally memory-only, but still valid for this
    // runtime instance. Reopening a popup for every API call breaks non-click
    // requests and can be blocked by the browser.
    if (this.token && !options?.forceRefresh) return this.token;
    if (options?.forceRefresh) {
      this.token = null;
      this.writeStoredToken(null);
    }
    const serverGrants = this.serverGrants;
    // Compatibility for older hosts whose tokens contained viewer permissions.
    // Modern hosts resolve grants server-side and must never re-open consent.
    // When refreshing a token, re-authorize every consent the app previously
    // obtained so the refreshed token retains those viewer grants. A plain
    // /session token only carries app-side scopes, which would cause 403 on
    // viewer-scoped operations. Each authorize call returns a token carrying
    // all live grants, so the last response is the complete token.
    if (!serverGrants && options?.forceRefresh && this.authorizedGrants && this.authorizedGrants.length > 0) {
      // A denied consent (the viewer denied the dialog, or the server
      // rejected the renewal) is dropped; a transient failure (network,
      // unavailable host) keeps the consent so a later refresh can renew it.
      let refreshed = false;
      let next: AppRuntimeAuthorizedGrant[] = [];
      for (const grant of this.authorizedGrants) {
        try {
          const response = await this.transport.request<{ token: string | null; space?: { id?: unknown } | null }>(
            { type: "cohub.app.authorize", scopes: grant.scopes, spaceId: grant.spaceId },
            { timeoutMs: 120_000 },
          );
          this.observeTransportIdentity();
          if (identityVersion !== this.identityVersion && !this.transport.memoryOnly) return null;
          const token = response?.token ?? null;
          if (!token) continue; // denied — drop this consent, keep the others
          this.token = token;
          next = recordConsent(next, responseSpaceId(response?.space?.id) ?? grant.spaceId, grant.scopes);
          refreshed = true;
        } catch {
          this.observeTransportIdentity();
          if (identityVersion !== this.identityVersion && !this.transport.memoryOnly) return null;
          // Transient failure — keep the consent untouched.
          next = recordConsent(next, grant.spaceId, grant.scopes);
        }
      }
      this.authorizedGrants = next;
      this.writeStoredGrants(next);
      if (refreshed) {
        this.writeStoredToken(this.token);
        return this.token;
      }
      // Nothing refreshed — fall through to a plain session token. Viewer
      // grants still apply server-side, so the app keeps working.
    }
    const response = await this.transport.request<{ token: string | null }>(
      { type: "cohub.app.token", forceRefresh: Boolean(options?.forceRefresh) },
      { timeoutMs: 20_000 },
    );
    this.observeTransportIdentity();
    if (identityVersion !== this.identityVersion && !this.transport.memoryOnly) return null;
    this.token = response?.token ?? null;
    this.writeStoredToken(this.token);
    return this.token;
  }

  /** Structured authorization. Legacy hosts cannot execute this message. */
  async authorize(input: AppAuthorizationRequest): Promise<AppAuthorizationResult> {
    const parsed = appAuthorizationRequestSchema.safeParse(input);
    if (!parsed.success) throw new AppRuntimeError("invalid_request", "Invalid authorization request.");
    await this.ensureStorageKeys();
    const context = await this.context();
    if (context?.mode !== "broker" && context?.capabilities?.authorization !== 2) {
      throw new AppRuntimeError("unsupported", "This host does not support structured authorization.");
    }
    const identityVersion = this.identityVersion;
    const response = await this.transport.request<{ token?: string; result?: unknown }>(
      { type: "cohub.app.authorize.v2", ...parsed.data },
      { timeoutMs: 120_000 },
    );
    this.observeTransportIdentity();
    if (identityVersion !== this.identityVersion && !this.transport.memoryOnly) throw new AppRuntimeError("session_changed", "The signed-in account changed. Please try again.");
    if (!response) throw new AppRuntimeError("host_timeout", "Authorization host did not respond. It may not support structured authorization.");
    const result = appAuthorizationResultSchema.safeParse(response.result);
    if (!result.success) throw new AppRuntimeError("invalid_response", "Invalid authorization result.");
    this.serverGrants = true;
    if (result.data.status === "granted") {
      if (typeof response.token !== "string" || !response.token) throw new AppRuntimeError("invalid_response", "Authorization token is missing.");
      this.token = response.token;
      this.writeStoredToken(this.token);
    }
    return result.data;
  }

  /**
   * @deprecated Use authorize() to receive the actual target and grant.
   * Requests viewer consent. With an accessible `spaceId` the grant targets
   * that Space; otherwise the host resolves a viewer-controlled Space (the
   * invocation or embedding Space, then the viewer's last picked Space, then
   * their first accessible one) — never the app author's home Space. The app
   * may only grant what the viewer can already do there themselves. Reuses a
   * previous grant silently unless `alwaysAsk` forces the consent dialog.
   *
   * Returns whether a token was granted; use
   * {@link requestSpaceAuthorization} when the app needs to know which Space.
   */
  async requestAuthorization(input: { scopes: Permission[]; reason?: string; spaceId?: string; alwaysAsk?: boolean }) {
    await this.ensureStorageKeys();
    this.observeTransportIdentity();
    const response = await this.transport.request<{ token: string | null; space?: { id?: unknown } | null }>(
      { type: "cohub.app.authorize", scopes: input.scopes, reason: input.reason, spaceId: input.spaceId, alwaysAsk: input.alwaysAsk },
      { timeoutMs: 120_000 },
    );
    this.observeTransportIdentity();
    const token = response?.token ?? null;
    // A denial leaves any existing token untouched — it stays valid until it
    // expires, and only a successful consent replaces it.
    if (token) {
      this.token = token;
      this.writeStoredToken(token);
      const spaceId = responseSpaceId(response?.space?.id) ?? input.spaceId;
      this.authorizedGrants = recordConsent(this.authorizedGrants, spaceId, input.scopes);
      this.writeStoredGrants(this.authorizedGrants);
    }
    return Boolean(token);
  }

  /**
   * @deprecated Use authorize() with a pick-space target.
   * Asks the viewer to pick a Space and grant the scopes on it — one consent
   * dialog covers both. Resolves with the picked space so the app knows where
   * it may act; `space` is null when the viewer denied.
   */
  async requestSpaceAuthorization(input: { scopes: Permission[]; reason?: string; alwaysAsk?: boolean }): Promise<AppRuntimeAuthorizationResult> {
    await this.ensureStorageKeys();
    this.observeTransportIdentity();
    const response = await this.transport.request<{ token: string | null; space?: { id?: unknown; name?: unknown } | null }>(
      { type: "cohub.app.authorize", scopes: input.scopes, reason: input.reason, selectSpace: true, alwaysAsk: input.alwaysAsk },
      { timeoutMs: 120_000 },
    );
    this.observeTransportIdentity();
    const token = response?.token ?? null;
    const spaceId = typeof response?.space?.id === "string" ? response.space.id : null;
    const spaceName = typeof response?.space?.name === "string" ? response.space.name : null;
    // A denial leaves any existing token untouched.
    if (token) {
      this.token = token;
      this.writeStoredToken(token);
    }
    if (token && spaceId) {
      this.authorizedGrants = recordConsent(this.authorizedGrants, spaceId, input.scopes);
      this.writeStoredGrants(this.authorizedGrants);
    }
    return {
      granted: Boolean(token),
      space: spaceId ? { id: spaceId, name: spaceName } : null,
    };
  }

  /**
   * One consent: create a viewer-owned Space (full `CreateSpaceInput`, same
   * as `spaces.create`) and grant the scopes on it. Never silent — each
   * confirm mints a new Space. The host creates with the viewer's account
   * token.
   * `{ granted: false, space }` means the Space was created but not provisioned;
   * no grant was issued. A viewer deny is `{ granted: false, space: null }`.
   */
  async requestCreateSpaceAuthorization(input: {
    scopes: Permission[];
    space: CreateSpaceInput;
    reason?: string;
  }): Promise<AppRuntimeAuthorizationResult> {
    await this.ensureStorageKeys();
    this.observeTransportIdentity();
    const response = await this.transport.request<{ token: string | null; space?: { id?: unknown; name?: unknown } | null }>(
      { type: "cohub.app.authorize", scopes: input.scopes, reason: input.reason, createSpace: input.space },
      { timeoutMs: 120_000 },
    );
    this.observeTransportIdentity();
    const token = response?.token ?? null;
    const spaceId = typeof response?.space?.id === "string" ? response.space.id : null;
    const spaceName = typeof response?.space?.name === "string" ? response.space.name : null;
    if (token) {
      this.token = token;
      this.writeStoredToken(token);
    }
    if (token && spaceId) {
      this.authorizedGrants = recordConsent(this.authorizedGrants, spaceId, input.scopes);
      this.writeStoredGrants(this.authorizedGrants);
    }
    return {
      granted: Boolean(token),
      space: spaceId ? { id: spaceId, name: spaceName } : null,
    };
  }

  async purchase(input: { productKey: string; purchaseAttemptId?: string }) {
    const purchaseAttemptId = input.purchaseAttemptId?.trim() || generateRequestId();
    const response = await this.transport.request<{ checkout: { providerKey: string | null; checkoutUrl: string | null; checkoutUsable: boolean; status: string | null; message: string | null; orderId: string; productKey: string } | null }>(
      {
        type: "cohub.app.purchase",
        productKey: input.productKey,
        purchaseAttemptId,
      },
      { timeoutMs: 120_000 },
    );
    return response?.checkout ?? null;
  }

  async checkoutState() {
    const response = await this.transport.request<AppRuntimeCheckoutState>(
      { type: "cohub.app.checkout-state" },
      { timeoutMs: 8_000, retryIntervalMs: 250 },
    );
    return response ?? null;
  }
}

/**
 * Configuration for the app runtime mode.
 */
export type AppRuntimeModeConfig = {
  /** Explicit mode selection. When omitted, auto-detection is used. */
  mode?: "bridge" | "broker";
  /** Cohub origin for the broker page (e.g. "https://cohub.live"). */
  brokerOrigin?: string;
  /**
   * The app's public id. Required for broker mode unless the slug triple
   * below is supplied, in which case the id is resolved at runtime.
   */
  appId?: string;
  /** Space owner's username. Used with {@link spaceSlug} + {@link appSlug} to
   * resolve the appId at runtime via the public `apps.getBySlug` API. */
  ownerUsername?: string;
  /** Space slug. Part of the slug triple used for runtime appId resolution. */
  spaceSlug?: string;
  /** App slug. Part of the slug triple used for runtime appId resolution. */
  appSlug?: string;
};

/** Lazily resolves an app's public id, e.g. via slug reverse lookup. */
export type AppIdResolver = () => Promise<string | null>;

/** Resolves complete App identity from the browser's current standalone origin. */
export function createOriginAppResolver(deps: {
  apiBaseUrl: string;
  fetch?: typeof globalThis.fetch;
  origin?: () => string | null;
}): AppRuntimeAppResolver {
  let cached: Promise<AppRuntimeResolvedApp | null> | null = null;
  return () => {
    if (cached) return cached;
    const run = (async (): Promise<AppRuntimeResolvedApp | null> => {
      const doFetch = deps.fetch ?? globalThis.fetch;
      const origin = deps.origin?.() ?? (typeof window !== "undefined" ? window.location.origin : null);
      if (typeof doFetch !== "function" || !origin) return null;
      const response = await doFetch(`${deps.apiBaseUrl}/api/apps/by-origin`, {
        credentials: "omit",
        headers: { Accept: "application/json" },
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`getByOrigin failed: ${response.status}`);
      const data = await response.json() as {
        app?: { id?: unknown; slug?: unknown; spaceId?: unknown; appScopes?: unknown };
        space?: { id?: unknown; name?: unknown };
      } | null;
      const app = data?.app;
      const space = data?.space;
      if (
        typeof app?.id !== "string" ||
        typeof app.slug !== "string" ||
        typeof app.spaceId !== "string" ||
        typeof space?.id !== "string" ||
        space.id !== app.spaceId
      ) return null;
      const knownScopes = new Set<string>(PERMISSIONS);
      const appScopes = Array.isArray(app.appScopes)
        ? app.appScopes.filter((scope): scope is Permission => typeof scope === "string" && knownScopes.has(scope))
        : [];
      return {
        id: app.id,
        slug: app.slug,
        url: origin,
        homeSpace: {
          id: space.id,
          name: typeof space.name === "string" ? space.name : null,
        },
        appScopes,
      };
    })().catch(() => {
      cached = null;
      return null;
    });
    cached = run;
    return run;
  };
}

/**
 * Defers standalone origin discovery until the runtime is first used.
 * Apps should initialize `context()` before click-triggered authorization so
 * discovery does not consume the browser's transient user activation.
 */
export class OriginBrokerTransport implements AppRuntimeTransport {
  readonly supportsNavigation = false;
  readonly memoryOnly = true;
  private transport: Promise<PopupBrokerTransport | null> | null = null;
  private resolvedTransport: PopupBrokerTransport | null = null;

  getViewerIdentity() {
    return this.resolvedTransport?.getViewerIdentity();
  }

  constructor(
    private readonly brokerOrigin: string,
    private readonly resolveApp: AppRuntimeAppResolver,
  ) {}

  private resolveTransport() {
    if (this.transport) return this.transport;
    const attempt = this.resolveApp()
      .then((app) =>
        app ? new PopupBrokerTransport({ brokerOrigin: this.brokerOrigin, app }) : null,
      )
      .then((transport) => {
        this.resolvedTransport = transport;
        return transport;
      })
      .catch(() => null);
    this.transport = attempt;
    void attempt.then((transport) => {
      // A transient resolver failure is represented as null and is not cached
      // by the resolver. Let a later context/auth request retry it.
      if (!transport && this.transport === attempt) this.transport = null;
    });
    return attempt;
  }

  async request<T>(message: Record<string, unknown>, options?: AppRuntimeRequestOptions) {
    const transport = await this.resolveTransport();
    return transport?.request<T>(message, options) ?? null;
  }
}

/**
 * Builds a memoized appId resolver that reverse-looks-up the appId from the
 * public slug triple via `GET /api/apps/by-slug/:username/:spaceSlug/:appSlug`
 * (the works REST routes are dual-mounted; `/api/works` keeps serving older
 * consumers with identical payloads). The endpoint is
 * anonymous (no auth) for public apps, so no token is needed. The result is
 * cached; a failed lookup is not cached so it can be retried.
 */
export function createSlugAppIdResolver(deps: {
  apiBaseUrl: string;
  fetch?: typeof globalThis.fetch;
  ownerUsername: string;
  spaceSlug: string;
  appSlug: string;
}): AppIdResolver {
  let cached: Promise<string | null> | null = null;
  return () => {
    if (cached) return cached;
    const run = (async (): Promise<string | null> => {
      const doFetch = deps.fetch ?? globalThis.fetch;
      if (typeof doFetch !== "function") return null;
      const url = `${deps.apiBaseUrl}/api/apps/by-slug/${encodeURIComponent(deps.ownerUsername)}/${encodeURIComponent(deps.spaceSlug)}/${encodeURIComponent(deps.appSlug)}`;
      const response = await doFetch(url);
      if (!response.ok) throw new Error(`getBySlug failed: ${response.status}`);
      const data = (await response.json()) as { app?: { id?: string }; work?: { id?: string } } | null;
      return data?.app?.id ?? data?.work?.id ?? null;
    })().catch(() => {
      // Do not cache failures — allow a later retry.
      cached = null;
      return null;
    });
    cached = run;
    return run;
  };
}

/**
 * Resolves the appropriate transport. Iframes use the parent bridge;
 * standalone pages use explicit legacy configuration or Origin discovery.
 */
export function resolveAppTransport(
  config?: AppRuntimeModeConfig,
  appIdResolver?: AppIdResolver,
  originAppResolver?: AppRuntimeAppResolver,
  defaultBrokerOrigin?: string,
): AppRuntimeTransport {
  const explicitMode = config?.mode;
  const brokerOrigin = config?.brokerOrigin;
  const appId = config?.appId;
  const canResolveAppId = Boolean(appId || appIdResolver);
  const hasBrokerConfig = Boolean(brokerOrigin && canResolveAppId);

  const createBroker = (): AppRuntimeTransport =>
    brokerOrigin && canResolveAppId
      ? new PopupBrokerTransport({ brokerOrigin, appId, getAppId: appIdResolver })
      : new ParentBridgeTransport();

  if (explicitMode === "bridge") return new ParentBridgeTransport();
  if (explicitMode === "broker") return createBroker();

  // Auto-detect
  if (typeof window !== "undefined" && window.parent !== window) {
    // Inside an iframe → bridge mode
    return new ParentBridgeTransport();
  }
  if (hasBrokerConfig) return createBroker();
  if (originAppResolver && defaultBrokerOrigin) {
    return new OriginBrokerTransport(defaultBrokerOrigin, originAppResolver);
  }
  // Direct transport consumers without client environment configuration keep
  // the legacy null-context behavior.
  return new ParentBridgeTransport();
}

export const createAppRuntime = (
  transport?: AppRuntimeTransport,
  appId?: string,
  appIdResolver?: AppIdResolver,
) => new AppRuntimeApi(transport, appId, appIdResolver);
