export type CohubConsoleLevel =
  | "debug"
  | "error"
  | "info"
  | "log"
  | "trace"
  | "warn";

export type CohubNetworkKind =
  | "eventsource"
  | "fetch"
  | "resource"
  | "websocket"
  | "xhr";

export type CohubNetworkPhase =
  | "abort"
  | "close"
  | "error"
  | "line"
  | "message"
  | "open"
  | "request"
  | "response"
  | "timeout";

export interface CohubDebuggerOptions {
  enabled?: boolean;
  maxConsoleEntries?: number;
  maxNetworkEntries?: number;
  maxPayloadBytes?: number;
  maxLineBytes?: number;
  maxResponseCaptureBytes?: number;
  captureHeaders?: boolean;
  captureRequestBody?: boolean;
  captureResponseBody?: boolean;
  redactHeaders?: string[];
}

export interface CohubDebuggerHandle {
  exportLog: () => CohubDebugLogPackage;
  exportHar: () => CohubDebugHar;
  clear: () => void;
  stop: () => void;
}

export interface CohubDebugLogPackage {
  version: 1;
  exportedAt: string;
  startedAt: string;
  userAgent?: string;
  url?: string;
  options: Required<CohubDebuggerOptions>;
  console: CohubConsoleEntry[];
  network: CohubNetworkEntry[];
  dropped: {
    console: number;
    network: number;
  };
}

export interface CohubConsoleEntry {
  id: number;
  at: string;
  elapsedMs: number;
  level: CohubConsoleLevel;
  args: SerializedValue[];
  stack?: string;
}

export interface CohubNetworkEntry {
  id: number;
  connectionId: string;
  at: string;
  elapsedMs: number;
  kind: CohubNetworkKind;
  phase: CohubNetworkPhase;
  method?: string;
  url: string;
  status?: number;
  statusText?: string;
  durationMs?: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  direction?: "incoming" | "outgoing";
  source?: "instrumentation" | "performance";
  initiatorType?: string;
  lineNumber?: number;
  sizeBytes?: number;
  truncated?: boolean;
  eventName?: string;
  payload?: SerializedValue | string;
  bodyCaptureSkipped?: boolean;
  error?: string;
  close?: {
    code: number;
    reason: string;
    wasClean: boolean;
  };
}

export interface CohubDebugHar {
  log: {
    version: "1.2";
    creator: {
      name: "@neta-art/cohub/debugger";
      version: string;
    };
    browser?: {
      name: string;
      version: string;
    };
    pages: HarPage[];
    entries: HarEntry[];
    _cohub?: {
      exportedAt: string;
      startedAt: string;
      dropped: {
        console: number;
        network: number;
      };
    };
  };
}

export interface HarPage {
  startedDateTime: string;
  id: string;
  title: string;
  pageTimings: {
    onContentLoad: number;
    onLoad: number;
  };
}

export interface HarEntry {
  pageref: string;
  startedDateTime: string;
  time: number;
  request: HarRequest;
  response: HarResponse;
  cache: Record<string, never>;
  timings: HarTimings;
  serverIPAddress: string;
  connection: string;
  _resourceType: string;
  _cohubConnectionId: string;
  _cohubKind: CohubNetworkKind;
  _cohubSource?: "instrumentation" | "performance";
  _cohubEntries: CohubNetworkEntry[];
  _cohubMessages?: HarCohubMessage[];
  _webSocketMessages?: HarWebSocketMessage[];
}

export interface HarRequest {
  method: string;
  url: string;
  httpVersion: string;
  cookies: HarCookie[];
  headers: HarNameValuePair[];
  queryString: HarNameValuePair[];
  headersSize: number;
  bodySize: number;
  postData?: HarPostData;
}

export interface HarResponse {
  status: number;
  statusText: string;
  httpVersion: string;
  cookies: HarCookie[];
  headers: HarNameValuePair[];
  content: HarContent;
  redirectURL: string;
  headersSize: number;
  bodySize: number;
}

export interface HarNameValuePair {
  name: string;
  value: string;
}

export interface HarCookie extends HarNameValuePair {
  path?: string;
  domain?: string;
  expires?: string | null;
  httpOnly?: boolean;
  secure?: boolean;
}

export interface HarPostData {
  mimeType: string;
  text: string;
  params: HarNameValuePair[];
}

export interface HarContent {
  size: number;
  mimeType: string;
  text?: string;
  encoding?: string;
}

export interface HarTimings {
  blocked: number;
  dns: number;
  connect: number;
  send: number;
  wait: number;
  receive: number;
  ssl: number;
}

export interface HarCohubMessage {
  time: string;
  direction?: "incoming" | "outgoing";
  lineNumber?: number;
  eventName?: string;
  data: string;
}

export interface HarWebSocketMessage {
  type: "receive" | "send";
  time: number;
  opcode: number;
  data: string;
}

export type SerializedValue =
  | null
  | boolean
  | number
  | string
  | SerializedValue[]
  | {
      [key: string]: SerializedValue;
    };

const DEFAULT_OPTIONS: Required<CohubDebuggerOptions> = {
  enabled: true,
  maxConsoleEntries: 1_000,
  maxNetworkEntries: 5_000,
  maxPayloadBytes: 64 * 1024,
  maxLineBytes: 16 * 1024,
  maxResponseCaptureBytes: 256 * 1024,
  captureHeaders: true,
  captureRequestBody: true,
  captureResponseBody: true,
  redactHeaders: ["authorization", "cookie", "set-cookie", "x-api-key"],
};

const consoleLevels: CohubConsoleLevel[] = [
  "debug",
  "error",
  "info",
  "log",
  "trace",
  "warn",
];

const globalKey = "__cohubDebuggerState__";
const textEncoder = new TextEncoder();

interface RingBuffer<T> {
  push: (entry: T) => void;
  clear: () => void;
  toArray: () => T[];
  getDropped: () => number;
}

interface DebuggerState {
  options: Required<CohubDebuggerOptions>;
  startedAtMs: number;
  startedAt: string;
  consoleBuffer: RingBuffer<CohubConsoleEntry>;
  networkBuffer: RingBuffer<CohubNetworkEntry>;
  instrumentedRequestUrls: Set<string>;
  performanceResourceKeys: Set<string>;
  nextConsoleId: number;
  nextNetworkId: number;
  nextConnectionId: number;
  originals: Originals;
  installed: boolean;
}

interface Originals {
  console: Partial<Record<CohubConsoleLevel, (...args: unknown[]) => void>>;
  fetch?: typeof fetch;
  XMLHttpRequest?: typeof XMLHttpRequest;
  xhrOpen?: typeof XMLHttpRequest.prototype.open;
  xhrSend?: typeof XMLHttpRequest.prototype.send;
  xhrSetRequestHeader?: typeof XMLHttpRequest.prototype.setRequestHeader;
  EventSource?: typeof EventSource;
  WebSocket?: typeof WebSocket;
  performanceObserver?: PerformanceObserver;
}

