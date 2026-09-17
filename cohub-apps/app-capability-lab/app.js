const DEFAULT_SDK_URL = `https://esm.sh/@neta-art/cohub?bundle&target=es2022`;
const $ = (id) => document.getElementById(id);

const state = {
  module: null,
  client: null,
  context: null,
  space: null,
  token: null,
  parentOrigin: null,
  manifest: null,
  surfaceCounter: 0,
  surfaceRegistered: false,
  contextUnsubscribe: null,
};

const statusMap = {
  asset: ["sAsset", "tAsset"],
  import: ["sImport", "tImport"],
  client: ["sClient", "tClient"],
  context: ["sContext", "tContext"],
  shell: ["sShell", "tShell"],
  wire: ["sWire", "tWire"],
  action: ["sAction", "tAction"],
  token: ["sToken", "tToken"],
  config: ["sConfig", "tConfig"],
  files: ["sFiles", "tFiles"],
  sessions: ["sSessions", "tSessions"],
  auth: ["sAuth", "tAuth"],
  prompt: ["sPrompt", "tPrompt"],
  accountSpaces: ["sAccountSpaces", "tAccountSpaces"],
  accountSessions: ["sAccountSessions", "tAccountSessions"],
  accountUsage: ["sAccountUsage", "tAccountUsage"],
};

function detectParentOrigin() {
  try {
    const ancestor = window.location.ancestorOrigins?.[0];
    if (ancestor) return ancestor;
    return document.referrer ? new URL(document.referrer).origin : null;
  } catch {
    return null;
  }
}

function setStatus(key, kind, text) {
  const pair = statusMap[key];
  if (!pair) return;
  $(pair[0]).className = `dot${kind ? ` ${kind}` : ""}`;
  $(pair[1]).textContent = text;
}

function log(kind, message, detail) {
  const row = document.createElement("div");
  row.className = `event ${kind}`;
  row.innerHTML = `<time>${new Date().toLocaleTimeString()}</time><span class="kind">${kind}</span><span class="message"></span>`;
  row.querySelector(".message").textContent = detail ? `${message} ${detail}` : message;
  $("log").prepend(row);
}

function renderChips(id, values, granted = true) {
  const el = $(id);
  const list = Array.isArray(values) ? values : [];
  el.innerHTML = "";
  if (!list.length) {
    el.innerHTML = '<span class="chip">none</span>';
    return;
  }
  for (const value of list) {
    const chip = document.createElement("span");
    chip.className = `chip ${granted ? "ok" : "warn"}`;
    chip.textContent = value;
    el.appendChild(chip);
  }
}

function renderViewerGrants(grants) {
  const el = $("viewerGrants");
  el.innerHTML = "";
  if (!grants.length) {
    el.innerHTML = '<span class="chip">none</span>';
    return;
  }
  for (const grant of grants) {
    const chip = document.createElement("span");
    chip.className = "chip ok";
    chip.title = grant.spaceId;
    chip.textContent = `${grant.spaceId.slice(0, 8)} · ${grant.scopes.join(" ")}`;
    el.appendChild(chip);
  }
}

