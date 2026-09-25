import { z } from "zod";
import type { ContentBlock } from "../core/content.js";
import type { MessageRecord } from "../model/session.js";
export type {
  ChannelConfig,
  DiscordChannelConfig,
  FeishuChannelConfig,
  WeChatChannelConfig,
  QQChannelConfig,
  ChannelRuntimeState,
  ChannelHealthReasonCode,
  ChannelHealth,
} from "./types.js";

export type ChannelProvider = "web" | "discord" | "feishu" | "wechat" | "qq" | "telegram" | "slack";
export const GATEWAY_CHANNEL_COMMAND_SPECS = [
  {
    name: "help",
    slash: "/help",
    description: "Show available commands and usage info.",
  },
  {
    name: "new",
    slash: "/new",
    description: "Start a new Cohub session for this conversation.",
  },
  {
    name: "status",
    slash: "/status",
    description: "Show the current Cohub session status.",
  },
  {
    name: "model",
    slash: "/model",
    description: "Show or change the model for this conversation.",
  },
  {
    name: "models",
    slash: "/models",
    description: "List all available models.",
  },
] as const;

export type GatewayChannelCommandName = typeof GATEWAY_CHANNEL_COMMAND_SPECS[number]["name"];
const GATEWAY_CHANNEL_COMMAND_NAMES = GATEWAY_CHANNEL_COMMAND_SPECS.map((spec) => spec.name) as [
  GatewayChannelCommandName,
  ...GatewayChannelCommandName[],
];

export interface GatewayChannelCommand {
  name: GatewayChannelCommandName;
  rawText?: string;
  args?: string;
}

export type GatewayInboundBinding = {
  key: string;
  parentKey?: string | null;
};

const recordSchema = z.record(z.string(), z.unknown());
const contentBlockMetaSchema = recordSchema;
const contentBlockSchema: z.ZodType<ContentBlock> = z.lazy(() => z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string(),
    _meta: contentBlockMetaSchema.optional(),
  }),
  z.object({
    type: z.literal("thinking"),
    thinking: z.string(),
    signature: z.string().optional(),
    _meta: contentBlockMetaSchema.optional(),
  }),
  z.object({
    type: z.literal("image"),
    source: z.union([
      z.object({ type: z.literal("url"), url: z.string() }),
      z.object({ type: z.literal("base64"), media_type: z.string(), data: z.string() }),
    ]),
    _meta: contentBlockMetaSchema.optional(),
  }),
  z.object({
    type: z.literal("tool_use"),
    id: z.string(),
    name: z.string(),
    input: recordSchema,
    _meta: contentBlockMetaSchema.optional(),
  }),
  z.object({
    type: z.literal("tool_result"),
    tool_use_id: z.string(),
    content: z.union([z.string(), z.array(contentBlockSchema)]),
    is_error: z.boolean().optional(),
    _meta: contentBlockMetaSchema.optional(),
  }),
  z.object({
    type: z.literal("system_note"),
    note_type: z.enum(["session_created", "forked", "compacted", "info"]),
    text: z.string(),
    _meta: contentBlockMetaSchema.optional(),
  }),
]));

export const gatewayChannelCommandNameSchema = z.enum(GATEWAY_CHANNEL_COMMAND_NAMES);
export const gatewayChannelCommandSchema = z.object({
  name: gatewayChannelCommandNameSchema,
  rawText: z.string().optional(),
  args: z.string().optional(),
});

const channelProviderSchema = z.enum(["web", "discord", "feishu", "wechat", "qq", "telegram", "slack"]);
const gatewayInboundBindingSchema = z.object({
  key: z.string().min(1),
  parentKey: z.string().min(1).nullable().optional(),
});
const gatewayInboundConversationSchema = z.object({
  id: z.string(),
  parentId: z.string().nullable().optional(),
  meta: recordSchema.nullable().optional(),
});
const gatewayInboundMessageSchema = z.object({
  parentMessageId: z.string().nullable().optional(),
  meta: recordSchema.nullable().optional(),
});
const gatewayInboundSenderSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
});

const gatewayInboundEventBaseSchema = z.object({
  eventId: z.string(),
  timestamp: z.number(),
  channelId: z.string(),
  provider: channelProviderSchema,
  externalChatId: z.string(),
  externalMessageId: z.string(),
  bindingKey: z.string().optional(),
  binding: gatewayInboundBindingSchema.optional(),
  conversation: gatewayInboundConversationSchema,
  message: gatewayInboundMessageSchema.optional(),
  sender: gatewayInboundSenderSchema,
  content: z.array(contentBlockSchema),
  meta: recordSchema.nullable().optional(),
  providerEvent: z.unknown().optional(),
});