interface XhrMetadata {
  id: string;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  startedAtMs?: number;
  responseLineCount: number;
  lastResponseLength: number;
  pendingResponseLine: string;
}

interface EventListenerRecord {
  type: string;
  listener: EventListenerOrEventListenerObject | null;
  options?: boolean | AddEventListenerOptions;
  wrappedListener: EventListener;
}

export function startCohubDebugger(
  options: CohubDebuggerOptions = {},
): CohubDebuggerHandle {
  const state = getOrCreateState(options);
  state.options = normalizeOptions({
    ...state.options,
    ...options,
  });

  if (state.installed || !state.options.enabled) {
    return createHandle(state);
  }

  installConsoleCollector(state);
  installFetchCollector(state);
  installXhrCollector(state);
  installEventSourceCollector(state);
  installWebSocketCollector(state);
  installPerformanceCollector(state);
  state.installed = true;

  return createHandle(state);
}

export function exportCohubDebugLog(): CohubDebugLogPackage {
  return createLogPackage(getOrCreateState());
}

export function exportCohubDebugHar(): CohubDebugHar {
  return createHarPackage(getOrCreateState());
}

export function clearCohubDebugLog(): void {
  const state = getOrCreateState();
  state.consoleBuffer.clear();
  state.networkBuffer.clear();
}

export function stopCohubDebugger(): void {
  const state = getExistingState();
  if (!state?.installed) {
    return;
  }

  for (const level of consoleLevels) {
    const original = state.originals.console[level];
    if (original) {
      console[level] = original as Console[typeof level];
    }
  }

  if (state.originals.fetch) {
    globalThis.fetch = state.originals.fetch;
  }

  if (state.originals.XMLHttpRequest) {
    globalThis.XMLHttpRequest = state.originals.XMLHttpRequest;
  }

  if (
    state.originals.xhrOpen &&
    state.originals.xhrSend &&
    state.originals.xhrSetRequestHeader &&
    globalThis.XMLHttpRequest
  ) {
    XMLHttpRequest.prototype.open = state.originals.xhrOpen;
    XMLHttpRequest.prototype.send = state.originals.xhrSend;
    XMLHttpRequest.prototype.setRequestHeader =
      state.originals.xhrSetRequestHeader;
  }

  if (state.originals.EventSource) {
    globalThis.EventSource = state.originals.EventSource;
  }

  if (state.originals.WebSocket) {
    globalThis.WebSocket = state.originals.WebSocket;
  }

  state.originals.performanceObserver?.disconnect();
  state.originals.performanceObserver = undefined;
  state.installed = false;
}

function installConsoleCollector(state: DebuggerState): void {
  for (const level of consoleLevels) {
    const original = console[level]?.bind(console);
    if (!original) {
      continue;
    }

    state.originals.console[level] = original;
    console[level] = ((...args: unknown[]) => {
      appendConsole(state, level, args);
      original(...args);
    }) as Console[typeof level];
  }
}

function installFetchCollector(state: DebuggerState): void {
  if (typeof globalThis.fetch !== "function") {
    return;
  }

  const originalFetch = globalThis.fetch.bind(globalThis);
  state.originals.fetch = globalThis.fetch;

  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const connectionId = nextConnectionId(state, "fetch");
    const startedAtMs = Date.now();
    const requestInfo = normalizeFetchRequest(input, init, state.options);
    state.instrumentedRequestUrls.add(requestInfo.url);

    appendNetwork(state, {
      connectionId,
      kind: "fetch",
      phase: "request",
      method: requestInfo.method,
      url: requestInfo.url,
      requestHeaders: requestInfo.headers,
      payload: requestInfo.body,
      sizeBytes: requestInfo.bodySizeBytes,
      truncated: requestInfo.bodyTruncated,
    });

    try {
      const response = await originalFetch(input, init);
      const durationMs = Date.now() - startedAtMs;
      const responseUrl = normalizeHarUrl(response.url || requestInfo.url);
      state.instrumentedRequestUrls.add(responseUrl);
      const responseHeaders = state.options.captureHeaders
        ? headersToRecord(response.headers, state.options)
        : undefined;
      const responseBodyCaptureSkipped = isResponseBodyCaptureSkipped(
        response,
        state.options,
      );

      appendNetwork(state, {
        connectionId,
        kind: "fetch",
        phase: "response",
        method: requestInfo.method,
        url: responseUrl,
        status: response.status,
        statusText: response.statusText,
        durationMs,
        responseHeaders,
        bodyCaptureSkipped: responseBodyCaptureSkipped,
      });

      collectFetchResponseBody(
        state,
        connectionId,
        requestInfo.method,
        responseUrl,
        response,
      );

      return response;
    } catch (error) {
      appendNetwork(state, {
        connectionId,
        kind: "fetch",
        phase: "error",
        method: requestInfo.method,
        url: requestInfo.url,
        durationMs: Date.now() - startedAtMs,
        error: errorToString(error),
      });
      throw error;
    }
  }) as typeof fetch;
}

