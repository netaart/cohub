import { createLogger } from "@cohub/infra/logging";
import { rtcIceServerSchema, type RtcIceServer, type RtcIceServers } from "@cohub/protocol";
import { z } from "zod";
import { config } from "./config.js";

const logger = createLogger({ serviceName: "cohub-api" });

const STUN_ONLY: RtcIceServer[] = [{ urls: "stun:stun.cloudflare.com:3478" }];
const CREDENTIAL_TTL_SECONDS = 24 * 60 * 60;
const REUSE_MS = 60 * 60 * 1000;
const FAILURE_BACKOFF_MS = 60 * 1000;
const MAX_CACHED_USERS = 10_000;
const REQUEST_TIMEOUT_MS = 5_000;

type Cached = { value: RtcIceServers; reuseUntil: number };

const cache = new Map<string, Cached>();
const inFlight = new Map<string, Promise<RtcIceServers>>();

const cloudflareResponseSchema = z.object({ iceServers: z.array(rtcIceServerSchema).min(1).max(8) });

/** Browsers refuse port 53, so Cloudflare's DNS-port fallbacks only cost timeouts. */
function dropPort53(servers: RtcIceServer[]): RtcIceServer[] {
  return servers
    .map((server) => {
      const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter((url) => !/:53(\?|$)/.test(url));
      return { ...server, urls };
    })
    .filter((server) => server.urls.length > 0);
}

async function requestCloudflare(keyId: string, token: string): Promise<RtcIceServer[]> {
  const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ttl: CREDENTIAL_TTL_SECONDS }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Cloudflare TURN responded ${response.status}`);
  return dropPort53(cloudflareResponseSchema.parse(await response.json()).iceServers);
}

async function issue(): Promise<{ value: RtcIceServers; reuseMs: number }> {
  const now = Date.now();
  const { rtcTurnKeyId: keyId, rtcTurnKeyApiToken: token } = config;
  if (!keyId || !token) {
    return { value: { iceServers: STUN_ONLY, expiresAt: new Date(now + CREDENTIAL_TTL_SECONDS * 1000).toISOString() }, reuseMs: REUSE_MS };
  }
  try {
    const iceServers = await requestCloudflare(keyId, token);
    return { value: { iceServers, expiresAt: new Date(now + CREDENTIAL_TTL_SECONDS * 1000).toISOString() }, reuseMs: REUSE_MS };
  } catch (error) {
    logger.warn("[RTC] TURN credentials unavailable; falling back to STUN", { error });
    return { value: { iceServers: STUN_ONLY, expiresAt: new Date(now + FAILURE_BACKOFF_MS).toISOString() }, reuseMs: FAILURE_BACKOFF_MS };
  }
}

export function getIceServers(userId: string): Promise<RtcIceServers> {
  const cached = cache.get(userId);
  if (cached && cached.reuseUntil > Date.now()) return Promise.resolve(cached.value);
  const pending = inFlight.get(userId);
  if (pending) return pending;
  const request = issue()
    .then(({ value, reuseMs }) => {
      if (cache.size >= MAX_CACHED_USERS) cache.delete(cache.keys().next().value as string);
      cache.delete(userId);
      cache.set(userId, { value, reuseUntil: Date.now() + reuseMs });
      return value;
    })
    .finally(() => inFlight.delete(userId));
  inFlight.set(userId, request);
  return request;
}

export function resetIceServerCache() {
  cache.clear();
  inFlight.clear();
}
