export interface WorkerConfig {
  redisUrl: string;
  bullmqRedisUrl: string;
  databaseUrl: string;
  giteaBaseUrl?: string;
  giteaToken?: string;
  giteaOrg: string;
  workerSecret: string;
  appEncryptionKey: string;
  spaceStorageRoot: string;
  spaceSystemRoot: string;
  checkpointCacheRoot: string;
  spaceStorageSubpath: string;
  checkpointCacheSubpath: string;
  checkpointAssetThresholdBytes: number;
  platformConfigRoot: string;
  platformSpaceId: string;
  generationApiKey: string;
  generationBaseUrl?: string;
  turnObjectS3Endpoint?: string;
  turnObjectS3Region: string;
  turnObjectS3Bucket?: string;
  turnObjectCdnBaseUrl: string;
  turnObjectS3AccessKeyId?: string;
  turnObjectS3SecretAccessKey?: string;
  publicAssetOssEndpoint?: string;
  publicAssetOssRegion: string;
  publicAssetOssBucket?: string;
  publicAssetOssAccessKeyId?: string;
  publicAssetOssSecretAccessKey?: string;
  userUploadS3Endpoint?: string;
  userUploadS3Region: string;
  userUploadS3Bucket?: string;
  userUploadS3AccessKeyId?: string;
  userUploadS3SecretAccessKey?: string;
  checkpointAssetOssEndpoint?: string;
  checkpointAssetOssRegion: string;
  checkpointAssetOssBucket?: string;
  checkpointAssetOssAccessKeyId?: string;
  checkpointAssetOssSecretAccessKey?: string;
  talesofaiBillingBaseUrl?: string;
  talesofaiBillingBusinessKey?: string;
  talesofaiBillingAdminApiKey?: string;
  env: "dev" | "prod";
  /** Author email for checkpoint git commits. */
  checkpointGitAuthorEmail: string;
}

const env = (process.env.ENV === "prod" ? "prod" : "dev") as "dev" | "prod";

type GiteaConfig = Pick<WorkerConfig, "giteaBaseUrl" | "giteaToken" | "giteaOrg">;

export const resolveGiteaConfig = (
  source: Record<string, string | undefined> = process.env,
): GiteaConfig => ({
  giteaBaseUrl: source.GITEA_BASE_URL?.trim().replace(/\/+$/, "") || undefined,
  giteaToken: source.GITEA_TOKEN?.trim() || undefined,
  giteaOrg: source.GITEA_ORG?.trim() || "cohub-spaces",
});

const assertRedisUrl = (value: string, envName: string) => {
  if (!value) throw new Error(`Missing required env: ${envName}`);
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
      throw new Error("invalid protocol");
    }
  } catch {
    throw new Error(`Invalid ${envName}: must be a redis:// or rediss:// URL`);
  }
};

