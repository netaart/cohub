/**
 * 課金殿 — The Whale Shrine
 *
 * A Cohub App where viewers pay $5 to summon an echo into the void.
 * Payment via App commerce (credit consumption), writing via an owner-funded
 * App Action (no viewer grant, no LLM), display via file reads.
 */

// ─── Config ──────────────────────────────────────────────────────────────

const CONFIG = {
  SDK_URL: "https://esm.sh/@neta-art/cohub?bundle&target=es2022",
  /** Space-root-relative path for files.read() and the App Action write. */
  DATA_PATH: "cohub-apps/whale-shrine/data/shouts.jsonl",
  /** App-root-relative path for standalone preview fetch(). */
  PREVIEW_DATA_PATH: "data/shouts.jsonl",
  /** App Action name (file stem under .cohub/actions/). */
  ACTION_NAME: "post-shout",
  PRODUCT_KEY: "burn_one_offering",
  POST_PRICE_USD: 5,
  POLL_INTERVAL_MS: 1000,
  POLL_TIMEOUT_MS: 60_000,
  PENDING_KEY: "whale-shrine:pending",
};

// ─── Rarity system ────────────────────────────────────────────────────────

const RARITIES = [
  { code: "LR",  title: "Whale King",       emoji: "👑", color: "var(--r-lr)" },
  { code: "UR",  title: "Whale Emperor",    emoji: "🐉", color: "var(--r-ur)" },
  { code: "SSR", title: "Pay-to-Win Hero",  emoji: "⚔️", color: "var(--r-ssr)" },
  { code: "SR",  title: "Veteran Admiral",  emoji: "⚓", color: "var(--r-sr)" },
  { code: "R",   title: "Rookie Summoner",  emoji: "✨", color: "var(--r-r)" },
  { code: "N",   title: "Passerby NPC",     emoji: "👤", color: "var(--r-n)" },
];

const SUMMON_LINES = [
  "The gacha gods are pleased.",
  "Your offering has been accepted.",
  "The shrine trembles with your power.",
  "Whale energy: MAXIMUM.",
  "SSR luck activated. Temporarily.",
  "The void echoes your name.",
];

const TICKER_LINES = [
  "Gacha RNG: rigged in favor of those who pay. As it should be.",
  "SSR pull rate: 100% for $5. Skill issue if you miss.",
  "Pity counter: MAXED. Guaranteed SSR. You're welcome.",
  "The shrine remembers every whale. Every. Single. One.",
  "No free-to-play energy here. This is a pay-to-win establishment.",
  "Whaling since 20XX. Your credit card is your sword.",
  "課力 Exchange: $1 = ∞ Spiritual Clout",
];

// ─── State ────────────────────────────────────────────────────────────────

