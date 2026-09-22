import { request } from "node:http";
import { isAbsolute } from "node:path";
import {
  SEARCH_DOCUMENT_PROTOCOL_VERSION,
  type SearchIndexStatus,
  type SearchMutationBatch,
  type SearchQuery,
  type SearchQueryResult,
} from "@cohub/protocol/search";

const MAX_BYTES = 32 * 1024 * 1024;

export class SearchIndexError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "SearchIndexError";
  }
}

/** Trusted, local producers only. The socket is not a browser or public API. */
export class SearchIndexClient {
  private readonly timeoutMs: number;

  constructor(private readonly socketPath: string, options: { timeoutMs?: number } = {}) {
    if (!isAbsolute(socketPath)) throw new Error("Search socket path must be absolute / 搜索 socket 必须使用绝对路径");
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("Search timeout must be a positive integer / 搜索超时必须为正整数");
    }
  }

  status(signal?: AbortSignal): Promise<SearchIndexStatus> {
    return this.send("GET", "/status", undefined, signal);
  }

  /** Resolves only after durable commit and reader refresh; does not auto-retry. */
  apply(batch: SearchMutationBatch, signal?: AbortSignal): Promise<SearchIndexStatus> {
    return this.send("POST", "/documents/apply", batch, signal);
  }

  query(query: SearchQuery, signal?: AbortSignal): Promise<SearchQueryResult> {
    return this.send("POST", "/query", query, signal);
  }

  private async send<T extends SearchIndexStatus>(method: string, path: string, payload?: unknown, signal?: AbortSignal): Promise<T> {
    const body = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload));
    if (body && body.length > MAX_BYTES) throw new Error("Search request exceeds 32 MiB / 搜索请求超过 32 MiB");
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    return new Promise<T>((resolve, reject) => {
      const req = request({
        socketPath: this.socketPath,
        path,
        method,
        signal: combinedSignal,
        headers: body ? { "content-type": "application/json", "content-length": body.length } : undefined,
      }, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("error", reject);
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            const error = new Error("Search response exceeds 32 MiB / 搜索响应超过 32 MiB");
            response.destroy(error);
            req.destroy(error);
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new SearchIndexError(status, text));
            return;
          }
          try {
            const parsed: unknown = JSON.parse(text);
            if (!parsed || typeof parsed !== "object" || !("protocolVersion" in parsed) || parsed.protocolVersion !== SEARCH_DOCUMENT_PROTOCOL_VERSION) {
              throw new Error("Incompatible search document protocol / 搜索文档协议不兼容");
            }
            // The owned binary serializes this versioned contract. Input field
            // validation and cursor ordering are enforced by the engine.
            resolve(parsed as T);
          } catch (error) {
            reject(error);
          }
        });
      });
      req.on("error", reject);
      req.end(body);
    });
  }
}
