import assert from "node:assert/strict";
import { test } from "node:test";
import { CohubHttpClient } from "../src/http.js";
import {
  LocalWorkspaceRpcError,
  LocalWorkspaceUnavailableError,
  loopbackWorkspace,
  type LocalWorkspaceTransport,
} from "../src/local-workspace.js";
import type { Fetch } from "../src/transport.js";

const SPACE = "space-1";

function client(transport: Partial<LocalWorkspaceTransport> | null) {
  const remote: string[] = [];
  const fetch: Fetch = async (input, init) => {
    remote.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
    return new Response(JSON.stringify({ path: "a.txt", entries: [], size: 1, mtimeMs: 1, created: false, createdDirs: [] }), {
      headers: { "Content-Type": "application/json" },
    });
  };
  const http = new CohubHttpClient({
    baseUrl: "https://api.example.test",
    fetch,
    localWorkspace: (spaceId) => (spaceId === SPACE && transport ? { call: async () => ({}), ...transport } : null),
  });
  return { space: http.space(SPACE), remote };
}

test("a request that never reached the Runtime goes to the API", async () => {
  const { space, remote } = client({ call: async () => { throw new LocalWorkspaceUnavailableError("down"); } });
  await space.files.createDir("docs");
  assert.deepEqual(remote, ["POST /api/spaces/space-1/fs/dir"]);
});

test("a mutation the Runtime may have run is never retried through the API", async () => {
  const { space, remote } = client({
    call: async (method) => {
      if (method === "fs.stat") return { exists: true, isDirectory: false };
      throw new Error("socket hang up");
    },
  });
  await assert.rejects(space.files.delete("a.txt"), /socket hang up/);
  assert.deepEqual(remote, []);
});

const endpoint = { url: "http://127.0.0.1:1", token: "secret" };
const failing = (code: string): typeof fetch => async () => { throw new TypeError("fetch failed", { cause: { code } }); };
const answering = (status: number, body: unknown): typeof fetch => async (_input, init) => {
  assert.equal(new Headers(init?.headers).get("authorization"), "Bearer secret");
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
};

test("the loopback transport tells undelivered requests from answered ones", async () => {
  await assert.rejects(loopbackWorkspace(endpoint, failing("ECONNREFUSED")).call("fs.stat", {}), LocalWorkspaceUnavailableError);
  await assert.rejects(loopbackWorkspace(endpoint, answering(401, {})).call("fs.stat", {}), LocalWorkspaceUnavailableError);
  await assert.rejects(loopbackWorkspace(endpoint, failing("ECONNRESET")).call("fs.stat", {}), (error: unknown) =>
    error instanceof TypeError && !(error instanceof LocalWorkspaceUnavailableError));
  await assert.rejects(loopbackWorkspace(endpoint, answering(422, { error: { code: "NOT_FOUND", message: "missing" } })).call("fs.stat", {}), (error: unknown) =>
    error instanceof LocalWorkspaceRpcError && error.rpcErrorCode === "NOT_FOUND");
  assert.deepEqual(await loopbackWorkspace(endpoint, answering(200, { result: { exists: true } })).call("fs.stat", {}), { exists: true });
});