function installXhrCollector(state: DebuggerState): void {
  if (typeof globalThis.XMLHttpRequest !== "function") {
    return;
  }

  const metadata = new WeakMap<XMLHttpRequest, XhrMetadata>();
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  state.originals.XMLHttpRequest = globalThis.XMLHttpRequest;
  state.originals.xhrOpen = originalOpen;
  state.originals.xhrSend = originalSend;
  state.originals.xhrSetRequestHeader = originalSetRequestHeader;

  XMLHttpRequest.prototype.open = function open(
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ) {
    const normalizedUrl = normalizeHarUrl(String(url));
    metadata.set(this, {
      id: nextConnectionId(state, "xhr"),
      method: method.toUpperCase(),
      url: normalizedUrl,
      requestHeaders: {},
      responseLineCount: 0,
      lastResponseLength: 0,
      pendingResponseLine: "",
    });
    state.instrumentedRequestUrls.add(normalizedUrl);

    return originalOpen.call(this, method, url, async ?? true, username, password);
  };

  XMLHttpRequest.prototype.setRequestHeader = function setRequestHeader(
    name: string,
    value: string,
  ) {
    const meta = metadata.get(this);
    if (meta) {
      meta.requestHeaders[name] = value;
    }

    return originalSetRequestHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function send(body?: Document | XMLHttpRequestBodyInit | null) {
    const meta = metadata.get(this);

    if (meta) {
      meta.startedAtMs = Date.now();
      const bodyPreview = state.options.captureRequestBody
        ? serializeBodyPreview(body, state.options)
        : undefined;

      appendNetwork(state, {
        connectionId: meta.id,
        kind: "xhr",
        phase: "request",
        method: meta.method,
        url: meta.url,
        requestHeaders: state.options.captureHeaders
          ? redactHeaderRecord(meta.requestHeaders, state.options)
          : undefined,
        payload: bodyPreview?.payload,
        sizeBytes: bodyPreview?.sizeBytes,
        truncated: bodyPreview?.truncated,
      });

      this.addEventListener("progress", () => {
        collectXhrResponseLines(state, this, meta);
      });
      this.addEventListener("readystatechange", () => {
        collectXhrResponseLines(state, this, meta);
      });
      this.addEventListener("loadend", () => {
        collectXhrResponseLines(state, this, meta, true);
        appendNetwork(state, {
          connectionId: meta.id,
          kind: "xhr",
          phase: "response",
          method: meta.method,
          url: meta.url,
          status: this.status,
          statusText: this.statusText,
          durationMs: meta.startedAtMs ? Date.now() - meta.startedAtMs : undefined,
          responseHeaders: state.options.captureHeaders
            ? parseRawHeaders(this.getAllResponseHeaders(), state.options)
            : undefined,
          ...getXhrResponsePreview(this, state.options),
        });
      });
      this.addEventListener("error", () => {
        appendNetwork(state, {
          connectionId: meta.id,
          kind: "xhr",
          phase: "error",
          method: meta.method,
          url: meta.url,
          durationMs: meta.startedAtMs ? Date.now() - meta.startedAtMs : undefined,
        });
      });
      this.addEventListener("abort", () => {
        appendNetwork(state, {
          connectionId: meta.id,
          kind: "xhr",
          phase: "abort",
          method: meta.method,
          url: meta.url,
          durationMs: meta.startedAtMs ? Date.now() - meta.startedAtMs : undefined,
        });
      });
      this.addEventListener("timeout", () => {
        appendNetwork(state, {
          connectionId: meta.id,
          kind: "xhr",
          phase: "timeout",
          method: meta.method,
          url: meta.url,
          durationMs: meta.startedAtMs ? Date.now() - meta.startedAtMs : undefined,
        });
      });
    }

    return originalSend.call(this, body ?? null);
  };
}

function installEventSourceCollector(state: DebuggerState): void {
  if (typeof globalThis.EventSource !== "function") {
    return;
  }

  const OriginalEventSource = globalThis.EventSource;
  state.originals.EventSource = OriginalEventSource;

  const InstrumentedEventSource = function EventSource(
    this: EventSource,
    url: string | URL,
    eventSourceInitDict?: EventSourceInit,
  ) {
    const connectionId = nextConnectionId(state, "eventsource");
    const sourceUrl = normalizeHarUrl(String(url));
    const source = new OriginalEventSource(url, eventSourceInitDict);
    let lineNumber = 0;
    const listenerRecords: EventListenerRecord[] = [];
    state.instrumentedRequestUrls.add(sourceUrl);

    const appendEventSourceMessage = (eventName: string, event: MessageEvent) => {
      appendLines(state, {
        connectionId,
        kind: "eventsource",
        method: "GET",
        url: sourceUrl,
        direction: "incoming",
        eventName,
        text: event.data,
        nextLineNumber: () => {
          lineNumber += 1;
          return lineNumber;
        },
      });
    };

    appendNetwork(state, {
      connectionId,
      kind: "eventsource",
      phase: "request",
      method: "GET",
      url: sourceUrl,
      payload: eventSourceInitDict
        ? serializeValue(eventSourceInitDict, state.options)
        : undefined,
    });

    source.addEventListener("open", () => {
      appendNetwork(state, {
        connectionId,
        kind: "eventsource",
        phase: "open",
        method: "GET",
        url: sourceUrl,
      });
    });

    source.addEventListener("message", (event) => {
      appendEventSourceMessage("message", event);
    });

    source.addEventListener("error", () => {
      appendNetwork(state, {
        connectionId,
        kind: "eventsource",
        phase: "error",
        method: "GET",
        url: sourceUrl,
      });
    });

    const originalAddEventListener = source.addEventListener.bind(source);
    const originalRemoveEventListener = source.removeEventListener.bind(source);

    source.addEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) => {
      if (!listener) {
        return;
      }

      if (type === "open" || type === "message" || type === "error") {
        return originalAddEventListener(type, listener, options);
      }

      const wrappedListener: EventListener = (event) => {
        if (event instanceof MessageEvent) {
          appendEventSourceMessage(type, event);
        }

        if (typeof listener === "function") {
          return listener.call(source, event);
        }

        return listener.handleEvent(event);
      };

      listenerRecords.push({
        type,
        listener,
        options,
        wrappedListener,
      });

      return originalAddEventListener(type, wrappedListener, options);
    }) as EventSource["addEventListener"];

    source.removeEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ) => {
      if (!listener) {
        return;
      }

      const recordIndex = listenerRecords.findIndex(
        (record) => record.type === type && record.listener === listener,
      );
      const record =
        recordIndex >= 0 ? listenerRecords.splice(recordIndex, 1)[0] : undefined;

      return originalRemoveEventListener(
        type,
        record?.wrappedListener ?? listener,
        options,
      );
    }) as EventSource["removeEventListener"];

    return source;
  } as unknown as typeof EventSource;

  InstrumentedEventSource.prototype = OriginalEventSource.prototype;
  Object.defineProperty(InstrumentedEventSource, "CONNECTING", {
    value: OriginalEventSource.CONNECTING,
  });
  Object.defineProperty(InstrumentedEventSource, "OPEN", {
    value: OriginalEventSource.OPEN,
  });
  Object.defineProperty(InstrumentedEventSource, "CLOSED", {
    value: OriginalEventSource.CLOSED,
  });

  globalThis.EventSource = InstrumentedEventSource;
}

