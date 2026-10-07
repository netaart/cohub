import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  compileDisplayActions,
  DISPLAY_SYSTEM_ACTIONS,
  DisplayActionError,
  type DisplayAction,
  type DisplayInfo,
} from "@neta-art/cohub";
import type { Command } from "commander";
import { createClient } from "../client.js";
import { error, handleHttp, json as outJson, jsonRequested, ok, table } from "../output.js";
import { resolveSpace } from "../space.js";

type TargetOptions = { display?: string; size?: string };

const DIRECTIONS = ["up", "down", "left", "right"] as const;
const BUTTONS = ["primary", "secondary", "middle"] as const;

function parseSize(value: string): { width: number; height: number } {
  const match = /^(\d{1,5})x(\d{1,5})$/i.exec(value.trim());
  const width = Number(match?.[1]);
  const height = Number(match?.[2]);
  if (!match || width < 1 || height < 1) return error("Invalid size", "Use WIDTHxHEIGHT, e.g. 576x1280.");
  return { width, height };
}

function parseNumber(name: string, value: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return error(`Invalid ${name}`, `${name} must be a number.`);
  return number;
}

function pickDisplay(displays: DisplayInfo[], requested: string | undefined): DisplayInfo {
  if (requested) {
    const found = displays.find((display) => display.id === requested);
    if (!found) return error(`Display "${requested}" is not shared`, `Shared displays: ${displays.map((display) => display.id).join(", ") || "none"}`);
    return found;
  }
  if (displays.length === 1 && displays[0]) return displays[0];
  if (displays.length === 0) return error("No display is shared with this Space", "Share a screen from the device's Runtime menu first.");
  return error("Several displays are shared", `Pass --display with one of: ${displays.map((display) => display.id).join(", ")}`);
}

async function target(spacesCmd: Command, opts: TargetOptions) {
  const spaceId = await resolveSpace(spacesCmd);
  const api = createClient().space(spaceId).displays;
  const { displays } = await api.list();
  return { api, display: pickDisplay(displays, opts.display) };
}

async function act(spacesCmd: Command, opts: TargetOptions & { json?: boolean }, actions: DisplayAction[]) {
  try {
    const { api, display } = await target(spacesCmd, opts);
    if (!display.input) return error("This display is view only", "Allow control on the device first.");
    const size = opts.size ? parseSize(opts.size) : { width: display.width, height: display.height };
    const events = compileDisplayActions(actions, size.width, size.height);
    const result = await api.input(display.id, events);
    if (jsonRequested(opts)) return outJson({ display: display.id, ...result });
    ok(`Performed ${actions.length} action${actions.length === 1 ? "" : "s"} on ${display.name || display.id}`);
  } catch (e: unknown) {
    if (e instanceof DisplayActionError) return error("Invalid action", e.message);
    handleHttp(e);
  }
}

function withTarget(command: Command): Command {
  return command
    .option("-d, --display <id>", "Display id; defaults to the only shared display")
    .option("--size <WxH>", "Coordinates are pixels of an image this size, e.g. a screenshot")
    .option("--json", "Output as JSON");
}

