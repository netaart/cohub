import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  HOST_BRIDGE_ERROR,
  HOST_BRIDGE_METHODS,
  HOST_SERVICE_VERSION,
  HOST_SERVICE_WORKSPACE_ENDPOINT,
  HostBridgeErrorClass,
  hostBridgeRequestSchema,
  type HostBridgeCapability,
  type HostBridgeMethod,
  type HostServiceHello,
} from "@neta-art/cohub/host-bridge";
import { findLocalWorkspace } from "../runtime/local-workspace.js";
import { currentIdentityKey } from "../space.js";
import { HostAuth } from "./auth.js";
import { loginShellEnv } from "./login-env.js";
import { DeviceRuntimeHost } from "./runtime.js";
import { callLocalWorkspace } from "./workspaces.js";

export type HostEmit = (name: string, payload?: unknown) => void;

const SCREEN_PLATFORMS: readonly NodeJS.Platform[] = ["darwin", "win32"];

type Handler = (params: Record<string, unknown>) => Promise<unknown> | unknown;

const CAPABILITIES: readonly HostBridgeCapability[] = ["auth.token", "auth.signIn", "auth.session", "runtime", "runtime.keepAwake", "workspace", ...(SCREEN_PLATFORMS.includes(process.platform) ? ["display" as const] : [])];
const SPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Shells re-encode requests, and may escape what the page sized as one byte into six.
const MAX_LINE = 8 * 1024 * 1024;

const write = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);

export async function serveHost(entry = fileURLToPath(new URL("../../bin/cohub.js", import.meta.url))) {
  const emit: HostEmit = (name, payload) => write({ type: "event", name, ...(payload === undefined ? {} : { payload }) });
  let environment: Promise<NodeJS.ProcessEnv> | null = null;
  const runtime = new DeviceRuntimeHost(emit, {
    cli: entry,
    env: () => (environment ??= loginShellEnv()),
    account: currentIdentityKey,
  });
  const auth = new HostAuth(emit, () => {
    runtime.accountChanged();
    runtime.changed();
    void runtime.restore();
  });

  const handlers: Partial<Record<HostBridgeMethod, Handler>> = {
    "auth.getAccessToken": (params) => auth.accessToken(params.forceRefresh === true),
    "auth.getSessionVersion": () => auth.sessionVersion(),
    "auth.getSession": () => auth.session(),
    "auth.signIn": (params) => auth.signIn(typeof params.redirectPath === "string" ? params.redirectPath : undefined),
    "auth.signOut": async () => {
      await runtime.stopAccount().catch((error: unknown) => process.stderr.write(`Could not stop Runtimes before signing out: ${error instanceof Error ? error.message : String(error)}\n`));
      return auth.signOut();
    },
    "runtime.list": () => runtime.list(),
    "runtime.browse": (params) => runtime.browse(typeof params.path === "string" ? params.path : undefined),
    "runtime.start": (params) => runtime.connect(String(params.spaceId), String(params.root)),
    "runtime.stop": (params) => runtime.disconnect(String(params.spaceId), params.force === true),
    "runtime.keepAwake": (params) => runtime.keepAwake(typeof params.enabled === "boolean" ? params.enabled : undefined),
    ...(CAPABILITIES.includes("display") ? {
      "display.status": () => runtime.displayStatus(),
      "display.share": (params) => runtime.share(String(params.spaceId)),
      "display.stop": () => runtime.stopSharing(),
    } : {}),
    "workspace.call": (params) => callLocalWorkspace(String(params.spaceId), String(params.method), params.params),
  };
  // Asked by the shell itself to proxy file URLs; absent from hello, so a page can never reach it.
  const shellHandlers: Record<string, Handler> = {
    [HOST_SERVICE_WORKSPACE_ENDPOINT]: (params) => {
      const spaceId = String(params.spaceId ?? "");
      if (!SPACE_ID.test(spaceId)) throw new Error("A Space id is required");
      return findLocalWorkspace(spaceId);
    },
  };

  const answer = async (line: string) => {
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { return; }
    const request = hostBridgeRequestSchema.safeParse(raw);
    if (!request.success) return;
    const { id, method } = request.data;
    const fail = (code: string, message: string) => write({ type: "response", id, error: { code, message: message.slice(0, 2_000) || "Host call failed" } });
    const name = method as HostBridgeMethod;
    const shellHandler = Object.hasOwn(shellHandlers, method) ? shellHandlers[method] : undefined;
    if (shellHandler) {
      try { write({ type: "response", id, result: await shellHandler((request.data.params ?? {}) as Record<string, unknown>) ?? null }); }
      catch (error) { fail(HOST_BRIDGE_ERROR.failed, error instanceof Error ? error.message : String(error)); }
      return;
    }
    const handler = handlers[name];
    if (!handler) return fail(HOST_BRIDGE_ERROR.unsupported, `Unsupported method: ${method}`);
    const shape = HOST_BRIDGE_METHODS[name];
    const params = shape.params.safeParse(request.data.params);
    if (!params.success) return fail(HOST_BRIDGE_ERROR.failed, `Invalid params for ${method}`);
    try {
      const result = await handler((params.data ?? {}) as Record<string, unknown>);
      write({ type: "response", id, result: shape.result.parse(result) });
    } catch (error) {
      const denied = ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "");
      const code = error instanceof HostBridgeErrorClass ? error.code : denied ? HOST_BRIDGE_ERROR.denied : HOST_BRIDGE_ERROR.failed;
      fail(code, error instanceof Error ? error.message : String(error));
    }
  };

  const hello: HostServiceHello = { type: "hello", version: HOST_SERVICE_VERSION, capabilities: [...CAPABILITIES], methods: Object.keys(handlers) };
  write(hello);
  auth.watch();
  runtime.watch();

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => { if (line.length <= MAX_LINE) void answer(line); });
  await new Promise<void>((resolve) => input.once("close", resolve));
  auth.close();
  await runtime.stopOwnSharing();
  runtime.close();
}
