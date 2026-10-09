import { resolveLogtoEndpoint } from "@cohub/identity";

const normalizeBaseUrl = (value: string) => value.replace(/\/+$/, "");

const env = process.env.ENV === "prod" ? "prod" : "dev";

export const resolveBullmqRedisUrl = (
  source: Record<string, string | undefined> = process.env,
) => {
  const value = source.BULLMQ_REDIS_URL?.trim();
  if (!value) throw new Error("Missing required env: BULLMQ_REDIS_URL");
  return value;
};

export const gatewayConfig = {
  apiBaseUrl: normalizeBaseUrl(process.env.API_BASE_URL ?? "http://localhost:8787"),
  workerSecret: process.env.WORKER_SECRET ?? "",
  logtoEndpoint: resolveLogtoEndpoint({ endpoint: process.env.LOGTO_ENDPOINT, env }),
  port: Number(process.env.PORT ?? 8788),
  // Pod IP used to build the cluster-internal relay endpoint advertised to
  // agents for local sandboxes. Falls back to localhost for single-node dev.
  podIp: (process.env.POD_IP ?? "127.0.0.1").trim(),
  nodeId: process.env.POD_NAME || process.env.HOSTNAME || "unknown",
  get bullmqRedisUrl() {
    return resolveBullmqRedisUrl();
  },
  volcAsr: {
    apiKey: process.env.VOLC_ASR_API_KEY ?? "",
    resourceId: "volc.seedasr.sauc.duration",
    url: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
  },
};

export type GatewayAuthUser = {
  uuid: string;
  nick_name?: string;
  avatar_url?: string;
  [key: string]: unknown;
};