function installWebSocketCollector(state: DebuggerState): void {
  if (typeof globalThis.WebSocket !== "function") {
    return;
  }

  const OriginalWebSocket = globalThis.WebSocket;
  state.originals.WebSocket = OriginalWebSocket;

  const InstrumentedWebSocket = function WebSocket(
    this: WebSocket,
    url: string | URL,
    protocols?: string | string[],
  ) {
    const connectionId = nextConnectionId(state, "websocket");
    const socketUrl = normalizeHarUrl(String(url), "websocket");
    state.instrumentedRequestUrls.add(socketUrl);
    const socket =
      protocols === undefined
        ? new OriginalWebSocket(url)
        : new OriginalWebSocket(url, protocols);
    let lineNumber = 0;
    let userOnOpen: ((event: Event) => void) | null = null;
    let userOnMessage: ((event: MessageEvent) => void) | null = null;
    let userOnError: ((event: Event) => void) | null = null;
    let userOnClose: ((event: CloseEvent) => void) | null = null;

    appendNetwork(state, {
      connectionId,
      kind: "websocket",
      phase: "request",
      method: "GET",
      url: socketUrl,
      payload: protocols ? serializeValue({ protocols }, state.options) : undefined,
    });

    socket.addEventListener("open", () => {
      appendNetwork(state, {
        connectionId,
        kind: "websocket",
        phase: "open",
        method: "GET",
        url: socketUrl,
      });
    });

    socket.addEventListener("message", (event) => {
      appendWebSocketPayload(state, {
        connectionId,
        url: socketUrl,
        direction: "incoming",
        data: event.data,
        nextLineNumber: () => {
          lineNumber += 1;
          return lineNumber;
        },
      });
    });

    socket.addEventListener("error", () => {
      appendNetwork(state, {
        connectionId,
        kind: "websocket",
        phase: "error",
        method: "GET",
        url: socketUrl,
      });
    });

    socket.addEventListener("close", (event) => {
      appendNetwork(state, {
        connectionId,
        kind: "websocket",
        phase: "close",
        method: "GET",
        url: socketUrl,
        close: {
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
        },
      });
    });

    Object.defineProperties(socket, {
      onopen: {
        configurable: true,
        enumerable: true,
        get: () => userOnOpen,
        set: (handler) => {
          userOnOpen = typeof handler === "function" ? handler : null;
        },
      },
      onmessage: {
        configurable: true,
        enumerable: true,
        get: () => userOnMessage,
        set: (handler) => {
          userOnMessage = typeof handler === "function" ? handler : null;
        },
      },
      onerror: {
        configurable: true,
        enumerable: true,
        get: () => userOnError,
        set: (handler) => {
          userOnError = typeof handler === "function" ? handler : null;
        },
      },
      onclose: {
        configurable: true,
        enumerable: true,
        get: () => userOnClose,
        set: (handler) => {
          userOnClose = typeof handler === "function" ? handler : null;
        },
      },
    });

    socket.addEventListener("open", (event) => {
      userOnOpen?.call(socket, event);
    });
    socket.addEventListener("message", (event) => {
      userOnMessage?.call(socket, event);
    });
    socket.addEventListener("error", (event) => {
      userOnError?.call(socket, event);
    });
    socket.addEventListener("close", (event) => {
      userOnClose?.call(socket, event);
    });

    const originalSend = socket.send.bind(socket);
    socket.send = (data: string | Blob | BufferSource) => {
      appendWebSocketPayload(state, {
        connectionId,
        url: socketUrl,
        direction: "outgoing",
        data,
        nextLineNumber: () => {
          lineNumber += 1;
          return lineNumber;
        },
      });
      return originalSend(data);
    };

    return socket;
  } as unknown as typeof WebSocket;

  InstrumentedWebSocket.prototype = OriginalWebSocket.prototype;
  Object.defineProperty(InstrumentedWebSocket, "CONNECTING", {
    value: OriginalWebSocket.CONNECTING,
  });
  Object.defineProperty(InstrumentedWebSocket, "OPEN", {
    value: OriginalWebSocket.OPEN,
  });
  Object.defineProperty(InstrumentedWebSocket, "CLOSING", {
    value: OriginalWebSocket.CLOSING,
  });
  Object.defineProperty(InstrumentedWebSocket, "CLOSED", {
    value: OriginalWebSocket.CLOSED,
  });

  globalThis.WebSocket = InstrumentedWebSocket;
}

function installPerformanceCollector(state: DebuggerState): void {
  if (
    typeof performance === "undefined" ||
    typeof PerformanceObserver === "undefined"
  ) {
    return;
  }

  collectPerformanceResources(state, performance.getEntriesByType("resource"));

  const observer = new PerformanceObserver((list) => {
    collectPerformanceResources(state, list.getEntries());
  });

  try {
    observer.observe({ type: "resource", buffered: true });
    state.originals.performanceObserver = observer;
  } catch {
    observer.disconnect();
  }
}

function collectPerformanceResources(
  state: DebuggerState,
  entries: PerformanceEntryList,
): void {
  for (const entry of entries) {
    if (!(entry instanceof PerformanceResourceTiming)) {
      continue;
    }

    const key = `${entry.name}:${entry.startTime}:${entry.duration}`;
    if (state.performanceResourceKeys.has(key)) {
      continue;
    }
    state.performanceResourceKeys.add(key);

    const normalizedEntryUrl = normalizeHarUrl(entry.name);
    if (state.instrumentedRequestUrls.has(normalizedEntryUrl)) {
      continue;
    }

    const initiatorType = entry.initiatorType || "resource";
    const kind = resourceKindFromInitiator(initiatorType, entry.name);
    appendNetwork(state, {
      connectionId: nextConnectionId(state, "resource"),
      kind,
      phase: "response",
      method: "GET",
      url: normalizedEntryUrl,
      status: entry.responseStatus || undefined,
      durationMs: Math.round(entry.duration),
      source: "performance",
      initiatorType,
      sizeBytes: Math.round(
        entry.encodedBodySize || entry.transferSize || entry.decodedBodySize || 0,
      ),
      payload: serializeValue(
        {
          startTimeMs: Math.round(entry.startTime),
          responseEndMs: Math.round(entry.responseEnd),
          transferSize: entry.transferSize,
          encodedBodySize: entry.encodedBodySize,
          decodedBodySize: entry.decodedBodySize,
        },
        state.options,
      ),
    });
  }
}

function resourceKindFromInitiator(
  initiatorType: string,
  url: string,
): CohubNetworkKind {
  if (initiatorType === "fetch") {
    return "fetch";
  }
  if (initiatorType === "xmlhttprequest") {
    return "xhr";
  }
  if (initiatorType === "eventsource") {
    return "eventsource";
  }
  if (initiatorType === "websocket" || url.startsWith("ws")) {
    return "websocket";
  }
  return "resource";
}

function collectFetchResponseBody(
  state: DebuggerState,
  connectionId: string,
  method: string,
  url: string,
  response: Response,
): void {
  if (
    !state.options.captureResponseBody ||
    !response.body ||
    isResponseBodyCaptureSkipped(response, state.options)
  ) {
    return;
  }

  const clone = response.clone();
  const contentType = clone.headers.get("content-type") ?? "";

  if (contentType.includes("text/event-stream")) {
    void collectReadableStreamLines(state, {
      connectionId,
      kind: "fetch",
      method,
      url,
      response: clone,
    });
    return;
  }

  void clone.text().then(
    (text) => {
      const preview = createTextPreview(text, state.options.maxPayloadBytes);
      appendNetwork(state, {
        connectionId,
        kind: "fetch",
        phase: "line",
        method,
        url,
        direction: "incoming",
        lineNumber: 1,
        payload: preview.payload,
        sizeBytes: preview.sizeBytes,
        truncated: preview.truncated,
      });
    },
    () => {
      // The original response has already been returned to the app. Failed
      // clone reads should not affect application behavior.
    },
  );
}

async function collectReadableStreamLines(
  state: DebuggerState,
  details: {
    connectionId: string;
    kind: CohubNetworkKind;
    method: string;
    url: string;
    response: Response;
  },
): Promise<void> {
  const reader = details.response.body?.getReader();
  if (!reader) {
    return;
  }

  const decoder = new TextDecoder();
  let buffered = "";
  let lineNumber = 0;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffered += decoder.decode(value, { stream: true });
      const parts = buffered.split(/\r?\n/);
      buffered = parts.pop() ?? "";

      for (const line of parts) {
        lineNumber += 1;
        appendLine(state, {
          connectionId: details.connectionId,
          kind: details.kind,
          method: details.method,
          url: details.url,
          direction: "incoming",
          lineNumber,
          text: line,
        });
      }
    }

    buffered += decoder.decode();
    if (buffered) {
      lineNumber += 1;
      appendLine(state, {
        connectionId: details.connectionId,
        kind: details.kind,
        method: details.method,
        url: details.url,
        direction: "incoming",
        lineNumber,
        text: buffered,
      });
    }
  } catch (error) {
    appendNetwork(state, {
      connectionId: details.connectionId,
      kind: details.kind,
      phase: "error",
      method: details.method,
      url: details.url,
      error: errorToString(error),
    });
  } finally {
    reader.releaseLock();
  }
}

