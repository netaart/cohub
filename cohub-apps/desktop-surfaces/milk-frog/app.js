/**
 * Milk Frog — a desktop companion that lives on the Cohub overlay layer.
 *
 * It merges the two desktop-surface examples into one App:
 *   - the walking `mascot` (rect input regions, composer chip, surface methods,
 *     a realtime room), and
 *   - the chat-following `hud` (viewer consent, live generation stream), whose
 *     run status no longer has a panel — the frog itself is the surface.
 *
 * Its job is to muse: it reads the current session — the live stream first,
 * recent turns second — and asks a chat completion for one or two lines in the
 * Milk Frog's curator voice. It wakes to comment when the chat changes, when a
 * turn finishes, and when you poke it.
 *
 * Rendered from generated sprite sheets; no build step, no runtime deps beyond
 * the Cohub SDK.
 */

// ── SDK bootstrap ───────────────────────────────────────────────────────────
// Try each CDN in turn: a freshly published SDK can take a while for one
// builder to produce, and a failed import would abort the whole module.
const SDK_URLS = [
  "https://cdn.jsdelivr.net/npm/@neta-art/cohub/+esm",
  "https://esm.sh/@neta-art/cohub?bundle&target=es2022",
];

async function loadCohub() {
  let lastError;
  for (const url of SDK_URLS) {
    try {
      return await import(url);
    } catch (cause) {
      lastError = cause;
    }
  }
  throw lastError;
}

// ── Sprite sheets ───────────────────────────────────────────────────────────
// Every sheet is one horizontal row of equal cells. `idle` frames 0–3 breathe;
// 4 and 5 are the closed-eye blink, addressed directly by the renderer.
// Sheets are served from the CDN (see "Asset provenance" in the README), so the
// repository ships no image binaries.
const ASSET_BASE =
  "https://public.cohub.live/p/cf327f11-5065-4f3a-bfe5-cdb0a70f3377/cohub-apps/desktop-surfaces/milk-frog";
const SPRITES = {
  idle: { src: `${ASSET_BASE}/pet-idle.webp`, frames: 6 },
  walk: { src: `${ASSET_BASE}/pet-walk.webp`, frames: 6 },
  talk: { src: `${ASSET_BASE}/pet-talk.webp`, frames: 3 },
  happy: { src: `${ASSET_BASE}/pet-happy.webp`, frames: 2 },
  down: { src: `${ASSET_BASE}/pet-down.webp`, frames: 2 },
  sleep: { src: `${ASSET_BASE}/pet-sleep.webp`, frames: 2 },
};
const IDLE_LOOP = 4;
const IDLE_FPS = 1.7;
const WALK_FPS = 8;
const TALK_FPS = 7;
const HAPPY_FPS = 4;
const DOWN_FPS = 1.6;
const SLEEP_FPS = 1.2;
const WALK_SPEED = 34; // px / s

// Stage box, mirrored by `--box` / `--stage-w` / `--stage-h` in styles.css.
const BOX = 128;
const STAGE_W = 128;
const STAGE_H = 150;
const EDGE = 4;
// The frog walks on a floor line lifted clear of the chat composer, so it rests
// *above* the input box instead of overlapping it. Tunable per viewer.
const DEFAULT_FLOOR = 104;
const DOCK_FLOOR = 6;
const PREFS_KEY = "milkfrog:prefs";

// ── Tone ────────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = [
  "You are 奶蛙 (the Milk Frog), the serene curator of a small imaginary art museum, living as a tiny companion on the user's Cohub desktop.",
  "Voice: calm, cultured, gently deadpan, a little aloof; fond of dry understatement, museum and art-history metaphors, and light teasing. Never cruel, never crude.",
  "Reply in the SAME language as the conversation you are given.",
  "Write only 1–2 very short sentences (at most ~40 Chinese characters or ~90 English characters each). No quotes, no stage directions, no markdown, at most one understated emoji.",
  "Do not greet and do not explain yourself. Just observe and murmur a quip, like a curator beside a visitor.",
].join(" ");

const FALLBACK = {
  zh: [
    "……你继续，我在看。",
    "这一步，可以进馆。",
    "嗯，值得装裱。",
    "笔触不错，别自满。",
    "我什么都没说，只是路过。",
    "又熬夜了？博物馆可不这么开。",
    "安静点，我在听颜料干透。",
    "这一笔，有点意思。",
  ],
  en: [
    "Keep going — I'm watching.",
    "That one belongs in a frame.",
    "Hmm. Worth hanging.",
    "Not bad. Don't get smug.",
    "I said nothing. Just passing through.",
    "Still awake? Museums close at six.",
    "Quiet — the paint is drying.",
    "That stroke has promise.",
  ],
};