export const gatewayMessageCreateEventSchema = gatewayInboundEventBaseSchema.extend({
  eventType: z.literal("message_create"),
  command: z.never().optional(),
}).passthrough();

export const gatewayConversationCreateEventSchema = gatewayInboundEventBaseSchema.extend({
  eventType: z.literal("conversation_create"),
  command: z.never().optional(),
}).passthrough();

export const gatewayChannelCommandEventSchema = gatewayInboundEventBaseSchema.extend({
  eventType: z.literal("channel_command"),
  command: gatewayChannelCommandSchema,
}).passthrough();

export const gatewayInboundEventSchema = z.discriminatedUnion("eventType", [
  gatewayMessageCreateEventSchema,
  gatewayConversationCreateEventSchema,
  gatewayChannelCommandEventSchema,
]);

export interface GatewayInboundEventBase {
  eventId: string;
  timestamp: number;

  channelId: string;
  provider: ChannelProvider;
  externalChatId: string;
  externalMessageId: string;
  bindingKey?: string;
  binding?: GatewayInboundBinding;

  conversation: {
    id: string;
    parentId?: string | null;
    meta?: Record<string, unknown> | null;
  };
  message?: {
    parentMessageId?: string | null;
    meta?: Record<string, unknown> | null;
  };

  sender: {
    id: string;
    name?: string;
  };
  content: ContentBlock[];
  meta?: Record<string, unknown> | null;
  providerEvent?: unknown;
}

export interface GatewayMessageCreateEvent extends GatewayInboundEventBase {
  eventType: "message_create";
  command?: never;
}

export interface GatewayConversationCreateEvent extends GatewayInboundEventBase {
  eventType: "conversation_create";
  command?: never;
}

export interface GatewayChannelCommandEvent extends GatewayInboundEventBase {
  eventType: "channel_command";
  command: GatewayChannelCommand;
}

export type GatewayInboundEvent =
  | GatewayMessageCreateEvent
  | GatewayConversationCreateEvent
  | GatewayChannelCommandEvent;

export interface GatewaySessionOutputBase {
  type: "session.turn.patch" | "session.turn.error" | "session.message.persisted";
  spaceId: string;
  sessionId: string;
}

export type GatewaySessionPatchOperation =
  | { o: "append"; p: string; v: unknown }
  | { o: "replace"; p: string; v: unknown }
  | { o: "add"; p: string; v: unknown }
  | { o: "merge"; p: string; v: Record<string, unknown> }
  | { o: "remove"; p: string }
  | { v: unknown; o?: undefined; p?: undefined };

export interface GatewaySessionTurnPatchOutput extends GatewaySessionOutputBase {
  type: "session.turn.patch";
  turnId: string | null;
  messageId: string | null;
  messageOrdinal?: number | null;
  anchorUserMessageId: string | null;
  seq: number;
  baseSeq: number;
  ops: GatewaySessionPatchOperation[];
}

export interface GatewaySessionTurnErrorOutput extends GatewaySessionOutputBase {
  type: "session.turn.error";
  turnId?: string | null;
  anchorUserMessageId: string | null;
  error: string;
}

export interface GatewaySessionMessagePersistedOutput extends GatewaySessionOutputBase {
  type: "session.message.persisted";
  message: MessageRecord;
}

export type GatewaySessionOutput =
  | GatewaySessionTurnPatchOutput
  | GatewaySessionTurnErrorOutput
  | GatewaySessionMessagePersistedOutput;

export interface GatewayOutboundCommand {
  commandId: string;
  timestamp: number;

  channelId: string;
  provider: ChannelProvider;
  externalChatId: string;

  content: ContentBlock[];

  replyToExternalMessageId?: string;
  spaceId?: string;
  spaceSessionId?: string;
  sessionMessageId?: string;
  meta?: (Record<string, unknown> & { sessionOutput?: GatewaySessionOutput | null }) | null;
}

export interface GatewayControlCommand {
  action: "connect" | "disconnect" | "reload";
  configs: {
    channelId: string;
    provider: ChannelProvider;
    credentials: Record<string, unknown>;
  }[];
}

export type GatewayLogDirection = "inbound" | "outbound";
export type GatewayLogStatus = "pending" | "success" | "failed";

export interface GatewayLogEvent {
  logId: string;
  timestamp: number;
  direction: GatewayLogDirection;
  provider: ChannelProvider;
  channelId: string;
  externalChatId: string;
  externalMessageId?: string;

  rawPayload: Record<string, unknown>;
  normalizedPayload?: Record<string, unknown>;

  status: GatewayLogStatus;
  errorMessage?: string;
  correlationId?: string;
}

export * from "./delivery-plan.js";
