import { displayRpcError } from "@cohub/protocol";
import {
  CURRENT_SANDBOX_FS_FEATURES,
  createSandboxSpaceFs,
  isSandboxFsRpcError,
  SpaceFsError,
  spaceFsErrorBody,
  toSpaceFsError,
  type SandboxSpaceFs,
} from "@cohub/protocol/fs";
import type { FsWriteResult, RpcRequestMap } from "@cohub/protocol/sandbox";
import { HttpError } from "./transport.js";

export class LocalWorkspaceRpcError extends Error {
  override name = "LocalWorkspaceRpcError";
  readonly rpcErrorCode: string;

  constructor(rpcErrorCode: string, message: string) {
    super(message);
    this.rpcErrorCode = rpcErrorCode;
  }
}

export class LocalWorkspaceUnavailableError extends Error {
  override name = "LocalWorkspaceUnavailableError";
}

export type LocalWorkspaceMethod = Extract<keyof RpcRequestMap, `fs.${string}` | `display.${string}`>;

export type LocalWorkspacePutOptions = { exclusive: true } | { expected: { size: number; mtimeMs: number } };

export type LocalWorkspaceTransport = {
  call(method: LocalWorkspaceMethod, params: unknown, signal?: AbortSignal): Promise<unknown>;
  open?(path: string, init?: { signal?: AbortSignal; headers?: HeadersInit }): Promise<Response>;
  put?(path: string, body: Blob, options?: LocalWorkspacePutOptions): Promise<FsWriteResult>;
  url?(path: string, version: string): string;
};

export type LocalWorkspaceResolver = (spaceId: string) => LocalWorkspaceTransport | null | Promise<LocalWorkspaceTransport | null>;

export type LocalWorkspace = {
  readonly transport: LocalWorkspaceTransport;
  readonly fs: SandboxSpaceFs;
  call<M extends LocalWorkspaceMethod>(method: M, params: RpcRequestMap[M]["params"], signal?: AbortSignal): Promise<RpcRequestMap[M]["result"]>;
  readonly open?: NonNullable<LocalWorkspaceTransport["open"]>;
  readonly put?: NonNullable<LocalWorkspaceTransport["put"]>;
};

export type LocalWorkspaces = {
  get(spaceId: string): Promise<LocalWorkspace | null>;
  /**
   * Serve on this machine when it can, otherwise through the API. A read falls
   * back on any transport failure; a mutation only when it was never delivered,
   * so it can never run twice.
   */
  run<T>(spaceId: string, mode: "read" | "write", local: (workspace: LocalWorkspace) => Promise<T>, remote: () => Promise<T>): Promise<T>;
};

/** Errors as the HTTP API would answer them. Filesystem failures are SpaceFsErrors by now, so an RPC error is a screen's. */
export function localWorkspaceHttpError(error: unknown): unknown {
  if (error instanceof SpaceFsError) {
    const body = spaceFsErrorBody(error);
    return new HttpError(body.message, error.status, body);
  }
  if (error instanceof LocalWorkspaceRpcError) {
    const mapped = displayRpcError(error.rpcErrorCode, error.message);
    if (mapped) return new HttpError(mapped.message, mapped.status, { code: mapped.code, message: mapped.message });
    return new HttpError("The display request failed.", 502, { code: "display_error", message: "The display request failed." });
  }
  return error;
}

function workspaceOf(transport: LocalWorkspaceTransport): LocalWorkspace {
  const call = ((method: LocalWorkspaceMethod, params: unknown, signal?: AbortSignal) =>
    transport.call(method, params, signal)) as LocalWorkspace["call"];
  const { open, put } = transport;
  const mapped = async <T>(operation: Promise<T>) => {
    try {
      return await operation;
    } catch (error) {
      throw toSpaceFsError(error);
    }
  };
  return {
    transport,
    call,
    ...(open ? { open: (path: string, init?: Parameters<typeof open>[1]) => mapped(open.call(transport, path, init)) } : {}),
    ...(put ? { put: (path: string, body: Blob, options?: LocalWorkspacePutOptions) => mapped(put.call(transport, path, body, options)) } : {}),
    fs: createSandboxSpaceFs({
      call: (method, params) => call(method as LocalWorkspaceMethod, params as never),
      features: async () => CURRENT_SANDBOX_FS_FEATURES,
    }),
  };
}

const canceled = (error: unknown) => ["AbortError", "TimeoutError"].includes((error as Error | null)?.name ?? "");

export function createLocalWorkspaces(resolve?: LocalWorkspaceResolver): LocalWorkspaces {
  const get = async (spaceId: string) => {
    if (!resolve) return null;
    const transport = await Promise.resolve(resolve(spaceId)).catch(() => null);
    return transport ? workspaceOf(transport) : null;
  };
  return {
    get,
    async run(spaceId, mode, local, remote) {
      const workspace = await get(spaceId);
      if (!workspace) return remote();
      try {
        return await local(workspace);
      } catch (error) {
        if (error instanceof LocalWorkspaceUnavailableError) return remote();
        const answered = error instanceof SpaceFsError || error instanceof LocalWorkspaceRpcError || isSandboxFsRpcError(error);
        if (!answered && mode === "read" && !canceled(error)) return remote();
        throw localWorkspaceHttpError(error);
      }
    },
  };
}

const UNREACHABLE = new Set(["ECONNREFUSED", "ENOENT", "EADDRNOTAVAIL", "UND_ERR_CONNECT"]);

function unreachable(error: unknown) {
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === "string" && UNREACHABLE.has(code);
}

/**
 * A Runtime's loopback API reached over HTTP, as by a CLI on the same machine.
 * `fetcher` must never use a proxy: requests carry the Runtime's token.
 */
export function loopbackWorkspace(endpoint: { url: string; token: string }, fetcher: typeof fetch): LocalWorkspaceTransport {
  const send = async (path: string, init: RequestInit = {}) => {
    let response: Response;
    try {
      response = await fetcher(new URL(path, endpoint.url), {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init.headers)), authorization: `Bearer ${endpoint.token}` },
      });
    } catch (error) {
      if (unreachable(error)) throw new LocalWorkspaceUnavailableError("The local Runtime is not reachable", { cause: error });
      throw error;
    }
    // A restarted sandbox rotates its token: nothing ran, so the API can serve it.
    if (response.status === 401) throw new LocalWorkspaceUnavailableError("The local Runtime rejected its credentials");
    return response;
  };
  const result = async (response: Response) => {
    const body = await response.json() as { result?: unknown; error?: { code: string; message: string } };
    if (body.error) throw new LocalWorkspaceRpcError(body.error.code, body.error.message);
    return body.result;
  };
  const files = (path: string, query: Record<string, string> = {}) => `/files?${new URLSearchParams({ path, ...query })}`;
  return {
    call: async (method, params, signal) => result(await send("/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, params }),
      signal,
    })),
    open: async (path, init = {}) => {
      const response = await send(files(path), init);
      if (response.status === 422) await result(response);
      return response;
    },
    put: async (path, body, options) => {
      const query: Record<string, string> = !options ? {} : "exclusive" in options
        ? { exclusive: "true" }
        : { expectedSize: String(options.expected.size), expectedMtimeMs: String(options.expected.mtimeMs) };
      return result(await send(files(path, query), { method: "PUT", body })) as Promise<FsWriteResult>;
    },
  };
}