function decodeJwtPayload(token) {
  const part = token?.split(".")[1];
  if (!part) return null;
  try {
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const json = decodeURIComponent(Array.from(atob(padded)).map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`).join(""));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function shellPath(shell) {
  return [shell?.space?.id, shell?.session?.id, shell?.turn?.id].map((value) => value || "none").join("/");
}

function applyShellContext(shell, source) {
  $("shellSurface").textContent = shell?.surface || "unavailable";
  $("shellSpacePath").textContent = shell?.space?.id || "space";
  $("shellSessionPath").textContent = shell?.session?.id || "session";
  $("shellTurnPath").textContent = shell?.turn?.id || "turn";
  $("shellSpace").textContent = shell?.space?.name
    ? `${shell.space.name} · ${shell.space.id}`
    : shell?.space?.id || "none";
  $("shellSession").textContent = shell?.session?.id || "none";
  $("shellTurn").textContent = shell?.turn?.id || "none";
  setStatus("shell", shell ? "ok" : "warn", shell ? "live" : "not available");
  $("shellUpdated").textContent = source === "event"
    ? `Updated ${new Date().toLocaleTimeString()}`
    : "Waiting for shell events";
  $("shellEventSummary").textContent = source === "event"
    ? `Observed ${shellPath(shell)}`
    : "Listening for shell changes";
}

function applyContext(context, source = "snapshot") {
  const previousShellPath = shellPath(state.context?.shell);
  state.context = context;
  state.space = context ? state.client.space(context.space.id) : null;
  $("appId").textContent = context?.app?.id || "missing";
  $("appSlug").textContent = context?.app?.slug || "missing";
  $("spaceId").textContent = context?.space?.id || "missing";
  $("contextSource").textContent = context?.invocation?.source || "none";
  $("contextSession").textContent = context?.invocation?.sessionId || "none";
  $("contextTurn").textContent = context?.invocation?.turnId || "none";
  applyShellContext(context?.shell || null, source);
  renderChips("appScopes", context?.permissions?.appScopes || [], true);
  renderViewerGrants(context?.permissions?.viewerGrants || []);
  const nextShellPath = shellPath(context?.shell);
  if (source === "event" && previousShellPath !== nextShellPath) {
    log("info", "Shell environment changed", `${previousShellPath} to ${nextShellPath}`);
  } else {
    log("info", source === "event" ? "App context changed" : "App context loaded", context?.invocation?.source || "no invocation");
  }
}

function renderSurfaceState(source = "local") {
  $("surfaceCounter").textContent = String(state.surfaceCounter);
  $("surfaceStateMeta").textContent = `${source} · iframe state is still mounted`;
}

async function handleSurfaceMethod(method, input, context = {}) {
  let result;
  if (method === "counter.increment") {
    const amount = Math.max(1, Math.min(100, Number(input?.amount) || 1));
    state.surfaceCounter += amount;
    result = { value: state.surfaceCounter };
  } else if (method === "counter.reset") {
    state.surfaceCounter = 0;
    result = { value: state.surfaceCounter };
  } else {
    throw new Error(`Unknown App Surface method: ${method}`);
  }
  renderSurfaceState(method);
  log("ok", `App Surface ${method}`, `counter=${state.surfaceCounter}`);

  // Called by a desktop command: settle the pending command so `--call` returns
  // promptly with the result instead of waiting for the CLI timeout.
  const commandId = context?.commandId;
  if (commandId && state.client?.desktop?.reportResult) {
    try {
      await state.client.desktop.reportResult(commandId, {
        status: "applied",
        result,
        error: null,
      });
      log("ok", `App Surface ${method} settled`, `commandId=${commandId}`);
    } catch (reportError) {
      log("bad", `App Surface ${method} report failed`, reportError?.message || String(reportError));
    }
  }
  return result;
}

function registerSurface() {
  if (state.surfaceRegistered || !state.client?.app?.surface?.handle) return;
  state.surfaceRegistered = true;
  state.client.app.surface.handle("counter.increment", (input, context) => handleSurfaceMethod("counter.increment", input, context));
  state.client.app.surface.handle("counter.reset", (input, context) => handleSurfaceMethod("counter.reset", input, context));
  renderSurfaceState("ready");
  log("ok", "App Surface ready", "counter.increment, counter.reset");
}

function applyToken(token) {
  state.token = token;
  const payload = decodeJwtPayload(token);
  $("tokenState").textContent = token ? `present (${token.length} chars)` : "empty";
  $("tokenPayload").textContent = payload ? JSON.stringify(payload, null, 2) : "Token received, but payload could not be decoded.";
  if (payload?.appScopes) renderChips("appScopes", payload.appScopes, true);
}

function runtimeRequest(message, timeoutMs = 1800) {
  if (window.parent === window) return Promise.resolve(null);
  const requestId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  const parentOrigin = state.parentOrigin || detectParentOrigin();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      resolve(null);
    }, timeoutMs);
    function onMessage(event) {
      if (event.source !== window.parent) return;
      if (parentOrigin && event.origin !== parentOrigin) return;
      const data = event.data || {};
      if (data.requestId !== requestId) return;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      state.parentOrigin = event.origin;
      if (data.type === "cohub.app.error") reject(new Error(data.message || "Runtime request failed."));
      else resolve(data);
    }
    window.addEventListener("message", onMessage);
    window.parent.postMessage({ ...message, requestId }, parentOrigin || "*");
  });
}

async function run(key, fn) {
  setStatus(key, "run", "running");
  try {
    const result = await fn();
    setStatus(key, "ok", "passed");
    return result;
  } catch (error) {
    const status = error && typeof error === "object" && "status" in error ? error.status : null;
    const kind = status === 401 || status === 403 ? "warn" : "bad";
    setStatus(key, kind, error?.message || "failed");
    log(kind, `${key} failed`, error?.message || String(error));
    throw error;
  }
}

async function probeAssets() {
  return run("asset", async () => {
    const response = await fetch("./assets/lab-manifest.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`manifest ${response.status}`);
    state.manifest = await response.json();
    const files = Array.isArray(state.manifest.files) ? state.manifest.files.join(", ") : "no file list";
    log("ok", "Directory assets loaded", `${state.manifest.name || "manifest"} ${state.manifest.version || ""}: ${files}`);
    return state.manifest;
  });
}

async function importSdk() {
  return run("import", async () => {
    const url = $("sdkUrl").value.trim() || DEFAULT_SDK_URL;
    state.module = await import(url);
    if (typeof state.module.createCohubClient !== "function") throw new Error("createCohubClient export is missing.");
    $("sdkStamp").textContent = url;
    log("ok", "SDK imported", url);
    return state.module;
  });
}

async function createClient() {
  return run("client", async () => {
    if (!state.module) await importSdk();
    const baseUrl = $("apiBase").value.trim().replace(/\/+$/, "");
    // Do NOT override getAccessToken. The SDK's default appRuntime
    // getAccessToken() resolves Host capabilities from context: modern hosts
    // keep viewer grants server-side and refresh tokens silently, while older
    // hosts retain the legacy renewal path.
    const options = {};
    if (baseUrl) options.baseUrl = baseUrl;
    state.client = state.module.createCohubClient(options);
    registerSurface();
    if (!state.contextUnsubscribe && typeof state.client.app?.onContextChanged === "function") {
      state.contextUnsubscribe = state.client.app.onContextChanged((context) => applyContext(context, "event"));
    }
    const methods = [
      typeof state.client.context === "function" ? "context" : "no context",
      state.client.auth?.authorize ? "auth.authorize" : "no auth.authorize",
      state.client.space ? "space" : "no space",
    ].join(" / ");
    $("clientState").textContent = baseUrl ? `ready (${baseUrl})` : `ready (${methods})`;
    log("ok", "Client created", methods);
    return state.client;
  });
}

async function sdkContext() {
  return run("context", async () => {
    if (!state.client) await createClient();
    let context = null;
    if (typeof state.client.context === "function") {
      context = await state.client.context();
      if (context) log("ok", "SDK context loaded", context.app.slug);
    } else {
      log("warn", "SDK context helper missing", "falling back to App runtime wire protocol");
    }
    if (!context) {
      const response = await runtimeRequest({ type: "cohub.app.context" }, 8000);
      context = response?.context || null;
      if (context) log("ok", "Wire context loaded", context.app.slug);
    }
    if (!context) throw new Error("No App context. Publish this directory as a Cohub App to enable its runtime.");
    applyContext(context, "pull");
    return context;
  });
}

async function wireContext() {
  return run("wire", async () => {
    const response = await runtimeRequest({ type: "cohub.app.context" }, 8000);
    if (!response?.context) throw new Error("No direct runtime context response.");
    applyContext(response.context, "wire");
    log("ok", "Wire context loaded", response.context.app.slug);
    return response.context;
  });
}

async function getAppTokenRaw(forceRefresh = false) {
  if (state.token && !forceRefresh) return state.token;
  const response = await runtimeRequest({ type: "cohub.app.token", forceRefresh }, 20000);
  if (!response?.token) return null;
  applyToken(response.token);
  return response.token;
}

async function getRuntimeToken(forceRefresh = false) {
  return run("token", async () => {
    const token = await getAppTokenRaw(forceRefresh);
    if (!token) throw new Error("No token returned. Sign in and open the published App.");
    log("ok", forceRefresh ? "Runtime token refreshed" : "Runtime token minted", `${token.length} chars`);
    return token;
  });
}

async function ensureSpace() {
  if (!state.context) await sdkContext();
  if (!state.space) state.space = state.client.space(state.context.space.id);
  return state.space;
}

async function spaceConfig() {
  return run("config", async () => {
    const space = await ensureSpace();
    const result = await space.getConfig();
    log("ok", "space.getConfig() accepted", JSON.stringify(result.config?.sandbox || result).slice(0, 180));
    return result;
  });
}

async function fileTree() {
  return run("files", async () => {
    const space = await ensureSpace();
    const path = $("treePath").value.trim();
    const result = await space.files.list(path);
    const count = Array.isArray(result.entries) ? result.entries.length : "unknown";
    log("ok", "space.files.list() accepted", `${count} entries`);
    return result;
  });
}

async function sessionsList() {
  return run("sessions", async () => {
    const space = await ensureSpace();
    const result = await space.sessions.list({ limit: 5 });
    const count = Array.isArray(result.sessions) ? result.sessions.length : "unknown";
    log("ok", "space.sessions.list() accepted", `${count} sessions`);
    return result;
  });
}

const DEFAULT_AUTH_REASON = "App SDK Lab wants to verify viewer-granted prompts and account access through the Cohub SDK.";

const ACCOUNT_SCOPES = new Set(["user.space.list", "user.session.list", "user.taskrun.list", "user.usage.read", "space.create"]);

// Space-bound consent needs an explicit target. Prefer where the App is
// actually running, and never silently fall back to the App's own Space;
// ask the viewer to pick when nothing is known.
function resolveSpaceTarget() {
  const spaceId = state.context?.shell?.space?.id || state.context?.invocation?.spaceId;
  return spaceId ? { kind: "space", spaceId } : { kind: "pick-space" };
}

function authorizationSummary(result) {
  if (result.target.kind !== "space") return result.resolution;
  return `${result.resolution} → ${result.target.name || result.target.spaceId}`;
}

async function authorizeScopes(scopes, reason, options = {}) {
  const client = await ensureClient();
  if (typeof client.auth?.authorize !== "function") throw new Error("This SDK build does not expose auth.authorize().");
  const { target: requestedTarget, ...rest } = options;
  const target = requestedTarget
    ?? (scopes.every((scope) => ACCOUNT_SCOPES.has(scope)) ? { kind: "account" } : resolveSpaceTarget());
  const result = await client.auth.authorize({ target, scopes, reason, ...rest });
  if (result.status === "denied") log("warn", `auth.authorize() denied (${result.code})`, scopes.join(", "));
  return result;
}

async function requestAuth(scopes, reason = DEFAULT_AUTH_REASON) {
  return run("auth", async () => {
    const result = await authorizeScopes(scopes, reason);
    if (result.status !== "granted") throw new Error("Authorization was cancelled or denied.");
    log("ok", "cohub.auth.authorize() granted", `${scopes.join(", ")} · ${authorizationSummary(result)}`);
    return result;
  });
}

// One consent: the viewer picks a Space and grants the scopes on it. The
// result names the actual target, so the app knows exactly where it may act.
async function requestSpaceAuth(alwaysAsk = false) {
  return run("authSpace", async () => {
    const result = await authorizeScopes(
      ["file.view", "session.view"],
      "App SDK Lab reads the Space you pick to demo per-space viewer grants.",
      { target: { kind: "pick-space" }, ...(alwaysAsk ? { alwaysAsk: true } : {}) },
    );
    if (result.status !== "granted" || result.target.kind !== "space") throw new Error("Authorization was cancelled or denied.");
    log("ok", "cohub.auth.authorize({ target: 'pick-space' }) granted", `${result.target.name || "unnamed"} (${result.target.spaceId})`);
    // Prove the grant end-to-end with a scoped read on the picked Space.
    const picked = state.client.space(result.target.spaceId);
    const files = await picked.files.list();
    const count = Array.isArray(files.entries) ? files.entries.length : "unknown";
    log("ok", "picked space.files.list() accepted", `${count} entries`);
    return result;
  });
}

// alwaysAsk skips silent reuse: the consent dialog opens even when a previous
// grant already covers the scopes, so the viewer can re-confirm or choose
// another Space.
async function requestAuthAgain() {
  return run("authAsk", async () => {
    const result = await authorizeScopes(
      ["session.prompt.readonly"],
      "App SDK Lab asks again to demo alwaysAsk.",
      { alwaysAsk: true },
    );
    if (result.status !== "granted") throw new Error("Authorization was cancelled or denied.");
    log("ok", "auth.authorize({ alwaysAsk: true }) granted", `session.prompt.readonly · ${authorizationSummary(result)}`);
    return result;
  });
}

async function sendPrompt(accessMode) {
  return run("prompt", async () => {
    const space = await ensureSpace();
    const result = await space.prompt({
      accessMode,
      intent: "followup",
      title: "App SDK Lab",
      content: [{ type: "text", text: $("promptText").value.trim() || "Say one concise observation." }],
    });
    log("ok", `space.prompt(${accessMode}) accepted`, result.sessionId || "session created");
    return result;
  });
}

async function ensureClient() {
  if (!state.client) await createClient();
  return state.client;
}

async function ensureAccountScope(scope, reason) {
  await requestAuth([scope], reason);
}
async function accountSpaces() {
  return run("accountSpaces", async () => {
    await ensureAccountScope("user.space.list", "This probe lists your Spaces.");
    const client = await ensureClient();
    const result = await client.spaces.list();
    const list = Array.isArray(result) ? result : result.spaces ?? [];
    log("ok", "spaces.list() accepted", `${list.length} spaces`);
    return result;
  });
}

async function accountSessions() {
  return run("accountSessions", async () => {
    await ensureAccountScope("user.session.list", "This probe lists your recent sessions.");
    const client = await ensureClient();
    const result = await client.user.listSessions({ limit: 5 });
    const count = Array.isArray(result.sessions) ? result.sessions.length : "unknown";
    log("ok", "user.listSessions() accepted", `${count} sessions`);
    return result;
  });
}

async function accountUsage() {
  return run("accountUsage", async () => {
    await ensureAccountScope("user.usage.read", "This probe reads your account activity.");
    const client = await ensureClient();
    const result = await client.user.getActivity({ days: 30 });
    log("ok", "user.getActivity({ days: 30 }) accepted", `${result.summary?.totalTokens ?? 0} tokens, ${result.summary?.costTotal ?? 0}`);
    return result;
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runAppAction(action, buttonId) {
  const button = $(buttonId);
  button.disabled = true;
  $("actionOutput").textContent = `Queueing ${action}...`;
  try {
    return await run("action", async () => {
      const client = await ensureClient();
      const queued = await client.app.actions.run({
        action,
        input: { message: "Hello from the App frontend", requestedAt: new Date().toISOString() },
      });
      log("info", "App Action queued", queued.taskRunId);

      for (let attempt = 0; attempt < 120; attempt += 1) {
        const detail = await client.tasks.get(queued.taskRunId);
        if (detail.run.status === "completed") {
          const output = detail.run.result?.output ?? "";
          let rendered = output;
          try { rendered = JSON.stringify(JSON.parse(output), null, 2); } catch { /* keep raw output */ }
          $("actionOutput").textContent = rendered || "Action completed without output.";
          log("ok", "App Action completed", queued.taskRunId);
          return detail;
        }
        if (detail.run.status === "failed") {
          throw new Error(detail.run.errorMessage || "App Action failed. Inspect the Task Run for details.");
        }
        await wait(1000);
      }
      throw new Error("App Action is still running. Inspect the Task Run for its latest status.");
    });
  } finally {
    button.disabled = false;
  }
}

async function bootstrap() {
  try {
    await probeAssets();
    await importSdk();
    await createClient();
    await sdkContext();
    await getRuntimeToken(false).catch(() => null);
  } catch (error) {
    log("warn", "Bootstrap incomplete", error?.message || String(error));
  }
}

$("sdkUrl").value = DEFAULT_SDK_URL;
state.parentOrigin = detectParentOrigin();
$("modeStamp").textContent = window.parent === window ? "Standalone preview" : "Cohub iframe";
$("parentStamp").textContent = state.parentOrigin ? new URL(state.parentOrigin).host : "standalone";
log("info", "Lab loaded", window.parent === window ? "standalone" : "iframe mode");

$("assetProbe").onclick = () => probeAssets().catch(() => {});
$("importSdk").onclick = () => importSdk().catch(() => {});
$("createClient").onclick = () => createClient().catch(() => {});
$("sdkContext").onclick = () => sdkContext().catch(() => {});
$("wireContext").onclick = () => wireContext().catch(() => {});
$("runActionTs").onclick = () => runAppAction("inspect-ts", "runActionTs").catch(() => {});
$("runActionBash").onclick = () => runAppAction("inspect-bash", "runActionBash").catch(() => {});
$("getToken").onclick = () => getRuntimeToken(false).catch(() => {});
$("refreshToken").onclick = () => getRuntimeToken(true).catch(() => {});
$("spaceConfig").onclick = () => spaceConfig().catch(() => {});
$("fileTree").onclick = () => fileTree().catch(() => {});
$("sessionsList").onclick = () => sessionsList().catch(() => {});
$("authReadonly").onclick = () => requestAuth(["session.prompt.readonly"]).catch(() => {});
$("authFull").onclick = () => requestAuth(["session.prompt.fullaccess"]).catch(() => {});
$("authAccount").onclick = () => requestAuth(["user.space.list", "user.session.list", "user.usage.read"]).catch(() => {});
$("authPickSpace").onclick = () => requestSpaceAuth().catch(() => {});
$("authSwitchSpace").onclick = () => requestSpaceAuth(true).catch(() => {});
$("authAlwaysAsk").onclick = () => requestAuthAgain().catch(() => {});
$("promptReadonly").onclick = () => sendPrompt("read_only").catch(() => {});
$("promptFull").onclick = () => sendPrompt("full_access").catch(() => {});
$("accountSpacesBtn").onclick = () => accountSpaces().catch(() => {});
$("accountSessionsBtn").onclick = () => accountSessions().catch(() => {});
$("accountUsageBtn").onclick = () => accountUsage().catch(() => {});
$("incrementState").onclick = () => handleSurfaceMethod("counter.increment", { amount: 1 }).catch((error) => log("bad", "State update failed", error.message));
$("resetState").onclick = () => handleSurfaceMethod("counter.reset").catch((error) => log("bad", "State reset failed", error.message));
$("runReadSuite").onclick = async () => {
  try { await ensureSpace(); } catch (error) { log("warn", "Read suite stopped", error?.message || String(error)); return; }
  await spaceConfig().catch(() => {});
  await fileTree().catch(() => {});
  await sessionsList().catch(() => {});
};
$("bootstrap").onclick = () => bootstrap();
$("clearLog").onclick = () => { $("log").innerHTML = ""; };

bootstrap();
