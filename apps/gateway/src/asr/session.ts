import { randomUUID } from "node:crypto";
import { WebSocket, type RawData } from "ws";
import * as z from "zod";
import { createLogger } from "@cohub/infra/logging";
import { authenticateRealtimeToken, type RealtimeAuthResult } from "../api-client.js";
import { gatewayConfig } from "../config.js";
import { VolcAsrProvider } from "./volc-asr-provider.js";

const logger = createLogger({ serviceName: "cohub-gateway" });

const ASR_MAX_MESSAGE_BYTES = 1024 * 1024;
const ASR_MAX_SESSION_MS = 10 * 60_000;
const ASR_IDLE_CONNECTION_MS = 30 * 60_000;

const authMessageSchema = z.object({
  type: z.literal("auth"),
  requestId: z.string().optional(),
  payload: z.object({
    token: z.string().min(1),
  }),
});

const asrMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("asr.start"),
    requestId: z.string().optional(),
    payload: z.object({
      language: z.string().min(1).optional(),
    }).optional(),
  }),
  z.object({
    type: z.literal("asr.audio"),
    requestId: z.string().optional(),
    payload: z.object({
      audio: z.string().min(1),
    }),
  }),
  z.object({
    type: z.literal("asr.stop"),
    requestId: z.string().optional(),
  }),
  z.object({
    type: z.literal("asr.cancel"),
    requestId: z.string().optional(),
  }),
  z.object({
    type: z.literal("ping"),
    requestId: z.string().optional(),
  }),
]);

type AsrMessage = z.infer<typeof asrMessageSchema>;

type AsrConnectionContext = {
  connectionId: string;
  userId?: string;
  token?: string;
  provider?: VolcAsrProvider;
  committedText: string;
  partialText: string;
  timeout?: NodeJS.Timeout;
  idleTimeout?: NodeJS.Timeout;
};

const send = (socket: WebSocket, input: {
  type: string;
  requestId?: string | null;
  payload?: Record<string, unknown>;
}) => {
  if (socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify({
      id: randomUUID(),
      timestamp: Date.now(),
      requestId: input.requestId ?? null,
      type: input.type,
      payload: input.payload ?? {},
    }));
  } catch (error) {
    logger.warn("[ASR] failed to send websocket message", { error: error instanceof Error ? error.message : String(error) });
  }
};

const sendError = (socket: WebSocket, code: string, message: string, requestId?: string | null) => {
  send(socket, { type: "asr.error", requestId, payload: { code, message } });
};

const parseRawMessage = (data: RawData) => {
  const raw = typeof data === "string"
    ? data
    : Buffer.isBuffer(data)
      ? data.toString("utf-8")
      : Array.isArray(data)
        ? Buffer.concat(data.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))).toString("utf-8")
        : Buffer.from(data).toString("utf-8");
  if (Buffer.byteLength(raw, "utf-8") > ASR_MAX_MESSAGE_BYTES) {
    throw new Error("message too large");
  }
  return JSON.parse(raw) as unknown;
};

const getVolcConfig = () => {
  const apiKey = gatewayConfig.volcAsr.apiKey;
  if (!apiKey) throw new Error("VOLC_ASR_API_KEY is not configured");
  return {
    apiKey,
    resourceId: gatewayConfig.volcAsr.resourceId,
    url: gatewayConfig.volcAsr.url,
  };
};

const clearSessionTimeout = (ctx: AsrConnectionContext) => {
  if (ctx.timeout) clearTimeout(ctx.timeout);
  ctx.timeout = undefined;
};

const clearIdleTimeout = (ctx: AsrConnectionContext) => {
  if (ctx.idleTimeout) clearTimeout(ctx.idleTimeout);
  ctx.idleTimeout = undefined;
};

const scheduleIdleClose = (socket: WebSocket, ctx: AsrConnectionContext) => {
  clearIdleTimeout(ctx);
  if (ctx.provider) return;
  ctx.idleTimeout = setTimeout(() => {
    if (ctx.provider || socket.readyState !== WebSocket.OPEN) return;
    socket.close(1000, "asr connection idle timeout");
  }, ASR_IDLE_CONNECTION_MS);
};

const closeProvider = (ctx: AsrConnectionContext) => {
  clearSessionTimeout(ctx);
  const provider = ctx.provider;
  ctx.provider = undefined;
  provider?.close();
};

const markProviderClosed = (ctx: AsrConnectionContext, provider: VolcAsrProvider) => {
  if (ctx.provider !== provider) return;
  clearSessionTimeout(ctx);
  ctx.provider = undefined;
};

