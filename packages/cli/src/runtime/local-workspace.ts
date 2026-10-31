import { Agent, request } from "node:http";
import { Readable } from "node:stream";
import { loopbackWorkspace, type LocalWorkspaceResolver, type LocalWorkspaceTransport } from "@neta-art/cohub";
import { currentIdentityKey } from "../space.js";
import { controlRuntimeInstance, runtimeInstanceDirectory } from "./instance.js";

const DISCOVERY_TIMEOUT_MS = 1_500;
const NULL_BODY_STATUS = new Set([204, 304]);

/** Its own agent keeps requests off the proxy `--use-env-proxy` gives global fetch and http: they carry the Runtime's token. */
const direct = new Agent({ keepAlive: true });

const loopbackFetch: typeof fetch = (input, init = {}) => new Promise((resolve, reject) => {
  const client = request(String(input), { agent: direct, method: init.method ?? "GET", headers: Object.fromEntries(new Headers(init.headers)), signal: init.signal ?? undefined }, (response) => {
    const headers = new Headers(Object.entries(response.headers).flatMap(([name, value]) => [value ?? []].flat().map((item): [string, string] => [name, item])));
    const status = response.statusCode ?? 502;
    resolve(new Response(NULL_BODY_STATUS.has(status) ? null : Readable.toWeb(response) as ReadableStream, { status, headers }));
  });
  client.on("error", (cause) => reject(new TypeError("fetch failed", { cause })));
  const { body } = init;
  if (body instanceof Blob) Readable.from(body.stream()).on("error", (error) => client.destroy(error)).pipe(client);
  else client.end(typeof body === "string" ? body : undefined);
});

export const connectLocalWorkspace = (endpoint: Endpoint) => loopbackWorkspace(endpoint, loopbackFetch);

type Endpoint = { url: string; token: string };

const isEndpoint = (value: unknown): value is Endpoint => {
  const endpoint = value as Partial<Endpoint> | null;
  return typeof endpoint?.token === "string" && typeof endpoint.url === "string" && /^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint.url);
};

export async function findLocalWorkspace(spaceId: string): Promise<Endpoint | null> {
  const identity = currentIdentityKey();
  if (!identity) return null;
  const response = await controlRuntimeInstance(runtimeInstanceDirectory(identity, spaceId), "workspace", {}, DISCOVERY_TIMEOUT_MS).catch(() => null);
  return isEndpoint(response?.result) ? response.result : null;
}

const found = new Map<string, Promise<LocalWorkspaceTransport | null>>();

/**
 * Files and displays of a Space this machine serves go straight to its Runtime,
 * looked up once per account and process. Only the signed-in owner goes direct: a scoped
 * execution token stays on the API that enforces its scope, as does
 * `COHUB_NO_DIRECT=1`.
 */
export const resolveLocalWorkspace: LocalWorkspaceResolver = (spaceId) => {
  if (process.env.COHUB_NO_DIRECT === "1" || process.env.COHUB_EXECUTION_TOKEN?.trim()) return null;
  const key = `${currentIdentityKey()}\0${spaceId}`;
  let workspace = found.get(key);
  if (!workspace) {
    workspace = findLocalWorkspace(spaceId).then((endpoint) => (endpoint ? connectLocalWorkspace(endpoint) : null));
    found.set(key, workspace);
  }
  return workspace;
};