function collectXhrResponseLines(
  state: DebuggerState,
  xhr: XMLHttpRequest,
  meta: XhrMetadata,
  flush = false,
): void {
  if (!state.options.captureResponseBody) {
    return;
  }

  const contentType = xhr.getResponseHeader("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    return;
  }

  if (xhr.responseType && xhr.responseType !== "text") {
    return;
  }

  const text = xhr.responseText;
  if (text.length <= meta.lastResponseLength) {
    return;
  }

  const nextChunk = text.slice(meta.lastResponseLength);
  meta.lastResponseLength = text.length;

  const parts = `${meta.pendingResponseLine}${nextChunk}`.split(/\r?\n/);
  meta.pendingResponseLine = parts.pop() ?? "";

  for (const line of parts) {
    appendLine(state, {
      connectionId: meta.id,
      kind: "xhr",
      method: meta.method,
      url: meta.url,
      direction: "incoming",
      lineNumber: nextXhrLineNumber(meta),
      text: line,
    });
  }

  if (flush && meta.pendingResponseLine) {
    const line = meta.pendingResponseLine;
    meta.pendingResponseLine = "";
    appendLine(state, {
      connectionId: meta.id,
      kind: "xhr",
      method: meta.method,
      url: meta.url,
      direction: "incoming",
      lineNumber: nextXhrLineNumber(meta),
      text: line,
    });
  }
}

function appendWebSocketPayload(
  state: DebuggerState,
  details: {
    connectionId: string;
    url: string;
    direction: "incoming" | "outgoing";
    data: unknown;
    nextLineNumber: () => number;
  },
): void {
  if (typeof details.data === "string") {
    appendLines(state, {
      connectionId: details.connectionId,
      kind: "websocket",
      method: "GET",
      url: details.url,
      direction: details.direction,
      text: details.data,
      nextLineNumber: details.nextLineNumber,
    });
    return;
  }

  const payload = serializeBodyPreview(details.data, state.options) ?? {
    payload: null,
  };
  appendNetwork(state, {
    connectionId: details.connectionId,
    kind: "websocket",
    phase: "message",
    method: "GET",
    url: details.url,
    direction: details.direction,
    lineNumber: details.nextLineNumber(),
    payload: payload.payload,
    sizeBytes: payload.sizeBytes,
    truncated: payload.truncated,
  });
}

function appendLines(
  state: DebuggerState,
  details: {
    connectionId: string;
    kind: CohubNetworkKind;
    method: string;
    url: string;
    direction: "incoming" | "outgoing";
    text: string;
    eventName?: string;
    nextLineNumber: () => number;
  },
): void {
  for (const line of details.text.split(/\r?\n/)) {
    appendLine(state, {
      ...details,
      lineNumber: details.nextLineNumber(),
      text: line,
    });
  }
}

function appendLine(
  state: DebuggerState,
  details: {
    connectionId: string;
    kind: CohubNetworkKind;
    method: string;
    url: string;
    direction: "incoming" | "outgoing";
    lineNumber: number;
    text: string;
    eventName?: string;
  },
): void {
  appendNetwork(state, {
    connectionId: details.connectionId,
    kind: details.kind,
    phase: "line",
    method: details.method,
    url: details.url,
    direction: details.direction,
    lineNumber: details.lineNumber,
    eventName: details.eventName,
    ...createTextPreview(details.text, state.options.maxLineBytes),
  });
}

function nextXhrLineNumber(meta: XhrMetadata): number {
  meta.responseLineCount += 1;
  return meta.responseLineCount;
}

function normalizeFetchRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  options: Required<CohubDebuggerOptions>,
): {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: SerializedValue | string;
  bodySizeBytes?: number;
  bodyTruncated?: boolean;
} {
  const request =
    typeof Request !== "undefined" && input instanceof Request
      ? input
      : undefined;
  const method = (
    init?.method ??
    request?.method ??
    "GET"
  ).toUpperCase();
  const url =
    typeof Request !== "undefined" && input instanceof Request
      ? input.url
      : typeof URL !== "undefined" && input instanceof URL
        ? input.href
        : normalizeHarUrl(String(input));
  const headers = options.captureHeaders
    ? mergeHeaders(request?.headers, init?.headers, options)
    : undefined;
  const bodyPreview = options.captureRequestBody
    ? serializeBodyPreview(init?.body, options)
    : undefined;

  return {
    method,
    url,
    headers,
    body: bodyPreview?.payload,
    bodySizeBytes: bodyPreview?.sizeBytes,
    bodyTruncated: bodyPreview?.truncated,
  };
}

function getXhrResponsePreview(
  xhr: XMLHttpRequest,
  options: Required<CohubDebuggerOptions>,
): {
  payload?: SerializedValue | string;
  sizeBytes?: number;
  truncated?: boolean;
} {
  if (!options.captureResponseBody) {
    return {};
  }

  if (xhr.responseType && xhr.responseType !== "text") {
    return {
      payload: serializeValue(
        {
          responseType: xhr.responseType,
          note: "Non-text XHR response body was not captured.",
        },
        options,
      ),
    };
  }

  return createTextPreview(xhr.responseText, options.maxPayloadBytes);
}

function serializeBodyPreview(
  body: unknown,
  options: Required<CohubDebuggerOptions>,
): {
  payload: SerializedValue | string;
  sizeBytes?: number;
  truncated?: boolean;
} | undefined {
  if (body == null) {
    return undefined;
  }

  if (typeof body === "string") {
    return createTextPreview(body, options.maxPayloadBytes);
  }

  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
    const text = body.toString();
    return createTextPreview(text, options.maxPayloadBytes);
  }

  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return {
      payload: {
        type: "Blob",
        mimeType: body.type,
        size: body.size,
      },
      sizeBytes: body.size,
      truncated: body.size > options.maxPayloadBytes,
    };
  }

  if (typeof FormData !== "undefined" && body instanceof FormData) {
    return {
      payload: serializeFormData(body, options),
    };
  }

  if (typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer) {
    return {
      payload: {
        type: "ArrayBuffer",
        byteLength: body.byteLength,
      },
      sizeBytes: body.byteLength,
      truncated: body.byteLength > options.maxPayloadBytes,
    };
  }

  if (ArrayBuffer.isView(body)) {
    return {
      payload: {
        type: body.constructor.name,
        byteLength: body.byteLength,
      },
      sizeBytes: body.byteLength,
      truncated: body.byteLength > options.maxPayloadBytes,
    };
  }

  return {
    payload: serializeValue(body, options),
  };
}