const POKE = {
  zh: ["别戳，在策展。", "嗯？", "手感不错。", "我在。", "轻点，颜料未干。", "……有事？"],
  en: ["Careful — wet paint.", "Hm?", "I'm here.", "Yes?", "Mind the varnish.", "Don't poke the curator."],
};

const BURST = ["✦", "✧", "♥", "♪", "✦"];
const BURST_FAIL = ["✕", "✧", "…", "!"];

const OOPS = {
  zh: ["……刚才那页被谁撕了？", "策展笔记掉进墨水瓶了。", "这次先记作‘待考’。", "展厅刚停电了一瞬。"],
  en: [
    "Someone dog-eared my catalogue.",
    "Dropped my notes in the ink.",
    "Let's file that under ‘unresolved’.",
    "A brief power cut in the gallery.",
  ],
};

// ── DOM ─────────────────────────────────────────────────────────────────────
const stage = document.getElementById("stage");
const frog = document.getElementById("frog");
const sprite = document.getElementById("sprite");
const controls = document.getElementById("controls");
const above = document.getElementById("above");
const bubble = document.getElementById("bubble");
const thought = document.getElementById("thought");

// ── Helpers ─────────────────────────────────────────────────────────────────
const now = () => performance.now();
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const clip = (text, max) => {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const withTimeout = (promise, ms) => Promise.race([promise, sleep(ms).then(() => "pending")]);
const pick = (pool) => pool[Math.floor(Math.random() * pool.length)];

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ chatter: chatterEnabled, floor: floorOffset }));
  } catch {
    // Preferences are a nicety; ignore storage failures.
  }
}

// ── Runtime state ───────────────────────────────────────────────────────────
let ctx = null;
let dpr = 1;
let sprites = {};
let reducedMotion = false;
let lastDrawKey = null;

// Behaviour.
let mode = "idle"; // idle | walk | gaze | sleep
let facing = 1;
let x = 0;
let targetX = 0;
let walkStart = 0;
let sleepSince = 0;
let idleSince = now();
let talking = false;
let talkStart = 0;
let emotion = null; // { kind, since }
let blinkStart = 0;
let blinkUntil = 0;

// Overlay.
let cohub = null;
let context = null;
// Touch has no hover, so the roaming rect shape never receives a tap; a coarse
// pointer starts in the fixed, fully-interactive dock panel instead.
const coarsePointer = window.matchMedia?.("(pointer: coarse)")?.matches ?? false;
let dock = coarsePointer;
let lastRegionKey = "";
let lastRegionAt = 0;
// The last transform actually written, so a resting frog costs no CSS writes.
let stageLeft = Number.NaN;
let stageTop = Number.NaN;

// Session following.
let followed = null; // { spaceId, sessionId, stop }
const followAccess = new Map();
let authDenied = false;
let live = { active: false, assistantText: "" };
let lastTurn = null;
let lastFollowKey = "";

// Chatter.
const prefs = loadPrefs();
let chatterEnabled = prefs.chatter !== false;
let floorOffset = Number.isFinite(prefs.floor) ? prefs.floor : DEFAULT_FLOOR;
let chatterTimer = null;
let sessionMuseTimer = null;
let completionBusy = false;
let lastQuipAt = 0;
let quipTimes = [];
let greeted = false;
const promptScopeState = new Map(); // spaceId -> "granted" | "denied"
const promptScopePending = new Map(); // spaceId -> Promise<boolean>
const MIN_GAP_MS = 45_000;
const INTERACTIVE_GAP_MS = 6_000;
const QUIP_WINDOW_MS = 10 * 60_000;
const MAX_QUIPS_PER_WINDOW = 4;

// ── Sprites ─────────────────────────────────────────────────────────────────
async function loadSprites() {
  reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  await Promise.all(
    Object.entries(SPRITES).map(
      ([name, spec]) =>
        new Promise((resolve) => {
          const image = new Image();
          image.onload = () => {
            sprites[name] = { ...spec, image };
            resolve();
          };
          image.onerror = () => resolve();
          image.src = spec.src;
        }),
    ),
  );
}

function fitCanvas() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  const size = Math.round(BOX * dpr);
  sprite.width = size;
  sprite.height = size;
  ctx = sprite.getContext("2d");
  lastDrawKey = null;
}

