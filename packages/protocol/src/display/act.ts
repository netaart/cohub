import * as z from "zod";
import {
  DISPLAY_ELEMENT_ACTIONS,
  DISPLAY_ELEMENT_REF_PATTERN,
  DISPLAY_ELEMENT_ROLES,
  DISPLAY_ELEMENT_TEXT_MAX,
  DISPLAY_INPUT_MAX_EVENTS,
  DISPLAY_INPUT_MAX_TEXT,
  DISPLAY_LABEL_MAX,
  DISPLAY_TREE_MAX_ELEMENTS,
  DISPLAY_DIMENSION_MAX,
  type DisplayCapture,
  type DisplayElement,
  type DisplayPointerKind,
  type DisplayRecorder,
  type DisplayTree,
  displayInputBatchSchema,
  displayInputEventSchema,
  displayWindowIdSchema,
} from "./schema.js";

export const DISPLAY_ACT_MAX_STEPS = 32;
export const DISPLAY_ACT_MAX_MS = 90_000;
export const DISPLAY_UNTIL_DEFAULT_MS = 8_000;
export const DISPLAY_UNTIL_MAX_MS = 30_000;
export const DISPLAY_WAIT_MAX_MS = 10_000;
export const DISPLAY_ACT_CANDIDATES_MAX = 8;
export const DISPLAY_TARGET_NTH_MAX = 50;
export const DISPLAY_URL_MAX = 2_048;
export const DISPLAY_APPS_MAX = 2_000;
export const DISPLAY_HANDOVER_DEFAULT_MS = 10 * 60_000;
export const DISPLAY_HANDOVER_MAX_MS = 12 * 60 * 60_000;
export const DISPLAY_HANDOVER_WAIT_MS = 25_000;

export const DISPLAY_APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
export const DISPLAY_ACTOR_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const DISPLAY_URL_BLOCKED_SCHEMES = ["file", "content", "data", "javascript", "intent"] as const;

export const DISPLAY_EFFECTS = ["none", "changed", "navigated"] as const;
export type DisplayEffect = (typeof DISPLAY_EFFECTS)[number];
export const DISPLAY_STOP_NEXTS = ["look", "lookImage", "list"] as const;
export type DisplayStopNext = (typeof DISPLAY_STOP_NEXTS)[number];
export const DISPLAY_ACT_STOPS = ["not_found", "ambiguous", "moved", "timeout", "dialog", "app_changed", "failed", "preempted", "interrupted"] as const;
export type DisplayActStop = (typeof DISPLAY_ACT_STOPS)[number];
export const DISPLAY_HANDOVER_STATES = ["waiting", "returned", "stopped", "expired", "gone"] as const;
export type DisplayHandoverState = (typeof DISPLAY_HANDOVER_STATES)[number];
export const DISPLAY_TREE_QUALITIES = ["good", "poor"] as const;
export type DisplayTreeQuality = (typeof DISPLAY_TREE_QUALITIES)[number];
export const DISPLAY_OBSERVE_TREES = ["compact", "full", "none"] as const;
export const DISPLAY_OBSERVE_IMAGES = ["auto", "always", "never"] as const;

const text = z.string().min(1).max(DISPLAY_ELEMENT_TEXT_MAX);
const appId = z.string().regex(DISPLAY_APP_ID_PATTERN);

export const displayTargetSchema = z
  .object({
    ref: z.string().regex(DISPLAY_ELEMENT_REF_PATTERN).optional(),
    name: text.optional(),
    role: z.enum(DISPLAY_ELEMENT_ROLES).optional(),
    nth: z.number().int().min(1).max(DISPLAY_TARGET_NTH_MAX).optional(),
    scroll: z.literal(true).optional(),
  })
  .refine((target) => (target.ref !== undefined) !== (target.name !== undefined || target.role !== undefined), {
    message: "a target is a ref, or a name and/or role",
  })
  .refine((target) => target.ref === undefined || (target.nth === undefined && target.scroll === undefined), {
    message: "nth and scroll go with a name or role",
  });
export type DisplayTarget = z.infer<typeof displayTargetSchema>;

export const displayUntilSchema = z
  .object({
    text: text.optional(),
    gone: text.optional(),
    app: appId.optional(),
    stable: z.literal(true).optional(),
    timeoutMs: z.number().int().min(1).max(DISPLAY_UNTIL_MAX_MS).optional(),
  })
  .refine((until) => until.text !== undefined || until.gone !== undefined || until.app !== undefined || until.stable, {
    message: "until needs text, gone, app or stable",
  });
export type DisplayUntil = z.infer<typeof displayUntilSchema>;

const stepCommon = {
  until: displayUntilSchema.optional(),
  label: z.string().min(1).max(DISPLAY_LABEL_MAX).optional(),
};

