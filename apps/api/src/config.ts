import { resolveLogtoEndpoint } from "@cohub/identity";
import {
  parseCohubAppHostTemplate,
  type CohubAppHostTemplate,
} from "@cohub/protocol";

export type AppConfig = {
  logtoEndpoint: string;
  webOrigin?: string;
  redisUrl: string;
  litellmApiKey?: string;
  talesofaiBillingBaseUrl?: string;
  talesofaiBillingBusinessKey?: string;
  talesofaiBillingAdminApiKey?: string;
  env: "dev" | "prod";
  appEncryptionKey: string;
  /** Optional checkpoint to bootstrap first-time Home spaces from; blank when unset. */
  homeBootstrapCheckpointId?: string;
  sandboxImage: string;
  sandboxImagePullSecret?: string;
  sandboxSearchEnabled: boolean;
  sandboxSearchVersion: string;
  sandboxSearchCdnBaseUrl: string;
  sandboxNodeSelector: Record<string, string>;
  sandboxTolerations: SandboxToleration[];
  bullmqRedisUrl: string;
  workerSecret: string;
  spaceStorageRoot: string;
  spaceStoragePvc: string;
  checkpointCachePvc: string;
  checkpointCacheRoot: string;
  spaceSystemRoot: string;
  spaceSystemPvc: string;
  spaceSystemSubpath: string;
  spaceStorageSubpath: string;
  checkpointCacheSubpath: string;
  configsSubpath: string;
  platformConfigRoot: string;
  turnObjectS3Endpoint?: string;
  turnObjectS3PublicEndpoint?: string;
  turnObjectS3Region: string;
  turnObjectS3Bucket?: string;
  turnObjectS3AccessKeyId?: string;
  turnObjectS3SecretAccessKey?: string;
  turnObjectCdnBaseUrl: string;
  publicAssetOssEndpoint?: string;
  publicAssetOssPublicEndpoint?: string;
  publicAssetOssRegion: string;
  publicAssetOssBucket?: string;
  publicAssetOssAccessKeyId?: string;
  publicAssetOssSecretAccessKey?: string;
  publicAssetCdnBaseUrl?: string;
  userUploadS3Endpoint?: string;
  userUploadS3Region: string;
  userUploadS3AccessKeyId?: string;
  userUploadS3SecretAccessKey?: string;
  chatAttachmentS3Bucket?: string;
  chatAttachmentPublicBaseUrl?: string;
  spaceUploadS3Bucket?: string;
  appAssetCdnBaseUrl?: string;
  checkpointAssetOssEndpoint?: string;
  checkpointAssetOssPublicEndpoint?: string;
  checkpointAssetOssRegion: string;
  checkpointAssetOssBucket?: string;
  checkpointAssetOssAccessKeyId?: string;
  checkpointAssetOssSecretAccessKey?: string;
  /** Optional router-status service URL. router-status publishes model health,
   * observed traffic, and probe history for availability indicators. */
  routerStatusUrl?: string;
  /** Hostnames accepted for file preview requests. */
  previewHostnames: string[];
  /** Public domains for sandbox port hostnames; the first is the primary. */
  sandboxPublicDomains: string[];
  /** Host suffixes accepted for app content port URLs (security boundary). */
  allowedAppContentHostSuffixes: string[];
  /**
   * Hostname template for published App standalone origins, e.g.
   * `{id}.apps.example.com`. Unset disables standalone origins entirely.
   */
  appStandaloneHostTemplate: CohubAppHostTemplate | null;
  /** Author email for checkpoint git commits. */
  checkpointGitAuthorEmail: string;
  /** Optional deployment-level Meta promotion provider configuration. */
  metaPromotionPixelId?: string;
  metaPromotionAccessToken?: string;
  metaPromotionApiVersion: string;
  /** Trusted proxy header containing the public client IP for Meta CAPI. */
  metaPromotionClientIpHeader?: string;
  /** Optional Meta Events Manager test code; omit in normal production traffic. */
  metaPromotionTestEventCode?: string;
};

export type SandboxToleration = {
  key: string;
  operator: "Equal";
  value: string;
  effect?: "NoSchedule" | "PreferNoSchedule" | "NoExecute";
};

const getSessionsNamespace = (env: string): string => {
  return env === "dev" ? "cohub-sessions-dev" : "cohub-sessions";
};

