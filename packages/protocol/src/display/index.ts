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

const unit = z.number().min(0).max(1);

export const DISPLAY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
export const displayIdSchema = z.string().regex(DISPLAY_ID_PATTERN);

export const DISPLAY_SYSTEM_ACTIONS = ["back", "home", "recents", "notifications", "quickSettings", "lock"] as const;
export type DisplaySystemAction = (typeof DISPLAY_SYSTEM_ACTIONS)[number];
export const DISPLAY_PERMISSIONS = ["screenRecording", "accessibility"] as const;
export type DisplayPermission = (typeof DISPLAY_PERMISSIONS)[number];

/** A list of known names; names a newer machine adds are dropped, so older clients keep working. */
const knownNames = <T extends string>(names: readonly T[], max: number) =>
  z
    .array(z.string().max(32))
    .max(max)
    .transform((values) => values.filter((value): value is T => (names as readonly string[]).includes(value)));

export const displayInfoSchema = z.object({
  id: displayIdSchema,
  name: z.string().max(200),
  width: z.number().int().min(0).max(16_384),
  height: z.number().int().min(0).max(16_384),
  stream: z.boolean(),
  capture: z.boolean(),
  input: z.boolean(),
  system: knownNames(DISPLAY_SYSTEM_ACTIONS, 16).optional(),
  desktop: z.boolean().optional(),
  tree: z.boolean().optional(),
  needs: knownNames(DISPLAY_PERMISSIONS, 8).optional(),
});
export type DisplayInfo = z.infer<typeof displayInfoSchema>;

export const DISPLAYS_MAX = 16;
export const displaysSnapshotSchema = z.object({
  displays: z.array(displayInfoSchema).max(DISPLAYS_MAX),
});
export type DisplaysSnapshot = z.infer<typeof displaysSnapshotSchema>;

export type DisplayVirtualState = "available" | "running";
export type DisplayList = { displays: DisplayInfo[]; virtual?: DisplayVirtualState };

export const DISPLAY_VIRTUAL_SIZE_PATTERN = /^\d{3,4}x\d{3,4}$/;
export const displayVirtualStartSchema = z.object({
  size: z.string().regex(DISPLAY_VIRTUAL_SIZE_PATTERN).optional(),
});
export type DisplayVirtualStart = z.infer<typeof displayVirtualStartSchema>;

export const DISPLAY_ELEMENT_ROLES = [
  "window", "dialog", "group", "list", "listItem", "text", "heading", "image", "button", "link",
  "textField", "checkbox", "radio", "switch", "slider", "tab", "menu", "menuItem", "web", "other",
] as const;
export type DisplayElementRole = (typeof DISPLAY_ELEMENT_ROLES)[number];
export const DISPLAY_ELEMENT_STATES = ["focused", "selected", "checked", "disabled", "editable", "password", "scrollable", "expanded"] as const;
export type DisplayElementState = (typeof DISPLAY_ELEMENT_STATES)[number];
export const DISPLAY_ELEMENT_ACTIONS = ["click", "longPress", "focus", "setText", "scrollForward", "scrollBackward"] as const;
export type DisplayElementAction = (typeof DISPLAY_ELEMENT_ACTIONS)[number];

export const DISPLAY_ELEMENT_REF_PATTERN = /^e\d{1,9}\.\d{1,5}$/;
export const DISPLAY_TREE_MAX_ELEMENTS = 1_000;
export const DISPLAY_ELEMENT_TEXT_MAX = 500;

export const displayElementSchema = z.object({
  ref: z.string().regex(DISPLAY_ELEMENT_REF_PATTERN),
  depth: z.number().int().min(0).max(64),
  role: z
    .string()
    .max(32)
    .transform((role): DisplayElementRole => ((DISPLAY_ELEMENT_ROLES as readonly string[]).includes(role) ? (role as DisplayElementRole) : "other")),
  name: z.string().max(DISPLAY_ELEMENT_TEXT_MAX).optional(),
  /** The current text of a field; never reported for passwords. */
  value: z.string().max(DISPLAY_ELEMENT_TEXT_MAX).optional(),
  bounds: z.tuple([unit, unit, unit, unit]),
  states: knownNames(DISPLAY_ELEMENT_STATES, 16).optional(),
  actions: knownNames(DISPLAY_ELEMENT_ACTIONS, 16).optional(),
});
export type DisplayElement = z.infer<typeof displayElementSchema>;

export const displayTreeParamsSchema = z.object({
  maxElements: z.number().int().min(1).max(DISPLAY_TREE_MAX_ELEMENTS).optional(),
});
export type DisplayTreeParams = z.infer<typeof displayTreeParamsSchema>;

export const displayTreeSchema = z.object({
  width: z.number().int().min(0).max(16_384),
  height: z.number().int().min(0).max(16_384),
  elements: z.array(displayElementSchema).max(DISPLAY_TREE_MAX_ELEMENTS),
  truncated: z.boolean().optional(),
});
export type DisplayTree = z.infer<typeof displayTreeSchema>;

export const DISPLAY_INPUT_MAX_EVENTS = 512;
export const DISPLAY_INPUT_MAX_TEXT = 4_096;
export const DISPLAY_INPUT_MAX_SCHEDULE_MS = 60_000;

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
  z.object({
    type: z.literal("element"),
    ref: z.string().regex(DISPLAY_ELEMENT_REF_PATTERN),
    action: z.enum(DISPLAY_ELEMENT_ACTIONS),
    text: z.string().max(DISPLAY_INPUT_MAX_TEXT).optional(),
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
      if (event.type === "element" && (event.action === "setText") !== (event.text !== undefined)) {
        ctx.addIssue({ code: "custom", path: ["events", index, "text"], message: "text goes with setText only" });
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

export type DisplayViewerMessage = { type: "ping"; id: number } | { type: "keyframe" } | { type: "pause" } | { type: "resume" };

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