// ── Renderer ────────────────────────────────────────────────────────────────
function resolveSprite(t) {
  if (talking) {
    return { name: "talk", frame: Math.floor(((t - talkStart) / 1000) * TALK_FPS) % SPRITES.talk.frames };
  }
  if (emotion) {
    const fps = emotion.kind === "happy" ? HAPPY_FPS : DOWN_FPS;
    return { name: emotion.kind, frame: Math.floor(((t - emotion.since) / 1000) * fps) % 2 };
  }
  if (mode === "walk") {
    return { name: "walk", frame: Math.floor(((t - walkStart) / 1000) * WALK_FPS) % SPRITES.walk.frames };
  }
  if (mode === "sleep") {
    return { name: "sleep", frame: Math.floor((t / 1000) * SLEEP_FPS) % 2 };
  }
  if (t >= blinkUntil) {
    return { name: "idle", frame: Math.floor((t / 1000) * IDLE_FPS) % IDLE_LOOP };
  }
  return { name: "idle", frame: t < blinkStart + 70 ? 4 : 5 };
}

function drawScene(t) {
  if (!ctx) return;
  const w = sprite.width;
  const h = sprite.height;
  const sel = resolveSprite(t);
  const sheet = sprites[sel.name];
  const hop = sel.name === "happy" ? -h * 0.03 : 0;
  // Only idle/talk breathe every frame; every other pose is static between its
  // sprite frames, so redraw when something visible actually changes.
  const breathing = !reducedMotion && (sel.name === "idle" || sel.name === "talk");
  const key = breathing ? null : `${sel.name}:${sel.frame}:${facing}:${hop}`;
  if (key !== null && key === lastDrawKey) return;
  lastDrawKey = key;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!sheet?.image) return;

  const frameW = sheet.image.width / sheet.frames;
  const frameH = sheet.image.height;
  let scale = 1;
  if (mode === "gaze") scale *= 1.045;
  if (breathing) {
    scale *= 1 + 0.012 * Math.sin(t / 1400);
  }

  // Contact shadow — part of the character, so it scales with the pose.
  const shadow = (sel.name === "happy" ? 0.86 : 1) * scale;
  ctx.save();
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = "#3c3220";
  ctx.beginPath();
  ctx.ellipse(w / 2, h - 2 * dpr, w * 0.3 * shadow, h * 0.045 * shadow, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Sprite: bottom-anchored, flipped by facing, breathing applied on top.
  ctx.save();
  ctx.translate(w / 2, h + hop);
  ctx.scale(facing * scale, scale);
  ctx.drawImage(sheet.image, sel.frame * frameW, 0, frameW, frameH, -w / 2, -h, w, h);
  ctx.restore();
}

// ── Layout + overlay region ─────────────────────────────────────────────────
// The default shape is a full-window layer whose pointer hit region follows the
// frog. Note this only responds to a mouse: the host activates rect regions on
// hover, so on a touch screen the first tap passes through. Dock mode is the
// touch-safe alternative (`geometry` + `inputRegion: "all"`).
function applyStagePosition() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const floor = dock ? DOCK_FLOOR : floorOffset;
  x = clamp(x, EDGE, Math.max(EDGE, vw - STAGE_W - EDGE));
  const left = Math.round(x);
  const top = Math.round(vh - floor - STAGE_H);
  if (left === stageLeft && top === stageTop) return;
  stageLeft = left;
  stageTop = top;
  stage.style.transform = `translate3d(${left}px, ${top}px, 0)`;
}

function clampAbove() {
  above.style.setProperty("--shift", "0px");
  const rect = above.getBoundingClientRect();
  const vw = window.innerWidth;
  let shift = 0;
  if (rect.left < 8) shift = 8 - rect.left;
  else if (rect.right > vw - 8) shift = vw - 8 - rect.right;
  above.style.setProperty("--shift", `${Math.round(shift)}px`);
  bubble.style.setProperty("--tail", `${Math.round(-shift)}px`);
}

function reportRegion(force = false) {
  if (!cohub || dock) return; // dock mode configures `all` once in setDock()
  const t = now();
  if (!force && t - lastRegionAt < 90) return;
  lastRegionAt = t;
  // `#stage` is a fixed box moved only by its transform, so its rect is the
  // written position plus the constant stage size — no layout read needed.
  const next = { x: stageLeft, y: stageTop, width: STAGE_W, height: STAGE_H };
  const key = JSON.stringify(next);
  if (key === lastRegionKey) return;
  lastRegionKey = key;
  cohub.app.requestConfigure({ inputRegion: [next] });
}

