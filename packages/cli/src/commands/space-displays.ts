import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  compileDisplayPlan,
  DISPLAY_ELEMENT_REF_PATTERN,
  DISPLAY_ELEMENT_ROLES,
  DISPLAY_SYSTEM_ACTIONS,
  DISPLAY_HANDOVER_DEFAULT_MS,
  DISPLAY_HANDOVER_MAX_MS,
  DISPLAY_HANDOVER_WAIT_MS,
  DISPLAY_RECORDINGS_DIR,
  DisplayActionError,
  type DisplayAction,
  type DisplayActResult,
  type DisplayActStepResult,
  type DisplayCapture,
  type DisplayElement,
  type DisplayHandoverState,
  type DisplayInfo,
  type DisplayRecordingMeta,
  type DisplayStepTarget,
  type DisplayStopNext,
  type DisplayTree,
  type DisplayUntil,
  type SpaceDisplaysApi,
} from "@neta-art/cohub";
import { type Command, Option } from "commander";
import { createClient } from "../client.js";
import { error, handleHttp, json as outJson, jsonRequested, ok, table, warn } from "../output.js";
import { resolveSpace } from "../space.js";
import { webUrl } from "../web.js";

type Size = { width: number; height: number };
type ActOptions = {
  display?: string;
  window?: string;
  size?: string;
  untilText?: string;
  untilGone?: string;
  untilApp?: string;
  untilStable?: boolean;
  timeoutMs?: string;
  label?: string;
  screenshot?: string | boolean;
  tree?: string;
  json?: boolean;
};
type TargetOptions = { name?: string; role?: string; nth?: string; scroll?: boolean };

const DIRECTIONS = ["up", "down", "left", "right"] as const;
const NEXT_COMMANDS: Record<DisplayStopNext, string> = { look: "look", lookImage: "look --screenshot", list: "ls" };
const BUTTONS = ["primary", "secondary", "middle"] as const;
const TREES = ["compact", "full", "none"] as const;
const DEFAULT_MAX_SIZE = 1280;
const HANDOVER_RETRY_MS = 60_000;
const HANDOVER_RETRY_GAP_MS = 2_000;
const CACHE_DIR = join(homedir(), ".cache", "cohub-cli");
const FRAMES_PATH = join(CACHE_DIR, "display-frames.json");
// In the workspace, where a Runtime's fenced file tools reach them.
const IMAGE_DIR = join(".cache", "cohub", "displays");
const KEPT_IMAGES = 20;
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

const frameKey = (spaceId: string, display: DisplayInfo, window?: string) => `${spaceId}/${display.id}${window ? `#${window}` : ""}`;

async function rememberFrame(spaceId: string, display: DisplayInfo, size: Size, window?: string) {
  const frames = await readFrames();
  frames[frameKey(spaceId, display, window)] = { width: size.width, height: size.height, display: { width: display.width, height: display.height } };
  await mkdir(dirname(FRAMES_PATH), { recursive: true });
  await writeFile(FRAMES_PATH, JSON.stringify(frames));
}

async function frameOf(spaceId: string, display: DisplayInfo, size?: string, window?: string, api?: SpaceDisplaysApi): Promise<Size> {
  if (size) return parseSize(size);
  const frame = (await readFrames())[frameKey(spaceId, display, window)];
  if (frame && frame.display.width === display.width && frame.display.height === display.height) return frame;
  if (window && api) {
    const found = (await api.windows(display.id)).windows.find((item) => item.id === window);
    if (!found) return error(`Window "${window}" is not on ${display.name || display.id}`, "List them with `cohub spaces displays windows`.");
    return { width: Math.max(1, Math.round(found.bounds[2] * display.width)), height: Math.max(1, Math.round(found.bounds[3] * display.height)) };
  }
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

async function target(spacesCmd: Command, opts: { display?: string }, launching = false) {
  const spaceId = await resolveSpace(spacesCmd);
  const api = createClient().space(spaceId).displays;
  let { displays, virtual } = await api.list();
  if (launching && !opts.display && !displays.some((display) => display.apps) && virtual === "available") ({ displays } = await api.startVirtual());
  const launchers = displays.filter((display) => display.apps);
  return { spaceId, api, display: pickDisplay(launching && !opts.display && launchers.length > 0 ? launchers : displays, opts.display) };
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

async function writeOnce(path: string, content: string) {
  await writeFile(path, content, { flag: "wx" }).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "EEXIST") throw e;
  });
}

