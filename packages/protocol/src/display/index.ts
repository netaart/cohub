import { z } from "zod";

export * from "./actions.js";

/**
 * Displays: a machine's screens, shared with people over WebRTC and with
 * agents as stills and input. Mirrored in Go by `apps/sandbox/display` and
 * `apps/sandbox/rtc`, and in Kotlin by the Android display provider.
 *
 * Coordinates are normalized to the display (0..1, origin top-left), so
 * viewers and agents never need its pixel size to act on it.
 */

export const DISPLAY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
export const displayIdSchema = z.string().regex(DISPLAY_ID_PATTERN);

export const DISPLAY_SYSTEM_ACTIONS = ["back", "home", "recents", "notifications", "quickSettings", "lock"] as const;
export type DisplaySystemAction = (typeof DISPLAY_SYSTEM_ACTIONS)[number];
const isSystemAction = (action: string): action is DisplaySystemAction => (DISPLAY_SYSTEM_ACTIONS as readonly string[]).includes(action);

export const displayInfoSchema = z.object({
  id: displayIdSchema,
  name: z.string().max(200),
  width: z.number().int().min(0).max(16_384),
  height: z.number().int().min(0).max(16_384),
  stream: z.boolean(),
  capture: z.boolean(),
  input: z.boolean(),
  /** System buttons it has, e.g. a phone's back and home; names a newer machine adds are dropped. */
  system: z
    .array(z.string().max(32))
    .max(16)
    .transform((actions) => actions.filter(isSystemAction))
    .optional(),
  desktop: z.boolean().optional(),
});
export type DisplayInfo = z.infer<typeof displayInfoSchema>;

export const DISPLAYS_MAX = 16;
export const displaysSnapshotSchema = z.object({
  displays: z.array(displayInfoSchema).max(DISPLAYS_MAX),
});
export type DisplaysSnapshot = z.infer<typeof displaysSnapshotSchema>;

export const DISPLAY_INPUT_MAX_EVENTS = 512;
export const DISPLAY_INPUT_MAX_TEXT = 4_096;
export const DISPLAY_INPUT_MAX_SCHEDULE_MS = 60_000;

const unit = z.number().min(0).max(1);
const delta = z.number().min(-10).max(10);
const at = z.number().int().min(0).max(DISPLAY_INPUT_MAX_SCHEDULE_MS).optional();

export const displayInputEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("pointer"),
    action: z.enum(["down", "move", "up", "cancel"]),
    x: unit,
    y: unit,
    button: z.enum(["primary", "secondary", "middle"]).optional(),
    t: at,
  }),
  z.object({
    type: z.literal("scroll"),
    x: unit,
    y: unit,
    dx: delta.optional(),
    dy: delta.optional(),
    t: at,
  }),
  z.object({
    type: z.literal("key"),
    action: z.enum(["down", "up", "press"]),
    key: z.string().min(1).max(64),
    t: at,
  }),
  z.object({
    type: z.literal("text"),
    text: z.string().min(1).max(DISPLAY_INPUT_MAX_TEXT),
    t: at,
  }),
  z.object({
    type: z.literal("system"),
    action: z.enum(DISPLAY_SYSTEM_ACTIONS),
    t: at,
  }),
]);
export type DisplayInputEvent = z.infer<typeof displayInputEventSchema>;

export const displayInputBatchSchema = z
  .object({
    events: z.array(displayInputEventSchema).min(1).max(DISPLAY_INPUT_MAX_EVENTS),
  })
  .superRefine(({ events }, ctx) => {
    let last = 0;
    events.forEach((event, index) => {
      if (event.type === "scroll" && !event.dx && !event.dy) {
        ctx.addIssue({ code: "custom", path: ["events", index], message: "scroll needs dx or dy" });
      }
      if (event.t === undefined) return;
      if (event.t < last) ctx.addIssue({ code: "custom", path: ["events", index, "t"], message: "t must ascend" });
      last = event.t;
    });
  });
export type DisplayInputBatch = z.infer<typeof displayInputBatchSchema>;

export const displayCaptureParamsSchema = z.object({
  format: z.enum(["jpeg", "png"]).optional(),
  quality: z.number().int().min(1).max(100).optional(),
  maxSize: z.number().int().min(1).max(16_384).optional(),
});
export type DisplayCaptureParams = z.infer<typeof displayCaptureParamsSchema>;

export type DisplayCapture = {
  mimeType: "image/jpeg" | "image/png";
  data: string;
  width: number;
  height: number;
};

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

export const DISPLAY_SESSION_OFFER_MAX = 64 * 1024;

export const displaySessionRequestSchema = z.object({
  offer: z.string().min(1).max(DISPLAY_SESSION_OFFER_MAX),
  control: z.boolean().optional(),
});
export type DisplaySessionRequest = z.infer<typeof displaySessionRequestSchema>;

export type DisplaySession = {
  sessionId: string;
  answer: string;
};

export const DISPLAY_CONTROL_CHANNEL = "control";
export const DISPLAY_INPUT_CHANNEL = "input";
export const DISPLAY_PING_INTERVAL_MS = 5_000;

export const DISPLAY_SESSION_CLOSE_REASONS = [
  "closed",
  "display_ended",
  "connect_timeout",
  "idle",
  "failed",
  "expired",
  "shutdown",
] as const;
export type DisplaySessionCloseReason = (typeof DISPLAY_SESSION_CLOSE_REASONS)[number];

export type DisplayControlMessage =
  | { type: "ready"; display: DisplayInfo; control: boolean }
  | { type: "display"; display: DisplayInfo }
  | { type: "pong"; id: number }
  | { type: "closed"; reason: DisplaySessionCloseReason | (string & {}) }
  | { type: "error"; code: string; message: string };

export type DisplayViewerMessage = { type: "ping"; id: number } | { type: "keyframe" };

export function normalizeDisplayPoint(x: number, y: number, width: number, height: number): { x: number; y: number } {
  const unit = (value: number, extent: number) => Math.min(1, Math.max(0, extent > 1 ? value / (extent - 1) : 0));
  return { x: unit(x, width), y: unit(y, height) };
}

export function splitDisplayText(text: string, max = DISPLAY_INPUT_MAX_TEXT): string[] {
  const pieces: string[] = [];
  let piece = "";
  for (const char of text) {
    if (piece.length + char.length > max) {
      pieces.push(piece);
      piece = "";
    }
    piece += char;
  }
  if (piece) pieces.push(piece);
  return pieces;
}
