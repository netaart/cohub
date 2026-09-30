import { createPrivateKey, type KeyObject } from "node:crypto";
import { connect, constants, type ClientHttp2Session } from "node:http2";
import { SignJWT } from "jose";
import type { Logger } from "@cohub/infra/logging";
import type { PushTargetEnvironment } from "@cohub/db";

export const APNS_ORIGINS: Record<PushTargetEnvironment, string> = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
};

/** Apple rejects provider tokens older than 1 h and refreshes more often than every 20 min. */
export const APNS_PROVIDER_TOKEN_REFRESH_MS = 50 * 60 * 1000;
export const APNS_REQUEST_TIMEOUT_MS = 10_000;
export const APNS_COLLAPSE_ID_MAX_BYTES = 64;

/** Rejections that mean the registration itself is dead; the target is deleted. */
const INVALID_TARGET_REASONS = new Set(["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"]);

export type ApnsTarget = {
  token: string;
  environment: PushTargetEnvironment;
  topic: string;
};

export type ApnsNotification = {
  payload: Record<string, unknown>;
  collapseId?: string;
  /** Epoch seconds after which APNs stops retrying delivery. */
  expiresAt?: number;
};

export type ApnsTransportRequest = {
  origin: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
};

export type ApnsTransportResponse = { status: number; body: string };

export type ApnsTransport = {
  request(input: ApnsTransportRequest): Promise<ApnsTransportResponse>;
  close(): void;
};

/** Signs and caches the ES256 provider token shared by every APNs request. */
export class ApnsProviderToken {
  private cached: { token: string; issuedAtMs: number } | null = null;
  private pending: Promise<string> | null = null;
  private readonly privateKey: KeyObject;

  constructor(
    private readonly input: {
      keyId: string;
      teamId: string;
      privateKey: string | KeyObject;
      now?: () => number;
    },
  ) {
    this.privateKey = typeof input.privateKey === "string" ? createPrivateKey(input.privateKey) : input.privateKey;
  }

  async get(): Promise<string> {
    const nowMs = (this.input.now ?? Date.now)();
    if (this.cached && nowMs - this.cached.issuedAtMs < APNS_PROVIDER_TOKEN_REFRESH_MS) {
      return this.cached.token;
    }
    this.pending ??= this.sign(nowMs).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  /** Drops the cached token after APNs reports it expired. */
  invalidate() {
    this.cached = null;
  }

  private async sign(nowMs: number) {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: this.input.keyId })
      .setIssuer(this.input.teamId)
      .setIssuedAt(Math.floor(nowMs / 1000))
      .sign(this.privateKey);
    this.cached = { token, issuedAtMs: nowMs };
    return token;
  }
}

/** HTTP/2 transport keeping one session per APNs origin, reconnecting once it closes. */
export const createHttp2ApnsTransport = (): ApnsTransport => {
  const sessions = new Map<string, ClientHttp2Session>();

  const getSession = (origin: string) => {
    const existing = sessions.get(origin);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = connect(origin);
    // Idle sessions must not keep the process alive on shutdown.
    session.unref();
    const forget = () => {
      if (sessions.get(origin) === session) sessions.delete(origin);
    };
    session.on("error", forget);
    session.on("goaway", forget);
    session.on("close", forget);
    sessions.set(origin, session);
    return session;
  };

  return {
    request: (input) =>
      new Promise((resolve, reject) => {
        const stream = getSession(input.origin).request({
          ":method": "POST",
          ":path": input.path,
          "content-type": "application/json",
          ...input.headers,
        });
        let status = 0;
        let body = "";
        let settled = false;
        const settle = (error: Error | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) reject(error);
          else resolve({ status, body });
        };
        const timer = setTimeout(() => {
          stream.close(constants.NGHTTP2_CANCEL);
          settle(new Error(`APNs request timed out after ${input.timeoutMs}ms`));
        }, input.timeoutMs);
        stream.setEncoding("utf8");
        stream.on("response", (headers) => {
          status = Number(headers[":status"] ?? 0);
        });
        stream.on("data", (chunk: string) => {
          body += chunk;
        });
        stream.on("end", () => settle(null));
        stream.on("close", () => settle(status ? null : new Error("APNs stream closed without a response")));
        stream.on("error", (error) => settle(error));
        stream.end(input.body);
      }),
    close: () => {
      for (const session of sessions.values()) session.close();
      sessions.clear();
    },
  };
};

const parseReason = (body: string) => {
  try {
    const parsed = JSON.parse(body) as { reason?: unknown };
    return typeof parsed.reason === "string" ? parsed.reason : null;
  } catch {
    return null;
  }
};

/** Truncates to at most `maxBytes` of UTF-8 without splitting a code point. */
export const truncateUtf8 = (value: string, maxBytes: number) => {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let result = "";
  let bytes = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char);
    if (bytes + size > maxBytes) break;
    result += char;
    bytes += size;
  }
  return result;
};

export type ApnsClient = {
  readonly topics: readonly string[];
  /** Delivers to every target; never throws. Dead registrations are deleted. */
  send(targets: readonly ApnsTarget[], notification: ApnsNotification): Promise<void>;
  close(): void;
};

export const createApnsClient = (input: {
  providerToken: Pick<ApnsProviderToken, "get" | "invalidate">;
  topics: readonly string[];
  transport: ApnsTransport;
  deleteTarget: (target: ApnsTarget) => Promise<void>;
  logger: Pick<Logger, "warn" | "error">;
  timeoutMs?: number;
}): ApnsClient => {
  const timeoutMs = input.timeoutMs ?? APNS_REQUEST_TIMEOUT_MS;
  const allowedTopics = new Set(input.topics);

  const sendOne = async (target: ApnsTarget, notification: ApnsNotification, body: string) => {
    const logMeta = { environment: target.environment, topic: target.topic, token: `${target.token.slice(0, 8)}...` };
    if (!allowedTopics.has(target.topic)) {
      input.logger.warn("[APNs] skipped target with an unconfigured topic", logMeta);
      return;
    }
    try {
      const headers: Record<string, string> = {
        authorization: `bearer ${await input.providerToken.get()}`,
        "apns-topic": target.topic,
        "apns-push-type": "alert",
        "apns-priority": "10",
      };
      if (notification.collapseId) {
        headers["apns-collapse-id"] = truncateUtf8(notification.collapseId, APNS_COLLAPSE_ID_MAX_BYTES);
      }
      if (notification.expiresAt !== undefined) headers["apns-expiration"] = String(notification.expiresAt);

      const response = await input.transport.request({
        origin: APNS_ORIGINS[target.environment],
        path: `/3/device/${target.token}`,
        headers,
        body,
        timeoutMs,
      });
      if (response.status === 200) return;

      const reason = parseReason(response.body);
      if (response.status === 410 || (reason !== null && INVALID_TARGET_REASONS.has(reason))) {
        await input.deleteTarget(target);
        input.logger.warn("[APNs] deleted rejected push target", { ...logMeta, status: response.status, reason });
        return;
      }
      if (reason === "ExpiredProviderToken") input.providerToken.invalidate();
      input.logger.error("[APNs] push rejected", { ...logMeta, status: response.status, reason });
    } catch (error) {
      input.logger.error("[APNs] push failed", {
        ...logMeta,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return {
    topics: input.topics,
    send: async (targets, notification) => {
      const body = JSON.stringify(notification.payload);
      await Promise.all(targets.map((target) => sendOne(target, notification, body)));
    },
    close: () => input.transport.close(),
  };
};