async function imageDir() {
  const dir = resolve(IMAGE_DIR);
  await mkdir(dir, { recursive: true });
  await Promise.all([writeOnce(join(dir, "..", ".gitignore"), "*\n"), writeOnce(join(dir, ".nomedia"), "")]);
  const images = (await readdir(dir)).filter((name) => name.endsWith(".jpg")).sort();
  await Promise.all(images.slice(0, -(KEPT_IMAGES - 1)).map((name) => rm(join(dir, name), { force: true })));
  return dir;
}

async function saveImage(spaceId: string, display: DisplayInfo, image: DisplayCapture, output?: string, window?: string) {
  const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${display.id}.jpg`;
  const path = output ? resolve(output) : join(await imageDir().catch(() => join(CACHE_DIR, "displays")), name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(image.data, "base64"));
  await rememberFrame(spaceId, display, image, window);
  return { path, width: image.width, height: image.height };
}

async function screenshot(api: SpaceDisplaysApi, spaceId: string, display: DisplayInfo, maxSize: number, output?: string, window?: string) {
  return saveImage(spaceId, display, await api.capture(display.id, { maxSize, ...(window ? { window } : {}) }), output, window);
}

function formatElement(element: DisplayElement, frame: Size, indent = true, box = true) {
  const scaleX = frame.width - 1 || 1;
  const scaleY = frame.height - 1 || 1;
  const [x, y, width, height] = element.bounds;
  const parts = [`${indent ? "  ".repeat(element.depth) : ""}${element.ref}`, element.role];
  if (element.name) parts.push(JSON.stringify(element.name));
  if (element.value) parts.push(`value=${JSON.stringify(element.value)}`);
  if (element.states?.length) parts.push(`[${element.states.join(", ")}]`);
  if (box) parts.push(`(${Math.round(x * scaleX)},${Math.round(y * scaleY)} ${Math.round(width * scaleX)}x${Math.round(height * scaleY)})`);
  return parts.join(" ");
}

function formatTree(tree: DisplayTree, frame: Size, compact = false): string {
  return tree.elements.map((element) => formatElement(element, frame, true, !compact || Boolean(element.actions?.length))).join("\n");
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
  return { ...until, ...(opts.timeoutMs ? { timeoutMs: parseNumber("timeout-ms", opts.timeoutMs) } : {}) };
}

async function act(spacesCmd: Command, opts: ActOptions, actions: DisplayAction[]) {
  let sent = false;
  try {
    const launching = actions.some((action) => action.type === "launch" || action.type === "open");
    const { spaceId, api, display } = await target(spacesCmd, opts, launching);
    if (!display.input && actions.some((action) => action.type !== "wait")) return error("This display is view only", needsHint(display) ?? "Allow control on the device first.");
    const frame = await frameOf(spaceId, display, opts.size, opts.window, api);
    const tree = opts.tree ?? "compact";
    if (!(TREES as readonly string[]).includes(tree)) return error("Invalid tree", `Use one of: ${TREES.join(", ")}`);
    const last = actions.at(-1);
    if (last) {
      const until = untilOf(opts);
      if (until) last.until = until;
      if (opts.label) last.label = opts.label;
    }
    const steps = compileDisplayPlan(actions, frame.width, frame.height);
    sent = steps.length > 0;
    const result = await api.act(display.id, {
      steps,
      observe: { tree: tree as (typeof TREES)[number], image: opts.screenshot ? "always" : "auto", maxSize: DEFAULT_MAX_SIZE },
      ...(ACTOR ? { actor: ACTOR } : {}),
      ...(opts.window ? { window: opts.window } : {}),
    });
    const image = result.screen.image
      ? await saveImage(spaceId, display, result.screen.image, typeof opts.screenshot === "string" ? opts.screenshot : undefined, opts.window)
      : undefined;
    const shown = image ?? frame;
    if (result.stopped) process.exitCode = 1;
    if (jsonRequested(opts)) {
      const { image: _, ...screen } = result.screen;
      return outJson({ display: display.id, ...result, screen: { ...screen, ...(image ? { image } : {}) }, frame: { width: shown.width, height: shown.height } });
    }
    printResult(display, actions, result, shown, tree === "compact", image?.path);
  } catch (e: unknown) {
    if (e instanceof DisplayActionError) return error("Invalid action", e.message);
    if (sent && isLostAnswer(e)) return error("The answer was lost", "The plan may have run, in part or whole: `look` before repeating any step.");
    handleHttp(e);
  }
}

function isLostAnswer(e: unknown) {
  const status = (e as { status?: number }).status;
  return status === undefined ? e instanceof TypeError : status >= 500 && status !== 501;
}

function targetText(target: DisplayStepTarget) {
  return target.name ? `${target.role} ${JSON.stringify(target.name)}` : target.role;
}

function atPoint(action: DisplayAction) {
  return action.x !== undefined && action.ref === undefined && action.name === undefined && action.role === undefined;
}

function actionText(action: DisplayAction) {
  const point = atPoint(action) ? ` (${action.x},${action.y})` : "";
  switch (action.type) {
    case "tap": return `${action.count === 2 ? "double-tap" : action.count === 3 ? "triple-tap" : "tap"}${point}`;
    case "long_press": return `long press${point}`;
    case "swipe": return `swipe${point} to (${action.to_x},${action.to_y})`;
    case "scroll": return `scroll ${action.direction ?? "down"}`;
    case "type": return `type ${[...(action.text ?? "")].length} characters`; // never echo it: it may be a secret
    case "key": return `key ${action.key}`;
    case "system": return `press ${action.action}`;
    case "launch": return `launch ${action.app}`;
    case "open": return `open ${action.url}`;
    case "wait": return "wait";
  }
}

function stepText(action: DisplayAction | undefined, step: DisplayActStepResult) {
  const parts = [action ? actionText(action) : "step"];
  if (step.target) parts.push(`${action && atPoint(action) ? "on " : action?.type === "type" ? "into " : ""}${targetText(step.target)}`);
  if (action?.type !== "wait") parts.push(`· ${step.effect}`);
  if (step.readBack) parts.push("· read back");
  parts.push(`· ${step.findMs + step.actMs + step.waitedMs} ms`);
  return parts.join(" ");
}

function printResult(display: DisplayInfo, actions: DisplayAction[], result: DisplayActResult, frame: Size, compact: boolean, imageFile?: string) {
  const name = display.name || display.id;
  if (result.steps.length > 0 || result.stopped) {
    const done = result.steps.length;
    const still = result.steps.findIndex((step, index) => step.effect === "none" && actions[index]?.type !== "wait");
    if (!result.stopped) {
      if (still >= 0) warn(`Step ${still + 1} changed nothing on ${name}: it may not have landed. Look before repeating it.`);
      else ok(`${done} step${done === 1 ? "" : "s"} on ${name}`);
    }
    for (const [index, step] of result.steps.entries()) console.log(`  ${index + 1}. ${stepText(actions[index], step)}`);
    if (result.stopped) {
      console.log(`✗ Stopped (${result.stopped.reason}): ${result.stopped.message}`);
      for (const candidate of result.stopped.candidates ?? []) console.log(`    ${formatElement(candidate, frame, false)}`);
      const { hint, next } = result.stopped;
      if (hint) console.log(`  ${hint}`);
      if (next) console.log(`  Next: cohub spaces displays ${NEXT_COMMANDS[next]}${next === "list" ? "" : ` --display ${display.id}`}`);
    }
  }
  const { screen } = result;
  console.log(`\n${[screen.app, screen.quality === "poor" ? "the tree misses much of this screen: read the image" : null].filter(Boolean).join(" · ") || name}`);
  if (screen.unchanged) console.log("  The screen is as you last saw it; its refs are gone, so target by name or `look` again.");
  if (screen.tree) {
    console.log(formatTree(screen.tree, frame, compact));
    if (screen.tree.truncated) console.log("  More elements exist; pass --tree full or read `tree --max`.");
  }
  if (imageFile) console.log(`\n  Image ${frame.width}x${frame.height}: ${imageFile} (coordinates are its pixels)`);
  if (screen.tree) console.log(`\n  Boxes are x,y and size in ${frame.width}x${frame.height} pixels.`);
  if (display.held) console.log("  A person at the device has taken it over; wait until they hand it back.");
  else if (display.viewers?.some((viewer) => viewer.control)) console.log("  A person is watching with control; what you do here pauses while they act.");
}

const HANDOVER_ENDS: Record<Exclude<DisplayHandoverState, "waiting" | "returned">, (held?: boolean) => [string, string]> = {
  stopped: () => ["The person stopped this", "Do not go on with this Turn; ask them."],
  gone: () => ["The display went away", "Ask the person what happened before going on."],
  expired: (held) => held
    ? ["Timed out while the person is still working", "Tell them to say so in the chat when done; they will not wake you by handing back."]
    : ["Timed out; the person did not take over", "Tell them what is needed, and to say so in the chat when done."],
};

async function handover(spacesCmd: Command, opts: { reason: string; display?: string; timeoutMs?: string; wait: boolean; json?: boolean }) {
  try {
    const timeoutMs = opts.timeoutMs ? parseNumber("timeout-ms", opts.timeoutMs) : DISPLAY_HANDOVER_DEFAULT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DISPLAY_HANDOVER_MAX_MS) return error("Invalid timeout", `--timeout-ms must be between 1 and ${DISPLAY_HANDOVER_MAX_MS} milliseconds.`);
    const { api, display } = await target(spacesCmd, opts);
    const params = { id: randomUUID(), reason: opts.reason, timeoutMs, ...(ACTOR ? { actor: ACTOR } : {}) };
    const giveUpAt = Date.now() + timeoutMs + HANDOVER_RETRY_MS;
    let result = await api.handover(display.id, { ...params, waitMs: opts.wait ? DISPLAY_HANDOVER_WAIT_MS : 0 });
    while (opts.wait && result.state === "waiting") {
      try {
        result = await api.handover(display.id, { ...params, waitMs: DISPLAY_HANDOVER_WAIT_MS });
      } catch (e: unknown) {
        if (!isLostAnswer(e) || Date.now() > giveUpAt) throw e;
        await new Promise((done) => setTimeout(done, HANDOVER_RETRY_GAP_MS));
      }
    }
    if (result.state === "waiting") {
      if (jsonRequested(opts)) return outJson({ display: display.id, ...result });
      return ok(`Asked the person: ${opts.reason}`);
    }
    if (result.state === "returned") return act(spacesCmd, { display: display.id, json: opts.json }, []);
    const [title, hint] = HANDOVER_ENDS[result.state](result.held);
    if (jsonRequested(opts)) {
      process.exitCode = 1;
      return outJson({ display: display.id, ...result });
    }
    return error(title, hint);
  } catch (e: unknown) {
    handleHttp(e);
  }
}

function withAct(command: Command): Command {
  return command
    .option("-d, --display <id>", "Display id; defaults to the only one, or the agent screen")
    .option("-w, --window <id>", "Read and show this window alone (see `windows`); coordinates are its pixels")
    .option("--size <WxH>", "Coordinates are pixels of an image this size (default: the latest image)")
    .option("--until-text <text>", "Wait until this text shows")
    .option("--until-gone <text>", "Wait until this text is gone, e.g. a loading label")
    .option("--until-app <id>", "Wait until this app is in front")
    .option("--until-stable", "Wait until the screen stops changing")
    .option("--timeout-ms <ms>", "How long --until-* waits (default 8000)")
    .option("--label <text>", "What this does, shown to people watching")
    .option("--screenshot [path]", "Attach an image of the screen after (by default only when its tree misses much)")
    .option("--tree <kind>", `The tree after: ${TREES.join(", ")}`)
    .option("--json", "Output as JSON");
}

function withTarget(command: Command): Command {
  return command
    .option("--name <text>", "The element that says this: whole, then start, then part")
    .option("--role <role>", `Its role: ${DISPLAY_ELEMENT_ROLES.join(", ")}`)
    .option("--nth <n>", "The nth match, top to bottom")
    .option("--scroll", "Scroll the list on until it shows");
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
      ...(opts.scroll ? { scroll: true } : {}),
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
              abilities: [display.stream && "view", display.capture && "capture", display.input && "control", display.tree && "tree", display.apps && "apps", display.windows && "windows", display.record && "record", display.desktop && "desktop"].filter(Boolean).join(", "),
              using: [
                display.held && "a person at the device",
                display.activity && `an agent${display.activity.label ? `: ${display.activity.label}` : ""}`,
                display.viewers?.length && `${display.viewers.length} watching${display.viewers.some((viewer) => viewer.control) ? " (controlling)" : ""}`,
                display.recording?.id ? `recording${display.recording.paused ? " (paused)" : ""}` : display.recording?.auto && "recording agents' plans",
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
    .option("-o, --output <path>", `Where to write the image (default: ${IMAGE_DIR}/, the latest ${KEPT_IMAGES} kept)`)
    .option("--max-size <px>", `Longest edge in pixels (default ${DEFAULT_MAX_SIZE})`)
    .option("-w, --window <id>", "Capture this window alone (see `windows`)")
    .option("--json", "Output as JSON")
    .action(async (opts: { display?: string; output?: string; maxSize?: string; window?: string; json?: boolean }) => {
      try {
        const { spaceId, api, display } = await target(spacesCmd, opts);
        const maxSize = opts.maxSize ? parseNumber("max-size", opts.maxSize) : DEFAULT_MAX_SIZE;
        const shot = await screenshot(api, spaceId, display, maxSize, opts.output, opts.window);
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
    .option("--full", "Every element, nested, instead of what can be acted on or read")
    .option("-w, --window <id>", "Read this window alone (see `windows`)")
    .addOption(new Option("--compact").hideHelp())
    .option("--json", "Output as JSON")
    .action(async (opts: { display?: string; max?: string; full?: boolean; window?: string; json?: boolean }) => {
      try {
        const { spaceId, api, display } = await target(spacesCmd, opts);
        if (!display.tree) return error("This display has no element tree", "Use capture and coordinates instead.");
        const tree = await api.tree(display.id, {
          ...(opts.max ? { maxElements: parseNumber("max", opts.max) } : {}),
          ...(opts.full ? {} : { compact: true }),
          ...(opts.window ? { window: opts.window } : {}),
        });
        if (jsonRequested(opts)) return outJson(tree);
        const frame = await frameOf(spaceId, display, undefined, opts.window, api);
        if (tree.app) console.log(tree.app);
        console.log(formatTree(tree, frame, !opts.full));
        console.log(`\n  Boxes are x,y and size in ${frame.width}x${frame.height} pixels. Act with: tap --name <text> · type <text> --into <ref> · act < plan.json`);
        if (tree.truncated) console.log("  More elements exist; pass --max to read more.");
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  displays
    .command("windows")
    .description("List a desktop's windows, front first; pass an id as --window to read one alone")
    .option("-d, --display <id>", "Display id; defaults to the only one, or the agent screen")
    .option("--json", "Output as JSON")
    .action(async (opts: { display?: string; json?: boolean }) => {
      try {
        const { api, display } = await target(spacesCmd, opts);
        if (!display.windows) return error("This display does not list its windows");
        const { windows } = await api.windows(display.id);
        if (jsonRequested(opts)) return outJson({ windows });
        table(windows.map((item) => ({
          ...item,
          front: item.focused ? "●" : "",
          size: `${Math.round(item.bounds[2] * display.width)}x${Math.round(item.bounds[3] * display.height)}`,
        })), [
          { key: "id", label: "ID" },
          { key: "front", label: "" },
          { key: "app", label: "App" },
          { key: "title", label: "Title" },
          { key: "size", label: "Size" },
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  registerRecord(displays, spacesCmd);

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

  withAct(displays.command("look").description("Read the screen as `act` reports it, without acting; --until-* waits first"))
    .action((opts: ActOptions) => act(spacesCmd, opts, untilOf(opts) ? [{ type: "wait" }] : []));

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

  displays
    .command("handover")
    .description("Ask the person to do what you must not (sign in, pay), and wait until they hand back")
    .requiredOption("--reason <text>", "What they need to do, in their language; shown on the device")
    .option("-d, --display <id>", "Display id; defaults to the only one, or the agent screen")
    .option("--timeout-ms <ms>", `How long to wait (default: ${DISPLAY_HANDOVER_DEFAULT_MS}; max: ${DISPLAY_HANDOVER_MAX_MS})`)
    .option("--no-wait", "Ask and exit without waiting")
    .option("--json", "Output as JSON")
    .action(async (opts: { reason: string; display?: string; timeoutMs?: string; wait: boolean; json?: boolean }) => {
      await handover(spacesCmd, opts);
    });

  withAct(displays.command("act").description("Run a plan: a JSON array of actions from --actions or stdin"))
    .option("--actions <json>", 'Actions, e.g. \'[{"type":"launch","app":"com.android.settings"},{"type":"tap","name":"Wi-Fi"}]\'')
    .addHelpText("after", `
Each action is one step; the plan runs on the device and stops at the first
surprise (a target missing or ambiguous, an until that never came, a dialog,
another app, a person taking over), then reports the screen.

  {"type":"launch","app":"<id>"}                      {"type":"open","url":"<link>"}
  {"type":"tap","name":"Send"}  {"type":"tap","name":"Ada","scroll":true}  {"type":"tap","ref":"e3.12"}  {"type":"tap","x":540,"y":1200}
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

function duration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
}

