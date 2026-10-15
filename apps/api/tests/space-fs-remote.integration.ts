import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import type { RpcMethod } from "@cohub/protocol/sandbox";
import type { SandboxConnection } from "../../../packages/sandbox-client/src/index.js";

process.env.LOG_LEVEL = "silent";

const sandboxClient = await import("../../../packages/sandbox-client/src/index.js");
let connection: SandboxConnection;
const mocks = [
  mock.module("@cohub/sandbox-client", { exports: {
    ...sandboxClient,
    getSandboxClientConnection: () => connection,
  } }),
  mock.module("../src/config.js", { exports: { config: {} } }),
  mock.module("../src/space-sandboxes.js", { exports: { getSpaceSandboxBySpaceId: async () => null } }),
  mock.module("../src/space-fs-cdn-cache.js", { exports: {
    buildPreparingFile: () => {}, buildUrlFileResponse: () => {}, ensureFsCdnManifest: () => {},
    enqueueFsCdnWarmForMeta: () => {}, getFreshFsCdnManifests: () => {}, shouldUseFsCdnForMeta: () => {},
    waitForFsCdnManifests: () => {},
  } }),
];
after(() => { for (const item of mocks.reverse()) item.restore(); });

const { deleteSpaceNode, moveSpaceNode, readSpaceFiles } = await import("../src/space-fs-remote.js");
const { SpaceFsError } = await import("../src/space-fs.js");
const { SandboxOfflineError } = await import("../src/space-sandbox-rpc.js");

const spaceId = "space-fs-errors";
const failureMessage = "open connection closed.txt: access is denied";

function connect(failingMethod: RpcMethod, disconnected = false) {
  const registration: ConstructorParameters<typeof sandboxClient.SandboxConnection>[6] = {
    spaceId, wsUrl: "ws://sandbox.test", identity: "api-test", started: false, generation: 0,
    activeRun: null, connection: null, resolveWaiters: [], pendingByRequestId: new Map(), requestIdByOpId: new Map(),
  };
  const socket = {
    send(data: string) {
      const request = JSON.parse(data);
      if (request.method === failingMethod && disconnected) {
        connection.dispose(new Error("connection closed"));
        return;
      }
      const base = {
        version: "1" as const, spaceId, sandboxId: "sandbox-test", timestamp: Date.now(),
        requestId: request.requestId, opId: request.requestId,
      };
      if (request.method === failingMethod) {
        connection.handleMessage({
          ...base, type: "rpc.failed", error: { code: "IO_ERROR", message: failureMessage, retryable: false },
        });
      } else {
        assert.equal(request.method, "fs.stat");
        connection.handleMessage({
          ...base, type: "rpc.completed", result: { exists: request.params.path !== "target.txt", isDirectory: false, size: 1 },
        });
      }
    },
  } as ConstructorParameters<typeof sandboxClient.SandboxConnection>[5];
  connection = new sandboxClient.SandboxConnection(spaceId, "sandbox-test", "api-test", "connection-test", { fsDelete: true, fsMove: true }, socket, registration);
}

for (const operation of [
  { method: "fs.delete", code: "delete_failed", run: () => deleteSpaceNode(spaceId, "source.txt") },
  { method: "fs.move", code: "move_failed", run: () => moveSpaceNode(spaceId, { fromPath: "source.txt", toPath: "target.txt" }) },
] as const) {
  test(`${operation.method} reports remote OS failures without marking the runtime offline`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    connect(operation.method);
    await assert.rejects(operation.run, (error: unknown) => error instanceof SpaceFsError
      && error.status === 400 && error.code === operation.code && error.message === failureMessage);
  });

  test(`${operation.method} preserves offline errors when the transport disconnects`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    connect(operation.method, true);
    await assert.rejects(operation.run, SandboxOfflineError);
  });
}

test("batch reads report remote OS failures per file", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  connect("fs.read");
  assert.deepEqual(await readSpaceFiles(spaceId, ["source.txt"]), {
    files: [], errors: [{ path: "source.txt", code: "space_fs_error", message: failureMessage, status: 500 }],
  });
});

test("batch reads preserve offline errors when the transport disconnects", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  connect("fs.read", true);
  await assert.rejects(() => readSpaceFiles(spaceId, ["source.txt"]), SandboxOfflineError);
});
