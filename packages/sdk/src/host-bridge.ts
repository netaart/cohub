import type { z } from "zod";
import {
  HOST_BRIDGE_ERROR,
  HOST_BRIDGE_GLOBAL,
  HOST_BRIDGE_HANDSHAKE_TIMEOUT_MS,
  type HOST_BRIDGE_METHODS,
  HOST_BRIDGE_REQUEST_TIMEOUT_MS,
  hostBridgeMessageSchema,
  hostDescriptionSchema,
  type HostBridgeCapability,
  type HostBridgeEvent,
  type HostBridgeMethod,
  type HostBridgeRequest,
  type HostBridgeResponse,
  type HostDescription,
  type HostPlatform,
} from "@cohub/protocol/host-bridge";

export type HostBridgeError = HostBridgeErrorClass;

export type HostBridgeResult<M extends HostBridgeMethod> = z.infer<
  (typeof HOST_BRIDGE_METHODS)[M]["result"]
>;

export type HostBridgeParams<M extends HostBridgeMethod> = z.infer<
  (typeof HOST_BRIDGE_METHODS)[M]["params"]
>;

export class HostBridgeErrorClass extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HostBridgeError";
    this.code = code;
  }

  get isCanceled(): boolean {
    return this.code === HOST_BRIDGE_ERROR.canceled;
  }

  get isUnsupported(): boolean {
    return this.code === HOST_BRIDGE_ERROR.unsupported;
  }
}

/** Minimal surface a host must provide (Android: web message listener). */
export type HostBridgeChannel = {
  postMessage(message: string): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
};

export type HostBridgeStatus = {
  platform: HostPlatform;
  version: number;
  hostId: string;
  capabilities: readonly HostBridgeCapability[];
};

export type HostBridgeCallOptions = { timeoutMs?: number; signal?: AbortSignal };

export type HostBridgeClient = {
  readonly status: HostBridgeStatus | null;
  readonly connected: boolean;
  ready(): Promise<HostBridgeStatus | null>;
  supports(capability: HostBridgeCapability): boolean;
  call<M extends HostBridgeMethod>(
    method: M,
    params?: HostBridgeParams<M>,
    options?: HostBridgeCallOptions,
  ): Promise<HostBridgeResult<M>>;
  onEvent(listener: (event: HostBridgeEvent) => void): () => void;
  dispose(): void;
};

type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
};

const readChannel = (): HostBridgeChannel | null => {
  const candidate = (globalThis as Record<string, unknown>)[HOST_BRIDGE_GLOBAL];
  if (!candidate || typeof candidate !== "object") return null;
  const channel = candidate as Partial<HostBridgeChannel>;
  return typeof channel.postMessage === "function" ? (channel as HostBridgeChannel) : null;
};

const parseIncoming = (data: unknown) => {
  if (typeof data === "string") {
    try {
      return hostBridgeMessageSchema.safeParse(JSON.parse(data));
    } catch {
      return { success: false as const, error: null };
    }
  }
  return hostBridgeMessageSchema.safeParse(data);
};

/**
 * Connect to the injected host, if any. With no channel this resolves `null`
 * immediately — the browser path must not pay for a host that is not there.
 *
 * Until the handshake completes every capability is absent, so a
 * half-initialised host is never mistaken for a capable one.
 */
