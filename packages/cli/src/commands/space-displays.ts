import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  compileDisplayActions,
  DISPLAY_ELEMENT_REF_PATTERN,
  DISPLAY_SYSTEM_ACTIONS,
  DisplayActionError,
  type DisplayAction,
  type DisplayInfo,
  type DisplayTree,
  type SpaceDisplaysApi,
} from "@neta-art/cohub";
import type { Command } from "commander";
import { createClient } from "../client.js";
import { error, handleHttp, json as outJson, jsonRequested, ok, table } from "../output.js";
import { resolveSpace } from "../space.js";
import { webUrl } from "../web.js";

type Size = { width: number; height: number };
type TargetOptions = { display?: string; size?: string; screenshot?: string | boolean; json?: boolean };

const DIRECTIONS = ["up", "down", "left", "right"] as const;
const BUTTONS = ["primary", "secondary", "middle"] as const;
const DEFAULT_MAX_SIZE = 1280;
const SETTLE_MS = 600;
const FRAMES_PATH = join(homedir(), ".cache", "cohub-cli", "display-frames.json");
const NO_DISPLAY_HINT =
  "Share one first: the Android app's Runtime menu, `cohub runtime up --display` on a computer, or `cohub spaces displays start` for a virtual screen.";

function parseSize(value: string): Size {
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

function isRef(value: string) {
  return DISPLAY_ELEMENT_REF_PATTERN.test(value);
}

type Frame = Size & { display: Size };
type Frames = Record<string, Frame>;

async function readFrames(): Promise<Frames> {
  try {
    return JSON.parse(await readFile(FRAMES_PATH, "utf8")) as Frames;
  } catch {
    return {};
  }
}

async function rememberFrame(spaceId: string, display: DisplayInfo, size: Size) {
  const frames = await readFrames();
  frames[`${spaceId}/${display.id}`] = { width: size.width, height: size.height, display: { width: display.width, height: display.height } };
  await mkdir(dirname(FRAMES_PATH), { recursive: true });
  await writeFile(FRAMES_PATH, JSON.stringify(frames));
}

async function frameOf(spaceId: string, display: DisplayInfo, size?: string): Promise<Size> {
  if (size) return parseSize(size);
  const frame = (await readFrames())[`${spaceId}/${display.id}`];
  if (frame && frame.display.width === display.width && frame.display.height === display.height) return frame;
  return { width: display.width, height: display.height };
}

function pickDisplay(displays: DisplayInfo[], requested: string | undefined): DisplayInfo {
  if (requested) {
    const found = displays.find((display) => display.id === requested);
    if (!found) return error(`Display "${requested}" is not shared`, `Shared displays: ${displays.map((display) => display.id).join(", ") || "none"}`);
    return found;
  }
  if (displays.length === 1 && displays[0]) return displays[0];
  if (displays.length === 0) return error("No display is shared with this Space", NO_DISPLAY_HINT);
  return error("Several displays are shared", `Pass --display with one of: ${displays.map((display) => display.id).join(", ")}`);
}

async function target(spacesCmd: Command, opts: { display?: string }) {
  const spaceId = await resolveSpace(spacesCmd);
  const api = createClient().space(spaceId).displays;
  const { displays } = await api.list();
  return { spaceId, api, display: pickDisplay(displays, opts.display) };
}

function displayUrl(spaceId: string, displayId: string) {
  return webUrl(`/spaces/${spaceId}?window=${encodeURIComponent(`display:${displayId}`)}`);
}

function needsHint(display: DisplayInfo) {
  const needs = display.needs ?? [];
  if (needs.length === 0) return null;
  if (!display.desktop) return `${display.name || display.id} needs control: on the phone, choose Allow control in the Space's Runtime menu and enable Cohub in Accessibility settings.`;
  const names = needs.map((need) => (need === "screenRecording" ? "Screen Recording" : "Accessibility")).join(" and ");
  return `${display.name || display.id} needs ${names}: allow it for the Runtime's terminal in System Settings → Privacy & Security, then restart the Runtime.`;
}

async function screenshot(api: SpaceDisplaysApi, spaceId: string, display: DisplayInfo, maxSize: number, output?: string) {
  const capture = await api.capture(display.id, { maxSize });
  const path = resolve(output ?? `${display.id}-${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`);
  await writeFile(path, Buffer.from(capture.data, "base64"));
  await rememberFrame(spaceId, display, capture);
  return { path, width: capture.width, height: capture.height };
}

async function act(spacesCmd: Command, opts: TargetOptions, actions: DisplayAction[]) {
  try {
    const { spaceId, api, display } = await target(spacesCmd, opts);
    if (!display.input) return error("This display is view only", needsHint(display) ?? "Allow control on the device first.");
    const frame = await frameOf(spaceId, display, opts.size);
    const events = compileDisplayActions(actions, frame.width, frame.height);
    const result = await api.input(display.id, events);
    let shot: Awaited<ReturnType<typeof screenshot>> | undefined;
    if (opts.screenshot) {
      await new Promise((done) => setTimeout(done, SETTLE_MS));
      shot = await screenshot(api, spaceId, display, Math.max(frame.width, frame.height), typeof opts.screenshot === "string" ? opts.screenshot : undefined);
    }
    if (jsonRequested(opts)) return outJson({ display: display.id, ...result, frame: { width: frame.width, height: frame.height }, ...(shot ? { screenshot: shot } : {}) });
    ok(`Performed ${actions.length} action${actions.length === 1 ? "" : "s"} on ${display.name || display.id}, in ${frame.width}x${frame.height} pixels`);
    if (shot) console.log(`  Screenshot ${shot.width}x${shot.height}: ${shot.path}`);
  } catch (e: unknown) {
    if (e instanceof DisplayActionError) return error("Invalid action", e.message);
    handleHttp(e);
  }
}

function withTarget(command: Command): Command {
  return command
    .option("-d, --display <id>", "Display id; defaults to the only shared display")
    .option("--size <WxH>", "Coordinates are pixels of an image this size (default: the latest screenshot)")
    .option("--screenshot [path]", "Save a screenshot once the screen settles")
    .option("--json", "Output as JSON");
}

function pointOrRef(x: string, y: string | undefined, command: string): { ref: string } | { x: number; y: number } {
  if (y === undefined) return isRef(x) ? { ref: x } : error("Invalid target", `Pass x and y, or an element ref from \`cohub spaces displays tree\`, e.g. ${command} e3.12.`);
  return { x: parseNumber("x", x), y: parseNumber("y", y) };
}

function formatTree(tree: DisplayTree, frame: Size): string {
  const scaleX = (frame.width - 1) || 1;
  const scaleY = (frame.height - 1) || 1;
  return tree.elements
    .map((element) => {
      const [x, y, width, height] = element.bounds;
      const box = `(${Math.round(x * scaleX)},${Math.round(y * scaleY)} ${Math.round(width * scaleX)}x${Math.round(height * scaleY)})`;
      const parts = [`${"  ".repeat(element.depth)}${element.ref}`, element.role];
      if (element.name) parts.push(JSON.stringify(element.name));
      if (element.value) parts.push(`value=${JSON.stringify(element.value)}`);
      if (element.states?.length) parts.push(`[${element.states.join(", ")}]`);
      parts.push(box);
      return parts.join(" ");
    })
    .join("\n");
}

export function registerSpaceDisplays(spacesCmd: Command): void {
  const displays = spacesCmd
    .command("displays")
    .description("Screens shared with a Space: view, read and control")
    .hook("preAction", async () => { await resolveSpace(spacesCmd); });

  displays
    .command("ls")
    .alias("list")
    .description("List shared displays and who watches them")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const spaceId = await resolveSpace(spacesCmd);
        const result = await createClient().space(spaceId).displays.list();
        if (jsonRequested(opts)) return outJson(result);
        if (result.displays.length === 0) console.log(`  (no shared displays) ${NO_DISPLAY_HINT}`);
        else {
          table(
            result.displays.map((display) => ({
              ...display,
              size: `${display.width}x${display.height}`,
              abilities: [display.stream && "view", display.capture && "capture", display.input && "control", display.tree && "tree", display.desktop && "desktop"].filter(Boolean).join(", "),
              watching: display.viewers?.length ? `${display.viewers.length}${display.viewers.some((viewer) => viewer.control) ? " (controlling)" : ""}` : "—",
            })),
            [
              { key: "id", label: "ID" },
              { key: "name", label: "Name" },
              { key: "size", label: "Size" },
              { key: "abilities", label: "Abilities" },
              { key: "watching", label: "Watching" },
            ],
          );
          for (const display of result.displays) {
            const hint = needsHint(display);
            if (hint) console.log(`  ${hint}`);
          }
        }
        if (result.virtual) console.log(`  Virtual screen: ${result.virtual === "running" ? "running (cohub spaces displays stop)" : "available (cohub spaces displays start)"}`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  displays
    .command("start")
    .description("Start the machine's virtual screen, e.g. in a cloud sandbox")
    .option("--size <WxH>", "Screen size (default 1280x800)")
    .option("--json", "Output as JSON")
    .action(async (opts: { size?: string; json?: boolean }) => {
      try {
        const spaceId = await resolveSpace(spacesCmd);
        if (opts.size) parseSize(opts.size);
        const result = await createClient().space(spaceId).displays.startVirtual(opts.size ? { size: opts.size } : {});
        const url = result.displays[0] ? displayUrl(spaceId, result.displays[0].id) : null;
        if (jsonRequested(opts)) return outJson({ ...result, url });
        ok("Virtual screen running; programs started from now on draw on it");
        if (url) console.log(`  Watch and take over: ${url}`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  displays
    .command("stop")
    .description("Stop the machine's virtual screen")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const spaceId = await resolveSpace(spacesCmd);
        const result = await createClient().space(spaceId).displays.stopVirtual();
        if (jsonRequested(opts)) return outJson(result);
        ok("Virtual screen stopped");
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  displays
    .command("capture")
    .description("Save a screenshot; later coordinates are its pixels")
    .option("-d, --display <id>", "Display id; defaults to the only shared display")
    .option("-o, --output <path>", "Where to write the image (default: <display>-<time>.jpg)")
    .option("--max-size <px>", `Longest edge in pixels (default ${DEFAULT_MAX_SIZE})`)
    .option("--json", "Output as JSON")
    .action(async (opts: { display?: string; output?: string; maxSize?: string; json?: boolean }) => {
      try {
        const { spaceId, api, display } = await target(spacesCmd, opts);
        const maxSize = opts.maxSize ? parseNumber("max-size", opts.maxSize) : DEFAULT_MAX_SIZE;
        const shot = await screenshot(api, spaceId, display, maxSize, opts.output);
        if (jsonRequested(opts)) return outJson({ display: display.id, ...shot });
        ok(`Saved ${shot.width}x${shot.height} screenshot to ${shot.path}`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  displays
    .command("tree")
    .description("Read the interface as elements: refs to act on, roles, names and boxes")
    .option("-d, --display <id>", "Display id; defaults to the only shared display")
    .option("--max <n>", "Most elements to return (default 300)")
    .option("--actionable", "Only elements that take an action, flat: fewer tokens when looking for a target")
    .option("--json", "Output as JSON")
    .action(async (opts: { display?: string; max?: string; actionable?: boolean; json?: boolean }) => {
      try {
        const { spaceId, api, display } = await target(spacesCmd, opts);
        if (!display.tree) return error("This display has no element tree", "Use capture and coordinates instead.");
        const tree = await api.tree(display.id, {
          ...(opts.max ? { maxElements: parseNumber("max", opts.max) } : {}),
          ...(opts.actionable ? { actionable: true } : {}),
        });
        if (jsonRequested(opts)) return outJson(tree);
        const frame = await frameOf(spaceId, display);
        console.log(formatTree(tree, frame));
        console.log(`\n  Boxes are x,y and size in ${frame.width}x${frame.height} pixels. Act with: tap <ref> · type <text> --into <ref> · scroll <direction> --in <ref>`);
        if (tree.truncated) console.log("  More elements exist; pass --max to read more.");
        if (display.viewers?.some((viewer) => viewer.control)) console.log("  A person is watching with control; what you do here pauses while they act.");
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  withTarget(displays.command("tap <x> [y]").description("Tap or click a point, or an element by ref"))
    .option("--count <n>", "2 to double-click, 3 to triple-click")
    .option("--button <button>", `Mouse button on a desktop: ${BUTTONS.join(", ")}`)
    .action((x: string, y: string | undefined, opts: TargetOptions & { count?: string; button?: string }) => {
      const button = BUTTONS.find((candidate) => candidate === (opts.button ?? "primary"));
      if (!button) return error("Invalid button", `Use one of: ${BUTTONS.join(", ")}`);
      return act(spacesCmd, opts, [{
        type: "tap", ...pointOrRef(x, y, "tap"), button,
        ...(opts.count ? { count: parseNumber("count", opts.count) } : {}),
      }]);
    });

  withTarget(displays.command("long-press <x> [y]").description("Touch and hold a point, or an element by ref"))
    .option("--duration <ms>", "Hold time in milliseconds", "800")
    .action((x: string, y: string | undefined, opts: TargetOptions & { duration: string }) =>
      act(spacesCmd, opts, [{ type: "long_press", ...pointOrRef(x, y, "long-press"), duration_ms: parseNumber("duration", opts.duration) }]));

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
    .option("--in <ref>", "Scroll this element of the tree")
    .action((direction: string, opts: TargetOptions & { amount: string; in?: string }) => {
      if (!(DIRECTIONS as readonly string[]).includes(direction)) return error("Invalid direction", `Use one of: ${DIRECTIONS.join(", ")}`);
      return act(spacesCmd, opts, [{
        type: "scroll", direction: direction as (typeof DIRECTIONS)[number], amount: parseNumber("amount", opts.amount),
        ...(opts.in ? { ref: opts.in } : {}),
      }]);
    });

  withTarget(displays.command("type <text>").description("Type into the focused field, or replace an element's text"))
    .option("--into <ref>", "Replace the text of this element of the tree")
    .action((text: string, opts: TargetOptions & { into?: string }) => act(spacesCmd, opts, [{ type: "type", text, ...(opts.into ? { ref: opts.into } : {}) }]));

  withTarget(displays.command("key <key>").description("Press a key or shortcut, e.g. Enter or Control+a"))
    .action((key: string, opts: TargetOptions) => act(spacesCmd, opts, [{ type: "key", key }]));

  withTarget(displays.command("press <button>").description(`Press a system button: ${DISPLAY_SYSTEM_ACTIONS.join(", ")}`))
    .action((button: string, opts: TargetOptions) => {
      const action = DISPLAY_SYSTEM_ACTIONS.find((candidate) => candidate === button);
      if (!action) return error("Invalid button", `Use one of: ${DISPLAY_SYSTEM_ACTIONS.join(", ")}`);
      return act(spacesCmd, opts, [{ type: "system", action }]);
    });

  withTarget(displays.command("act").description("Run a JSON array of actions from --actions or stdin"))
    .option("--actions <json>", "Actions, e.g. '[{\"type\":\"tap\",\"x\":540,\"y\":1200},{\"type\":\"tap\",\"ref\":\"e3.12\"}]'")
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