const state = { cohub: null, context: null, space: null, isApp: false, userUuid: null, shouts: [], busy: false };
const $ = (id) => document.getElementById(id);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ─── Utilities ────────────────────────────────────────────────────────────

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function formatTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  const diff = Date.now() - d.getTime();
  const m = Math.floor(diff / 6e4), h = Math.floor(diff / 36e5), day = Math.floor(diff / 864e5);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  if (day < 30) return `${day}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function parseShouts(text) {
  if (!text?.trim()) return [];
  return text.split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// ─── Rarity ───────────────────────────────────────────────────────────────

function computeLeaderboard(shouts) {
  const byUser = new Map();
  for (const s of shouts) {
    const e = byUser.get(s.userId);
    if (e) { e.total += s.amountUsd; e.count++; e.name = s.name; }
    else byUser.set(s.userId, { userId: s.userId, name: s.name, total: s.amountUsd, count: 1 });
  }
  return [...byUser.values()].sort((a, b) => b.total - a.total);
}

function rarityForRank(rank) { return rank >= 1 && rank <= 5 ? RARITIES[rank - 1] : RARITIES[5]; }
function rarityForUser(userId, lb) { const i = lb.findIndex((e) => e.userId === userId); return i === -1 ? RARITIES[5] : rarityForRank(i + 1); }

// ─── Runtime init ─────────────────────────────────────────────────────────

async function initRuntime() {
  try {
    const { createCohubClient } = await import(CONFIG.SDK_URL);
    state.cohub = createCohubClient();
    state.context = await state.cohub.context();
    if (state.context) {
      state.isApp = true;
      // The Shrine reads and writes its own Space (the one that owns the App).
      state.homeSpaceId = state.context.app?.homeSpace?.id ?? null;
      state.space = state.homeSpaceId ? state.cohub.space(state.homeSpaceId) : null;
      // The App runtime context already carries the current viewer identity.
      state.userUuid = state.context.viewer?.userUuid ?? null;
    }
  } catch { /* standalone preview */ }
  if (!state.isApp) {
    $("banner").textContent = "Preview mode — Publish as a Cohub App to summon.";
    $("banner").classList.add("visible");
  }
}

// ─── Data ─────────────────────────────────────────────────────────────────

async function loadShouts() {
  try {
    if (state.isApp) {
      const file = await state.space.files.read(CONFIG.DATA_PATH);
      if ("content" in file) state.shouts = parseShouts(file.content);
    } else {
      const res = await fetch(CONFIG.PREVIEW_DATA_PATH, { cache: "no-store" });
      if (res.ok) state.shouts = parseShouts(await res.text());
    }
  } catch { state.shouts = []; }
  renderAll();
}

// ─── Rendering ────────────────────────────────────────────────────────────

function renderAll() {
  const lb = computeLeaderboard(state.shouts);
  renderLeaderboard(lb);
  renderWall(lb);
  $("wallCount").textContent = state.shouts.length ? `${state.shouts.length} echo${state.shouts.length > 1 ? "s" : ""}` : "";
}

function renderLeaderboard(lb) {
  const el = $("leaderboard");
  if (!lb.length) { el.innerHTML = '<div class="lb-empty">No whales yet.<br>The throne awaits.</div>'; return; }
  el.innerHTML = lb.slice(0, 5).map((e, i) => {
    const r = rarityForRank(i + 1);
    return `<div class="lb-row" data-rank="${i + 1}">
      <div class="lb-rank">${i === 0 ? "👑" : i + 1}</div>
      <div class="lb-info">
        <div class="lb-name">${escapeHtml(e.name)}</div>
        <div class="lb-title">${r.code} · ${r.title} · ${e.count} pull${e.count > 1 ? "s" : ""}</div>
      </div>
      <div class="lb-amount">$${e.total.toLocaleString()}</div>
    </div>`;
  }).join("");
}

function renderWall(lb) {
  const el = $("wall");
  if (!state.shouts.length) {
    el.innerHTML = '<div class="wall-empty"><div class="wall-empty-icon">課</div>The void is silent.<br>Be the first whale to make an offering.</div>';
    return;
  }
  const sorted = [...state.shouts].sort((a, b) => {
    const ra = lb.findIndex((e) => e.userId === a.userId);
    const rb = lb.findIndex((e) => e.userId === b.userId);
    return ra !== rb ? ra - rb : new Date(b.ts) - new Date(a.ts);
  });
  el.innerHTML = sorted.map((s) => {
    const r = rarityForUser(s.userId, lb);
    return `<article class="echo-card" data-rarity="${r.code}">
      <div class="card-head">
        <span class="rarity-badge">${r.emoji} ${r.code}</span>
        <span class="card-amount">$${s.amountUsd.toLocaleString()}</span>
      </div>
      <div class="card-message">${escapeHtml(s.message)}</div>
      <div class="card-foot">
        <span class="card-name">${escapeHtml(s.name)}</span>
        <span class="card-time">${formatTime(s.ts)}</span>
      </div>
    </article>`;
  }).join("");
}

// ─── Ticker ───────────────────────────────────────────────────────────────

function startTicker() {
  const el = $("tickerText");
  let i = 0;
  const rotate = () => {
    el.classList.remove("visible");
    setTimeout(() => { el.textContent = TICKER_LINES[i]; el.classList.add("visible"); i = (i + 1) % TICKER_LINES.length; }, 400);
  };
  rotate();
  setInterval(rotate, 5000);
}

// ─── Summon flow ──────────────────────────────────────────────────────────

function setBusy(busy) {
  state.busy = busy;
  $("summonBtn").disabled = busy;
  $("summonBtn").textContent = busy ? "Summoning..." : "Burn $5 to Summon";
}

function flashError(msg) {
  const el = $("summonStatus");
  el.textContent = msg;
  el.className = "summon-status error";
  setTimeout(() => { el.className = "summon-status"; el.textContent = ""; }, 4000);
}

/**
 * Unified summon: check credits → consume → auth → post → poll → animate.
 * Works for both fresh summons and checkout-return resumes.
 */
async function summon(shout) {
  setBusy(true);
  localStorage.setItem(CONFIG.PENDING_KEY, JSON.stringify(shout));
  try {
    // Credits
    const { credits } = await state.cohub.app.commerce.getEntitlements();
    if (credits.available <= 0) {
      const co = await state.cohub.app.commerce.purchase({ productKey: CONFIG.PRODUCT_KEY });
      if (!co?.checkoutUsable) throw new Error(co?.message || "Checkout unavailable.");
      return; // host redirects — will resume on return
    }

    // Consume (idempotent via shout.id)
    const result = await state.cohub.app.commerce.consumeCredits({ amount: 1, operationId: shout.id, reason: `Echo: ${shout.id}` });
    if (result.status === "insufficient") {
      const co = await state.cohub.app.commerce.purchase({ productKey: CONFIG.PRODUCT_KEY });
      if (!co?.checkoutUsable) throw new Error("Checkout unavailable.");
      return;
    }

    // Post via an owner-funded App Action: the write runs as the App owner in
    // the home Space sandbox. No viewer grant, no prompt access needed — the
    // viewer already paid through the consumed credit.
    const queued = await state.cohub.app.actions.run({
      action: CONFIG.ACTION_NAME,
      input: { shout, dataPath: CONFIG.DATA_PATH },
    });

    // Poll the Task Run until it completes
    const appeared = await waitForAction(queued.taskRunId, shout.id);
    if (!appeared) throw new Error("Echo delayed — refresh later.");

    // Celebrate
    localStorage.removeItem(CONFIG.PENDING_KEY);
    const lb = computeLeaderboard(state.shouts);
    await playSummonAnimation(rarityForUser(shout.userId, lb));
    $("nameInput").value = "";
    $("messageInput").value = "";
    updateCounter();
  } catch (err) {
    flashError(err?.message || "Summon failed.");
  } finally {
    setBusy(false);
  }
}

/**
 * Wait for the App Action's Task Run to reach a terminal state, then confirm
 * the echo is readable. Returns true when the shout is on the wall.
 */
async function waitForAction(taskRunId, shoutId) {
  const deadline = Date.now() + CONFIG.POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, CONFIG.POLL_INTERVAL_MS));
    try {
      const detail = await state.cohub.tasks.get(taskRunId);
      if (detail.run.status === "failed") {
        throw new Error(detail.run.errorMessage || "App Action failed.");
      }
      if (detail.run.status === "completed") {
        const output = detail.run.result?.output;
        if (typeof output === "string" && output.includes('"status":"error"')) {
          throw new Error(`App Action rejected the echo: ${output}`);
        }
        await loadShouts();
        return state.shouts.some((s) => s.id === shoutId);
      }
    } catch (err) {
      if (err?.message?.startsWith("App Action")) throw err;
    }
  }
  return false;
}

/** On page load, check if we're returning from a successful checkout. */
async function checkCheckoutReturn() {
  if (!state.isApp) return;
  const pending = localStorage.getItem(CONFIG.PENDING_KEY);
  if (!pending) return;
  try {
    const cs = await state.cohub.app.commerce.getCheckoutState();
    if (cs?.orderId) {
      const { order } = await state.cohub.app.commerce.getOrder(cs.orderId);
      if (order?.status === "paid") {
        await summon(JSON.parse(pending));
        return;
      }
    }
  } catch { /* no checkout state */ }
}

// ─── Animations ───────────────────────────────────────────────────────────

const hasAnime = () => typeof anime !== "undefined";

async function playSummonAnimation(rarity) {
  const overlay = $("summonOverlay"), portal = $("summonPortal"), card = $("summonCard3d");
  const front = $("summonCardFront"), rays = $("summonRays"), textEl = $("summonText");

  front.innerHTML = `
    <div class="summon-rarity-label" style="color:${rarity.color}">${rarity.emoji} ${rarity.code}</div>
    <div class="summon-rarity-title">${rarity.title}</div>
    <div class="summon-rarity-msg">${pick(SUMMON_LINES)}</div>`;
  textEl.textContent = `${rarity.code} SUMMONED`;
  overlay.classList.add("active");

  if (!hasAnime()) { await new Promise((r) => setTimeout(r, 1500)); overlay.classList.remove("active"); return; }

  return new Promise((resolve) => {
    anime({ targets: portal, opacity: [0, 1], scale: [0.3, 1], duration: 500, easing: "easeOutExpo" });
    anime.timeline({ targets: card, easing: "easeOutQuart" })
      .add({ opacity: [0, 1], scale: [0.5, 1], rotateY: 0, duration: 400 })
      .add({ rotateY: 180, duration: 700, easing: "easeInOutQuart" })
      .add({ targets: rays, opacity: [0, 1], scale: [0.5, 1.2], rotate: "1turn", duration: 600, easing: "easeOutExpo" })
      .add({ targets: textEl, opacity: [0, 1], scale: [0.7, 1], duration: 400, easing: "easeOutBack" })
      .add({ duration: 700 })
      .add({ targets: [portal, card, rays, textEl], opacity: 0, scale: 0.8, duration: 400, easing: "easeInQuart", delay: anime.stagger(60) });
    setTimeout(() => { overlay.classList.remove("active"); anime.set(card, { rotateY: 0, opacity: 0, scale: 1 }); resolve(); }, 3300);
  });
}

function playEntranceAnimations() {
  if (!hasAnime()) return;
  anime({ targets: ".hero > *", opacity: [0, 1], translateY: [20, 0], duration: 700, delay: anime.stagger(90), easing: "easeOutQuart" });
  anime({ targets: ".leaderboard, .summon-form", opacity: [0, 1], translateY: [24, 0], duration: 600, delay: anime.stagger(120, { start: 300 }), easing: "easeOutQuart" });
  anime({ targets: ".echo-card", opacity: [0, 1], translateY: [18, 0], scale: [0.96, 1], duration: 500, delay: anime.stagger(50, { start: 500 }), easing: "easeOutQuart" });
}

// ─── Particles ────────────────────────────────────────────────────────────

function spawnParticles() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const container = $("particles");
  for (let i = 0; i < 24; i++) {
    const p = document.createElement("div");
    p.className = "particle";
    p.style.left = `${Math.random() * 100}%`;
    p.style.animationDuration = `${8 + Math.random() * 12}s`;
    p.style.animationDelay = `${Math.random() * 15}s`;
    p.style.setProperty("--drift", `${(Math.random() - 0.5) * 80}px`);
    const size = `${1.5 + Math.random() * 2.5}px`;
    p.style.width = size;
    p.style.height = size;
    container.appendChild(p);
  }
}

// ─── Form ─────────────────────────────────────────────────────────────────

function updateCounter() {
  $("messageCounter").textContent = `${$("messageInput").value.length} / 280`;
}

async function handleSummonClick() {
  if (state.busy) return;
  const name = $("nameInput").value.trim();
  const message = $("messageInput").value.trim();
  if (!name || !message) { flashError("A whale needs a name and a message."); return; }
  if (!state.isApp) { flashError("Publish as a Cohub App to summon."); return; }
  if (!state.userUuid) { flashError("Unable to identify viewer."); return; }

  const shout = {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    userId: state.userUuid,
    name, message, amountUsd: CONFIG.POST_PRICE_USD,
  };
  await summon(shout);
}

// ─── Init ─────────────────────────────────────────────────────────────────

async function init() {
  spawnParticles();
  startTicker();
  $("summonBtn").addEventListener("click", handleSummonClick);
  $("messageInput").addEventListener("input", updateCounter);

  // Restore pending form if returning from checkout
  const pending = localStorage.getItem(CONFIG.PENDING_KEY);
  if (pending) {
    try { const s = JSON.parse(pending); $("nameInput").value = s.name || ""; $("messageInput").value = s.message || ""; updateCounter(); }
    catch { localStorage.removeItem(CONFIG.PENDING_KEY); }
  }

  await initRuntime();
  await loadShouts();
  await checkCheckoutReturn();
  playEntranceAnimations();
}

init();