const startAsr = async (socket: WebSocket, ctx: AsrConnectionContext, message: Extract<AsrMessage, { type: "asr.start" }>) => {
  if (!ctx.userId) {
    sendError(socket, "UNAUTHORIZED", "authentication required", message.requestId);
    return;
  }
  clearIdleTimeout(ctx);
  closeProvider(ctx);
  ctx.committedText = "";
  ctx.partialText = "";

  const volcConfig = getVolcConfig();
  const requestId = message.requestId ?? randomUUID();
  const provider = new VolcAsrProvider({
    ...volcConfig,
    requestId,
    uid: ctx.userId,
    language: message.payload?.language ?? null,
  });
  ctx.provider = provider;

  provider.on("result", (result) => {
    if (result.definite) {
      ctx.committedText += result.text;
      ctx.partialText = "";
      send(socket, { type: "asr.final", requestId, payload: { text: result.text, fullText: ctx.committedText } });
      return;
    }
    ctx.partialText = result.text;
    send(socket, { type: "asr.partial", requestId, payload: { text: result.text, fullText: ctx.committedText + ctx.partialText } });
  });
  provider.on("error", (error) => {
    logger.warn("[ASR] provider error", { connectionId: ctx.connectionId, requestId, error: error.message });
    sendError(socket, "PROVIDER_ERROR", "Voice input is unavailable. Try again later.", requestId);
  });
  provider.on("close", () => {
    markProviderClosed(ctx, provider);
    send(socket, { type: "asr.done", requestId });
    scheduleIdleClose(socket, ctx);
  });

  await provider.start();
  ctx.timeout = setTimeout(() => {
    provider.stop();
    sendError(socket, "MAX_DURATION_EXCEEDED", "Voice input reached the time limit", requestId);
  }, ASR_MAX_SESSION_MS);
  send(socket, { type: "asr.started", requestId });
};

const handleAsrMessage = async (socket: WebSocket, ctx: AsrConnectionContext, message: AsrMessage) => {
  if (message.type === "ping") {
    send(socket, { type: "pong", requestId: message.requestId });
    return;
  }
  if (message.type === "asr.start") {
    await startAsr(socket, ctx, message);
    return;
  }
  if (!ctx.provider) {
    sendError(socket, "ASR_NOT_STARTED", "asr session is not started", message.requestId);
    return;
  }
  if (message.type === "asr.audio") {
    ctx.provider.sendAudio(Buffer.from(message.payload.audio, "base64"));
    return;
  }
  if (message.type === "asr.stop") {
    ctx.provider.stop();
    clearSessionTimeout(ctx);
    return;
  }
  if (message.type === "asr.cancel") {
    closeProvider(ctx);
    send(socket, { type: "asr.cancelled", requestId: message.requestId });
    scheduleIdleClose(socket, ctx);
  }
};

export const handleAsrWebSocketConnection = (socket: WebSocket) => {
  const ctx: AsrConnectionContext = {
    connectionId: randomUUID(),
    committedText: "",
    partialText: "",
  };
  send(socket, { type: "system.ready", payload: { connectionId: ctx.connectionId } });
  scheduleIdleClose(socket, ctx);

  socket.on("message", (data) => {
    void (async () => {
      try {
        const raw = parseRawMessage(data);
        const authParsed = authMessageSchema.safeParse(raw);
        if (authParsed.success) {
          const result: RealtimeAuthResult = await authenticateRealtimeToken({ token: authParsed.data.payload.token });
          if (!result.ok) {
            sendError(socket, "UNAUTHORIZED", result.error.message, authParsed.data.requestId);
            return;
          }
          ctx.userId = result.user.uuid;
          ctx.token = authParsed.data.payload.token;
          send(socket, { type: "system.auth.ok", requestId: authParsed.data.requestId, payload: { user: result.user } });
          return;
        }

        if (!ctx.userId) {
          sendError(socket, "UNAUTHORIZED", "authentication required");
          return;
        }

        const parsed = asrMessageSchema.safeParse(raw);
        if (!parsed.success) {
          sendError(socket, "BAD_REQUEST", "invalid asr message");
          return;
        }
        await handleAsrMessage(socket, ctx, parsed.data);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("[ASR] message handling failed", { connectionId: ctx.connectionId, error: message });
        sendError(
          socket,
          message === "message too large" ? "MESSAGE_TOO_LARGE" : "INTERNAL_ERROR",
          message === "message too large" ? "Voice data is too large" : "Voice input is unavailable. Try again later",
        );
      }
    })();
  });

  socket.on("close", () => {
    clearIdleTimeout(ctx);
    closeProvider(ctx);
  });
  socket.on("error", () => {
    clearIdleTimeout(ctx);
    closeProvider(ctx);
  });
};
