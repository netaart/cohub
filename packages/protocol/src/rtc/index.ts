import * as z from "zod";

export const rtcIceServerSchema = z.object({
  urls: z.union([z.string().min(1).max(512), z.array(z.string().min(1).max(512)).min(1).max(16)]),
  username: z.string().max(512).optional(),
  credential: z.string().max(512).optional(),
});
export type RtcIceServer = z.infer<typeof rtcIceServerSchema>;

export type RtcIceServers = {
  iceServers: RtcIceServer[];
  expiresAt: string;
};

export const RTC_SDP_MAX = 64 * 1024;

export const sessionDescriptionSchema = z.object({
  type: z.enum(["offer", "answer"]),
  sdp: z.string().min(1).max(RTC_SDP_MAX),
});
export type SessionDescription = z.infer<typeof sessionDescriptionSchema>;

export const APP_RTC_DELIVERIES = ["reliable", "latest"] as const;
export type AppRtcDelivery = (typeof APP_RTC_DELIVERIES)[number];

export const APP_RTC_PUBLICATION_KINDS = ["data", "audio", "video"] as const;
export type AppRtcPublicationKind = (typeof APP_RTC_PUBLICATION_KINDS)[number];
export type AppRtcMediaKind = Exclude<AppRtcPublicationKind, "data">;

export const APP_RTC_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
export const isAppRtcName = (value: unknown): value is string =>
  typeof value === "string" && APP_RTC_NAME_PATTERN.test(value) && !value.toLowerCase().startsWith("cohub.");

export const APP_RTC_LIMITS = {
  channelsPerMember: 16,
  tracksPerMember: 4,
  dataSubscriptions: 512,
  mediaSubscriptions: 16,
  messageBytes: 64 * 1024,
  operationsPerSecond: 10,
  opensPerSecond: 2,
  batch: 64,
} as const;

export const APP_RTC_QUALITIES = ["high", "medium", "low"] as const;
export type AppRtcQuality = (typeof APP_RTC_QUALITIES)[number];
export const APP_RTC_SIMULCAST_LAYERS: ReadonlyArray<{ rid: string; quality: AppRtcQuality; scaleResolutionDownBy: number }> = [
  { rid: "f", quality: "high", scaleResolutionDownBy: 1 },
  { rid: "h", quality: "medium", scaleResolutionDownBy: 2 },
  { rid: "q", quality: "low", scaleResolutionDownBy: 4 },
];
export const appRtcQualityRid = (quality: AppRtcQuality) =>
  APP_RTC_SIMULCAST_LAYERS.find((layer) => layer.quality === quality)?.rid ?? "f";

export const appRtcPublicationSchema = z.object({
  id: z.string().min(1).max(32),
  name: z.string().regex(APP_RTC_NAME_PATTERN),
  kind: z.enum(APP_RTC_PUBLICATION_KINDS),
  delivery: z.enum(APP_RTC_DELIVERIES).optional(),
  simulcast: z.boolean().optional(),
});
export type AppRtcPublication = z.infer<typeof appRtcPublicationSchema>;

const nameSchema = z.string().refine(isAppRtcName, "invalid name");
const participantIdSchema = z.string().uuid();

export const appRtcOpenRequestSchema = z.object({
  ticket: z.string().min(1).max(4096),
  participantId: participantIdSchema,
});
export type AppRtcOpenRequest = z.infer<typeof appRtcOpenRequestSchema>;

export type AppRtcOpenResponse = {
  sessionId: string;
  offer: SessionDescription;
  iceServers: RtcIceServer[];
};

export const appRtcAnswerRequestSchema = z.object({
  answer: sessionDescriptionSchema.refine((value) => value.type === "answer", "expected an answer"),
});

export const appRtcPublishRequestSchema = z.union([
  z.object({
    channels: z
      .array(z.object({ name: nameSchema, delivery: z.enum(APP_RTC_DELIVERIES) }))
      .min(1)
      .max(APP_RTC_LIMITS.channelsPerMember),
  }),
  z.object({
    offer: sessionDescriptionSchema.refine((value) => value.type === "offer", "expected an offer"),
    tracks: z
      .array(z.object({
        name: nameSchema,
        kind: z.enum(["audio", "video"]),
        mid: z.string().min(1).max(32),
        simulcast: z.boolean().optional(),
      }))
      .min(1)
      .max(APP_RTC_LIMITS.tracksPerMember),
  }),
]);
export type AppRtcPublishRequest = z.infer<typeof appRtcPublishRequestSchema>;

export type AppRtcPublishResponse = {
  publications: AppRtcPublication[];
  channelIds?: Record<string, number>;
  answer?: SessionDescription;
};

export const appRtcUnpublishRequestSchema = z.object({
  ids: z.array(z.string().min(1).max(32)).min(1).max(APP_RTC_LIMITS.channelsPerMember + APP_RTC_LIMITS.tracksPerMember),
  offer: sessionDescriptionSchema.refine((value) => value.type === "offer", "expected an offer").optional(),
});

export type AppRtcUnpublishResponse = { answer?: SessionDescription };

const subscriptionRefSchema = z.object({ participantId: participantIdSchema, publicationId: z.string().min(1).max(32) });
export type AppRtcSubscriptionRef = z.infer<typeof subscriptionRefSchema>;

const qualitySchema = z.enum(APP_RTC_QUALITIES);

export const appRtcSubscribeRequestSchema = z.object({
  kind: z.enum(["data", "media"]),
  items: z.array(subscriptionRefSchema.extend({ quality: qualitySchema.optional() })).min(1).max(APP_RTC_LIMITS.batch),
});

export type AppRtcSubscribeResponse = {
  subscriptions: Array<AppRtcSubscriptionRef & { channelId?: number; mid?: string }>;
  offer?: SessionDescription;
};

export const appRtcMediaUpdateRequestSchema = z.object({
  items: z
    .array(subscriptionRefSchema.extend({ mid: z.string().min(1).max(32), quality: qualitySchema.optional() }))
    .min(1)
    .max(APP_RTC_LIMITS.mediaSubscriptions),
});
export type AppRtcMediaUpdateRequest = z.infer<typeof appRtcMediaUpdateRequestSchema>;

export type AppRtcMediaUpdateResponse = {
  updated: Array<AppRtcSubscriptionRef & { mid: string }>;
  offer?: SessionDescription;
};

export const appRtcUnsubscribeRequestSchema = z.object({
  items: z.array(subscriptionRefSchema).min(1).max(APP_RTC_LIMITS.batch),
  offer: sessionDescriptionSchema.refine((value) => value.type === "offer", "expected an offer").optional(),
});

export type AppRtcUnsubscribeResponse = { answer?: SessionDescription };

export type AppRtcCloseReason = "closed" | "replaced" | "stale" | "expired";
