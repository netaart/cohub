import { ChannelsApi } from "./apis/channels.js";
import { BillingApi } from "./apis/billing.js";
import { CronJobsApi } from "./apis/cron-jobs.js";
import { GenerationsApi } from "./apis/generations.js";
import { ModelsApi } from "./apis/models.js";
import { PromptsApi } from "./apis/prompts.js";
import { SkillsApi } from "./apis/skills.js";
import { PublicAssetsApi } from "./apis/public-assets.js";
import { SessionAccessApi } from "./apis/session-access.js";
import { SearchApi } from "./apis/search.js";
import { ReferencesApi } from "./apis/references.js";
import { SpaceClient, SpacesApi, type WebSocketConnectionState } from "./apis/spaces.js";
import { TasksApi } from "./apis/tasks.js";
import { DesktopCommandsApi } from "./apis/desktop-commands.js";
import { UserApi } from "./apis/user.js";
import { UsersApi } from "./apis/users.js";
import { AppsApi } from "./apis/apps.js";
import { AppCommerceApi } from "./apis/app-commerce.js";
import { AppRealtimeApi } from "./apis/app-realtime.js";
import { PublicInviteApi } from "./apis/invitations.js";
import { ReferralsApi } from "./apis/referrals.js";
import { HttpTransport, type CohubClientOptions } from "./transport.js";
import { ensureRealtimeConnected } from "./realtime.js";
import { createWebsocketClient, type WebsocketEventPayload } from "./websocket.js";
import { VoiceApi } from "./voice-input.js";
import { AppSurfaceApi } from "./app-surface.js";
import { attachAppEmbed } from "./app-embed.js";
import type { AppComposerChip } from "@cohub/protocol/app-surface";
import {
  resolveApiBaseUrl,
  resolveExecutionAppId,
  resolveExecutionToken,
  resolveWebsocketUrl,
} from "./environment.js";
import {
  createSlugAppIdResolver,
  createAppRuntime,
  resolveAppTransport,
  type AppIdResolver,
  type AppContextChangedListener,
  type AppRuntimeApi,
  type AppAuthorizationRequest,
  type AppRuntimeConfigureRequest,
} from "./app-runtime.js";
import type { CreateSpaceInput, Permission } from "./types.js";
import type { AppCommerceCheckoutStatus } from "./apis/app-commerce.js";

export class CohubClient {
  readonly spaces: SpacesApi;
  readonly channels: ChannelsApi;
  readonly billing: BillingApi;
  readonly user: UserApi;
  readonly users: UsersApi;
  readonly generations: GenerationsApi;
  readonly models: ModelsApi;
  readonly prompts: PromptsApi;
  readonly skills: SkillsApi;
  readonly publicAssets: PublicAssetsApi;
  readonly sessionAccess: SessionAccessApi;
  readonly search: SearchApi;
  readonly references: ReferencesApi;
  readonly tasks: TasksApi;
  readonly cronJobs: CronJobsApi;
  readonly desktop: DesktopCommandsApi;
  readonly invite: PublicInviteApi;
  readonly referrals: ReferralsApi;
  readonly voice: VoiceApi;
  readonly apps: AppsApi;
  readonly appCommerce: AppCommerceApi;
  readonly navigation: {
    open: (
      target: import("@cohub/protocol/app-navigation").AppNavigationTarget | string,
      options?: { call?: import("@cohub/protocol/app-navigation").AppNavigationCall },
    ) => Promise<import("@cohub/protocol/app-navigation").AppNavigationOpenResponse>;
  };

  /** @deprecated Use `client.desktop`. */
  get ui(): DesktopCommandsApi {
    return this.desktop;
  }
  /** @deprecated Use `client.apps`. */
  get works(): AppsApi {
    return this.apps;
  }
  /** @deprecated Use `client.appCommerce`. */
  get workCommerce(): AppCommerceApi {
    return this.appCommerce;
  }

  private readonly transport: HttpTransport;
  private readonly websocketClient: ReturnType<typeof createWebsocketClient>;
  private readonly appRuntime: AppRuntimeApi;

