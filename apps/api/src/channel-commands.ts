import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { ContentBlock } from "@cohub/protocol/core";
import type { GatewayChannelCommand, GatewayChannelCommandName, GatewayInboundEvent } from "@cohub/protocol/gateway";
import { getRecord, loadMergedModelsCatalog, normalizeChannelModelConfig, resolveChannelModelSelection } from "./lib/channel-model-config.js";
import { config } from "./config.js";
import { db } from "./db/index.js";
import { sessionMessages, spaceSessionBindings, spaceChannels } from "@cohub/db";
import { buildSessionSourceChannel } from "./lib/session-source-channel.js";
import { assignSessionChannelSystemLabel } from "@cohub/core/labels/session-channel";
import { assignSessionSourceSystemLabel } from "@cohub/core/labels/session-source";
import { dispatchLabelAssignmentsUpdated } from "./realtime-events.js";
import { createLogger } from "@cohub/infra/logging";
import { registerSpaceSession } from "./space-sessions.js";
import { buildProviderMessageRefMeta } from "./lib/provider-message-ref.js";

const logger = createLogger({ serviceName: "cohub-api" });

type ResolvedGatewayInbound = {
  spaceId: string;
  sessionId: string;
  userId: string;
  spaceChannelId: string;
  channelId: string;
  conversationId: string;
  bindingKey: string;
};

export type ChannelCommandDeps = {
  buildDefaultBindingMeta: (event: GatewayInboundEvent) => Record<string, unknown>;
  createProviderMessageRef: (input: {
    provider: string;
    spaceId: string;
    spaceSessionId: string;
    spaceChannelId?: string | null;
    sessionMessageId?: string | null;
    direction: "inbound" | "outbound";
    externalConversationId: string;
    externalMessageId: string;
    parentExternalConversationId?: string | null;
    parentExternalMessageId?: string | null;
    externalAuthorId?: string | null;
    externalAuthorName?: string | null;
    meta?: Record<string, unknown> | null;
  }) => Promise<unknown>;
  createSpaceSessionBinding: (input: {
    spaceId: string;
    spaceSessionId: string;
    spaceChannelId: string;
    provider: string;
    bindingKey: string;
    externalChatId: string;
    meta?: Record<string, unknown> | null;
  }) => Promise<unknown>;
  dispatchOutboundMessage: (input: {
    spaceChannelId: string;
    spaceId?: string;
    spaceSessionId?: string;
    sessionMessageId?: string;
    provider?: string;
    externalChatId?: string | null;
    content: ContentBlock[];
    replyToExternalMessageId?: string;
    meta?: Record<string, unknown> | null;
  }) => Promise<void>;
};

type ChannelCommandExecutionInput = {
  event: GatewayInboundEvent;
  resolved: ResolvedGatewayInbound;
  command: GatewayChannelCommand;
  deps: ChannelCommandDeps;
};

type ChannelCommandHandler = (input: ChannelCommandExecutionInput) => Promise<boolean>;

const DEFAULT_MODEL_CONTEXT_WINDOW = 128_000;

const getSessionUrl = (spaceId: string, sessionId: string) => {
  const origin = (config.webOrigin ?? (config.env === "prod" ? "https://cohub.live" : "https://dev.cohub.live")).replace(/\/+$/, "");
  return `${origin}/spaces/${spaceId}/sessions/${sessionId}`;
};

const getModelContextWindow = async (spaceId: string, provider?: string | null, model?: string | null) => {
  const modelId = model?.trim();
  if (!modelId) return DEFAULT_MODEL_CONTEXT_WINDOW;

  const catalog = await loadMergedModelsCatalog(db, spaceId);
  const providers = provider?.trim()
    ? [[provider.trim(), catalog.providers[provider.trim()]] as const]
    : Object.entries(catalog.providers);

  for (const [, providerConfig] of providers) {
    const modelDef = providerConfig?.models?.find((item) => item.id === modelId);
    if (typeof modelDef?.contextWindow === "number" && Number.isFinite(modelDef.contextWindow) && modelDef.contextWindow > 0) {
      return modelDef.contextWindow;
    }
  }

  return DEFAULT_MODEL_CONTEXT_WINDOW;
};

