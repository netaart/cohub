import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { RUNTIME_MAX_FRAME_BYTES } from "@neta-art/cohub";
import { harnessEnvironment, JsonLineDecoder, record, RpcProcessClosedError, type JsonRecord } from "./json-rpc.js";
import { stopProcessGroup } from "./process-group.js";
import { workbuddyHomeDirectory } from "./native/workbuddy-transcript.js";
export { workbuddySessionPath as workbuddySessionFile } from "./native/workbuddy-transcript.js";

export type WorkBuddyModel = { id: string; name: string; description?: string };
export type WorkBuddyCatalog = { models: WorkBuddyModel[]; currentModelId?: string };
export type WorkBuddyLaunch = { binary: string; args: string[]; env: NodeJS.ProcessEnv; home: string };
export type WorkBuddyProcessOptions = {
  sessionId?: string;
  /** Existing native session ID. Never points to a desktop-owned session. */
  resume?: string;
  model?: string;
  permissionMode?: "default" | "acceptEdits" | "plan";
  context?: Record<string, string>;
};
const validSessionId = (id: string) => /^[a-zA-Z0-9][a-zA-Z0-9_:-]*$/.test(id);

async function workbuddyNetworkEnvironment(home: string): Promise<NodeJS.ProcessEnv> {
  let source: string;
  try { source = await readFile(join(home, "settings.json"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  const settings: unknown = JSON.parse(source);
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("Invalid WorkBuddy settings");
  const support = (settings as JsonRecord)["http.proxySupport"];
  if (support !== undefined && (typeof support !== "string" || !["off", "on", "override", "fallback"].includes(support))) throw new Error("Invalid WorkBuddy proxy support setting");
  if (support !== "off") return {};
  // Apply the desktop's explicit direct mode before Node can capture proxyEnv
  // in its global HTTP agents. Do not change the parent Runtime's connection.
  return {
    HTTP_PROXY: undefined, HTTPS_PROXY: undefined, ALL_PROXY: undefined,
    http_proxy: undefined, https_proxy: undefined, all_proxy: undefined,
    GLOBAL_AGENT_HTTP_PROXY: undefined, GLOBAL_AGENT_HTTPS_PROXY: undefined,
    NODE_USE_ENV_PROXY: undefined, NO_PROXY: "*", no_proxy: "*", GLOBAL_AGENT_NO_PROXY: "*",
  };
}

/** Use WorkBuddy's installed product and login identity, never the independent CodeBuddy CLI. */
export async function resolveWorkBuddyLaunch(cwd: string, binary?: string, home = workbuddyHomeDirectory()): Promise<WorkBuddyLaunch> {
  if (!isAbsolute(home)) throw new Error("WORKBUDDY_HOME must be an absolute path");
  const installed = "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/dist/codebuddy.js";
  if (!binary && process.platform !== "darwin") throw new Error("WorkBuddy requires an explicit installed executable path on this platform");
  const path = binary ? resolve(cwd, binary) : installed;
  const script = [".js", ".mjs", ".cjs"].includes(extname(path).toLowerCase());
  await access(path, script || process.platform === "win32" ? constants.R_OK : constants.X_OK);
  if (!(await stat(path)).isFile()) throw new Error("WorkBuddy executable is not a file");
  // The bundled CLI resolves its own regional product layers and authentication.
  // Validate that default discovery really belongs to WorkBuddy; do not replace
  // its authenticated environment with a guessed ACC_PRODUCT_CONFIG_V3 value.
  if (!binary || path === installed) {
    const product: unknown = JSON.parse(await readFile(join(dirname(dirname(path)), "product.json"), "utf8"));
    if (record(product).productName !== "WorkBuddy" || record(record(product).authentication).id !== "workbuddy-desktop") {
      throw new Error("Installed CLI does not contain the WorkBuddy product configuration");
    }
  }
  return {
    binary: script ? process.execPath : path,
    args: script ? [path] : [],
    home,
    env: {
      ...await workbuddyNetworkEnvironment(home),
      CODEBUDDY_CONFIG_DIR: home, WORKBUDDY_CONFIG_DIR: home, CODEBUDDY_HOST: "workbuddy-desktop",
      DISABLE_AUTOUPDATER: "1", CODEBUDDY_DISABLE_CRON: "1", CODEBUDDY_DISABLE_SESSION_HISTORY_CLEANUP: "1",
      CODEBUDDY_CODE_DISABLE_SESSION_TITLE_REFRESH: "1", CODEBUDDY_CODE_DISABLE_SESSION_SUMMARY: "1",
    },
  };
}

export async function installedWorkBuddy(cwd: string, binary?: string): Promise<boolean> {
  if (!binary && process.platform !== "darwin") return false;
  try { await resolveWorkBuddyLaunch(cwd, binary); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function catalog(value: JsonRecord): WorkBuddyCatalog {
  if (!Array.isArray(value.models)) throw new Error("Invalid WorkBuddy model catalog");
  const ids = new Set<string>();
  const models = value.models.map((raw): WorkBuddyModel => {
    const entry = record(raw);
    if (typeof entry.id !== "string" || !entry.id || typeof entry.name !== "string" || !entry.name || ids.has(entry.id)) throw new Error("Invalid WorkBuddy model catalog entry");
    if (entry.description !== undefined && typeof entry.description !== "string") throw new Error("Invalid WorkBuddy model catalog description");
    ids.add(entry.id);
    return { id: entry.id, name: entry.name, ...(typeof entry.description === "string" ? { description: entry.description } : {}) };
  });
  if (value.currentModelId !== undefined && (typeof value.currentModelId !== "string" || !value.currentModelId)) throw new Error("Invalid WorkBuddy current model");
  return { models, ...(typeof value.currentModelId === "string" ? { currentModelId: value.currentModelId } : {}) };
}

/** One turn per process prevents resume/fork options being reapplied to later turns. */
export class WorkBuddyProcess {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { resolve: (value: JsonRecord) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<(event: JsonRecord) => void>();
  private failureListeners = new Set<(error: Error) => void>();
  private failure: Error | null = null;
  private closing: Promise<void> | null = null;
  private closed: Promise<void>;
  private nextId = 0;
  private initialized = false;
  private prompted = false;
  private completed = false;
  private initializePromise: Promise<WorkBuddyCatalog> | null = null;
  get processGroupId(): number | null { return this.child.pid ?? null; }
  constructor(launch: WorkBuddyLaunch, cwd: string, options: WorkBuddyProcessOptions = {}) {
    if (options.sessionId && !validSessionId(options.sessionId) || options.resume && !validSessionId(options.resume)) throw new Error("Invalid WorkBuddy session ID");
    if (options.sessionId && options.resume) throw new Error("Specify either a new WorkBuddy session ID or a resume ID");
    if (options.permissionMode && !["default", "acceptEdits", "plan"].includes(options.permissionMode)) throw new Error("Unsupported WorkBuddy permission mode");
    const args = [...launch.args, "--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--replay-user-messages", "--permission-mode", options.permissionMode ?? "default"];
    if (options.resume) args.push("--resume", options.resume);
    if (options.sessionId) args.push("--session-id", options.sessionId);
    if (options.model) args.push("--model", options.model);
    this.child = spawn(launch.binary, args, { cwd, env: { ...harnessEnvironment(), ...options.context, ...launch.env }, stdio: "pipe", detached: process.platform !== "win32" });
    this.closed = new Promise((resolve) => this.child.once("close", () => resolve()));
    const decoder = new JsonLineDecoder((value) => this.receive(value));
    this.child.stdout.on("data", (chunk: Buffer) => { try { decoder.push(chunk); } catch (error) { this.fail(error); } });
    this.child.stdout.on("end", () => { try { decoder.end(); } catch (error) { this.fail(error); } });
    // Drain diagnostic output without copying account or provider secrets into errors.
    this.child.stderr.resume();
    this.child.on("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error) => { if (!this.closing) this.fail(error); });
    this.child.once("close", (code, signal) => {
      if (this.closing) return;
      if (code !== 0 || signal || this.pending.size || this.prompted && !this.completed || !this.initialized) {
        this.fail(new Error(signal ? `WorkBuddy terminated by ${signal}` : `WorkBuddy exited (${code})${this.prompted && !this.completed ? " before a result" : ""}`));
      }
    });
  }
  private fail(value: unknown) {
    if (this.failure || this.closing) return;
    this.failure = value instanceof Error ? value : new Error(String(value));
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(this.failure); }
    this.pending.clear();
    const listeners = [...this.failureListeners];
    for (const listener of listeners) listener(this.failure);
    // Keep the rejected cleanup promise for close() callers and notify observers.
    void this.close().catch((error: unknown) => { for (const listener of listeners) listener(error instanceof Error ? error : new Error(String(error))); });
  }
  private receive(value: JsonRecord) {
    if (value.type === "error") {
      if (typeof value.error !== "string" || !value.error) throw new Error("Invalid WorkBuddy error response");
      throw new Error(`WorkBuddy request failed: ${value.error}`);
    }
    if (value.type === "control_response") {
      const response = record(value.response);
      if (typeof response.request_id !== "string") throw new Error("Invalid WorkBuddy control response ID");
      const pending = this.pending.get(response.request_id);
      if (!pending) throw new Error("Unexpected WorkBuddy control response ID");
      this.pending.delete(response.request_id); clearTimeout(pending.timer);
      if (response.subtype === "error") pending.reject(new Error(typeof response.error === "string" ? response.error : "WorkBuddy control request failed"));
      else if (response.subtype === "success" && response.response && typeof response.response === "object" && !Array.isArray(response.response)) pending.resolve(response.response as JsonRecord);
      else { const error = new Error("Invalid WorkBuddy control response"); pending.reject(error); throw error; }
      return;
    }
    if (value.type === "result") {
      if (typeof value.session_id !== "string" || typeof value.is_error !== "boolean" || (value.subtype !== "success" && value.subtype !== "error_during_execution" && value.subtype !== "error_max_turns")) throw new Error("Invalid WorkBuddy result");
      // --resume may emit a no-prompt history replay result during initialization.
      if (this.prompted) this.completed = true;
    }
    for (const listener of this.listeners) listener(value);
  }
  write(value: unknown) {
    if (this.failure) throw this.failure;
    if (this.closing || !this.child.stdin.writable) throw new RpcProcessClosedError();
    const data = `${JSON.stringify(value)}\n`;
    if (this.child.stdin.writableLength + Buffer.byteLength(data) > RUNTIME_MAX_FRAME_BYTES) throw new Error("WorkBuddy input backpressure limit exceeded");
    this.child.stdin.write(data);
  }
  initialize(timeoutMs = 30_000): Promise<WorkBuddyCatalog> {
    this.initializePromise ??= this.request("initialize", { hasPrompt: true }, timeoutMs).then((value) => { const result = catalog(value); this.initialized = true; return result; }).catch((error: unknown) => { this.fail(error); throw error; });
    return this.initializePromise;
  }
  private request(subtype: string, params: JsonRecord, timeoutMs: number): Promise<JsonRecord> {
    if (this.failure) return Promise.reject(this.failure);
    const id = `cohub-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error(`WorkBuddy ${subtype} timed out`)), timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ type: "control_request", request_id: id, request: { subtype, ...params } }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  prompt(message: JsonRecord) {
    if (!this.initialized) throw new Error("WorkBuddy must be initialized before prompting");
    if (this.prompted) throw new Error("WorkBuddy process supports only one turn");
    if (message.type !== "user" || !message.message || typeof message.message !== "object" || Array.isArray(message.message)) throw new Error("Invalid WorkBuddy user message");
    this.write(message); this.prompted = true;
  }
  denyPermission(requestId: string, reason: string) {
    if (!requestId) throw new Error("Missing WorkBuddy permission request ID");
    this.write({ type: "control_response", response: { subtype: "success", request_id: requestId, response: { allowed: false, reason, interrupt: true } } });
  }
  onEvent(listener: (event: JsonRecord) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onFailure(listener: (error: Error) => void) {
    this.failureListeners.add(listener);
    if (this.failure) queueMicrotask(() => { if (this.failure && this.failureListeners.has(listener)) listener(this.failure); });
    return () => this.failureListeners.delete(listener);
  }
  close(): Promise<void> { this.closing ??= this.closeProcess(); return this.closing; }
  private async closeProcess() {
    try { if (this.child.pid) await stopProcessGroup(this.child.pid); }
    finally {
      const error = this.failure ?? new RpcProcessClosedError();
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      this.pending.clear();
      this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy();
    }
    await this.closed;
  }
}

export async function discoverWorkBuddy(cwd: string, binary?: string): Promise<WorkBuddyCatalog & { home: string }> {
  const launch = await resolveWorkBuddyLaunch(cwd, binary);
  const process = new WorkBuddyProcess(launch, cwd);
  try { return { ...await process.initialize(), home: launch.home }; }
  finally { await process.close(); }
}