  constructor(options: CohubClientOptions = {}) {
    const apiBaseUrl = resolveApiBaseUrl(options);
    const appRuntime = options.app ?? options.work;
    // When broker mode is configured with a slug triple instead of an explicit
    // appId, build a resolver that reverse-looks-up the appId at runtime via
    // the public getBySlug API. Shared by both the transport (popup) and the
    // runtime API (localStorage key isolation).
    const appIdResolver: AppIdResolver | undefined =
      !appRuntime?.appId &&
      appRuntime?.ownerUsername &&
      appRuntime?.spaceSlug &&
      appRuntime?.appSlug
        ? createSlugAppIdResolver({
            apiBaseUrl,
            fetch: options.fetch,
            ownerUsername: appRuntime.ownerUsername,
            spaceSlug: appRuntime.spaceSlug,
            appSlug: appRuntime.appSlug,
          })
        : undefined;
    const appTransport = resolveAppTransport(appRuntime, appIdResolver);
    this.appRuntime = createAppRuntime(appTransport, appRuntime?.appId, appIdResolver);
    const executionToken = resolveExecutionToken();
    const getAccessToken = options.getAccessToken
      ?? (executionToken
        ? () => executionToken
        : (tokenOptions?: { forceRefresh?: boolean }) => this.appRuntime.getAccessToken(tokenOptions));
    const resolvedOptions = { ...options, getAccessToken };
    this.transport = new HttpTransport(resolvedOptions);
    this.websocketClient = createWebsocketClient({
      url: resolveWebsocketUrl({
        env: options.websocket?.env ?? options.env,
        url: options.websocket?.url,
      }),
      ...options.websocket,
      getAccessToken: options.websocket?.getAccessToken ?? getAccessToken,
    });
    this.voice = new VoiceApi({
      env: options.voice?.env ?? options.env,
      url: options.voice?.url,
      getAccessToken: options.voice?.getAccessToken ?? getAccessToken,
      WebSocketImpl: options.voice?.WebSocketImpl,
      connectionTimeoutMs: options.voice?.connectionTimeoutMs,
      idleConnectionTimeoutMs: options.voice?.idleConnectionTimeoutMs,
    });
    this.spaces = new SpacesApi(this.transport);
    this.channels = new ChannelsApi(this.transport);
    this.billing = new BillingApi(this.transport);
    this.user = new UserApi(
      this.transport,
      apiBaseUrl,
      options.setStoredAuthToken,
      options.clearStoredAuthToken,
    );
    this.users = new UsersApi(this.transport);
    this.generations = new GenerationsApi(this.transport);
    this.models = new ModelsApi(this.transport);
    this.prompts = new PromptsApi(this.transport);
    this.skills = new SkillsApi(this.transport);
    this.publicAssets = new PublicAssetsApi(this.transport);
    this.sessionAccess = new SessionAccessApi(this.transport);
    this.search = new SearchApi(this.transport);
    this.references = new ReferencesApi(this.transport);
    this.tasks = new TasksApi(this.transport, this.websocketClient);
    this.cronJobs = new CronJobsApi(this.transport);
    this.desktop = new DesktopCommandsApi(this.transport);
    this.invite = new PublicInviteApi(this.transport);
    this.referrals = new ReferralsApi(this.transport);
    this.apps = new AppsApi(this.transport);
    this.appCommerce = new AppCommerceApi(this.transport);
    this.navigation = {
      open: (target, options) =>
        this.appRuntime.navigationOpen(
          typeof target === "string" ? { kind: "app", ref: target } : target,
          options?.call,
        ),
    };
    this.app.realtime = new AppRealtimeApi(
      this.transport,
      this.websocketClient,
      () => this.appRuntime.context(),
    );
  }

  context() {
    return this.appRuntime.context();
  }

  /** Releases listeners this client registered. Safe to call more than once. */
  dispose() {
    this.appRuntime.dispose();
  }

  readonly auth = {
    authorize: (input: AppAuthorizationRequest) => this.appRuntime.authorize(input),
    /**
     * @deprecated Use authorize() for the actual target and structured result.
     * Ensure the app holds these scopes. Without an accessible `spaceId` the
     * host targets a viewer-controlled Space (never the app author's home
     * Space) — use `requestSpace` when the app needs to know which Space.
     * Silent when a grant already covers them; `alwaysAsk` forces the dialog.
     */
    request: (input: { scopes: Permission[]; reason?: string; spaceId?: string; alwaysAsk?: boolean }) => this.appRuntime.requestAuthorization(input),
    /** @deprecated Use authorize({ target: { kind: "pick-space" }, scopes }). */
    requestSpace: (input: { scopes: Permission[]; reason?: string; alwaysAsk?: boolean }) => this.appRuntime.requestSpaceAuthorization(input),
    /** One consent: create a viewer-owned Space and grant the scopes on it. `space` is `CreateSpaceInput`. */
    requestCreateSpace: (input: { scopes: Permission[]; space: CreateSpaceInput; reason?: string }) => this.appRuntime.requestCreateSpaceAuthorization(input),
  };