const getUsageTotalTokens = (usage: unknown) => {
  if (!usage || typeof usage !== "object") return null;
  const record = usage as Record<string, unknown>;
  const explicit = record.totalTokens ?? record.total;
  if (typeof explicit === "number" && Number.isFinite(explicit)) return explicit;

  const input = typeof record.input === "number" ? record.input : 0;
  const output = typeof record.output === "number" ? record.output : 0;
  const cacheRead = typeof record.cacheRead === "number" ? record.cacheRead : 0;
  const cacheWrite = typeof record.cacheWrite === "number" ? record.cacheWrite : 0;
  const total = input + output + cacheRead + cacheWrite;
  return total > 0 ? total : null;
};

const formatTokenCount = (value: number) => {
  if (value < 1000) return String(Math.round(value));
  const thousands = value / 1000;
  if (thousands < 10 && !Number.isInteger(thousands)) return `${thousands.toFixed(1)}k`;
  return `${Math.round(thousands)}k`;
};

const getContextUsageText = async (spaceId: string, provider?: string | null, model?: string | null, usage?: unknown) => {
  const usedTokens = getUsageTotalTokens(usage) ?? 0;
  const contextWindow = await getModelContextWindow(spaceId, provider, model).catch(() => DEFAULT_MODEL_CONTEXT_WINDOW);
  return `${formatTokenCount(usedTokens)}/${formatTokenCount(contextWindow)}`;
};

const formatModelSelection = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;

const getHelpText = () => {
  return [
    "Cohub Commands:",
    "",
    "/help",
    "  Show available commands and usage info.",
    "",
    "/new",
    "  Start a new Cohub session for this conversation.",
    "",
    "/status",
    "  Show current session status and context usage.",
    "",
    "/model [provider/model_id]",
    "  Show current model & available model list, or change model (alias: /models).",
  ].join("\n");
};

const getModelListText = async (spaceId: string, resolved: ResolvedGatewayInbound) => {
  const current = await getBindingModelConfig(resolved);
  const currentText = current.model
    ? `${formatModelSelection(current.model)} (${current.source})`
    : `default (${current.source})`;

  const catalog = await loadMergedModelsCatalog(db, spaceId);
  const providerEntries = Object.entries(catalog.providers ?? {});

  const modelLines: string[] = [];
  for (const [provider, providerConfig] of providerEntries) {
    const visibleModels = (providerConfig.models ?? []).filter((model) => !model.hidden);
    if (visibleModels.length === 0) continue;

    modelLines.push(`• ${provider}`);
    for (const model of visibleModels) {
      modelLines.push(`  /model ${provider}/${model.id}`);
    }
  }

  return [
    `Current Model: ${currentText}`,
    "",
    "Available Models:",
    modelLines.length > 0 ? modelLines.join("\n") : "  (none)",
    "",
    "Usage:",
    "/model <provider/model-id>",
    "/model default (reset to space default)",
  ].join("\n");
};

const getBindingModelConfig = async (resolved: ResolvedGatewayInbound) => {
  const [binding] = await db.select({ meta: spaceSessionBindings.meta }).from(spaceSessionBindings).where(and(eq(spaceSessionBindings.spaceChannelId, resolved.spaceChannelId), eq(spaceSessionBindings.bindingKey, resolved.bindingKey))).limit(1);
  const bindingModel = normalizeChannelModelConfig(getRecord(binding?.meta)?.model);
  if (bindingModel) return { model: bindingModel, source: "conversation" as const };

  const [channel] = await db.select({ config: spaceChannels.config }).from(spaceChannels).where(eq(spaceChannels.id, resolved.spaceChannelId)).limit(1);
  const channelModel = normalizeChannelModelConfig(getRecord(channel?.config)?.model);
  if (channelModel) return { model: channelModel, source: "channel" as const };

  return { model: null, source: "default" as const };
};

const updateBindingModelConfig = async (resolved: ResolvedGatewayInbound, model: { provider: string; id: string } | null) => {
  const [binding] = await db.select().from(spaceSessionBindings).where(and(eq(spaceSessionBindings.spaceChannelId, resolved.spaceChannelId), eq(spaceSessionBindings.bindingKey, resolved.bindingKey))).limit(1);
  if (!binding) return;
  const currentMeta = getRecord(binding.meta) ?? {};
  const nextMeta: Record<string, unknown> = { ...currentMeta, model };
  if (!model) delete nextMeta.model;
  await db.update(spaceSessionBindings).set({ meta: nextMeta, updatedAt: new Date() }).where(eq(spaceSessionBindings.id, binding.id));
};