function bytes(value: number) {
  return value >= 1 << 30 ? `${(value / (1 << 30)).toFixed(1)} GB` : `${Math.max(0.1, value / (1 << 20)).toFixed(1)} MB`;
}

function registerRecord(displays: Command, spacesCmd: Command) {
  const record = displays
    .command("record")
    .description(`Record a display into the Space folder (${DISPLAY_RECORDINGS_DIR}), outside checkpoints`);

  record
    .command("start")
    .description("Start recording now; nothing is recorded while a password field has focus or a person steps in")
    .option("-d, --display <id>", "Display id; defaults to the only one, or the agent screen")
    .option("--auto", "Record agents' plans from now on instead, each from its start until shortly after")
    .option("--json", "Output as JSON")
    .action(async (opts: { display?: string; auto?: boolean; json?: boolean }) => {
      try {
        const { spaceId, api, display } = await target(spacesCmd, opts);
        if (display.record === false || !display.stream) return error("This display cannot be recorded", "It has no live video, or the machine runs an older Runtime.");
        const recording = await api.record(display.id, { ...(opts.auto ? { auto: true } : {}), ...(ACTOR ? { actor: ACTOR } : {}) });
        if (jsonRequested(opts)) return outJson({ display: display.id, ...recording });
        ok(opts.auto ? `Recording agents' plans on ${display.name || display.id}` : `Recording ${display.name || display.id}`);
        console.log(`  Watch it live: ${displayUrl(spaceId, display.id)}\n  Stop with: cohub spaces displays record stop`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  record
    .command("stop")
    .description("Stop recording")
    .option("-d, --display <id>", "Display id; defaults to the only one, or the agent screen")
    .option("--auto", "Stop recording agents' plans instead")
    .option("--json", "Output as JSON")
    .action(async (opts: { display?: string; auto?: boolean; json?: boolean }) => {
      try {
        const { api, display } = await target(spacesCmd, opts);
        await api.stopRecording(display.id, opts.auto ? { auto: true } : {});
        if (jsonRequested(opts)) return outJson({ display: display.id, stopped: true });
        ok(opts.auto ? `Stopped recording agents' plans on ${display.name || display.id}` : `Stopped recording ${display.name || display.id}`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  record
    .command("ls")
    .alias("list")
    .description("List the recordings kept in the Space folder, newest first")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const spaceId = await resolveSpace(spacesCmd);
        const recordings: DisplayRecordingMeta[] = await createClient().space(spaceId).displays.recordings();
        if (jsonRequested(opts)) return outJson({ recordings });
        if (recordings.length === 0) return console.log("  (no recordings)");
        table(recordings.map((item) => ({
          id: item.id,
          display: item.name || item.display,
          started: new Date(item.since).toLocaleString(),
          length: item.endedAt ? duration(item.endedAt - item.since) : "recording…",
          size: bytes(item.bytes),
          files: item.files.map((file) => `${DISPLAY_RECORDINGS_DIR}/${item.id}/${file.name}`).join(" "),
        })), [
          { key: "id", label: "ID" },
          { key: "display", label: "Display" },
          { key: "started", label: "Started" },
          { key: "length", label: "Length" },
          { key: "size", label: "Size" },
          { key: "files", label: "Files" },
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });
}
