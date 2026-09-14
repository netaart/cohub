import type { HttpTransport } from "../transport.js";
import type { RequestSource } from "@cohub/protocol/provenance";
import type { AppArtifactDescriptor, AppContentKind, AppPromotionEventKey } from "@cohub/protocol";
import type { Permission, SpacePublicProfile } from "../types.js";

export type AppTargetType = "file" | "directory" | "port";
export type AppStatus = "published" | "disabled";
export type AppVisibility = "public" | "space";

export type AppPresentationMeta = {
  hideCohubBar?: boolean;
  /** How the desktop presents the App when opened without an explicit surface. */
  surface?: "window" | "overlay";
};

/** Snapshot of fields extracted from the published page head. */
export type AppExtractedPageMeta = {
  title?: string | null;
  description?: string | null;
  icon?: string | null;
  image?: string | null;
  lang?: string | null;
  themeColor?: string | null;
  surface?: "window" | "overlay" | null;
  sourcePath?: string | null;
  extractedAt?: string | null;
};

/**
 * App presentation metadata.
 * `title` / `description` / `icon` / `image` / `lang` / `themeColor`
 * power public page head, share cards, and lists.
 */
export type AppMeta = Record<string, unknown> & {
  title?: string;
  /** @deprecated Prefer `title`. Kept for older clients. */
  name?: string;
  description?: string;
  icon?: string;
  image?: string;
  /** BCP 47 language tag from the published page (e.g. zh-CN). */
  lang?: string;
  /** CSS color from meta theme-color. */
  themeColor?: string;
  presentation?: AppPresentationMeta;
  extracted?: AppExtractedPageMeta;
  source?: RequestSource;
};