export function createHostBridge(
  options: { channel?: HostBridgeChannel | null; handshakeTimeoutMs?: number } = {},
): HostBridgeClient {
  const channel = options.channel === undefined ? readChannel() : options.channel;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? HOST_BRIDGE_HANDSHAKE_TIMEOUT_MS;
  const pending = new Map<string, PendingCall>();
  const eventListeners = new Set<(event: HostBridgeEvent) => void>();
  let status: HostBridgeStatus | null = null;
  let disposed = false;
  let sequence = 0;
  let handshake: Promise<HostBridgeStatus | null> | null = null;

  const nextRequestId = () => {
    sequence += 1;
    const random = globalThis.crypto?.randomUUID?.().replaceAll("-", "").slice(0, 16);
    return `h${sequence}-${random ?? sequence.toString(36)}`;
  };

  const settle = (id: string, apply: (call: PendingCall) => void) => {
    const call = pending.get(id);
    if (!call) return;
    pending.delete(id);
    clearTimeout(call.timer);
    if (call.signal && call.onAbort) call.signal.removeEventListener("abort", call.onAbort);
    apply(call);
  };

  const adoptHello = (hello: HostDescription) => {
    status = {
      platform: hello.platform,
      version: hello.version,
      hostId: hello.hostId,
      capabilities: hello.capabilities,
    };
  };

  const onMessage = (event: { data: unknown }) => {
    const parsed = parseIncoming(event.data);
    if (!parsed.success) return;
    const message = parsed.data;

    if (message.type === "hello") {
      adoptHello(message);
      return;
    }

    if (message.type === "response") {
      const response: HostBridgeResponse = message;
      settle(response.id, (call) => {
        if (response.error) {
          call.reject(new HostBridgeErrorClass(response.error.code, response.error.message));
          return;
        }
        call.resolve(response.result);
      });
      return;
    }

    if (message.type === "event") {
      for (const listener of eventListeners) listener(message);
    }
  };

  if (channel && !disposed) channel.addEventListener("message", onMessage);

  const rawCall = (
    method: string,
    params: unknown,
    callOptions?: HostBridgeCallOptions,
  ): Promise<unknown> => {
    if (!channel || disposed) {
      return Promise.reject(
        new HostBridgeErrorClass(HOST_BRIDGE_ERROR.unsupported, `Host bridge method is unavailable: ${method}`),
      );
    }
    const id = nextRequestId();
    const timeoutMs = callOptions?.timeoutMs ?? HOST_BRIDGE_REQUEST_TIMEOUT_MS;
    return new Promise<unknown>((resolve, reject) => {
      const signal = callOptions?.signal;
      if (signal?.aborted) {
        reject(new HostBridgeErrorClass(HOST_BRIDGE_ERROR.canceled, "canceled before send"));
        return;
      }
      const onAbort = () =>
        settle(id, (call) =>
          call.reject(new HostBridgeErrorClass(HOST_BRIDGE_ERROR.canceled, "canceled")),
        );
      const timer = setTimeout(() => {
        settle(id, (call) =>
          call.reject(
            new HostBridgeErrorClass(HOST_BRIDGE_ERROR.failed, `Host bridge timed out: ${method}`),
          ),
        );
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer, signal, onAbort });
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      const request: HostBridgeRequest = {
        type: "request",
        id,
        method,
        ...(params === undefined ? {} : { params }),
      };
      try {
        channel.postMessage(JSON.stringify(request));
      } catch (error) {
        settle(id, (call) => call.reject(error));
      }
    });
  };

  const describe = async (): Promise<HostBridgeStatus | null> => {
    if (!channel || disposed) return null;
    try {
      const described = await rawCall("host.describe", undefined, { timeoutMs: handshakeTimeoutMs });
      const parsed = hostDescriptionSchema.safeParse(described);
      if (!parsed.success) return null;
      adoptHello(parsed.data);
      return status;
    } catch {
      // No host, or one too old to describe itself: both mean browser behaviour.
      return null;
    }
  };

  const failAll = (error: unknown) => {
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      if (call.signal && call.onAbort) call.signal.removeEventListener("abort", call.onAbort);
      call.reject(error);
    }
    pending.clear();
  };

  return {
    get status() {
      return status;
    },
    get connected() {
      return Boolean(channel) && status !== null && !disposed;
    },
    ready() {
      // Memoised: hot paths call this repeatedly and must not re-handshake.
      handshake ??= describe();
      return handshake;
    },
    supports(capability) {
      return status?.capabilities.includes(capability) ?? false;
    },
    // Broad implementation; the exported type narrows per method.
    call(method: string, params?: unknown, callOptions?: HostBridgeCallOptions) {
      if (!status) {
        return Promise.reject(
          new HostBridgeErrorClass(
            HOST_BRIDGE_ERROR.unsupported,
            `Host bridge is not connected; awaiting handshake before ${method}`,
          ),
        ) as Promise<never>;
      }
      return rawCall(method, params, callOptions) as Promise<never>;
    },
    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    dispose() {
      disposed = true;
      failAll(new HostBridgeErrorClass(HOST_BRIDGE_ERROR.failed, "Host bridge disposed"));
      eventListeners.clear();
      if (channel) channel.removeEventListener("message", onMessage);
    },
  } as HostBridgeClient;
}