/** Point the host at the overlay shape this device needs. */
function applyOverlayShape() {
  if (!cohub) return;
  if (dock) {
    // A fixed, fully-interactive corner panel (touch-safe; the classic HUD pattern).
    cohub.app.requestConfigure({
      geometry: { anchor: "bottom-right", x: 14, y: 14, width: 360, height: 340 },
      inputRegion: "all",
    });
  } else {
    // Fill the window, with a rect that follows the frog. An empty geometry is
    // the fill shape, so it tracks the host viewport with no resize traffic.
    cohub.app.requestConfigure({
      geometry: {},
      inputRegion: [],
    });
    lastRegionKey = "";
    setTimeout(() => reportRegion(true), 80);
  }
  setTimeout(() => {
    applyStagePosition();
    clampAbove();
  }, 80);
}

function setDock(on) {
  dock = on;
  document.body.classList.toggle("dock", on);
  applyOverlayShape();
  nudge();
}

async function openChat() {
  const spaceId = followed?.spaceId;
  const sessionId = followed?.sessionId;
  if (!spaceId || !sessionId) return;
  try {
    await cohub.navigation.open({ kind: "session", spaceId, sessionId });
  } catch {
    // Navigation is best-effort.
  }
}

// ── Bubble ──────────────────────────────────────────────────────────────────
function setChip(text) {
  if (!context) return;
  cohub.app.composer.setChip({ key: "milkfrog", label: "Milk Frog muses", content: clip(text, 200) });
}

function clearChip() {
  if (!context) return;
  cohub.app.composer.clearChip("milkfrog");
}

let bubbleTimer = null;

function bubbleOpen(text) {
  clearTimeout(bubbleTimer);
  bubble.textContent = text;
  bubble.classList.add("show");
  talking = true;
  talkStart = now();
  if (text) setChip(text);
  clampAbove();
}

function bubbleUpdate(text) {
  bubble.textContent = text;
  setChip(text);
}

function bubbleCloseSoon(ms) {
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => {
    bubble.classList.remove("show");
    talking = false;
    clearChip();
  }, ms);
}

function say(text, durationMs) {
  if (!text) return;
  wake();
  bubbleOpen(text);
  bubbleCloseSoon(durationMs ?? clamp(2200 + text.length * 90, 3600, 11_000));
}

function cjkRatio(text) {
  const value = String(text ?? "");
  if (!value) return 0;
  return (value.match(/[\u3400-\u9fff]/g) ?? []).length / value.length;
}

function fallbackLine() {
  const contextText = [lastTurn?.userText, lastTurn?.assistantText, live.assistantText].filter(Boolean).join(" ");
  const pool = contextText ? (cjkRatio(contextText) > 0.15 ? FALLBACK.zh : FALLBACK.en) : [...FALLBACK.zh, ...FALLBACK.en];
  return pick(pool);
}

function pokeLine() {
  const contextText = [lastTurn?.userText, live.assistantText].filter(Boolean).join(" ");
  const pool = contextText && cjkRatio(contextText) > 0.15 ? POKE.zh : POKE.en;
  return pick(pool);
}

function oopsLine() {
  const contextText = [lastTurn?.userText, lastTurn?.assistantText, live.assistantText].filter(Boolean).join(" ");
  const pool = contextText && cjkRatio(contextText) > 0.15 ? OOPS.zh : OOPS.en;
  return pick(pool);
}

function burst(kind = "ok") {
  const el = document.createElement("span");
  el.className = kind === "fail" ? "burst fail" : "burst";
  el.textContent = pick(kind === "fail" ? BURST_FAIL : BURST);
  el.style.left = `${Math.round(BOX * 0.2 + Math.random() * BOX * 0.6)}px`;
  el.style.top = `${Math.round(BOX * 0.08)}px`;
  stage.appendChild(el);
  setTimeout(() => el.remove(), 950);
}

/** The pondering dots above the head: `reading` while gathering context, `thinking` while waiting on the model. */
function showThought(kind) {
  thought.dataset.kind = kind;
  thought.classList.add("show");
}

function hideThought() {
  thought.classList.remove("show");
}

function oops() {
  hideThought();
  wake();
  burst("fail");
  emotion = { kind: "down", since: now() };
  setTimeout(() => {
    if (emotion?.kind === "down") emotion = null;
    say(oopsLine(), 5200);
  }, 1100);
}