export type AppRecord = {
  id: string;
  spaceId: string;
  userUuid: string;
  slug: string;
  status: AppStatus;
  visibility: AppVisibility;
  targetType: AppTargetType;
  targetRef: string;
  assetKey: string | null;
  currentVersionId: string | null;
  latestVersion: number;
  publishedAt: string | null;
  appScopes: Permission[];
  allowedViewerScopes: Permission[];
  meta: AppMeta | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type AppCreateInput = {
  spaceId: string;
  slug: string;
  status?: AppStatus;
  visibility?: AppVisibility;
  targetType: AppTargetType;
  targetRef: string;
  assetKey?: string | null;
  appScopes?: Permission[];
  allowedViewerScopes?: Permission[];
  meta?: AppMeta | null;
};

export type AppUpdateInput = Partial<{
  slug: string;
  status: AppStatus;
  visibility: AppVisibility;
  targetType: AppTargetType;
  targetRef: string;
  appScopes: Permission[];
  allowedViewerScopes: Permission[];
  meta: AppMeta | null;
}>;

export type AppVersionRecord = {
  id: string;
  appId: string;
  version: number;
  targetType: AppTargetType;
  targetRef: string;
  assetKey: string | null;
  contentKind: AppContentKind;
  artifact: AppArtifactDescriptor | null;
  meta: AppMeta | null;
  createdAt: string | null;
};

export type AppContentDownload = {
  manifestUrl: string;
  manifestSha256: string;
};

export type AppContent =
  | { kind: "port"; url: string; targetType: "port"; port: string }
  | ((
      | { kind: "web"; url: string; targetType: "file" | "directory"; path: string }
      | {
          kind: "file";
          url: string;
          targetType: "file";
          path: string;
          name: string;
          mimeType: string | null;
          sizeBytes: number;
          sha256: string;
        }
    ) & {
      download?: AppContentDownload;
    })
  | {
      kind: "board";
      url: string;
      targetType: "file";
      path: string;
      boardId: string;
      boardVersion: number;
    };

export type AppPublicSpaceRecord = {
  id: string;
  slug: string;
  name: string | null;
  userUuid: string;
  publicProfile?: SpacePublicProfile | null;
};

export type AppPublicOwnerRecord = {
  userUuid: string;
  username: string;
  displayName: string;
  avatarUrl?: string | null;
};

export type AppDetailResponse = {
  app: AppRecord;
  space: AppPublicSpaceRecord;
  owner: AppPublicOwnerRecord;
  publicUrl: string | null;
  content: AppContent | null;
  /** All-time view count; `null` when the rollup total is unavailable. */
  totalViews?: number | null;
};

export type AppGetResponse = AppDetailResponse;

export type AppResolveResponse = AppDetailResponse;

export type AppViewSource = "web" | "cli" | "api";

export type AppViewStatsResponse = {
  summary: {
    totalViews: number;
    views24h: number;
    views7d: number;
    views30d: number;
  };
  daily: Array<{ date: string; views: number }>;
  sources: Array<{ source: AppViewSource; views: number }>;
};

export type AppPromotionProvider = "generic" | "meta";

export type AppPromotionRecord = {
  id: string;
  appId: string;
  name: string;
  provider: AppPromotionProvider | string;
  parameters: Record<string, string>;
  createdBy: string;
  createdAt: string;
};

export type AppPromotionProviderStatus = {
  key: AppPromotionProvider | string;
  configured: boolean;
};

export type AppPromotionCreateInput = {
  name: string;
  provider: AppPromotionProvider | string;
  parameters: Record<string, string>;
};

export type AppPromotionStatsResponse = {
  promotion: AppPromotionRecord;
  summary: {
    landing: number;
    ready: number;
    registrationCompleted: number;
    paywallViewed: number;
    checkoutStarted: number;
    readyRate: number;
  };
  daily: Array<{
    date: string;
    landing: number;
    ready: number;
    registrationCompleted: number;
    paywallViewed: number;
    checkoutStarted: number;
  }>;
};

export type AppPromotionEventResponse = {
  ok: true;
  eventId: string;
  browser:
    | { provider: "generic" }
    | { provider: "meta"; pixelId: string }
    | null;
};

export type AppSessionResponse = {
  token: string;
  expiresIn: number;
  app: AppRecord;
};

/** A viewer's consent for one app on one space (or their account via `user.*` scopes). */
export type AppViewerGrantRecord = {
  id: string;
  appId: string;
  spaceId: string;
  scopes: Permission[];
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type AppActionRunResponse = {
  taskRunId: string;
  action: string;
  status: "pending";
};

export type AppAuthorizeResponse = {
  token: string;
  expiresIn: number;
  grant: {
    id: string;
    spaceId: string;
    scopes: Permission[];
    expiresAt: string;
  };
};

export class AppsApi {
  constructor(private readonly transport: HttpTransport) {}

  listBySpace(spaceId: string) {
    return this.transport.request<{ apps: AppRecord[] }>(`/api/apps/space/${spaceId}`);
  }

  get(id: string) {
    return this.transport.request<AppGetResponse>(`/api/apps/${id}`);
  }

  runAction(appId: string, action: string, input?: unknown) {
    return this.transport.request<AppActionRunResponse>(
      `/api/apps/${encodeURIComponent(appId)}/actions/${encodeURIComponent(action)}/run`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: input ?? null }),
      },
    );
  }

  /**
   * Loads a published app's metadata + owner info by id (public access model).
   * Used by the standalone app auth broker page.
   */
  getPublicById(id: string) {
    return this.transport.request<AppResolveResponse>(`/api/apps/${id}/public`);
  }

  getBySlug(
    username: string,
    spaceSlug: string,
    appSlug: string,
    options?: { signal?: AbortSignal },
  ) {
    return this.transport.request<AppResolveResponse>(
      `/api/apps/by-slug/${encodeURIComponent(username)}/${encodeURIComponent(spaceSlug)}/${encodeURIComponent(appSlug)}`,
      options?.signal ? { signal: options.signal } : undefined,
    );
  }

  create(input: AppCreateInput) {
    return this.transport.request<{ app: AppRecord }>("/api/apps", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  update(id: string, input: AppUpdateInput) {
    return this.transport.request<{ app: AppRecord }>(`/api/apps/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  delete(id: string) {
    return this.transport.request<{ ok: true }>(`/api/apps/${id}`, {
      method: "DELETE",
    });
  }

  getStats(appId: string) {
    return this.transport.request<AppViewStatsResponse>(`/api/apps/${appId}/stats`);
  }

  listPromotions(appId: string) {
    return this.transport.request<{
      promotions: AppPromotionRecord[];
      providers: AppPromotionProviderStatus[];
    }>(`/api/apps/${appId}/promotions`);
  }

  createPromotion(appId: string, input: AppPromotionCreateInput) {
    return this.transport.request<{ promotion: AppPromotionRecord }>(
      `/api/apps/${appId}/promotions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }

  getPromotionStats(appId: string, promotionId: string) {
    return this.transport.request<AppPromotionStatsResponse>(
      `/api/apps/${appId}/promotions/${promotionId}/stats`,
    );
  }

  recordPromotionEvent(
    appId: string,
    promotionId: string,
    input: {
      eventKey: AppPromotionEventKey;
      eventId?: string;
      sourceUrl?: string;
      fbp?: string;
      fbc?: string;
      productKey?: string;
    },
  ) {
    return this.transport.request<AppPromotionEventResponse>(
      `/api/apps/${appId}/promotions/${promotionId}/events`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }

  recordPromotionRegistration(
    appId: string,
    promotionId: string,
    input?: { sourceUrl?: string; fbp?: string; fbc?: string },
  ) {
    return this.transport.request<{
      reported: boolean;
      eventId: string | null;
      browser: AppPromotionEventResponse["browser"];
    }>(
      `/api/apps/${appId}/promotions/${promotionId}/registration`,
      {
        method: "POST",
        headers: input ? { "Content-Type": "application/json" } : undefined,
        body: input ? JSON.stringify(input) : undefined,
      },
    );
  }

  listVersions(appId: string) {
    return this.transport.request<{ versions: AppVersionRecord[] }>(`/api/apps/${appId}/versions`);
  }

  publishVersion(appId: string, input?: { meta?: AppMeta | null }) {
    return this.transport.request<{ app: AppRecord; version: AppVersionRecord }>(`/api/apps/${appId}/versions`, {
      method: "POST",
      headers: input ? { "Content-Type": "application/json" } : undefined,
      body: input ? JSON.stringify(input) : undefined,
    });
  }

  createSession(appId: string) {
    return this.transport.request<AppSessionResponse>(`/api/apps/${appId}/session`, {
      method: "POST",
    });
  }

  /**
   * Grants scopes as the current user. Pass `silent: true` to only renew an
   * existing live grant — the server rejects it instead of creating or
   * reviving one, so revoked grants stay revoked.
   */
  authorize(appId: string, input: { scopes: Permission[]; spaceId?: string; reason?: string; silent?: boolean }) {
    return this.transport.request<AppAuthorizeResponse>(`/api/apps/${appId}/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  /** Lists the caller's own grants for an app, one row per space. */
  listMyGrants(appId: string) {
    return this.transport.request<{ grants: AppViewerGrantRecord[] }>(`/api/apps/${appId}/grants`);
  }

  /** Revokes one of the caller's own grants; tokens carrying it lose those scopes at once. */
  revokeMyGrant(appId: string, grantId: string) {
    return this.transport.request<{ ok: true }>(`/api/apps/${appId}/grants/${grantId}`, {
      method: "DELETE",
    });
  }
}

// ── Legacy aliases ────────────────────────────────────────────────────────────
// The works REST surface is dual-mounted: this SDK speaks the canonical
// `/api/apps` vocabulary (`app`, `apps`, `appScopes`, `appId`), while the
// server keeps serving the work-era field names at `/api/works` for older SDK
// versions and direct REST consumers. These aliases keep the work-era TYPE
// NAMES compiling; their field shapes follow the canonical wire.

/** @deprecated Use `AppTargetType`. */
export type WorkTargetType = AppTargetType;
/** @deprecated Use `AppStatus`. */
export type WorkStatus = AppStatus;
/** @deprecated Use `AppVisibility`. */
export type WorkVisibility = AppVisibility;
/** @deprecated Use `AppPresentationMeta`. */
export type WorkPresentationMeta = AppPresentationMeta;
/** @deprecated Use `AppExtractedPageMeta`. */
export type WorkExtractedPageMeta = AppExtractedPageMeta;
/** @deprecated Use `AppMeta`. */
export type WorkMeta = AppMeta;
/** @deprecated Use `AppRecord`. */
export type WorkRecord = AppRecord;
/** @deprecated Use `AppCreateInput`. */
export type WorkCreateInput = AppCreateInput;
/** @deprecated Use `AppUpdateInput`. */
export type WorkUpdateInput = AppUpdateInput;
/** @deprecated Use `AppVersionRecord`. */
export type WorkVersionRecord = AppVersionRecord;
/** @deprecated Use `AppContentDownload`. */
export type WorkContentDownload = AppContentDownload;
/** @deprecated Use `AppContent`. */
export type WorkContent = AppContent;
/** @deprecated Use `AppPublicSpaceRecord`. */
export type WorkPublicSpaceRecord = AppPublicSpaceRecord;
/** @deprecated Use `AppPublicOwnerRecord`. */
export type WorkPublicOwnerRecord = AppPublicOwnerRecord;
/** @deprecated Use `AppDetailResponse`. */
export type WorkDetailResponse = AppDetailResponse;
/** @deprecated Use `AppGetResponse`. */
export type WorkGetResponse = AppGetResponse;
/** @deprecated Use `AppResolveResponse`. */
export type WorkResolveResponse = AppResolveResponse;
/** @deprecated Use `AppViewSource`. */
export type WorkViewSource = AppViewSource;
/** @deprecated Use `AppViewStatsResponse`. */
export type WorkViewStatsResponse = AppViewStatsResponse;
/** @deprecated Use `AppPromotionProvider`. */
export type WorkPromotionProvider = AppPromotionProvider;
/** @deprecated Use `AppPromotionRecord`. */
export type WorkPromotionRecord = AppPromotionRecord;
/** @deprecated Use `AppPromotionProviderStatus`. */
export type WorkPromotionProviderStatus = AppPromotionProviderStatus;
/** @deprecated Use `AppPromotionCreateInput`. */
export type WorkPromotionCreateInput = AppPromotionCreateInput;
/** @deprecated Use `AppPromotionStatsResponse`. */
export type WorkPromotionStatsResponse = AppPromotionStatsResponse;
/** @deprecated Use `AppPromotionEventResponse`. */
export type WorkPromotionEventResponse = AppPromotionEventResponse;
/** @deprecated Use `AppSessionResponse`. */
export type WorkSessionResponse = AppSessionResponse;
/** @deprecated Use `AppAuthorizeResponse`. */
export type WorkAuthorizeResponse = AppAuthorizeResponse;
