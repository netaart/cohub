import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  compileDisplayPlan,
  DISPLAY_ELEMENT_REF_PATTERN,
  DISPLAY_ELEMENT_ROLES,
  DISPLAY_SYSTEM_ACTIONS,
  DisplayActionError,
  type DisplayAction,
  type DisplayActResult,
  type DisplayCapture,
  type DisplayElement,
  type DisplayInfo,
  type DisplayTree,
  type DisplayUntil,
  type SpaceDisplaysApi,
} from "@neta-art/cohub";
import type { Command } from "commander";
import { createClient } from "../client.js";
import { error, handleHttp, json as outJson, jsonRequested, ok, table } from "../output.js";
import { resolveSpace } from "../space.js";
import { webUrl } from "../web.js";

type Size = { width: number; height: number };
type ActOptions = {
  display?: string;
  size?: string;
  untilText?: string;
  untilGone?: string;
  untilApp?: string;
  untilStable?: boolean;
  timeout?: string;
  label?: string;
  screenshot?: string | boolean;
  tree?: string;
  json?: boolean;
};
type TargetOptions = { name?: string; role?: string; nth?: string };

const DIRECTIONS = ["up", "down", "left", "right"] as const;
const BUTTONS = ["primary", "secondary", "middle"] as const;
const TREES = ["actionable", "full", "none"] as const;
const DEFAULT_MAX_SIZE = 1280;
const CACHE_DIR = join(homedir(), ".cache", "cohub-cli");
const FRAMES_PATH = join(CACHE_DIR, "display-frames.json");
const NO_DISPLAY_HINT =
  "Share one first: set up phone control in the Cohub Android app, run `cohub runtime up --display` on a computer, or `cohub spaces displays start` for a virtual screen.";

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
  const agents = displays.filter((display) => display.kind === "agent");
  if (displays.length === 1 && displays[0]) return displays[0];
  if (agents.length === 1 && agents[0]) return agents[0];
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
  if (needs.includes("phoneControl")) return `${display.name || display.id} needs phone control: ask the user to set it up in the Cohub app on the phone.`;
  if (!display.desktop) return `${display.name || display.id} needs control: on the phone, enable Cohub in Accessibility settings.`;
  const names = needs.map((need) => (need === "screenRecording" ? "Screen Recording" : "Accessibility")).join(" and ");
  return `${display.name || display.id} needs ${names}: allow it for the Runtime's terminal in System Settings → Privacy & Security, then restart the Runtime.`;
}

function imagePath(display: DisplayInfo, output?: string) {
  return resolve(output ?? join(CACHE_DIR, "displays", `${display.id}-${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`));
}

async function saveImage(spaceId: string, display: DisplayInfo, image: DisplayCapture, output?: string) {
  const path = imagePath(display, output);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(image.data, "base64"));
  await rememberFrame(spaceId, display, image);
  return { path, width: image.width, height: image.height };
}

async function screenshot(api: SpaceDisplaysApi, spaceId: string, display: DisplayInfo, maxSize: number, output?: string) {
  return saveImage(spaceId, display, await api.capture(display.id, { maxSize }), output ?? resolve(`${display.id}-${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`));
}

function formatElement(element: DisplayElement, frame: Size, indent = true) {
  const scaleX = frame.width - 1 || 1;
  const scaleY = frame.height - 1 || 1;
  const [x, y, width, height] = element.bounds;
  const box = `(${Math.round(x * scaleX)},${Math.round(y * scaleY)} ${Math.round(width * scaleX)}x${Math.round(height * scaleY)})`;
  const parts = [`${indent ? "  ".repeat(element.depth) : ""}${element.ref}`, element.role];
  if (element.name) parts.push(JSON.stringify(element.name));
  if (element.value) parts.push(`value=${JSON.stringify(element.value)}`);
  if (element.states?.length) parts.push(`[${element.states.join(", ")}]`);
  parts.push(box);
  return parts.join(" ");
}