function nudge() {
  stage.classList.add("nudge");
  setTimeout(() => stage.classList.remove("nudge"), 1400);
}

// ── Stream state ────────────────────────────────────────────────────────────
function textFromBlocks(blocks) {
  return (blocks ?? [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("")
    .trim();
}

function resetSession() {
  live = { active: false, assistantText: "" };
  lastTurn = null;
}

function onStreamState(state) {
  const status = state?.status;
  if (status === "idle") return;
  if (state?.contentBlocks) {
    const text = textFromBlocks(state.contentBlocks);
    if (text) {
      live.active = true;
      live.assistantText = text;
    }
  }
}

function onTurnFinalized(turn) {
  live.active = false;
  if (turn) {
    lastTurn = {
      turnId: turn.id ?? null,
      userText: turn.userText ?? "",
      assistantText: turn.assistantText ?? "",
    };
  }
  scheduleChatter("turn", 1400 + Math.random() * 1800);
}

function onStreamError() {
  live.active = false;
  emotion = { kind: "down", since: now() };
  setTimeout(() => {
    if (emotion?.kind === "down") emotion = null;
  }, 2200);
}

// ── Follow the current chat ─────────────────────────────────────────────────
const FOLLOW_SCOPES = ["space.view", "session.view"];
// New consent is incremental: the server keeps scopes from a still-valid grant
// and adds the request on top, so the narrower prompt request never drops the
// follow scopes. Revoked or expired scopes still require a fresh dialog.
const PROMPT_SCOPES = [...FOLLOW_SCOPES, "session.prompt.readonly"];

function ensureFollowAccess(spaceId) {
  let pending = followAccess.get(spaceId);
  if (!pending) {
    pending = cohub.auth
      .authorize({
        target: { kind: "space", spaceId },
        scopes: FOLLOW_SCOPES,
        reason: "Follow the current chat so the frog can react to agent activity.",
      })
      .then((result) => result.status === "granted")
      .catch(() => false);
    followAccess.set(spaceId, pending);
  }
  return pending;
}

function openStream(client, handlers) {
  if (typeof client.subscribeGeneration === "function") {
    return client.subscribeGeneration(
      {
        state: (event) => handlers.onState(event.state),
        finalized: (event) => handlers.onFinalized(event.turn),
        error: (event) => handlers.onError(event),
      },
      { recover: true },
    );
  }
  // Older SDKs without the generation stream: the session subscription still
  // carries patches and the finalized turn.
  return client.subscribe({
    patchState: (result) => {
      if (result?.applied && result.state) handlers.onState(result.state);
    },
    turnFinalized: (event) => handlers.onFinalized(event?.payload?.turn ?? null),
    error: (event) => handlers.onError(event?.payload ? { message: event.payload.message } : event),
  });
}

async function followSession() {
  const spaceId = context?.shell?.space?.id ?? null;
  const sessionId = context?.shell?.session?.id ?? null;
  if (followed?.spaceId === spaceId && followed?.sessionId === sessionId) return;
  followed?.stop?.();
  followed = { spaceId, sessionId, stop: null };
  resetSession();
  if (!spaceId || !sessionId) {
    authDenied = false;
    return;
  }
  const granted = await ensureFollowAccess(spaceId);
  if (followed.spaceId !== spaceId || followed.sessionId !== sessionId) return;
  authDenied = !granted;
  if (!granted) return;
  try {
    followed.stop = openStream(cohub.space(spaceId).session(sessionId), {
      onState: onStreamState,
      onFinalized: onTurnFinalized,
      onError: onStreamError,
    });
  } catch {
    authDenied = true;
    return;
  }
  // A new chat deserves an opening remark: read its context and comment soon.
  const key = `${spaceId}:${sessionId}`;
  if (key !== lastFollowKey) {
    lastFollowKey = key;
    scheduleSessionMuse();
  }
}

function scheduleSessionMuse() {
  clearTimeout(sessionMuseTimer);
  sessionMuseTimer = setTimeout(
    () => {
      if (chatterEnabled) void muse("session", { eager: true, minGap: INTERACTIVE_GAP_MS });
    },
    1600 + Math.random() * 1400,
  );
}

// ── Chatter ─────────────────────────────────────────────────────────────────
function pruneQuips(t) {
  quipTimes = quipTimes.filter((at) => t - at < QUIP_WINDOW_MS);
  return quipTimes;
}

function scheduleChatter(reason, delayMs = 0) {
  if (!chatterEnabled || !context) return;
  const t = now();
  if (pruneQuips(t).length >= MAX_QUIPS_PER_WINDOW) return;
  const wait = Math.max(delayMs, lastQuipAt + MIN_GAP_MS - t, 0);
  if (wait > QUIP_WINDOW_MS) return;
  clearTimeout(chatterTimer);
  chatterTimer = setTimeout(() => void muse(reason, { eager: false }), wait);
}

async function buildContext() {
  const parts = [];
  let turns = [];
  let failed = false;
  try {
    const result = await cohub.space(followed.spaceId).session(followed.sessionId).turns.index({ limit: 4 });
    turns = (result.turns ?? []).slice().sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  } catch {
    // A failed read gets the frog's "oops" face rather than a blank stare.
    failed = true;
  }
  for (const turn of turns.slice(-3)) {
    if (turn.userPreview) parts.push(`Visitor: ${clip(turn.userPreview, 300)}`);
    if (turn.assistantPreview) parts.push(`Assistant: ${clip(turn.assistantPreview, 300)}`);
  }
  if (live.active && live.assistantText) {
    parts.push(`Assistant (still streaming): ${clip(live.assistantText, 700)}`);
  } else if (lastTurn?.assistantText && !turns.length) {
    parts.push(`Assistant: ${clip(lastTurn.assistantText, 700)}`);
  }
  return { text: parts.join("\n").slice(0, 1600), failed };
}

function sanitize(text) {
  let value = String(text ?? "").trim();
  value = value.replace(/```([\s\S]*?)```/g, "$1").trim();
  value = value.replace(/^(milk frog|奶蛙|assistant|curator)\s*[:：]\s*/i, "");
  value = value.replace(/^["'“”『』「」]+|["'“”『』「」]+$/g, "").trim();
  value = value.replace(/[ \t]+/g, " ");
  const lines = value
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 2);
  return lines.join("\n").slice(0, 200);
}

function ensurePromptScope(spaceId) {
  const state = promptScopeState.get(spaceId);
  if (state === "granted") return Promise.resolve(true);
  if (state === "denied") return Promise.resolve(false);
  let pending = promptScopePending.get(spaceId);
  if (!pending) {
    pending = cohub.auth
      .authorize({
        target: { kind: "space", spaceId },
        scopes: PROMPT_SCOPES,
        reason: "Follow this chat and let the frog read it so it can murmur something relevant.",
      })
      .then((result) => {
        const ok = result.status === "granted";
        promptScopeState.set(spaceId, ok ? "granted" : "denied");
        return ok;
      })
      .catch(() => false);
    promptScopePending.set(spaceId, pending);
  }
  return pending;
}

/**
 * Read the current chat and say one or two lines. `eager` marks an interaction
 * the viewer just caused (a poke, a chat switch): it always answers with at
 * least a curated line, while unprompted musings stay quiet when the pace or
 * budget says so.
 */
async function muse(reason, options = {}) {
  const eager = options.eager === true;
  const minGap = typeof options.minGap === "number" ? options.minGap : MIN_GAP_MS;
  const answer = () => say(reason === "poke" ? pokeLine() : fallbackLine());

  if (!chatterEnabled || completionBusy || !context) {
    if (eager) answer();
    return;
  }
  const spaceId = followed?.spaceId;
  const sessionId = followed?.sessionId;
  if (!spaceId || !sessionId || authDenied) {
    if (eager) answer();
    return;
  }
  const t = now();
  if (pruneQuips(t).length >= MAX_QUIPS_PER_WINDOW) {
    if (eager) answer();
    return;
  }
  if (t - lastQuipAt < minGap) {
    if (eager) answer();
    return;
  }

  // Ask for the prompt scope lazily, but never let a pending consent dialog
  // silence the frog — fall back to a curated line and try the model next time.
  showThought("reading");
  const granted = await withTimeout(ensurePromptScope(spaceId), 2500);
  if (granted !== true) {
    hideThought();
    if (eager) answer();
    return;
  }

  const { text: sessionContext, failed } = await buildContext();
  if (!sessionContext) {
    if (failed) oops();
    else if (eager) answer();
    return;
  }

  const situation =
    reason === "poke"
      ? "The visitor just poked you."
      : reason === "session"
        ? "The visitor just switched to this chat."
        : reason === "turn"
          ? "They just finished a turn."
          : "";

  completionBusy = true;
  showThought("thinking");
  wake();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  let streamed = "";
  let opened = false;
  const closeBubble = () => {
    if (!opened) return;
    bubble.classList.remove("show");
    talking = false;
    clearChip();
  };
  try {
    const messages = [
      { role: "system", content: [{ type: "text", text: SYSTEM_PROMPT }] },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Recent context from the chat beside you:\n${sessionContext}\n\n${situation} Murmur one or two lines of commentary in character.`.trim(),
          },
        ],
      },
    ];
    const generator = cohub
      .space(spaceId)
      .streamCompletion({ messages, temperature: 0.95, maxTokens: 160, thinkingLevel: "off" }, { signal: controller.signal });
    let result = null;
    for (;;) {
      const step = await generator.next();
      if (step.done) {
        result = step.value;
        break;
      }
      if (step.value?.type === "delta" && step.value.text) {
        streamed += step.value.text;
        const partial = sanitize(streamed) || streamed;
        // The pondering dots give way to the speech bubble on the first token.
        if (!opened) {
          hideThought();
          bubbleOpen(partial);
          opened = true;
        } else {
          bubbleUpdate(partial);
        }
      }
    }
    const fromBlocks = textFromBlocks(result?.message?.content);
    const final = sanitize(fromBlocks || streamed);
    if (final) {
      hideThought();
      if (opened) bubbleUpdate(final);
      else bubbleOpen(final);
      quipTimes.push(now());
      lastQuipAt = now();
      bubbleCloseSoon(clamp(2600 + final.length * 110, 4200, 12_000));
    } else {
      hideThought();
      closeBubble();
      answer();
    }
  } catch (error) {
    hideThought();
    closeBubble();
    if (error?.status === 402 || /billing|credit|insufficient/i.test(String(error?.message ?? ""))) {
      promptScopeState.set(spaceId, "denied");
    }
    oops();
  } finally {
    clearTimeout(timeout);
    hideThought();
    completionBusy = false;
  }
}

// ── Behaviour ───────────────────────────────────────────────────────────────
function wake() {
  if (mode === "sleep") {
    mode = "idle";
    idleSince = now();
  }
}

function startWander() {
  const minX = EDGE;
  const maxX = Math.max(minX, window.innerWidth - STAGE_W - EDGE);
  let next = minX + Math.random() * (maxX - minX);
  if (Math.abs(next - x) < 48) next = Math.random() < 0.5 ? minX : maxX;
  targetX = clamp(next, minX, maxX);
  facing = targetX >= x ? 1 : -1;
  walkStart = now();
  mode = "walk";
  idleSince = now();
}

function startGaze() {
  mode = "gaze";
  idleSince = now();
  const hold = 2400 + Math.random() * 2200;
  setTimeout(() => {
    if (mode === "gaze") {
      mode = "idle";
      idleSince = now();
    }
  }, hold);
}

function scheduleBlink() {
  const delay = 2200 + Math.random() * 4200;
  setTimeout(() => {
    blinkStart = now();
    blinkUntil = blinkStart + 150;
    scheduleBlink();
  }, delay);
}

async function autonomy() {
  for (;;) {
    await sleep(800 + Math.random() * 700);
    if (talking || emotion) continue;
    const t = now();
    if (mode === "sleep") {
      if (t - sleepSince > 24_000 + Math.random() * 36_000) {
        mode = "idle";
        idleSince = t;
      }
      continue;
    }
    if (mode !== "idle" && mode !== "gaze") continue;
    const idleMs = t - idleSince;
    if (idleMs > 95_000 && Math.random() < 0.35) {
      mode = "sleep";
      sleepSince = t;
      continue;
    }
    if (Math.random() < 0.45) continue;
    const roll = Math.random();
    if (roll < 0.55) startWander();
    else if (roll < 0.85) startGaze();
    if (Math.random() < 0.35) scheduleChatter("idle", 0);
  }
}

// ── Frame loop ──────────────────────────────────────────────────────────────
let lastFrame = 0;
function frame(t) {
  const dt = lastFrame ? Math.min(0.05, (t - lastFrame) / 1000) : 0;
  lastFrame = t;
  if (mode === "walk" && !talking && !emotion) {
    x += facing * WALK_SPEED * dt;
    if ((facing > 0 && x >= targetX) || (facing < 0 && x <= targetX)) {
      x = targetX;
      mode = "idle";
      idleSince = t;
    }
  }
  applyStagePosition();
  drawScene(t);
  reportRegion();
  requestAnimationFrame(frame);
}

// ── Interactions ────────────────────────────────────────────────────────────
function setChatter(on) {
  chatterEnabled = on;
  savePrefs();
  const button = controls.querySelector('[data-action="chatter"]');
  if (button) button.setAttribute("aria-pressed", String(on));
  if (on) {
    clearTimeout(chatterTimer);
    say(pokeLine());
  }
}

function poke() {
  nudge();
  wake();
  burst();
  emotion = { kind: "happy", since: now() };
  setTimeout(() => {
    if (emotion?.kind === "happy") emotion = null;
  }, 900);
  setTimeout(() => void muse("poke", { eager: true, minGap: INTERACTIVE_GAP_MS }), 180);
}

function bindInteractions() {
  const chatterButton = controls.querySelector('[data-action="chatter"]');
  if (chatterButton) chatterButton.setAttribute("aria-pressed", String(chatterEnabled));

  frog.addEventListener("click", poke);

  controls.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    switch (button.dataset.action) {
      case "chatter":
        setChatter(!chatterEnabled);
        break;
      case "chat":
        void openChat();
        break;
      case "mode":
        setDock(!dock);
        break;
      case "close":
        cohub?.app.requestClose();
        break;
    }
  });

  window.addEventListener("resize", () => {
    applyStagePosition();
    clampAbove();
  });
}

// ── Surface methods + realtime ──────────────────────────────────────────────
function bindSurface() {
  cohub.app.surface.handle("milkfrog.say", async (input, { commandId }) => {
    const text = typeof input?.text === "string" ? input.text : "";
    if (text) say(text, clamp(2200 + text.length * 110, 4200, 12_000));
    await cohub.desktop.reportResult(commandId, { status: "applied", result: { said: Boolean(text) }, error: null });
  });

  cohub.app.surface.handle("milkfrog.comment", async (_input, { commandId }) => {
    void muse("command", { eager: true, minGap: 0 });
    await cohub.desktop.reportResult(commandId, { status: "applied", result: null, error: null });
  });

  cohub.app.surface.handle("milkfrog.mode", async (input, { commandId }) => {
    setDock(input?.mode === "dock");
    await cohub.desktop.reportResult(commandId, { status: "applied", result: { mode: dock ? "dock" : "roam" }, error: null });
  });

  cohub.app.surface.handle("milkfrog.configure", async (input, { commandId }) => {
    if (typeof input?.chatter === "boolean") setChatter(input.chatter);
    if (typeof input?.floor === "number" && Number.isFinite(input.floor)) {
      floorOffset = clamp(Math.round(input.floor), 8, 600);
      savePrefs();
      if (dock) applyOverlayShape();
      else {
        applyStagePosition();
        reportRegion(true);
      }
    }
    await cohub.desktop.reportResult(commandId, { status: "applied", result: { chatter: chatterEnabled, floor: floorOffset }, error: null });
  });

  // The host clears its surface registration whenever the frame (re)loads. Our
  // handlers are registered right after boot, but a late load can still wipe
  // the announcement, so re-announce once the frame settles — otherwise an
  // early `--call` gets `surface_reset`. Re-announcing is idempotent.
  for (const delay of [1200, 3000]) {
    setTimeout(() => cohub.app.surface.announce(), delay);
  }
}

async function joinPresence() {
  try {
    const room = await cohub.app.realtime.createRoom({ code: "milk-frog-presence", seatPerUser: true });
    room.subscribe("greet", (event) => {
      if (event.self || greeted) return;
      greeted = true;
      say(pokeLine());
    });
    await room.publish("greet", { at: Date.now() });
  } catch {
    // Realtime is optional; the frog works without it.
  }
}

// ── Boot ────────────────────────────────────────────────────────────────────
async function boot() {
  fitCanvas();
  await loadSprites();
  bindInteractions();
  x = clamp(window.innerWidth * 0.24, EDGE, Math.max(EDGE, window.innerWidth - STAGE_W - EDGE));
  applyStagePosition();
  requestAnimationFrame(frame);
  scheduleBlink();
  void autonomy();

  try {
    const { createCohubClient } = await loadCohub();
    cohub = createCohubClient();
    context = await cohub.context();
  } catch {
    cohub = null;
    context = null;
  }

  if (!context) return;

  bindSurface();
  document.body.classList.toggle("dock", dock);
  applyOverlayShape();
  if (dock) nudge();
  await followSession();
  void joinPresence();
  cohub.app.onContextChanged((next) => {
    context = next;
    void followSession();
  });
}

void boot();
