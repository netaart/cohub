import type { Context } from "hono";
import { createLogger } from "@cohub/infra/logging";
import type { AppPromotionEventKey } from "@cohub/protocol";
import { config } from "./config.js";
import { buildMetaPromotionPayload } from "./app-promotion-meta-payload.js";

export type AppPromotionProviderKey = "generic" | "meta";

export type AppPromotionBrowserConfig =
  | { provider: "generic" }
  | { provider: "meta"; pixelId: string };

export type AppPromotionDeliveryEvent = {
  eventKey: AppPromotionEventKey;
  eventId: string;
  appId: string;
  promotionId: string;
  sourceUrl?: string;
  fbp?: string;
  fbc?: string;
  productKey?: string;
  value?: number;
  currency?: string;
};

export type AppPromotionProvider = {
  key: AppPromotionProviderKey;
  configured: () => boolean;
  browserConfig: () => AppPromotionBrowserConfig | null;
  deliver: (c: Context, event: AppPromotionDeliveryEvent) => Promise<void>;
};

const logger = createLogger({ serviceName: "cohub-api" });

function resolveSourceUrl(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const expectedOrigin = (config.webOrigin ?? (config.env === "prod" ? "https://cohub.live" : "https://dev.cohub.live")).replace(/\/+$/, "");
    return url.origin === expectedOrigin ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

const genericProvider: AppPromotionProvider = {
  key: "generic",
  configured: () => true,
  browserConfig: () => ({ provider: "generic" }),
  deliver: async () => undefined,
};

const META_EVENT_NAMES: Partial<Record<AppPromotionEventKey, string>> = {
  ready: "ViewContent",
  registration_completed: "CompleteRegistration",
  paywall_viewed: "AddToCart",
  checkout_started: "InitiateCheckout",
};

const metaProvider: AppPromotionProvider = {
  key: "meta",
  configured: () => Boolean(config.metaPromotionPixelId && config.metaPromotionAccessToken),
  browserConfig: () => config.metaPromotionPixelId && config.metaPromotionAccessToken
    ? { provider: "meta", pixelId: config.metaPromotionPixelId }
    : null,
  deliver: async (c, event) => {
    const eventName = META_EVENT_NAMES[event.eventKey];
    if (!eventName || !config.metaPromotionPixelId || !config.metaPromotionAccessToken) return;
    const userAgent = c.req.header("user-agent")?.trim();
    const sourceUrl = resolveSourceUrl(event.sourceUrl);
    const userData = {
      ...(userAgent ? { client_user_agent: userAgent } : {}),
      ...(event.fbp ? { fbp: event.fbp } : {}),
      ...(event.fbc ? { fbc: event.fbc } : {}),
    };
    const customData = {
      ...(event.productKey ? { content_ids: [event.productKey], content_type: "product" } : {}),
      ...(event.value !== undefined ? { value: event.value } : {}),
      ...(event.currency ? { currency: event.currency } : {}),
    };
    const endpoint = `https://graph.facebook.com/${config.metaPromotionApiVersion}/${encodeURIComponent(config.metaPromotionPixelId)}/events`;
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.metaPromotionAccessToken}`,
        },
        body: JSON.stringify(buildMetaPromotionPayload({
          eventName,
          eventTime: Math.floor(Date.now() / 1000),
          event,
          sourceUrl,
          userData,
          customData,
          testEventCode: config.metaPromotionTestEventCode,
        })),
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) {
        logger.warn("[AppPromotions] Meta delivery rejected", {
          status: response.status,
          eventKey: event.eventKey,
        });
      }
    } catch (error) {
      logger.warn("[AppPromotions] Meta delivery failed", {
        eventKey: event.eventKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
};

const providers = new Map<AppPromotionProviderKey, AppPromotionProvider>([
  [genericProvider.key, genericProvider],
  [metaProvider.key, metaProvider],
]);

export function getAppPromotionProvider(value: string): AppPromotionProvider | null {
  return providers.get(value as AppPromotionProviderKey) ?? null;
}

export function listAppPromotionProviders() {
  return Array.from(providers.values(), (provider) => ({
    key: provider.key,
    configured: provider.configured(),
  }));
}