function formatTree(tree: DisplayTree, frame: Size): string {
  return tree.elements.map((element) => formatElement(element, frame)).join("\n");
}

const ACTOR = process.env.COHUB_SESSION_ID
  ? { sessionId: process.env.COHUB_SESSION_ID, ...(process.env.COHUB_TURN_ID ? { turnId: process.env.COHUB_TURN_ID } : {}) }
  : undefined;

function untilOf(opts: ActOptions): DisplayUntil | undefined {
  const until: DisplayUntil = {
    ...(opts.untilText ? { text: opts.untilText } : {}),
    ...(opts.untilGone ? { gone: opts.untilGone } : {}),
    ...(opts.untilApp ? { app: opts.untilApp } : {}),
    ...(opts.untilStable ? { stable: true as const } : {}),
  };
  if (Object.keys(until).length === 0) return undefined;
  return { ...until, ...(opts.timeout ? { timeoutMs: parseNumber("timeout", opts.timeout) } : {}) };
}

async function act(spacesCmd: Command, opts: ActOptions, actions: DisplayAction[]) {
  try {
    const { spaceId, api, display } = await target(spacesCmd, opts);
    if (!display.input && actions.length > 0) return error("This display is view only", needsHint(display) ?? "Allow control on the device first.");
    const frame = await frameOf(spaceId, display, opts.size);
    const tree = opts.tree ?? "actionable";
    if (!(TREES as readonly string[]).includes(tree)) return error("Invalid tree", `Use one of: ${TREES.join(", ")}`);
    const last = actions.at(-1);
    if (last) {
      const until = untilOf(opts);
      if (until) last.until = until;
      if (opts.label) last.label = opts.label;
    }
    const steps = compileDisplayPlan(actions, frame.width, frame.height);
    const result = await api.act(display.id, {
      steps,
      observe: { tree: tree as (typeof TREES)[number], image: opts.screenshot ? "always" : "auto", maxSize: DEFAULT_MAX_SIZE },
      ...(ACTOR ? { actor: ACTOR } : {}),
    });
    const image = result.screen.image
      ? await saveImage(spaceId, display, result.screen.image, typeof opts.screenshot === "string" ? opts.screenshot : undefined)
      : undefined;
    const shown = image ?? frame;
    if (result.stopped) process.exitCode = 1;
    if (jsonRequested(opts)) {
      const { image: _, ...screen } = result.screen;
      return outJson({ display: display.id, ...result, screen: { ...screen, ...(image ? { image } : {}) }, frame: { width: shown.width, height: shown.height } });
    }
    printResult(display, result, shown, image?.path);
  } catch (e: unknown) {
    if (e instanceof DisplayActionError) return error("Invalid action", e.message);
    handleHttp(e);
  }
}

function printResult(display: DisplayInfo, result: DisplayActResult, frame: Size, imageFile?: string) {
  const name = display.name || display.id;
  if (result.steps.length > 0 || result.stopped) {
    const done = result.steps.length;
    if (!result.stopped) ok(`${done} step${done === 1 ? "" : "s"} on ${name}`);
    for (const [index, step] of result.steps.entries()) console.log(`  ${index + 1}. ${step.effect} · settled in ${step.waitedMs} ms`);
    if (result.stopped) {
      console.log(`✗ Stopped (${result.stopped.reason}): ${result.stopped.message}`);
      for (const candidate of result.stopped.candidates ?? []) console.log(`    ${formatElement(candidate, frame, false)}`);
    }
  }
  const { screen } = result;
  console.log(`\n${[screen.app, screen.quality === "poor" ? "the tree misses much of this screen: read the image" : null].filter(Boolean).join(" · ") || name}`);
  if (screen.tree) {
    console.log(formatTree(screen.tree, frame));
    if (screen.tree.truncated) console.log("  More elements exist; pass --tree full or read `tree --max`.");
  }
  if (imageFile) console.log(`\n  Image ${frame.width}x${frame.height}: ${imageFile} (coordinates are its pixels)`);
  console.log(`\n  Boxes are x,y and size in ${frame.width}x${frame.height} pixels.`);
  if (display.held) console.log("  A person at the device has taken it over; wait until they hand it back.");
  else if (display.viewers?.some((viewer) => viewer.control)) console.log("  A person is watching with control; what you do here pauses while they act.");
}