function serializeFormData(
  formData: FormData,
  options: Required<CohubDebuggerOptions>,
): SerializedValue {
  const entries: SerializedValue[] = [];

  for (const [name, value] of formData.entries()) {
    if (typeof value === "string") {
      entries.push({
        name,
        value: truncateText(value, options.maxLineBytes),
      });
    } else {
      entries.push({
        name,
        value: serializeFormDataFileValue(value),
      });
    }
  }

  return {
    type: "FormData",
    entries,
  };
}

function serializeFormDataFileValue(value: Blob): SerializedValue {
  return {
    type: typeof File !== "undefined" && value instanceof File ? "File" : "Blob",
    fileName: "name" in value && typeof value.name === "string" ? value.name : null,
    mimeType: value.type,
    size: value.size,
  };
}

function serializeValue(
  value: unknown,
  options: Required<CohubDebuggerOptions>,
  seen = new WeakSet<object>(),
): SerializedValue {
  if (value == null) {
    return null;
  }

  if (typeof value === "string") {
    return truncateText(value, options.maxPayloadBytes);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint") {
    return `${value.toString()}n`;
  }

  if (typeof value === "symbol") {
    return value.toString();
  }

  if (typeof value === "function") {
    return `[Function ${value.name || "anonymous"}]`;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack ?? null,
    };
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof RegExp) {
    return value.toString();
  }

  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return {
      type: "Blob",
      mimeType: value.type,
      size: value.size,
    };
  }

  if (typeof Element !== "undefined" && value instanceof Element) {
    return {
      type: "Element",
      tagName: value.tagName.toLowerCase(),
      id: value.id || null,
      className:
        typeof value.className === "string"
          ? truncateText(value.className, options.maxLineBytes)
          : null,
    };
  }

  if (typeof value !== "object") {
    return String(value);
  }

  if (seen.has(value)) {
    return "[Circular]";
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return value
      .slice(0, 100)
      .map((item) => serializeValue(item, options, seen));
  }

  const output: Record<string, SerializedValue> = {};
  let count = 0;

  for (const key of Object.keys(value)) {
    if (count >= 100) {
      output.__truncatedKeys = "Only the first 100 keys were captured.";
      break;
    }

    count += 1;
    try {
      output[key] = serializeValue(
        (value as Record<string, unknown>)[key],
        options,
        seen,
      );
    } catch (error) {
      output[key] = `[Unserializable: ${errorToString(error)}]`;
    }
  }

  return output;
}

function appendConsole(
  state: DebuggerState,
  level: CohubConsoleLevel,
  args: unknown[],
): void {
  state.consoleBuffer.push({
    id: state.nextConsoleId,
    at: new Date().toISOString(),
    elapsedMs: Date.now() - state.startedAtMs,
    level,
    args: args.map((arg) => redactValue(serializeValue(arg, state.options))),
    stack: level === "trace" ? new Error().stack : undefined,
  });
  state.nextConsoleId += 1;
}

function appendNetwork(
  state: DebuggerState,
  entry: Omit<CohubNetworkEntry, "at" | "elapsedMs" | "id">,
): void {
  state.networkBuffer.push({
    ...entry,
    url: redactUrl(entry.url),
    payload:
      entry.payload === undefined ? undefined : redactValue(entry.payload),
    id: state.nextNetworkId,
    at: new Date().toISOString(),
    elapsedMs: Date.now() - state.startedAtMs,
  });
  state.nextNetworkId += 1;
}

function createHandle(state: DebuggerState): CohubDebuggerHandle {
  return {
    exportLog: () => createLogPackage(state),
    exportHar: () => createHarPackage(state),
    clear: () => {
      state.consoleBuffer.clear();
      state.networkBuffer.clear();
    },
    stop: stopCohubDebugger,
  };
}

function createLogPackage(state: DebuggerState): CohubDebugLogPackage {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    startedAt: state.startedAt,
    userAgent:
      typeof navigator === "undefined" ? undefined : navigator.userAgent,
    url: typeof location === "undefined" ? undefined : location.href,
    options: state.options,
    console: state.consoleBuffer.toArray(),
    network: state.networkBuffer.toArray(),
    dropped: {
      console: state.consoleBuffer.getDropped(),
      network: state.networkBuffer.getDropped(),
    },
  };
}

function createHarPackage(state: DebuggerState): CohubDebugHar {
  const logPackage = createLogPackage(state);
  const pageId = "page_1";
  const entriesByConnection = new Map<string, CohubNetworkEntry[]>();

  for (const entry of logPackage.network) {
    const entries = entriesByConnection.get(entry.connectionId) ?? [];
    entries.push(entry);
    entriesByConnection.set(entry.connectionId, entries);
  }

  return {
    log: {
      version: "1.2",
      creator: {
        name: "@neta-art/cohub/debugger",
        version: "1",
      },
      browser: logPackage.userAgent
        ? {
            name: "Chrome",
            version: logPackage.userAgent,
          }
        : undefined,
      pages: [
        {
          startedDateTime: logPackage.startedAt,
          id: pageId,
          title: logPackage.url ?? "Cohub",
          pageTimings: {
            onContentLoad: -1,
            onLoad: -1,
          },
        },
      ],
      entries: [...entriesByConnection.values()].map((entries) =>
        createHarEntry(pageId, entries),
      ),
      _cohub: {
        exportedAt: logPackage.exportedAt,
        startedAt: logPackage.startedAt,
        dropped: logPackage.dropped,
      },
    },
  };
}