  readonly app = {
    realtime: null as unknown as AppRealtimeApi,
    /** Expose callable methods from inside a published app. */
    surface: new AppSurfaceApi(),
    onContextChanged: (listener: AppContextChangedListener) => this.appRuntime.onContextChanged(listener),
    /** Ask the host to close this App's surface. */
    requestClose: () => this.appRuntime.requestClose(),
    /**
     * Request that the host update this overlay's geometry or pointer hit
     * regions.  Only meaningful for `overlay` surfaces; ignored otherwise.
     */
    requestConfigure: (input: Omit<AppRuntimeConfigureRequest, "protocol" | "version" | "type">) =>
      this.appRuntime.requestConfigure(input),
    embed: {
      /** Host another App's public page in an iframe and forward the shell location to it. */
      attach: attachAppEmbed,
    },
    composer: {
      /** Attach or update context from this app in the Cohub composer. */
      setChip: (chip: AppComposerChip) => this.app.surface.setComposerChip(chip),
      /** Remove context previously attached by this app. */
      clearChip: (key: string) => this.app.surface.clearComposerChip(key),
    },
    actions: {
      run: async (input: { action: string; input?: unknown }) => {
        const context = await this.appRuntime.context();
        if (!context?.app?.id) throw new Error("App context is unavailable — not running inside a published app runtime.");
        return this.apps.runAction(context.app.id, input.action, input.input);
      },
    },
    commerce: {
      resolveProducts: async (input: { productKeys: string[] }) => {
        const context = await this.appRuntime.context();
        if (!context?.app?.id) throw new Error("App context is unavailable — not running inside a published app runtime.");
        return this.appCommerce.resolveProducts(context.app.id, input);
      },
      getEntitlements: async () => {
        const context = await this.appRuntime.context();
        const appId = context?.app?.id || resolveExecutionAppId();
        if (!appId) throw new Error("App context is unavailable — not running inside a published app runtime or App Action.");
        return this.appCommerce.getEntitlements(appId);
      },
      consumeCredits: async (input: { amount: number; operationId: string; reason?: string }) => {
        const context = await this.appRuntime.context();
        const appId = context?.app?.id || resolveExecutionAppId();
        if (!appId) throw new Error("App context is unavailable — not running inside a published app runtime or App Action.");
        return this.appCommerce.consumeCredits(appId, input);
      },
      purchase: async (input: { productKey: string; purchaseAttemptId?: string }) =>
        this.appRuntime.purchase(input),
      getCheckoutState: async (): Promise<{ status: AppCommerceCheckoutStatus; orderId: string | null }> => {
        const result = await this.appRuntime.checkoutState();
        return { status: result?.status ?? null, orderId: result?.orderId ?? null };
      },
      getOrder: async (orderId: string) => {
        const context = await this.appRuntime.context();
        if (!context?.app?.id) throw new Error("App context is unavailable — not running inside a published app runtime.");
        return this.appCommerce.getOrder(context.app.id, orderId);
      },
    },
  };

  space(spaceId: string) {
    return new SpaceClient(spaceId, this.transport, this.websocketClient);
  }

  onUserEvent(handler: (event: WebsocketEventPayload) => void): () => void {
    ensureRealtimeConnected(this.websocketClient);
    return this.websocketClient.on("event", handler);
  }

  onConnection(
    handler: (state: WebSocketConnectionState) => void,
  ): () => void {
    const connectingCleanup = this.websocketClient.on("connecting", (payload) => {
      handler({
        state: payload.isReconnect ? "reconnecting" : "connecting",
        willReconnect: payload.isReconnect,
        attempt: payload.attempt,
      });
    });
    const reconnectingCleanup = this.websocketClient.on("reconnecting", (payload) => {
      handler({
        state: "reconnecting",
        willReconnect: true,
        attempt: payload.attempt,
        delayMs: payload.delayMs,
      });
    });
    const openCleanup = this.websocketClient.on("open", (payload) => {
      handler({
        state: "open",
        willReconnect: false,
        connectionId: payload.connectionId,
      });
    });
    const closeCleanup = this.websocketClient.on("close", (payload) => {
      handler({
        state: "closed",
        willReconnect: payload.willReconnect,
      });
    });
    const errorCleanup = this.websocketClient.on("error", (payload) => {
      handler({
        state: "error",
        willReconnect: payload.recoverable,
        recoverable: payload.recoverable,
      });
    });
    return () => {
      connectingCleanup();
      reconnectingCleanup();
      openCleanup();
      closeCleanup();
      errorCleanup();
    };
  }
}

export const createCohubClient = (options?: CohubClientOptions) =>
  new CohubClient(options);
