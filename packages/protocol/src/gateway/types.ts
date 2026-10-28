import type { ModelThinkingLevel } from "../model/thinking.js";

export type ChannelModelConfig = {
  provider: string;
  id: string;
  thinkingLevel?: ModelThinkingLevel | null;
};

export type BaseChannelConfig = {
  model?: ChannelModelConfig | null;
};

export type DiscordChannelConfig = BaseChannelConfig & {
  inbound?: {
    requireMentionInGuild?: boolean;
  };
  outbound?: {
    showThinking?: boolean;
    showToolCalls?: boolean;
  };
};

export type FeishuChannelConfig = BaseChannelConfig & {
  brand?: "feishu" | "lark";
  inbound?: {
    requireMentionInGroup?: boolean;
  };
  outbound?: {
    renderMode?: "card" | "post";
    showThinking?: boolean;
    showToolCalls?: boolean;
  };
};

export type WeChatChannelConfig = BaseChannelConfig & {
  outbound?: {
    showIntermediateStatus?: boolean;
  };
};

export type QQChannelConfig = BaseChannelConfig & {
  inbound?: {
    requireMentionInGroup?: boolean;
  };
  outbound?: {
    markdownSupport?: boolean;
  };
};

export type ChannelConfig =
  | DiscordChannelConfig
  | FeishuChannelConfig
  | WeChatChannelConfig
  | QQChannelConfig
  | (BaseChannelConfig & Record<string, unknown>);

/** Runtime connection health for a bound gateway channel (space_channel id). */
export type ChannelRuntimeState =
  | "unbound"
  | "connecting"
  | "ready"
  | "degraded"
  | "error"
  | "stopped";

export type ChannelHealthReasonCode =
  | "invalid_credentials"
  | "auth_failed"
  | "network"
  | "permission"
  | "provider_error"
  | "rate_limit"
  | "unknown";

export type ChannelHealth = {
  state: ChannelRuntimeState;
  reasonCode?: ChannelHealthReasonCode | null;
  message?: string | null;
  detail?: string | null;
  lastReadyAt?: string | null;
  lastErrorAt?: string | null;
  lastInboundAt?: string | null;
  lastOutboundAt?: string | null;
  nodeId?: string | null;
  updatedAt: string;
  meta?: Record<string, string> | null;
};
