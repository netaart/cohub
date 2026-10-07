import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  compileDisplayActions,
  DISPLAY_ACTION_TYPES,
  DISPLAY_SYSTEM_ACTIONS,
  DisplayActionError,
  type DisplayCapture,
  type DisplayInfo,
  type DisplayInputEvent,
} from "@cohub/protocol/display";
import { createToolFailure } from "../runtime/tools/index.js";
import { AGENT_IMAGE_MAX_EDGE, imageOmittedText, normalizeAgentImage } from "../image-normalizer.js";

export type DisplayRpc = {
  list(): Promise<DisplayInfo[]>;
  capture(display: string, maxSize: number): Promise<DisplayCapture>;
  input(display: string, events: DisplayInputEvent[]): Promise<void>;
};

export type DisplayToolContext = {
  scope: () => string;
  rpc: () => Promise<DisplayRpc>;
};

const DEFAULT_MAX_SIZE = 1280;
const SETTLE_MS = 600;
const MAX_REMEMBERED = 1_000;

const actionSchema = Type.Object({
  type: Type.Union(DISPLAY_ACTION_TYPES.map((type) => Type.Literal(type)), {
    description: "tap, long_press and swipe touch the screen (on a desktop, tap clicks); scroll moves content; type enters text into the focused field; key presses a key or shortcut (Enter, Backspace, Control+a…); system presses a system button the display has, such as back or home; wait pauses.",
  }),
  x: Type.Optional(Type.Number({ description: "Pixel x in the latest screenshot (tap, long_press, swipe start, scroll)" })),
  y: Type.Optional(Type.Number({ description: "Pixel y in the latest screenshot" })),
  to_x: Type.Optional(Type.Number({ description: "swipe: pixel x where the finger lifts" })),
  to_y: Type.Optional(Type.Number({ description: "swipe: pixel y where the finger lifts" })),
  direction: Type.Optional(Type.Union([Type.Literal("up"), Type.Literal("down"), Type.Literal("left"), Type.Literal("right")], { description: "scroll: which way the content moves into view; down reveals what is below" })),
  amount: Type.Optional(Type.Number({ description: "scroll: fraction of the screen, 0.1–1 (default 0.5)" })),
  duration_ms: Type.Optional(Type.Number({ description: "long_press, swipe or wait duration in milliseconds" })),
  count: Type.Optional(Type.Number({ description: "tap: 2 to double-click, 3 to triple-click" })),
  button: Type.Optional(Type.Union([Type.Literal("primary"), Type.Literal("secondary"), Type.Literal("middle")], { description: "tap on a desktop: secondary right-clicks" })),
  text: Type.Optional(Type.String({ description: "type: the text to enter" })),
  key: Type.Optional(Type.String({ description: "key: a KeyboardEvent key name such as Enter, or a shortcut such as Control+c or Meta+Shift+z (desktops)" })),
  action: Type.Optional(Type.Union(DISPLAY_SYSTEM_ACTIONS.map((action) => Type.Literal(action)))),
});

const screenshotSchema = Type.Object({
  display: Type.Optional(Type.String({ description: "Display id; defaults to the only shared display" })),
  max_size: Type.Optional(Type.Number({ description: `Longest edge in pixels, up to ${AGENT_IMAGE_MAX_EDGE} (default ${DEFAULT_MAX_SIZE})` })),
});

const inputSchema = Type.Object({
  display: Type.Optional(Type.String({ description: "Display id; defaults to the only shared display" })),
  actions: Type.Array(actionSchema, { minItems: 1, maxItems: 50 }),
  screenshot: Type.Optional(Type.Boolean({ description: "Return a screenshot after the actions (default true)" })),
});

const lastSize = new Map<string, { width: number; height: number }>();

function remember(key: string, size: { width: number; height: number }) {
  lastSize.delete(key);
  lastSize.set(key, size);
  if (lastSize.size > MAX_REMEMBERED) lastSize.delete(lastSize.keys().next().value as string);
}