const getDefaultSandboxImage = (env: "dev" | "prod") => {
  return env === "prod"
    ? "git.talesofai.com/talesofai/cohub-sandbox:v20260325"
    : "git.talesofai.com/talesofai/cohub-sandbox:latest";
};

const env = (process.env.ENV === "prod" ? "prod" : "dev") as "dev" | "prod";

const parseCommaList = (value: string | undefined) => {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
};

const parseDomainList = (value: string | undefined, fallback: string[]) => {
  const parsed = parseCommaList(value).map((entry) =>
    entry.replace(/^https?:\/\//, "").replace(/\/+$/, "").toLowerCase(),
  );
  return parsed.length > 0 ? parsed : fallback;
};

/**
 * Match a hostname against a suffix list ("cohub.run" or ".cohub.run" both accepted).
 * Exact match covers the bare domain; endsWith covers its subdomains.
 */
export const isHostAllowedBySuffix = (hostname: string, suffixes: readonly string[]): boolean => {
  const host = hostname.toLowerCase();
  return suffixes.some((suffix) => {
    const dotSuffix = suffix.startsWith(".") ? suffix : `.${suffix}`;
    return host === dotSuffix.slice(1) || host.endsWith(dotSuffix);
  });
};

const parseSandboxNodeSelector = (value: string | undefined) => {
  return Object.fromEntries(
    parseCommaList(value).map((entry) => {
      const separatorIndex = entry.indexOf("=");
      if (separatorIndex <= 0 || separatorIndex === entry.length - 1) {
        throw new Error("SANDBOX_NODE_SELECTOR must use key=value format");
      }
      const key = entry.slice(0, separatorIndex);
      const selectorValue = entry.slice(separatorIndex + 1);
      return [key.trim(), selectorValue.trim()];
    }),
  );
};

const parseSandboxTolerations = (value: string | undefined): SandboxToleration[] => {
  const effects = new Set(["NoSchedule", "PreferNoSchedule", "NoExecute"]);

  return parseCommaList(value).map((entry) => {
    const effectSeparatorIndex = entry.lastIndexOf(":");
    const selector =
      effectSeparatorIndex >= 0 ? entry.slice(0, effectSeparatorIndex) : entry;
    const effect =
      effectSeparatorIndex >= 0 ? entry.slice(effectSeparatorIndex + 1) : "NoSchedule";
    const selectorSeparatorIndex = selector.indexOf("=");
    if (
      selectorSeparatorIndex <= 0 ||
      selectorSeparatorIndex === selector.length - 1
    ) {
      throw new Error("SANDBOX_TOLERATIONS must use key=value:Effect format");
    }
    if (!effects.has(effect)) {
      throw new Error(`SANDBOX_TOLERATIONS contains invalid effect: ${effect}`);
    }
    const key = selector.slice(0, selectorSeparatorIndex);
    const tolerationValue = selector.slice(selectorSeparatorIndex + 1);
    return {
      key: key.trim(),
      operator: "Equal",
      value: tolerationValue.trim(),
      effect: effect as SandboxToleration["effect"],
    };
  });
};

export const config: AppConfig = {
  workerSecret: process.env.WORKER_SECRET ?? "",
  logtoEndpoint: resolveLogtoEndpoint({ endpoint: process.env.LOGTO_ENDPOINT, env }),
  webOrigin: process.env.WEB_ORIGIN,
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  litellmApiKey: process.env.LITELLM_API_KEY,
  talesofaiBillingBaseUrl: process.env.TALESOFAI_BILLING_BASE_URL?.replace(/\/+$/, ""),
  talesofaiBillingBusinessKey: process.env.TALESOFAI_BILLING_BUSINESS_KEY,
  talesofaiBillingAdminApiKey: process.env.TALESOFAI_BILLING_ADMIN_API_KEY,
  env,
  appEncryptionKey: process.env.APP_ENCRYPTION_KEY ?? "",
  homeBootstrapCheckpointId: process.env.HOME_BOOTSTRAP_CHECKPOINT_ID?.trim() || undefined,
  sandboxImage:
    process.env.SANDBOX_IMAGE ?? getDefaultSandboxImage(env),
  sandboxImagePullSecret: (process.env.SANDBOX_IMAGE_PULL_SECRET ?? "gitea-registry").trim() || undefined,
  sandboxSearchEnabled: process.env.SANDBOX_SEARCH_ENABLED?.trim().toLowerCase() !== "false",
  sandboxSearchVersion: process.env.SANDBOX_SEARCH_VERSION?.trim() || "latest",
  sandboxSearchCdnBaseUrl:
    process.env.SANDBOX_SEARCH_CDN_BASE_URL?.trim().replace(/\/+$/, "") ||
    "https://public.cohub.live/search",
  sandboxNodeSelector: parseSandboxNodeSelector(process.env.SANDBOX_NODE_SELECTOR),
  sandboxTolerations: parseSandboxTolerations(process.env.SANDBOX_TOLERATIONS),
  bullmqRedisUrl:
    process.env.BULLMQ_REDIS_URL ?? "",
  spaceStorageRoot: process.env.SPACE_STORAGE_ROOT ?? "",
  spaceStoragePvc: process.env.SPACE_STORAGE_PVC ?? "cohub-spaces-pvc",
  checkpointCachePvc: process.env.CHECKPOINT_CACHE_PVC ?? process.env.SPACE_STORAGE_PVC ?? "cohub-spaces-pvc",
  checkpointCacheRoot: process.env.CHECKPOINT_CACHE_ROOT ?? "/checkpoint-cache",
  spaceSystemRoot: process.env.SPACE_SYSTEM_ROOT ?? "",
  spaceSystemPvc: process.env.SPACE_SYSTEM_PVC ?? "cohub-system-pvc",
  spaceSystemSubpath: process.env.SPACE_SYSTEM_SUBPATH ?? (env === "prod" ? "prod" : "dev"),
  spaceStorageSubpath: process.env.SPACE_STORAGE_SUBPATH ?? (env === "prod" ? "cohub-prod" : "cohub-dev"),
  checkpointCacheSubpath: process.env.CHECKPOINT_CACHE_SUBPATH ?? `${process.env.SPACE_STORAGE_SUBPATH ?? (env === "prod" ? "cohub-prod" : "cohub-dev")}/checkpoints`,
  configsSubpath: process.env.CONFIGS_SUBPATH ?? (env === "prod" ? "configs/prod" : "configs/dev"),
  platformConfigRoot: process.env.PLATFORM_CONFIG_ROOT ?? "/configs",
  turnObjectS3Endpoint: process.env.TURN_OBJECT_S3_ENDPOINT ?? "http://127.0.0.1:9000",
  turnObjectS3PublicEndpoint: process.env.TURN_OBJECT_S3_PUBLIC_ENDPOINT,
  turnObjectS3Region: process.env.TURN_OBJECT_S3_REGION ?? "us-west-1",
  turnObjectS3Bucket: process.env.TURN_OBJECT_S3_BUCKET ?? "cohub-sessions",
  turnObjectS3AccessKeyId: process.env.TURN_OBJECT_S3_ACCESS_KEY_ID,
  turnObjectS3SecretAccessKey: process.env.TURN_OBJECT_S3_SECRET_ACCESS_KEY,
  turnObjectCdnBaseUrl: (process.env.TURN_OBJECT_CDN_BASE_URL ?? "https://sessions.cohub.live").replace(/\/+$/, ""),
  publicAssetOssEndpoint: process.env.PUBLIC_ASSET_OSS_ENDPOINT,
  publicAssetOssPublicEndpoint: process.env.PUBLIC_ASSET_OSS_PUBLIC_ENDPOINT,
  publicAssetOssRegion: process.env.PUBLIC_ASSET_OSS_REGION ?? "us-west-1",
  publicAssetOssBucket: process.env.PUBLIC_ASSET_OSS_BUCKET,
  publicAssetOssAccessKeyId: process.env.PUBLIC_ASSET_OSS_ACCESS_KEY_ID,
  publicAssetOssSecretAccessKey: process.env.PUBLIC_ASSET_OSS_SECRET_ACCESS_KEY,
  publicAssetCdnBaseUrl: process.env.PUBLIC_ASSET_CDN_BASE_URL?.replace(/\/+$/, ""),
  userUploadS3Endpoint: process.env.USER_UPLOAD_S3_ENDPOINT,
  userUploadS3Region: process.env.USER_UPLOAD_S3_REGION ?? "auto",
  userUploadS3AccessKeyId: process.env.USER_UPLOAD_S3_ACCESS_KEY_ID,
  userUploadS3SecretAccessKey: process.env.USER_UPLOAD_S3_SECRET_ACCESS_KEY,
  chatAttachmentS3Bucket: process.env.CHAT_ATTACHMENT_S3_BUCKET,
  chatAttachmentPublicBaseUrl: process.env.CHAT_ATTACHMENT_PUBLIC_BASE_URL?.replace(/\/+$/, ""),
  spaceUploadS3Bucket: process.env.SPACE_UPLOAD_S3_BUCKET,
  // APP_* is canonical; the WORK_* spelling stays as a fallback for clusters
  // not yet migrated (both are set during the transition).
  appAssetCdnBaseUrl:
    (process.env.APP_ASSET_CDN_BASE_URL ?? process.env.WORK_ASSET_CDN_BASE_URL)?.replace(/\/+$/, ""),
  checkpointAssetOssEndpoint: process.env.CHECKPOINT_ASSET_OSS_ENDPOINT ?? process.env.TURN_OBJECT_S3_ENDPOINT ?? "http://127.0.0.1:9000",
  checkpointAssetOssPublicEndpoint: process.env.CHECKPOINT_ASSET_OSS_PUBLIC_ENDPOINT ?? process.env.TURN_OBJECT_S3_PUBLIC_ENDPOINT,
  checkpointAssetOssRegion: process.env.CHECKPOINT_ASSET_OSS_REGION ?? process.env.TURN_OBJECT_S3_REGION ?? "us-west-1",
  checkpointAssetOssBucket: process.env.CHECKPOINT_ASSET_OSS_BUCKET ?? process.env.TURN_OBJECT_S3_BUCKET,
  checkpointAssetOssAccessKeyId: process.env.CHECKPOINT_ASSET_OSS_ACCESS_KEY_ID ?? process.env.TURN_OBJECT_S3_ACCESS_KEY_ID,
  checkpointAssetOssSecretAccessKey: process.env.CHECKPOINT_ASSET_OSS_SECRET_ACCESS_KEY ?? process.env.TURN_OBJECT_S3_SECRET_ACCESS_KEY,
  routerStatusUrl: process.env.ROUTER_STATUS_URL?.trim() || undefined,
  previewHostnames: parseDomainList(
    process.env.PREVIEW_HOSTNAMES ?? process.env.PREVIEW_HOSTNAME,
    [],
  ),
  sandboxPublicDomains: parseDomainList(
    process.env.SANDBOX_PUBLIC_DOMAINS ?? process.env.SANDBOX_PUBLIC_DOMAIN,
    ["cohub.live", "cohub.run"],
  ),
  allowedAppContentHostSuffixes: parseDomainList(
    // Same APP_*-first policy as the asset CDN base URL above.
    process.env.APP_CONTENT_HOST_SUFFIXES ?? process.env.WORK_CONTENT_HOST_SUFFIXES,
    [".cohub.live", ".cohub.run"],
  ),
  appStandaloneHostTemplate: parseCohubAppHostTemplate(
    process.env.APP_STANDALONE_HOST_TEMPLATE,
  ),
  checkpointGitAuthorEmail: process.env.CHECKPOINT_GIT_AUTHOR_EMAIL?.trim() || "noreply@cohub.live",
  metaPromotionPixelId: process.env.COHUB_META_PIXEL_ID?.trim() || undefined,
  metaPromotionAccessToken: process.env.COHUB_META_CAPI_ACCESS_TOKEN?.trim() || undefined,
  metaPromotionApiVersion: process.env.COHUB_META_API_VERSION?.trim() || "v21.0",
  metaPromotionClientIpHeader: process.env.COHUB_META_CLIENT_IP_HEADER?.trim().toLowerCase() || undefined,
  metaPromotionTestEventCode: process.env.COHUB_META_TEST_EVENT_CODE?.trim() || undefined,
};

export const sessionsNamespace = getSessionsNamespace(config.env);

export const assertRequiredConfig = () => {
  if (!config.redisUrl) {
    throw new Error("Missing required env: REDIS_URL");
  }
  if (!config.appEncryptionKey) {
    throw new Error("Missing required env: APP_ENCRYPTION_KEY");
  }
  if (!config.workerSecret) {
    throw new Error("Missing required env: WORKER_SECRET");
  }
  if (!config.bullmqRedisUrl) {
    throw new Error("Missing required env: BULLMQ_REDIS_URL");
  }
};