function withAct(command: Command): Command {
  return command
    .option("-d, --display <id>", "Display id; defaults to the only one, or the agent screen")
    .option("--size <WxH>", "Coordinates are pixels of an image this size (default: the latest image)")
    .option("--until-text <text>", "Wait until this text shows")
    .option("--until-gone <text>", "Wait until this text is gone, e.g. a loading label")
    .option("--until-app <id>", "Wait until this app is in front")
    .option("--until-stable", "Wait until the screen stops changing")
    .option("--timeout <ms>", "How long --until-* waits (default 8000)")
    .option("--label <text>", "What this does, shown to people watching")
    .option("--screenshot [path]", "Attach an image of the screen after (by default only when its tree misses much)")
    .option("--tree <kind>", `The tree after: ${TREES.join(", ")}`)
    .option("--json", "Output as JSON");
}

function withTarget(command: Command): Command {
  return command
    .option("--name <text>", "The element that says this: whole, then start, then part")
    .option("--role <role>", `Its role: ${DISPLAY_ELEMENT_ROLES.join(", ")}`)
    .option("--nth <n>", "The nth match, top to bottom");
}

function targetOf(x: string | undefined, y: string | undefined, opts: TargetOptions, command: string): Partial<DisplayAction> {
  if (opts.name !== undefined || opts.role !== undefined) {
    if (opts.role !== undefined && !(DISPLAY_ELEMENT_ROLES as readonly string[]).includes(opts.role)) {
      return error("Invalid role", `Use one of: ${DISPLAY_ELEMENT_ROLES.join(", ")}`);
    }
    return {
      ...(opts.name !== undefined ? { name: opts.name } : {}),
      ...(opts.role !== undefined ? { role: opts.role as DisplayAction["role"] } : {}),
      ...(opts.nth !== undefined ? { nth: parseNumber("nth", opts.nth) } : {}),
    };
  }
  if (x === undefined) return error("Missing target", `Pass --name, an element ref, or x and y, e.g. ${command} --name Send.`);
  if (y === undefined) return isRef(x) ? { ref: x } : error("Invalid target", `Pass x and y, or an element ref from \`cohub spaces displays tree\`, e.g. ${command} e3.12.`);
  return { x: parseNumber("x", x), y: parseNumber("y", y) };
}