export const displayActStepSchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("element"),
      target: displayTargetSchema,
      action: z.enum(DISPLAY_ELEMENT_ACTIONS),
      text: z.string().max(DISPLAY_INPUT_MAX_TEXT).optional(),
      ...stepCommon,
    }),
    z.object({ type: z.literal("input"), events: z.array(displayInputEventSchema).min(1).max(DISPLAY_INPUT_MAX_EVENTS), ...stepCommon }),
    z.object({ type: z.literal("launch"), app: appId, ...stepCommon }),
    z.object({
      type: z.literal("open"),
      url: z
        .string()
        .max(DISPLAY_URL_MAX)
        .regex(/^[A-Za-z][A-Za-z0-9+.-]*:\S+$/, "open needs a URL with a scheme")
        .refine((url) => !(DISPLAY_URL_BLOCKED_SCHEMES as readonly string[]).includes(url.slice(0, url.indexOf(":")).toLowerCase()), {
          message: "open does not take file, content, data, javascript or intent URLs",
        }),
      ...stepCommon,
    }),
    z.object({ type: z.literal("wait"), ms: z.number().int().min(1).max(DISPLAY_WAIT_MAX_MS).optional(), ...stepCommon }),
  ])
  .superRefine((step, ctx) => {
    if (step.type === "element" && (step.action === "setText") !== (step.text !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["text"], message: "text goes with setText only" });
    }
    if (step.type === "input") {
      const batch = displayInputBatchSchema.safeParse({ events: step.events });
      if (!batch.success) ctx.addIssue({ code: "custom", path: ["events"], message: batch.error.issues[0]?.message ?? "invalid events" });
    }
  });
export type DisplayActStep = z.infer<typeof displayActStepSchema>;

export const displayObserveSchema = z.object({
  tree: z.enum(DISPLAY_OBSERVE_TREES).optional(),
  image: z.enum(DISPLAY_OBSERVE_IMAGES).optional(),
  maxSize: z.number().int().min(1).max(DISPLAY_DIMENSION_MAX).optional(),
  maxElements: z.number().int().min(1).max(DISPLAY_TREE_MAX_ELEMENTS).optional(),
});
export type DisplayObserve = z.infer<typeof displayObserveSchema>;

export const displayActorSchema = z.object({
  sessionId: z.string().regex(DISPLAY_ACTOR_ID_PATTERN),
  turnId: z.string().regex(DISPLAY_ACTOR_ID_PATTERN).optional(),
});
export type DisplayActor = z.infer<typeof displayActorSchema>;

export const displayActParamsSchema = z.object({
  steps: z.array(displayActStepSchema).max(DISPLAY_ACT_MAX_STEPS),
  observe: displayObserveSchema.optional(),
  actor: displayActorSchema.optional(),
  window: displayWindowIdSchema.optional(),
});
export type DisplayActParams = z.infer<typeof displayActParamsSchema>;

export const displayHandoverParamsSchema = z.object({
  id: z.string().regex(DISPLAY_ACTOR_ID_PATTERN),
  reason: z.string().min(1).max(DISPLAY_LABEL_MAX),
  timeoutMs: z.number().int().min(1).max(DISPLAY_HANDOVER_MAX_MS).optional(),
  waitMs: z.number().int().min(0).max(DISPLAY_HANDOVER_WAIT_MS).optional(),
  actor: displayActorSchema.optional(),
});
export type DisplayHandoverParams = z.infer<typeof displayHandoverParamsSchema>;
export type DisplayHandoverResult = { state: DisplayHandoverState; held?: boolean };

export type DisplayStepTarget = Pick<DisplayElement, "role" | "name" | "bounds">;

export type DisplayActStepResult = {
  effect: DisplayEffect;
  target?: DisplayStepTarget;
  readBack?: true;
  findMs: number;
  actMs: number;
  waitedMs: number;
};

export type DisplayScreen = {
  app?: string;
  quality?: DisplayTreeQuality;
  tree?: DisplayTree;
  unchanged?: boolean;
  image?: DisplayCapture;
};

export type DisplayActStopped = {
  step: number;
  reason: DisplayActStop;
  message: string;
  candidates?: DisplayElement[];
  hint?: string;
  next?: DisplayStopNext;
};

export type DisplayActResult = {
  steps: DisplayActStepResult[];
  stopped?: DisplayActStopped;
  screen: DisplayScreen;
  window?: { id: string; bounds: [number, number, number, number] };
};

export const DISPLAY_CACHE_DIR = ".cache/cohub/displays";
export const DISPLAY_TURNS_DIR = `${DISPLAY_CACHE_DIR}/turns`;
export const DISPLAY_RECORDINGS_DIR = `${DISPLAY_CACHE_DIR}/recordings`;

export const displayTurnLogPath = (turnId: string) => `${DISPLAY_TURNS_DIR}/${turnId}.ndjson`;
export const displayRecordingDir = (id: string) => `${DISPLAY_RECORDINGS_DIR}/${id}`;

export type DisplayLoggedStep = {
  type: "element" | "input" | "launch" | "open" | "wait";
  label?: string;
  at: number;
  point?: { x: number; y: number; kind: DisplayPointerKind };
} & DisplayActStepResult;

export type DisplayPlanLog = {
  plan: string;
  display: string;
  sessionId?: string;
  turnId: string;
  at: number;
  endedAt: number;
  width: number;
  height: number;
  steps: DisplayLoggedStep[];
  stopped?: Omit<DisplayActStopped, "candidates">;
  image?: string;
  recording?: string;
};

export type DisplayRecordingMeta = {
  id: string;
  display: string;
  name?: string;
  platform?: string;
  width: number;
  height: number;
  since: number;
  endedAt?: number;
  by?: DisplayRecorder;
  auto?: boolean;
  files: { name: string; at: number; width: number; height: number }[];
  pauses: [number, number | null][];
  turns: string[];
  bytes: number;
  stop?: "stopped" | "limit" | "disk" | "display_ended" | "failed";
};

export type DisplayApp = { id: string; name: string };
export type DisplayApps = { apps: DisplayApp[] };