function createHarEntry(pageId: string, entries: CohubNetworkEntry[]): HarEntry {
  const sortedEntries = [...entries].sort((a, b) => a.id - b.id);
  const firstEntry = sortedEntries[0];
  if (!firstEntry) {
    throw new Error("Cannot create a HAR entry without network entries.");
  }

  const requestEntry =
    sortedEntries.find((entry) => entry.phase === "request") ?? firstEntry;
  const responseEntry =
    [...sortedEntries].reverse().find((entry) => entry.phase === "response") ??
    [...sortedEntries].reverse().find((entry) => entry.phase === "close") ??
    [...sortedEntries].reverse().find((entry) => entry.phase === "error") ??
    requestEntry;
  const messageEntries = sortedEntries.filter(
    (entry) => entry.phase === "line" || entry.phase === "message",
  );
  const requestBodyEntry = sortedEntries.find(
    (entry) => entry.phase === "request" && entry.payload !== undefined,
  );
  const responseBodyEntry = [...messageEntries]
    .reverse()
    .find((entry) => entry.direction === "incoming");
  const durationMs = Math.max(
    responseEntry.durationMs ?? responseEntry.elapsedMs - requestEntry.elapsedMs,
    0,
  );
  const responseText =
    responseEntry.kind === "websocket"
      ? undefined
      : messageEntries.length > 0
        ? messageEntries
          .filter((entry) => entry.direction !== "outgoing")
          .map((entry) => payloadToText(entry.payload))
          .join("\n")
        : undefined;
  const contentType = guessMimeType(responseEntry.responseHeaders);
  const normalizedResponseText =
    responseText !== undefined &&
    contentType.toLowerCase().includes("text/event-stream")
      ? normalizeEventStreamText(responseText)
      : responseText;
  const responseContentSize =
    normalizedResponseText !== undefined
      ? byteLength(normalizedResponseText)
      : responseBodyEntry?.sizeBytes ?? responseEntry.sizeBytes ?? -1;

  return {
    pageref: pageId,
    startedDateTime: requestEntry.at,
    time: durationMs,
    request: {
      method: requestEntry.method ?? "GET",
      url: requestEntry.url,
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: headersRecordToHarPairs(requestEntry.requestHeaders),
      queryString: queryStringToHarPairs(requestEntry.url),
      headersSize: -1,
      bodySize: requestBodyEntry?.sizeBytes ?? -1,
      postData:
        requestBodyEntry?.payload === undefined
          ? undefined
          : {
              mimeType: guessMimeType(requestEntry.requestHeaders),
              text: payloadToText(requestBodyEntry.payload),
              params: [],
            },
    },
    response: {
      status: responseEntry.status ?? (responseEntry.kind === "websocket" ? 101 : 0),
      statusText: responseEntry.statusText ?? responseStatusText(responseEntry),
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: headersRecordToHarPairs(responseEntry.responseHeaders),
      content: {
        size: responseContentSize,
        mimeType: contentType,
        text: normalizedResponseText === undefined ? undefined : normalizedResponseText,
      },
      redirectURL: "",
      headersSize: -1,
      bodySize: responseContentSize,
    },
    cache: {},
    timings: {
      blocked: -1,
      dns: -1,
      connect: -1,
      send: 0,
      wait: durationMs,
      receive: 0,
      ssl: -1,
    },
    serverIPAddress: "",
    connection: requestEntry.connectionId,
    _resourceType: harResourceType(firstEntry),
    _cohubConnectionId: requestEntry.connectionId,
    _cohubKind: firstEntry.kind,
    _cohubSource: firstEntry.source,
    _cohubEntries: sortedEntries,
    _cohubMessages: createCohubMessages(messageEntries),
    _webSocketMessages:
      firstEntry.kind === "websocket"
        ? createWebSocketMessages(messageEntries)
        : undefined,
  };
}

function normalizeEventStreamText(text: string): string {
  if (!text) {
    return text;
  }

  if (text.endsWith("\n\n")) {
    return text;
  }

  return text.endsWith("\n") ? `${text}\n` : text;
}

function headersRecordToHarPairs(
  headers: Record<string, string> | undefined,
): HarNameValuePair[] {
  return Object.entries(headers ?? {}).map(([name, value]) => ({
    name,
    value,
  }));
}

function queryStringToHarPairs(url: string): HarNameValuePair[] {
  try {
    return [...new URL(url, "http://localhost").searchParams.entries()].map(
      ([name, value]) => ({ name, value }),
    );
  } catch {
    return [];
  }
}

function createCohubMessages(entries: CohubNetworkEntry[]): HarCohubMessage[] {
  return entries.map((entry) => ({
    time: entry.at,
    direction: entry.direction,
    lineNumber: entry.lineNumber,
    eventName: entry.eventName,
    data: payloadToText(entry.payload),
  }));
}

function createWebSocketMessages(
  entries: CohubNetworkEntry[],
): HarWebSocketMessage[] {
  return entries.map((entry) => ({
    type: entry.direction === "outgoing" ? "send" : "receive",
    time: Date.parse(entry.at) / 1000,
    opcode: typeof entry.payload === "string" ? 1 : 2,
    data: payloadToText(entry.payload),
  }));
}

function responseStatusText(entry: CohubNetworkEntry): string {
  if (entry.close) {
    return `WebSocket closed ${entry.close.code}`;
  }
  if (entry.error) {
    return entry.error;
  }
  return entry.status ? String(entry.status) : "";
}

function harResourceType(entry: CohubNetworkEntry): string {
  if (entry.kind === "websocket") {
    return "websocket";
  }
  if (entry.kind === "fetch") {
    return "fetch";
  }
  if (entry.kind === "xhr") {
    return "xhr";
  }
  if (entry.kind === "eventsource") {
    return "eventsource";
  }
  return entry.initiatorType ?? "other";
}

function guessMimeType(headers: Record<string, string> | undefined): string {
  const contentType = Object.entries(headers ?? {}).find(
    ([name]) => name.toLowerCase() === "content-type",
  )?.[1];
  return contentType ?? "text/plain";
}

function payloadToText(payload: SerializedValue | string | undefined): string {
  if (payload === undefined) {
    return "";
  }
  if (typeof payload === "string") {
    return payload;
  }
  return JSON.stringify(payload);
}

function createRingBuffer<T>(capacity: number): RingBuffer<T> {
  const items: T[] = [];
  let dropped = 0;

  return {
    push: (entry) => {
      if (items.length >= capacity) {
        items.shift();
        dropped += 1;
      }
      items.push(entry);
    },
    clear: () => {
      items.length = 0;
      dropped = 0;
    },
    toArray: () => [...items],
    getDropped: () => dropped,
  };
}

function getOrCreateState(options: CohubDebuggerOptions = {}): DebuggerState {
  const globalRecord = globalThis as typeof globalThis & {
    [globalKey]?: DebuggerState;
  };

  if (globalRecord[globalKey]) {
    return globalRecord[globalKey];
  }

  const normalizedOptions = normalizeOptions(options);
  const startedAtMs = Date.now();
  const state: DebuggerState = {
    options: normalizedOptions,
    startedAtMs,
    startedAt: new Date(startedAtMs).toISOString(),
    consoleBuffer: createRingBuffer(normalizedOptions.maxConsoleEntries),
    networkBuffer: createRingBuffer(normalizedOptions.maxNetworkEntries),
    instrumentedRequestUrls: new Set(),
    performanceResourceKeys: new Set(),
    nextConsoleId: 1,
    nextNetworkId: 1,
    nextConnectionId: 1,
    originals: {
      console: {},
    },
    installed: false,
  };

  globalRecord[globalKey] = state;
  return state;
}

function getExistingState(): DebuggerState | undefined {
  return (globalThis as typeof globalThis & { [globalKey]?: DebuggerState })[
    globalKey
  ];
}

function normalizeOptions(
  options: CohubDebuggerOptions,
): Required<CohubDebuggerOptions> {
  return {
    ...DEFAULT_OPTIONS,
    ...options,
    redactHeaders: options.redactHeaders ?? DEFAULT_OPTIONS.redactHeaders,
  };
}

function nextConnectionId(state: DebuggerState, kind: CohubNetworkKind): string {
  const id = `${kind}-${state.nextConnectionId}`;
  state.nextConnectionId += 1;
  return id;
}