async function resolveDisplay(rpc: DisplayRpc, requested: string | undefined): Promise<DisplayInfo> {
  const displays = await rpc.list();
  if (requested) {
    const found = displays.find((display) => display.id === requested);
    if (!found) throw new DisplayActionError(`display "${requested}" is not shared; shared displays: ${displays.map((display) => display.id).join(", ") || "none"}`);
    return found;
  }
  if (displays.length === 1 && displays[0]) return displays[0];
  if (displays.length === 0) throw new DisplayActionError("no display is shared with this Space; ask the user to share their phone screen from the Runtime menu, or a computer screen with `cohub runtime up --display`");
  throw new DisplayActionError(`several displays are shared; pass display as one of: ${displays.map((display) => display.id).join(", ")}`);
}

async function screenshotContent(context: DisplayToolContext, rpc: DisplayRpc, display: DisplayInfo, maxSize: number) {
  const capture = await rpc.capture(display.id, maxSize);
  const image = await normalizeAgentImage({ data: Buffer.from(capture.data, "base64"), mimeType: capture.mimeType, sourceKind: "tool_result", label: display.name, originalSource: "file" });
  if (!image) throw new DisplayActionError(imageOmittedText("the screenshot could not be processed", display.name));
  // Coordinates refer to the image the model sees, which may be smaller than the capture.
  const size = {
    width: Number(image.meta.normalizedWidth) || capture.width,
    height: Number(image.meta.normalizedHeight) || capture.height,
  };
  remember(`${context.scope()}:${display.id}`, size);
  const kind = display.desktop
    ? "A desktop: tap clicks, and key takes shortcuts."
    : `A touch screen${display.system?.length ? ` with system buttons ${display.system.join(", ")}` : ""}.`;
  const control = display.input ? "Act on it with display_input in these pixel coordinates." : "It is view only: the user has not allowed control.";
  return [
    { type: "text" as const, text: `Screenshot of ${display.name || display.id} (display "${display.id}"), ${size.width}×${size.height}. ${kind} ${control}` },
    { type: "image" as const, data: image.data, mimeType: image.mimeType },
  ];
}

function failure(error: unknown) {
  if (!(error instanceof DisplayActionError)) throw error;
  return { content: [{ type: "text" as const, text: error.message }], details: createToolFailure(error.message) };
}

export function createDisplayTools(context: DisplayToolContext): AgentTool[] {
  const screenshot: AgentTool = {
    name: "display_screenshot",
    label: "Screenshot",
    description: "Take a screenshot of a display shared with this Space, such as the user's phone or computer. Call it before acting, and again whenever you are unsure what the screen shows.",
    parameters: screenshotSchema,
    async execute(_toolCallId, rawParams) {
      const params = rawParams as Static<typeof screenshotSchema>;
      try {
        const rpc = await context.rpc();
        const display = await resolveDisplay(rpc, params.display);
        const maxSize = Math.round(Math.min(AGENT_IMAGE_MAX_EDGE, Math.max(256, params.max_size ?? DEFAULT_MAX_SIZE)));
        return { content: await screenshotContent(context, rpc, display, maxSize), details: undefined };
      } catch (error) {
        return failure(error);
      }
    },
  };

  const input: AgentTool = {
    name: "display_input",
    label: "Display input",
    description: "Act on a shared display: tap or click, long press, swipe, scroll, type, press keys, shortcuts or system buttons, in the pixel coordinates of your latest display_screenshot. Actions run in order; the result shows the screen afterwards.",
    parameters: inputSchema,
    async execute(_toolCallId, rawParams) {
      const params = rawParams as Static<typeof inputSchema>;
      try {
        const rpc = await context.rpc();
        const display = await resolveDisplay(rpc, params.display);
        if (!display.input) throw new DisplayActionError("this display is view only; ask the user to allow control on the device");
        const size = lastSize.get(`${context.scope()}:${display.id}`);
        if (!size) throw new DisplayActionError("take a display_screenshot first, so coordinates refer to what you saw");
        const events = compileDisplayActions(params.actions, size.width, size.height);
        await rpc.input(display.id, events);
        const text = { type: "text" as const, text: `Performed ${params.actions.length} action${params.actions.length === 1 ? "" : "s"}.` };
        if (params.screenshot === false) return { content: [text], details: undefined };
        await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
        return { content: [text, ...(await screenshotContent(context, rpc, display, Math.max(size.width, size.height)))], details: undefined };
      } catch (error) {
        return failure(error);
      }
    },
  };

  return [screenshot, input];
}

export const DISPLAY_TOOL_NAMES = new Set(["display_screenshot", "display_input"]);
