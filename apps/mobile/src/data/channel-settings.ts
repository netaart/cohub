import type { Channel, CohubClient } from "@neta-art/cohub";

export const channelProviders = ["discord", "feishu", "wechat", "qq"] as const;
export type ChannelProvider = typeof channelProviders[number];
export type ChannelDraft = { name: string; token: string; appId: string; secret: string; brand: "feishu" | "lark" };
export type ChannelField = "name" | "token" | "appId" | "secret";

export function isChannelProvider(value: unknown): value is ChannelProvider {
  return channelProviders.some((provider) => provider === value);
}

export function missingChannelField(provider: ChannelProvider, draft: ChannelDraft): ChannelField | null {
  if (!draft.name.trim()) return "name";
  if (provider === "discord" && !draft.token.trim()) return "token";
  if (provider === "feishu" || provider === "qq") {
    if (!draft.appId.trim()) return "appId";
    if (!draft.secret.trim()) return "secret";
  }
  return null;
}

export async function createSettingsChannel(client: CohubClient, provider: Exclude<ChannelProvider, "wechat">, draft: ChannelDraft): Promise<void> {
  const missing = missingChannelField(provider, draft);
  if (missing) throw new Error(`Channel ${missing} is required.`);
  const credentials = provider === "discord" ? { token: draft.token.trim() }
    : provider === "feishu" ? { appId: draft.appId.trim(), appSecret: draft.secret.trim(), brand: draft.brand }
    : { appId: draft.appId.trim(), clientSecret: draft.secret.trim() };
  await client.channels.create({ provider, name: draft.name.trim(), credentials });
}

export function channelHealthState(channel: Channel): NonNullable<Channel["health"]>["state"] {
  return channel.health?.state ?? (channel.boundSpace ? "connecting" : "unbound");
}

type WeChatStatus = Awaited<ReturnType<CohubClient["channels"]["waitWeChatLogin"]>>;

// SDK long polls cannot be aborted. Cancellation suppresses their results and prevents the next request.
export function createWeChatLoginPoller(wait: CohubClient["channels"]["waitWeChatLogin"]) {
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => { generation += 1; clearTimeout(timer); };
  return {
    stop,
    start(sessionKey: string, expiresAt: number, onStatus: (status: WeChatStatus) => void, onError: (error: unknown) => void, verifyCode?: string): void {
      stop();
      const current = generation;
      const poll = async (code?: string): Promise<void> => {
        if (current !== generation) return;
        if (Date.now() >= expiresAt) { onStatus({ connected: false, expired: true, message: "" }); return; }
        try {
          const status = await wait({ sessionKey, verifyCode: code });
          if (current !== generation) return;
          onStatus(status);
          if (!status.connected && !status.expired && !status.needVerifyCode) {
            timer = setTimeout(() => void poll(), 1200);
          }
        } catch (error) {
          if (current === generation) onError(error);
        }
      };
      void poll(verifyCode);
    },
  };
}
