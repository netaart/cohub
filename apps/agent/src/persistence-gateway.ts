import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { MessageRecord } from "@cohub/protocol/model";
import type { ChannelProvider, GatewayOutboundCommand } from "@cohub/protocol/gateway";
import { spaceChannels, spaceSessionBindings, providerMessageRefs, userChannels } from "@cohub/db";
import { buildTraceHeaders, getCurrentRequestId } from "@cohub/infra/tracing";
import { db } from "./db.js";
import { env } from "./env.js";
import { logger } from "./logger.js";
import { redis, getGatewayNodeOutboundStreamKey, xaddWithMaxlen } from "./redis.js";

const INTERNAL_API_BASE_URL =
  env.ENV === "prod"
    ? "http://cohub-api.cohub.svc.cluster.local:8787"
    : "http://cohub-api-dev.cohub-dev.svc.cluster.local:8787";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function requestGatewayChannelReconcile(reason: string) {
  try {
    const response = await fetch(`${INTERNAL_API_BASE_URL}/internal/gateway/reconcile-channels`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(env.WORKER_SECRET ? { "x-worker-secret": env.WORKER_SECRET } : {}), ...buildTraceHeaders({ requestId: getCurrentRequestId() }) },
      body: JSON.stringify({ reason }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Gateway reconcile failed ${response.status}: ${text}`);
    }
  } catch (error) {
    logger.warn("[GatewayBinding] failed to request channel reconcile", { reason, error });
  }
}

const GATEWAY_ROUTE_RETRY_DELAYS_MS = [200, 800, 2_000];

async function resolveGatewayNodeForOutbound(input: { spaceChannelId: string; spaceId: string; sessionId: string; messageId: string }) {
  for (let attempt = 0; attempt <= GATEWAY_ROUTE_RETRY_DELAYS_MS.length; attempt += 1) {
    const nodeId = await redis.hget("gateway:channel_routing", input.spaceChannelId);
    if (nodeId) return nodeId;
    await requestGatewayChannelReconcile(`missing_agent_outbound_route:${input.spaceChannelId}`);
    const retryDelay = GATEWAY_ROUTE_RETRY_DELAYS_MS[attempt];
    if (retryDelay == null) break;
    await sleep(retryDelay);
  }
  throw new Error(`Gateway route is missing for final assistant outbound channel ${input.spaceChannelId}`);
}

export async function dispatchFinalAssistantToGateway(input: { spaceId: string; sessionId: string; message: MessageRecord }) {
  if (input.message.role !== "assistant") return;
  const kind = input.message.meta?.messageKind;
  if (kind !== "assistant_final" && kind !== "assistant_error") return;

  const bindings = await db.select().from(spaceSessionBindings).where(eq(spaceSessionBindings.spaceSessionId, input.sessionId));
  const targetBindings = bindings.length > 0
    ? bindings.map((binding) => ({ spaceChannelId: binding.spaceChannelId, provider: binding.provider, externalChatId: binding.externalChatId, bindingKey: binding.bindingKey }))
    : (await db.select({ spaceChannelId: spaceChannels.id, provider: userChannels.provider, externalChatId: sql<string | null>`null`, bindingKey: sql<string>`''` }).from(spaceChannels).innerJoin(userChannels, eq(userChannels.id, spaceChannels.channelId)).where(eq(spaceChannels.spaceId, input.spaceId))).map((row) => ({ ...row, externalChatId: row.externalChatId ?? null }));

  for (const binding of targetBindings) {
    if (!binding.externalChatId) continue;
    const nodeId = await resolveGatewayNodeForOutbound({ spaceChannelId: binding.spaceChannelId, spaceId: input.spaceId, sessionId: input.sessionId, messageId: input.message.id });
    const turnAnchorMessageId = typeof input.message.meta?.anchorUserMessageId === "string" ? input.message.meta.anchorUserMessageId : input.message.id;
    const [anchorRef] = await db.select({ externalMessageId: providerMessageRefs.externalMessageId }).from(providerMessageRefs).where(and(eq(providerMessageRefs.spaceChannelId, binding.spaceChannelId), eq(providerMessageRefs.sessionMessageId, turnAnchorMessageId), eq(providerMessageRefs.direction, "inbound"))).orderBy(desc(providerMessageRefs.createdAt)).limit(1);
    const command: GatewayOutboundCommand = {
      commandId: randomUUID(), timestamp: Date.now(), channelId: binding.spaceChannelId,
      provider: binding.provider as ChannelProvider, externalChatId: binding.externalChatId,
      content: input.message.content, replyToExternalMessageId: anchorRef?.externalMessageId,
      spaceId: input.spaceId, spaceSessionId: input.sessionId, sessionMessageId: input.message.id,
      meta: { sessionOutput: { type: "session.message.persisted", spaceId: input.spaceId, sessionId: input.sessionId, message: input.message }, bindingKey: binding.bindingKey, sessionMessageRole: input.message.role, turnAnchorMessageId, targetNodeId: nodeId },
    };
    await xaddWithMaxlen(redis, getGatewayNodeOutboundStreamKey(nodeId), "*", "payload", JSON.stringify(command));
  }
}