export const config: WorkerConfig = {
  redisUrl: process.env.REDIS_URL ?? "",
  bullmqRedisUrl: process.env.BULLMQ_REDIS_URL ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  ...resolveGiteaConfig(),
  workerSecret: process.env.WORKER_SECRET ?? "",
  appEncryptionKey: process.env.APP_ENCRYPTION_KEY ?? "",
  spaceStorageRoot: process.env.SPACE_STORAGE_ROOT ?? "",
  spaceSystemRoot: process.env.SPACE_SYSTEM_ROOT ?? "",
  checkpointCacheRoot: process.env.CHECKPOINT_CACHE_ROOT ?? process.env.SPACE_STORAGE_ROOT ?? "",
  spaceStorageSubpath: process.env.SPACE_STORAGE_SUBPATH ?? (env === "prod" ? "cohub-prod" : "cohub-dev"),
  checkpointCacheSubpath: process.env.CHECKPOINT_CACHE_SUBPATH ?? `${process.env.SPACE_STORAGE_SUBPATH ?? (env === "prod" ? "cohub-prod" : "cohub-dev")}/checkpoints`,
  checkpointAssetThresholdBytes: Number(process.env.CHECKPOINT_ASSET_THRESHOLD_BYTES ?? 4 * 1024 * 1024),
  platformConfigRoot: process.env.PLATFORM_CONFIG_ROOT ?? "/configs",
  platformSpaceId: process.env.PLATFORM_SPACE_ID ?? "",
  generationApiKey: process.env.GENERATION_API_KEY ?? "",
  generationBaseUrl: process.env.GENERATION_BASE_URL?.trim() || undefined,
  turnObjectS3Endpoint: process.env.TURN_OBJECT_S3_ENDPOINT ?? "http://127.0.0.1:9000",
  turnObjectS3Region: process.env.TURN_OBJECT_S3_REGION ?? "us-west-1",
  turnObjectS3Bucket: process.env.TURN_OBJECT_S3_BUCKET ?? "cohub-sessions",
  turnObjectCdnBaseUrl: (process.env.TURN_OBJECT_CDN_BASE_URL ?? "https://sessions.cohub.live").replace(/\/+$/, ""),
  turnObjectS3AccessKeyId: process.env.TURN_OBJECT_S3_ACCESS_KEY_ID,
  turnObjectS3SecretAccessKey: process.env.TURN_OBJECT_S3_SECRET_ACCESS_KEY,
  publicAssetOssEndpoint: process.env.PUBLIC_ASSET_OSS_ENDPOINT,
  publicAssetOssRegion: process.env.PUBLIC_ASSET_OSS_REGION ?? "us-west-1",
  publicAssetOssBucket: process.env.PUBLIC_ASSET_OSS_BUCKET,
  publicAssetOssAccessKeyId: process.env.PUBLIC_ASSET_OSS_ACCESS_KEY_ID,
  publicAssetOssSecretAccessKey: process.env.PUBLIC_ASSET_OSS_SECRET_ACCESS_KEY,
  userUploadS3Endpoint: process.env.USER_UPLOAD_S3_ENDPOINT,
  userUploadS3Region: process.env.USER_UPLOAD_S3_REGION ?? "us-west-1",
  userUploadS3Bucket: process.env.CHAT_ATTACHMENT_S3_BUCKET,
  userUploadS3AccessKeyId: process.env.USER_UPLOAD_S3_ACCESS_KEY_ID,
  userUploadS3SecretAccessKey: process.env.USER_UPLOAD_S3_SECRET_ACCESS_KEY,
  checkpointAssetOssEndpoint: process.env.CHECKPOINT_ASSET_OSS_ENDPOINT ?? process.env.TURN_OBJECT_S3_ENDPOINT ?? "http://127.0.0.1:9000",
  checkpointAssetOssRegion: process.env.CHECKPOINT_ASSET_OSS_REGION ?? process.env.TURN_OBJECT_S3_REGION ?? "us-west-1",
  checkpointAssetOssBucket: process.env.CHECKPOINT_ASSET_OSS_BUCKET ?? process.env.TURN_OBJECT_S3_BUCKET,
  checkpointAssetOssAccessKeyId: process.env.CHECKPOINT_ASSET_OSS_ACCESS_KEY_ID ?? process.env.TURN_OBJECT_S3_ACCESS_KEY_ID,
  checkpointAssetOssSecretAccessKey: process.env.CHECKPOINT_ASSET_OSS_SECRET_ACCESS_KEY ?? process.env.TURN_OBJECT_S3_SECRET_ACCESS_KEY,
  talesofaiBillingBaseUrl: process.env.TALESOFAI_BILLING_BASE_URL?.replace(/\/+$/, ""),
  talesofaiBillingBusinessKey: process.env.TALESOFAI_BILLING_BUSINESS_KEY,
  talesofaiBillingAdminApiKey: process.env.TALESOFAI_BILLING_ADMIN_API_KEY,
  env,
  checkpointGitAuthorEmail: process.env.CHECKPOINT_GIT_AUTHOR_EMAIL?.trim() || "noreply@cohub.live",
};

export const assertRequiredConfig = (value: WorkerConfig = config) => {
  assertRedisUrl(value.redisUrl, "REDIS_URL");
  assertRedisUrl(value.bullmqRedisUrl, "BULLMQ_REDIS_URL");
  if (!value.databaseUrl) throw new Error("Missing required env: DATABASE_URL");
  if (Boolean(value.giteaBaseUrl) !== Boolean(value.giteaToken)) {
    throw new Error("GITEA_BASE_URL and GITEA_TOKEN must be configured together");
  }
  if (!value.workerSecret) throw new Error("Missing required env: WORKER_SECRET");
  if (!value.appEncryptionKey) throw new Error("Missing required env: APP_ENCRYPTION_KEY");
  if (!value.spaceStorageRoot) throw new Error("Missing required env: SPACE_STORAGE_ROOT");
  if (!value.spaceSystemRoot) throw new Error("Missing required env: SPACE_SYSTEM_ROOT");
  if (!value.checkpointCacheRoot) throw new Error("Missing required env: CHECKPOINT_CACHE_ROOT");
};