export function registerSpaceDisplays(spacesCmd: Command): void {
  const displays = spacesCmd
    .command("displays")
    .description("Screens shared with a Space: view, read and act on them")
    .hook("preAction", async () => { await resolveSpace(spacesCmd); });

  displays
    .command("ls")
    .alias("list")
    .description("List shared displays, what they can do, and who uses them")
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
              kind: display.kind ?? "screen",
              abilities: [display.stream && "view", display.capture && "capture", display.input && "control", display.tree && "tree", display.apps && "apps", display.desktop && "desktop"].filter(Boolean).join(", "),
              using: [
                display.held && "a person at the device",
                display.activity && `an agent${display.activity.label ? `: ${display.activity.label}` : ""}`,
                display.viewers?.length && `${display.viewers.length} watching${display.viewers.some((viewer) => viewer.control) ? " (controlling)" : ""}`,
              ].filter(Boolean).join("; ") || "—",
            })),
            [
              { key: "id", label: "ID" },
              { key: "name", label: "Name" },
              { key: "kind", label: "Kind" },
              { key: "size", label: "Size" },
              { key: "abilities", label: "Abilities" },
              { key: "using", label: "In use by" },
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
    .description("Start the machine's virtual screen: a phone's agent screen, or a sandbox's")
    .option("--size <WxH>", "Screen size where the machine lets you choose (default 1280x800)")
    .option("--json", "Output as JSON")
    .action(async (opts: { size?: string; json?: boolean }) => {
      try {
        const spaceId = await resolveSpace(spacesCmd);
        if (opts.size) parseSize(opts.size);
        const result = await createClient().space(spaceId).displays.startVirtual(opts.size ? { size: opts.size } : {});
        const started = result.displays.find((display) => display.kind === "agent") ?? result.displays[0];
        const url = started ? displayUrl(spaceId, started.id) : null;
        if (jsonRequested(opts)) return outJson({ ...result, url });
        ok("Virtual screen running; apps and programs you start from now on run on it");
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
    .option("-d, --display <id>", "Display id; defaults to the only one, or the agent screen")
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
    .option("-d, --display <id>", "Display id; defaults to the only one, or the agent screen")
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
        if (tree.app) console.log(tree.app);
        console.log(formatTree(tree, frame));
        console.log(`\n  Boxes are x,y and size in ${frame.width}x${frame.height} pixels. Act with: tap --name <text> · type <text> --into <ref> · act < plan.json`);
        if (tree.truncated) console.log("  More elements exist; pass --max to read more.");
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  displays
    .command("apps")
    .description("List the apps a display can launch")
    .option("-d, --display <id>", "Display id; defaults to the only one, or the agent screen")
    .option("--json", "Output as JSON")
    .action(async (opts: { display?: string; json?: boolean }) => {
      try {
        const { api, display } = await target(spacesCmd, opts);
        if (!display.apps) return error("This display does not launch apps");
        const { apps } = await api.apps(display.id);
        if (jsonRequested(opts)) return outJson({ apps });
        table(apps, [{ key: "id", label: "ID" }, { key: "name", label: "Name" }]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  withAct(displays.command("look").description("Read the screen as `act` reports it, without acting"))
    .action((opts: ActOptions) => act(spacesCmd, opts, []));

  withAct(displays.command("launch <app>").description("Launch an app by id (see `apps`) and wait until it is in front"))
    .action((app: string, opts: ActOptions) => act(spacesCmd, { untilApp: app, ...opts }, [{ type: "launch", app }]));

  withAct(displays.command("open <url>").description("Open a link, or a page of the system's settings"))
    .action((url: string, opts: ActOptions) => act(spacesCmd, opts, [{ type: "open", url }]));

  withAct(withTarget(displays.command("tap [x] [y]").description("Tap an element (--name, or a ref) or a point")))
    .option("--count <n>", "2 to double-tap, 3 to triple-tap")
    .option("--button <button>", `Mouse button on a desktop: ${BUTTONS.join(", ")}`)
    .action((x: string | undefined, y: string | undefined, opts: ActOptions & TargetOptions & { count?: string; button?: string }) => {
      const button = BUTTONS.find((candidate) => candidate === (opts.button ?? "primary"));
      if (!button) return error("Invalid button", `Use one of: ${BUTTONS.join(", ")}`);
      return act(spacesCmd, opts, [{
        type: "tap", ...targetOf(x, y, opts, "tap"), button,
        ...(opts.count ? { count: parseNumber("count", opts.count) } : {}),
      }]);
    });

  withAct(withTarget(displays.command("long-press [x] [y]").description("Touch and hold an element or a point")))
    .option("--duration <ms>", "Hold time in milliseconds", "800")
    .action((x: string | undefined, y: string | undefined, opts: ActOptions & TargetOptions & { duration: string }) =>
      act(spacesCmd, opts, [{ type: "long_press", ...targetOf(x, y, opts, "long-press"), duration_ms: parseNumber("duration", opts.duration) }]));

  withAct(displays.command("swipe <x1> <y1> <x2> <y2>").description("Swipe from one point to another"))
    .option("--duration <ms>", "Swipe time in milliseconds", "300")
    .action((x1: string, y1: string, x2: string, y2: string, opts: ActOptions & { duration: string }) =>
      act(spacesCmd, opts, [{
        type: "swipe",
        x: parseNumber("x1", x1), y: parseNumber("y1", y1),
        to_x: parseNumber("x2", x2), to_y: parseNumber("y2", y2),
        duration_ms: parseNumber("duration", opts.duration),
      }]));

  withAct(displays.command("scroll <direction>").description("Scroll content up, down, left or right"))
    .option("--amount <fraction>", "Fraction of the display, 0.1–1", "0.5")
    .option("--in <ref>", "Scroll this element of the tree")
    .action((direction: string, opts: ActOptions & { amount: string; in?: string }) => {
      if (!(DIRECTIONS as readonly string[]).includes(direction)) return error("Invalid direction", `Use one of: ${DIRECTIONS.join(", ")}`);
      return act(spacesCmd, opts, [{
        type: "scroll", direction: direction as (typeof DIRECTIONS)[number], amount: parseNumber("amount", opts.amount),
        ...(opts.in ? { ref: opts.in } : {}),
      }]);
    });

  withAct(withTarget(displays.command("type <text>").description("Type into the focused field, or replace a field's text")))
    .option("--into <ref>", "Replace the text of this element of the tree")
    .action((text: string, opts: ActOptions & TargetOptions & { into?: string }) => {
      const field = opts.into ? { ref: opts.into } : opts.name !== undefined || opts.role !== undefined ? targetOf(undefined, undefined, opts, "type") : {};
      return act(spacesCmd, opts, [{ type: "type", text, ...field }]);
    });

  withAct(displays.command("key <key>").description("Press a key or shortcut, e.g. Enter or Control+a"))
    .action((key: string, opts: ActOptions) => act(spacesCmd, opts, [{ type: "key", key }]));

  withAct(displays.command("press <button>").description(`Press a system button: ${DISPLAY_SYSTEM_ACTIONS.join(", ")}`))
    .action((button: string, opts: ActOptions) => {
      const action = DISPLAY_SYSTEM_ACTIONS.find((candidate) => candidate === button);
      if (!action) return error("Invalid button", `Use one of: ${DISPLAY_SYSTEM_ACTIONS.join(", ")}`);
      return act(spacesCmd, opts, [{ type: "system", action }]);
    });

  withAct(displays.command("wait").description("Wait for --until-* (or a pause) without acting"))
    .option("--ms <ms>", "Pause this long first")
    .action((opts: ActOptions & { ms?: string }) =>
      act(spacesCmd, opts, [{ type: "wait", ...(opts.ms ? { duration_ms: parseNumber("ms", opts.ms) } : {}) }]));

  withAct(displays.command("act").description("Run a plan: a JSON array of actions from --actions or stdin"))
    .option("--actions <json>", 'Actions, e.g. \'[{"type":"launch","app":"com.android.settings"},{"type":"tap","name":"Wi-Fi"}]\'')
    .addHelpText("after", `
Each action is one step; the plan runs on the device and stops at the first
surprise (a target missing or ambiguous, an until that never came, a dialog,
another app, a person taking over), then reports the screen.

  {"type":"launch","app":"<id>"}                      {"type":"open","url":"<link>"}
  {"type":"tap","name":"Send"}  {"type":"tap","ref":"e3.12"}  {"type":"tap","x":540,"y":1200}
  {"type":"type","text":"hi","name":"Message","role":"textField"}  {"type":"type","text":"hi"}
  {"type":"scroll","direction":"down"}  {"type":"swipe",...}  {"type":"key","key":"Enter"}
  {"type":"system","action":"back"}  {"type":"long_press",...}  {"type":"wait","duration_ms":500}

Any action takes "until": {"text"|"gone"|"app": …, "stable": true, "timeoutMs": 8000}
and "label": what it does, shown to people watching; name matches take "role" and "nth".`)
    .action(async (opts: ActOptions & { actions?: string }) => {
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