function normalizeHarUrl(url: string, mode: "http" | "websocket" = "http"): string {
  if (typeof URL === "undefined") {
    return url;
  }

  const baseUrl =
    typeof location !== "undefined" && location.href
      ? location.href
      : "http://localhost/";

  try {
    const normalizedUrl = new URL(url, baseUrl);
    if (
      mode === "websocket" &&
      (normalizedUrl.protocol === "http:" || normalizedUrl.protocol === "https:")
    ) {
      normalizedUrl.protocol = normalizedUrl.protocol === "https:" ? "wss:" : "ws:";
    }
    return normalizedUrl.href;
  } catch {
    return url;
  }
}

function headersToRecord(
  headers: Headers,
  options: Required<CohubDebuggerOptions>,
): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = shouldRedactHeader(key, options) ? "[redacted]" : value;
  });
  return record;
}

function mergeHeaders(
  base: Headers | undefined,
  override: HeadersInit | undefined,
  options: Required<CohubDebuggerOptions>,
): Record<string, string> {
  const merged = new Headers(base);
  if (override) {
    new Headers(override).forEach((value, key) => {
      merged.set(key, value);
    });
  }
  return headersToRecord(merged, options);
}

function redactHeaderRecord(
  headers: Record<string, string>,
  options: Required<CohubDebuggerOptions>,
): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    redacted[key] = shouldRedactHeader(key, options) ? "[redacted]" : value;
  }
  return redacted;
}

function parseRawHeaders(
  rawHeaders: string,
  options: Required<CohubDebuggerOptions>,
): Record<string, string> {
  const record: Record<string, string> = {};

  for (const line of rawHeaders.trim().split(/\r?\n/)) {
    if (!line) {
      continue;
    }

    const separatorIndex = line.indexOf(":");
    if (separatorIndex < 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    record[key] = shouldRedactHeader(key, options) ? "[redacted]" : value;
  }

  return record;
}

function shouldRedactHeader(
  key: string,
  options: Required<CohubDebuggerOptions>,
): boolean {
  const normalizedKey = key.toLowerCase();
  return options.redactHeaders.some(
    (header) => header.toLowerCase() === normalizedKey,
  );
}

/**
 * Content-level secret redaction.
 *
 * Header-based redaction (see {@link shouldRedactHeader}) only covers a fixed
 * list of HTTP header names. Tokens and secrets that travel inside request /
 * response bodies, WebSocket messages, EventSource lines, URL query strings or
 * console output would otherwise be persisted verbatim into the debug log and
 * HAR. The helpers below add a second layer that scrubs common secret shapes
 * — JWTs, known API-key prefixes (sk-, github_pat_, ghp_…, pat_), Bearer
 * tokens and sensitive JSON keys — from any text before it enters the ring
 * buffers, so both `exportCohubDebugLog` and `exportCohubDebugHar` stay safe.
 */
const SENSITIVE_KEY_NAMES = new Set([
  "token",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "authtoken",
  "auth_token",
  "apikey",
  "api_key",
  "apitoken",
  "api_token",
  "secret",
  "password",
  "passwd",
  "gittoken",
  "git_token",
  "authorization",
  "credential",
  "privatekey",
  "private_key",
]);

// Matches `"<sensitiveKey>":"<value>"` and keeps the key, redacting only the
// value. Runs case-insensitively and tolerates snake/kebab/camel casing via
// the `[_-]?` separators (e.g. accessToken, access_token, access-token).
const SENSITIVE_KEY_PATTERN =
  /("(?:token|access[_-]?token|refresh[_-]?token|auth[_-]?token|api[_-]?key|api[_-]?token|secret|password|passwd|git[_-]?token|authorization|credential|private[_-]?key)"\s*:\s*")([^"]*)(")/gi;

// Three base64url segments separated by dots, starting with `eyJ` (the
// base64 of `{`). Catches both at+jwt and plain JWTs embedded anywhere.
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._-]+/gi;

const SECRET_PREFIX_PATTERN =
  /\b(?:sk-[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|pat_[A-Za-z0-9_]{16,})/g;

// Cheap pre-filter so the vast majority of payloads (no secret markers) skip
// the regex passes entirely. This matters for high-frequency SSE / WebSocket
// line captures.
const REDACTION_HINT =
  /eyJ|sk-|pat_|gh[pousr]_|github_pat_|bearer|token|secret|password|passwd|apikey|api_key|authorization|credential|privatekey|private_key/i;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_NAMES.has(key.toLowerCase());
}

export function redactText(text: string): string {
  if (typeof text !== "string" || text.length === 0) {
    return text;
  }
  if (!REDACTION_HINT.test(text)) {
    return text;
  }

  let out = text;
  out = out.replace(SENSITIVE_KEY_PATTERN, "$1[redacted]$3");
  out = out.replace(BEARER_PATTERN, "Bearer [redacted]");
  out = out.replace(JWT_PATTERN, "[redacted jwt]");
  out = out.replace(SECRET_PREFIX_PATTERN, "[redacted token]");
  return out;
}

export function redactValue(value: SerializedValue, key?: string): SerializedValue {
  if (typeof value === "string") {
    return key !== undefined && isSensitiveKey(key)
      ? "[redacted]"
      : redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, SerializedValue> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactValue(v as SerializedValue, k);
    }
    return out;
  }
  return value;
}

// Redact sensitive query-parameter values in-place without re-parsing the URL,
// so relative URLs and ws/wss schemes keep their original textual form.
export function redactUrl(url: string): string {
  if (typeof url !== "string" || url.indexOf("?") === -1) {
    return url;
  }
  return url.replace(
    /([?&])([^=&#?]*)=([^&#]*)/g,
    (match, sep: string, key: string) =>
      isSensitiveKey(key) || /token|secret|pass|key|auth|credential/i.test(key)
        ? `${sep}${key}=[redacted]`
        : match,
  );
}

function createTextPreview(
  text: string,
  maxBytes: number,
): { payload: string; sizeBytes: number; truncated: boolean } {
  const sizeBytes = byteLength(text);
  return {
    payload: truncateText(text, maxBytes, sizeBytes),
    sizeBytes,
    truncated: sizeBytes > maxBytes,
  };
}

function truncateText(
  text: string,
  maxBytes: number,
  knownSizeBytes = byteLength(text),
): string {
  if (knownSizeBytes <= maxBytes) {
    return text;
  }

  // encodeInto stops before the first code point that would overflow.
  const { read } = textEncoder.encodeInto(text, new Uint8Array(maxBytes));
  return `${text.slice(0, read)}\n[truncated at ${maxBytes} bytes]`;
}

function byteLength(text: string): number {
  return textEncoder.encode(text).byteLength;
}

function isResponseBodyCaptureSkipped(
  response: Response,
  options: Required<CohubDebuggerOptions>,
): boolean {
  if (!options.captureResponseBody) {
    return false;
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength === null) {
    return false;
  }

  const size = Number(contentLength);
  return Number.isFinite(size) && size > options.maxResponseCaptureBytes;
}

function errorToString(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}