const createInboundCommandRef = async (input: {
  deps: ChannelCommandDeps;
  event: GatewayInboundEvent;
  resolved: ResolvedGatewayInbound;
  command: GatewayChannelCommand;
  sessionId?: string;
}) => input.deps.createProviderMessageRef({
  provider: input.event.provider,
  spaceId: input.resolved.spaceId,
  spaceSessionId: input.sessionId ?? input.resolved.sessionId,
  spaceChannelId: input.resolved.spaceChannelId,
  sessionMessageId: null,
  direction: "inbound",
  externalConversationId: input.resolved.conversationId,
  externalMessageId: input.event.externalMessageId,
  externalAuthorId: input.event.sender.id,
  externalAuthorName: input.event.sender.name ?? null,
  meta: buildProviderMessageRefMeta({
    bindingKey: input.resolved.bindingKey,
    command: input.command.name,
    contextIncluded: false,
  }, input.event.providerEvent),
});

const dispatchCommandReply = async (input: {
  deps: ChannelCommandDeps;
  event: GatewayInboundEvent;
  resolved: ResolvedGatewayInbound;
  sessionId: string;
  text: string;
}) => input.deps.dispatchOutboundMessage({
  spaceChannelId: input.resolved.spaceChannelId,
  spaceId: input.resolved.spaceId,
  spaceSessionId: input.sessionId,
  provider: input.event.provider,
  externalChatId: input.event.externalChatId,
  replyToExternalMessageId: input.event.externalMessageId,
  content: [{ type: "text", text: input.text }],
  meta: {
    bindingKey: input.resolved.bindingKey,
    source: "channel_command",
    commandReply: true,
  },
});

const getSessionStatusText = async (spaceId: string, sessionId: string) => {
  const latestMessages = await db
    .select({ provider: sessionMessages.provider, model: sessionMessages.model, usage: sessionMessages.usage })
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, sessionId))
    .orderBy(desc(sessionMessages.sequence))
    .limit(20);
  const latestModelMessage = latestMessages.find((message) => message.model?.trim());

  const modelText = latestModelMessage?.model
    ? `${latestModelMessage.provider ?? "unknown"}/${latestModelMessage.model}`
    : "unknown";
  const latestUsageMessage = latestMessages.find((message) => getUsageTotalTokens(message.usage) !== null);

  return [
    `Model: ${modelText}`,
    `Context: ${await getContextUsageText(spaceId, latestModelMessage?.provider, latestModelMessage?.model, latestUsageMessage?.usage)}`,
    `Session: ${sessionId}`,
    `Cohub: ${getSessionUrl(spaceId, sessionId)}`,
  ].join("\n");
};