export function registerSpaceDisplays(spacesCmd: Command): void {
  const displays = spacesCmd
    .command("displays")
    .description("Screens shared with a Space: view, capture and control")
    .hook("preAction", async () => { await resolveSpace(spacesCmd); });

  displays
    .command("ls")
    .alias("list")
    .description("List shared displays")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const spaceId = await resolveSpace(spacesCmd);
        const result = await createClient().space(spaceId).displays.list();
        if (jsonRequested(opts)) return outJson(result);
        if (result.displays.length === 0) {
          console.log("  (no shared displays)");
          return;
        }
        table(
          result.displays.map((display) => ({
            ...display,
            size: `${display.width}x${display.height}`,
            abilities: [display.stream && "view", display.capture && "capture", display.input && "control", display.desktop && "desktop"].filter(Boolean).join(", "),
          })),
          [
            { key: "id", label: "ID" },
            { key: "name", label: "Name" },
            { key: "size", label: "Size" },
            { key: "abilities", label: "Abilities" },
          ],
        );
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  displays
    .command("capture")
    .description("Save a screenshot")
    .option("-d, --display <id>", "Display id; defaults to the only shared display")
    .option("-o, --output <path>", "Where to write the image (default: <display>-<time>.<ext>)")
    .option("--max-size <px>", "Longest edge in pixels")
    .option("--png", "PNG instead of JPEG")
    .option("--json", "Output as JSON")
    .action(async (opts: { display?: string; output?: string; maxSize?: string; png?: boolean; json?: boolean }) => {
      try {
        const { api, display } = await target(spacesCmd, opts);
        const capture = await api.capture(display.id, {
          format: opts.png ? "png" : "jpeg",
          ...(opts.maxSize ? { maxSize: parseNumber("max-size", opts.maxSize) } : {}),
        });
        const extension = capture.mimeType === "image/png" ? "png" : "jpg";
        const path = resolve(opts.output ?? `${display.id}-${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`);
        await writeFile(path, Buffer.from(capture.data, "base64"));
        if (jsonRequested(opts)) return outJson({ path, display: display.id, mimeType: capture.mimeType, width: capture.width, height: capture.height });
        ok(`Saved ${capture.width}x${capture.height} screenshot to ${path}`);
        console.log(`  Pass --size ${capture.width}x${capture.height} to act in its pixels.`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  withTarget(displays.command("tap <x> <y>").description("Tap or click a point"))
    .option("--count <n>", "2 to double-click, 3 to triple-click")
    .option("--button <button>", `Mouse button on a desktop: ${BUTTONS.join(", ")}`)
    .action((x: string, y: string, opts: TargetOptions & { count?: string; button?: string }) => {
      const button = BUTTONS.find((candidate) => candidate === (opts.button ?? "primary"));
      if (!button) return error("Invalid button", `Use one of: ${BUTTONS.join(", ")}`);
      return act(spacesCmd, opts, [{
        type: "tap", x: parseNumber("x", x), y: parseNumber("y", y), button,
        ...(opts.count ? { count: parseNumber("count", opts.count) } : {}),
      }]);
    });

  withTarget(displays.command("long-press <x> <y>").description("Touch and hold a point"))
    .option("--duration <ms>", "Hold time in milliseconds", "800")
    .action((x: string, y: string, opts: TargetOptions & { duration: string }) =>
      act(spacesCmd, opts, [{ type: "long_press", x: parseNumber("x", x), y: parseNumber("y", y), duration_ms: parseNumber("duration", opts.duration) }]));

  withTarget(displays.command("swipe <x1> <y1> <x2> <y2>").description("Swipe from one point to another"))
    .option("--duration <ms>", "Swipe time in milliseconds", "300")
    .action((x1: string, y1: string, x2: string, y2: string, opts: TargetOptions & { duration: string }) =>
      act(spacesCmd, opts, [{
        type: "swipe",
        x: parseNumber("x1", x1), y: parseNumber("y1", y1),
        to_x: parseNumber("x2", x2), to_y: parseNumber("y2", y2),
        duration_ms: parseNumber("duration", opts.duration),
      }]));

  withTarget(displays.command("scroll <direction>").description("Scroll content up, down, left or right"))
    .option("--amount <fraction>", "Fraction of the display, 0.1–1", "0.5")
    .action((direction: string, opts: TargetOptions & { amount: string }) => {
      if (!(DIRECTIONS as readonly string[]).includes(direction)) return error("Invalid direction", `Use one of: ${DIRECTIONS.join(", ")}`);
      return act(spacesCmd, opts, [{ type: "scroll", direction: direction as (typeof DIRECTIONS)[number], amount: parseNumber("amount", opts.amount) }]);
    });

  withTarget(displays.command("type <text>").description("Type text into the focused field"))
    .action((text: string, opts: TargetOptions) => act(spacesCmd, opts, [{ type: "type", text }]));

  withTarget(displays.command("key <key>").description("Press a key or shortcut, e.g. Enter or Control+a"))
    .action((key: string, opts: TargetOptions) => act(spacesCmd, opts, [{ type: "key", key }]));

  withTarget(displays.command("press <button>").description(`Press a system button: ${DISPLAY_SYSTEM_ACTIONS.join(", ")}`))
    .action((button: string, opts: TargetOptions) => {
      const action = DISPLAY_SYSTEM_ACTIONS.find((candidate) => candidate === button);
      if (!action) return error("Invalid button", `Use one of: ${DISPLAY_SYSTEM_ACTIONS.join(", ")}`);
      return act(spacesCmd, opts, [{ type: "system", action }]);
    });

  withTarget(displays.command("act").description("Run a JSON array of actions from --actions or stdin"))
    .option("--actions <json>", "Actions, e.g. '[{\"type\":\"tap\",\"x\":540,\"y\":1200}]'")
    .action(async (opts: TargetOptions & { actions?: string }) => {
      let raw = opts.actions ?? "";
      if (!raw && !process.stdin.isTTY) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
        raw = Buffer.concat(chunks).toString();
      }
      let actions: unknown;
      try {
        actions = JSON.parse(raw);
      } catch {
        return error("Invalid actions", "Pass a JSON array with --actions or on stdin.");
      }
      if (!Array.isArray(actions) || actions.length === 0) return error("Invalid actions", "Pass a non-empty JSON array.");
      return act(spacesCmd, opts, actions as DisplayAction[]);
    });
}