const createFreshSessionForBinding = async (
  deps: ChannelCommandDeps,
  event: GatewayInboundEvent,
  resolved: ResolvedGatewayInbound,
) => {
  const sessionId = randomUUID();
  const sessionSource = buildSessionSourceChannel(event);
  const session = await registerSpaceSession({
    spaceId: resolved.spaceId,
    sessionId,
    userUuid: resolved.userId,
    source: sessionSource,
    externalSessionId: null,
    meta: {
      source: `channel:${event.provider}`,
      createdFrom: "gateway_command_new",
      conversation: event.conversation ?? null,
      providerMeta: event.meta ?? null,
      previousSessionId: resolved.sessionId,
    },
  });

  await Promise.all([
    assignSessionSourceSystemLabel({
      db,
      spaceId: resolved.spaceId,
      sessionId: session.id,
      source: sessionSource,
      provider: event.provider,
    }).catch((error: unknown) => logger.warn("[SessionSourceLabel] failed to assign channel source label", error)),
    assignSessionChannelSystemLabel({
      db,
      spaceId: resolved.spaceId,
      sessionId: session.id,
      channelId: resolved.channelId,
      spaceChannelId: resolved.spaceChannelId,
      provider: event.provider,
    }).catch((error: unknown) => logger.warn("[SessionChannelLabel] failed to assign channel label", error)),
  ]).then(() =>
    dispatchLabelAssignmentsUpdated({ spaceId: resolved.spaceId, resourceType: "session", resourceRef: session.id, sessionId: session.id }),
  ).catch((error: unknown) => logger.warn("[SessionLabels] failed to dispatch channel session label update", error));

  const defaultBindingMeta = deps.buildDefaultBindingMeta(event);
  const currentModel = await getBindingModelConfig(resolved);
  await deps.createSpaceSessionBinding({
    spaceId: resolved.spaceId,
    spaceSessionId: session.id,
    spaceChannelId: resolved.spaceChannelId,
    provider: event.provider,
    bindingKey: resolved.bindingKey,
    externalChatId: event.externalChatId,
    meta: {
      ...defaultBindingMeta,
      ...(currentModel.source === "conversation" && currentModel.model ? { model: currentModel.model } : {}),
      lifecycle: {
        ...(defaultBindingMeta.lifecycle as Record<string, unknown>),
        initializedAt: new Date(event.timestamp).toISOString(),
        initializedFromEventId: event.eventId,
        lastMaterializedBy: "command_new",
        previousSessionId: resolved.sessionId,
      },
    },
  });

  return session.id;
};

const handleHelpCommand: ChannelCommandHandler = async (input) => {
  const { event, resolved, command, deps } = input;
  await createInboundCommandRef({ deps, event, resolved, command });
  await dispatchCommandReply({
    deps,
    event,
    resolved,
    sessionId: resolved.sessionId,
    text: getHelpText(),
  });
  return true;
};

const handleStatusCommand: ChannelCommandHandler = async (input) => {
  const { event, resolved, command, deps } = input;
  await createInboundCommandRef({ deps, event, resolved, command });
  await dispatchCommandReply({
    deps,
    event,
    resolved,
    sessionId: resolved.sessionId,
    text: await getSessionStatusText(resolved.spaceId, resolved.sessionId),
  });
  return true;
};

const handleNewCommand: ChannelCommandHandler = async (input) => {
  const { event, resolved, command, deps } = input;
  const sessionId = await createFreshSessionForBinding(deps, event, resolved);
  await createInboundCommandRef({ deps, event, resolved, command, sessionId });
  await dispatchCommandReply({
    deps,
    event,
    resolved,
    sessionId,
    text: `Created a new session.\nCohub: ${getSessionUrl(resolved.spaceId, sessionId)}`,
  });
  return true;
};

const handleModelCommand: ChannelCommandHandler = async (input) => {
  const { event, resolved, command, deps } = input;
  const args = command.args?.trim() ?? "";
  await createInboundCommandRef({ deps, event, resolved, command });

  if (!args) {
    const text = await getModelListText(resolved.spaceId, resolved);
    await dispatchCommandReply({
      deps,
      event,
      resolved,
      sessionId: resolved.sessionId,
      text,
    });
    return true;
  }

  if (["default", "clear", "reset"].includes(args.toLowerCase())) {
    await updateBindingModelConfig(resolved, null);
    await dispatchCommandReply({ deps, event, resolved, sessionId: resolved.sessionId, text: "Model override cleared." });
    return true;
  }

  const model = await resolveChannelModelSelection(db, resolved.spaceId, args);
  if (!model) {
    await dispatchCommandReply({ deps, event, resolved, sessionId: resolved.sessionId, text: "Model not found or ambiguous. Use provider/model-id." });
    return true;
  }

  await updateBindingModelConfig(resolved, { provider: model.provider, id: model.id });
  await dispatchCommandReply({ deps, event, resolved, sessionId: resolved.sessionId, text: `Model set to ${model.display}.` });
  return true;
};

const channelCommandHandlers: Record<GatewayChannelCommandName, ChannelCommandHandler> = {
  help: handleHelpCommand,
  model: handleModelCommand,
  models: handleModelCommand,
  new: handleNewCommand,
  status: handleStatusCommand,
};

export const executeChannelCommand = async (input: ChannelCommandExecutionInput) => {
  const handler = channelCommandHandlers[input.command.name];
  return handler(input);
};
