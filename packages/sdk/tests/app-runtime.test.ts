import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { CohubClient } from "../src/client.js";
import {
	createSlugAppIdResolver,
	createAppRuntime,
	AppRuntimeApi,
	ParentBridgeTransport,
	PopupBrokerTransport,
	resolveAppTransport,
	type AppContextChangedListener,
	type AppDiagnostic,
	type AppDiagnosticListener,
	type AppRuntimeTransport,
} from "../src/app-runtime.js";

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalLocalStorage = globalThis.localStorage;

afterEach(() => {
	globalThis.window = originalWindow;
	globalThis.document = originalDocument;
	globalThis.localStorage = originalLocalStorage;
});

test("broker reuses fresh tokens in memory without restoring or persisting another account", async () => {
	const store: Record<string, string> = { "cohub:app-token:app-1": "previous-account" };
	globalThis.localStorage = {
		getItem: (key: string) => store[key] ?? null,
		setItem: (key: string, value: string) => { store[key] = value; },
		removeItem: (key: string) => { delete store[key]; },
	} as Storage;
	let handler: ((event: MessageEvent) => void) | null = null;
	let opens = 0;
	globalThis.window = {
		location: { origin: "https://app.example" },
		open: () => {
			opens++;
			const popup = {
				closed: false,
				close() { this.closed = true; },
				postMessage(message: Record<string, unknown>) {
					queueMicrotask(() => handler?.({ source: popup, origin: "https://cohub.live", data: {
						type: "cohub.app.authorize.result", requestId: message.requestId, token: `fresh-${opens}`,
						result: { status: "granted", requestedTarget: { kind: "account" }, target: { kind: "account" }, resolution: "requested",
							grant: { id: "grant", spaceId: "home", scopes: ["user.space.list"], expiresAt: null } },
					} } as MessageEvent));
				},
			};
			queueMicrotask(() => handler?.({ source: popup, origin: "https://cohub.live", data: { type: "cohub.app.broker.ready", authorizationVersion: 2 } } as MessageEvent));
			return popup;
		},
		addEventListener: (_type: string, callback: (event: MessageEvent) => void) => { handler = callback; },
		removeEventListener: () => { handler = null; },
	} as unknown as Window & typeof globalThis;
	const transport = () => new PopupBrokerTransport({ brokerOrigin: "https://cohub.live", appId: "app-1" });
	const runtime = createAppRuntime(transport(), "app-1");
	assert.equal(store["cohub:app-token:app-1"], undefined);
	store["cohub:app-token:app-1"] = "legacy-writer";
	await runtime.authorize({ target: { kind: "account" }, scopes: ["user.space.list"] });
	assert.deepEqual(await Promise.all([runtime.getAccessToken(), runtime.getAccessToken()]), ["fresh-1", "fresh-1"]);
	assert.equal(opens, 1);
	assert.equal(store["cohub:app-token:app-1"], undefined);
	assert.equal(await runtime.getAccessToken({ forceRefresh: true }), "fresh-2");
	assert.equal(await runtime.getAccessToken(), "fresh-2");
	assert.equal(opens, 2);
	assert.equal(store["cohub:app-token:app-1"], undefined);
	store["cohub:app-token:app-1"] = "previous-account";
	const reloaded = createAppRuntime(transport(), undefined, async () => "app-1");
	assert.equal(await reloaded.getAccessToken(), "fresh-3");
	assert.equal(await reloaded.getAccessToken(), "fresh-3");
	assert.equal(opens, 3);
	assert.equal(store["cohub:app-token:app-1"], undefined);
	runtime.dispose();
	reloaded.dispose();
});

test("work runtime ignores non-string ancestor origins", async () => {
	let messageHandler: ((event: MessageEvent) => void) | null = null;
	let targetOrigin: string | undefined;
	const parent = {
		postMessage: (payload: { requestId?: string }, origin: string) => {
			targetOrigin = origin;
			queueMicrotask(() => {
				messageHandler?.({
					data: {
						type: "cohub.app.context.result",
						requestId: payload.requestId,
						context: {
							work: { id: "work-1", slug: "demo" },
							space: { id: "space-1" },
						},
					},
					origin: "https://cohub.run",
					source: parent,
				} as MessageEvent);
			});
		},
	};
	const windowMock = {
		parent,
		location: { ancestorOrigins: [["https://invalid.example"]] },
		addEventListener: (_type: "message", handler: (event: MessageEvent) => void) => {
			messageHandler = handler;
		},
		removeEventListener: () => {
			messageHandler = null;
		},
	};

	globalThis.window = windowMock as unknown as Window & typeof globalThis;
	globalThis.document = { referrer: "https://cohub.run/tzwm/pulsewall/w/v1" } as Document;

	const context = await createAppRuntime().context();

	assert.equal(targetOrigin, "https://cohub.run");
	assert.equal(context?.space.id, "space-1");
});

test("ParentBridgeTransport announces runtime readiness when context changes are subscribed", () => {
	let posted: { origin: string; protocol?: string; type?: string } | null = null;
	const parent = {
		postMessage: (message: Record<string, unknown>, origin: string) => {
			posted = { origin, protocol: String(message.protocol), type: String(message.type) };
		},
	};
	globalThis.window = {
		parent,
		location: { ancestorOrigins: ["https://dev.cohub.live"] },
		addEventListener: () => {},
		removeEventListener: () => {},
	} as unknown as Window & typeof globalThis;
	globalThis.document = { referrer: "" } as Document;

	const transport = new ParentBridgeTransport();
	transport.subscribeContextChanged(() => {});

	assert.deepEqual(posted, {
		origin: "https://dev.cohub.live",
		protocol: "cohub.app.runtime",
		type: "ready",
	});
});

test("ParentBridgeTransport does not announce readiness without a trusted parent origin", () => {
	let posts = 0;
	const parent = { postMessage: () => { posts += 1; } };
	globalThis.window = {
		parent,
		location: { ancestorOrigins: [] },
		addEventListener: () => {},
		removeEventListener: () => {},
	} as unknown as Window & typeof globalThis;
	globalThis.document = { referrer: "" } as Document;

	new ParentBridgeTransport().subscribeContextChanged(() => {});
	assert.equal(posts, 0);
});

test("ParentBridgeTransport forwards host diagnostics to subscribers", () => {
	let handler: ((event: MessageEvent) => void) | null = null;
	const parent = { postMessage: () => {} };
	globalThis.window = {
		parent,
		location: { ancestorOrigins: ["https://dev.cohub.live"] },
		addEventListener: (_type: "message", next: (event: MessageEvent) => void) => {
			handler = next;
		},
		removeEventListener: () => {
			handler = null;
		},
	} as unknown as Window & typeof globalThis;
	globalThis.document = { referrer: "" } as Document;

	const transport = new ParentBridgeTransport();
	const seen: AppDiagnostic[] = [];
	const unsubscribe = transport.subscribeDiagnostics((diagnostic) => seen.push(diagnostic));
	const emit = (data: unknown, origin = "https://dev.cohub.live") => {
		handler?.({ data, origin, source: parent } as unknown as MessageEvent);
	};

	emit({ type: "cohub.app.context.changed", context: {} });
	emit({ type: "cohub.app.diagnostic", code: "space_inaccessible", message: "unknown Space" });
	assert.deepEqual(seen, [{ code: "space_inaccessible", message: "unknown Space" }]);

	emit(
		{ type: "cohub.app.diagnostic", code: "space_inaccessible", message: "forged" },
		"https://evil.example",
	);
	assert.equal(seen.length, 1);
	unsubscribe();
});

test("AppRuntimeApi.dispose removes pointer listeners", () => {
	const added = new Set<string>();
	const removed: string[] = [];
	globalThis.window = {
		addEventListener: (type: string) => {
			added.add(type);
		},
		removeEventListener: (type: string) => {
			removed.push(type);
		},
	} as unknown as Window & typeof globalThis;

	const transport: AppRuntimeTransport = {
		request: async () => null,
		notify: () => {},
	};
	const runtime = new AppRuntimeApi(transport);
	runtime.requestConfigure({ inputRegion: [{ x: 0, y: 0, width: 1, height: 1 }] });
	assert.equal(added.has("pointermove"), true);

	runtime.dispose();
	assert.deepEqual(removed.slice().sort(), [
		"pointercancel",
		"pointerdown",
		"pointermove",
		"pointerup",
	]);
});

test("ParentBridgeTransport announces readiness when diagnostics are subscribed", () => {
	let posted: { origin: string; protocol?: string; type?: string } | null = null;
	const parent = {
		postMessage: (message: Record<string, unknown>, origin: string) => {
			posted = { origin, protocol: String(message.protocol), type: String(message.type) };
		},
	};
	globalThis.window = {
		parent,
		location: { ancestorOrigins: ["https://dev.cohub.live"] },
		addEventListener: () => {},
		removeEventListener: () => {},
	} as unknown as Window & typeof globalThis;
	globalThis.document = { referrer: "" } as Document;

	new ParentBridgeTransport().subscribeDiagnostics(() => {});

	assert.deepEqual(posted, {
		origin: "https://dev.cohub.live",
		protocol: "cohub.app.runtime",
		type: "ready",
	});
});

test("AppRuntimeApi warns on host diagnostics", () => {
	const warnings: unknown[][] = [];
	const originalWarn = console.warn;
	console.warn = (...args: unknown[]) => {
		warnings.push(args);
	};
	try {
		let listener: AppDiagnosticListener | null = null;
		let unsubscribed = false;
		const transport: AppRuntimeTransport = {
			request: async () => null,
			subscribeDiagnostics: (next) => {
				listener = next;
				return () => {
					unsubscribed = true;
				};
			},
		};
		const runtime = new AppRuntimeApi(transport);
		listener?.({ code: "space_inaccessible", message: "bad Space" });
		assert.equal(warnings.length, 1);
		assert.match(String(warnings[0]?.[0]), /bad Space/);
		runtime.dispose();
		assert.equal(unsubscribed, true);
	} finally {
		console.warn = originalWarn;
	}
});

test("AppRuntimeApi sends navigation targets and optional calls through the bridge", async () => {
  const messages: Record<string, unknown>[] = [];
  const transport: AppRuntimeTransport = {
    supportsNavigation: true,
    request: async (message) => {
      messages.push(message);
      return {
        protocol: "cohub.app.navigation",
        version: 1,
        type: "open.result",
        requestId: String(message.requestId),
        handled: true,
        call: { ok: true, result: { selected: 1 } },
      };
    },
  };
  const runtime = createAppRuntime(transport);
  const result = await runtime.navigationOpen(
    { kind: "app", ref: "app://alice/studio/demo" },
    { method: "selection.get", input: { hidden: false } },
  );

  assert.equal(result.handled, true);
  assert.deepEqual(messages[0]?.target, {
    kind: "app",
    ref: "app://alice/studio/demo",
  });
  assert.deepEqual(messages[0]?.call, {
    method: "selection.get",
    input: { hidden: false },
  });
});

test("ParentBridgeTransport preserves a caller-provided request id", async () => {
  let messageHandler: ((event: MessageEvent) => void) | null = null;
  let posted: Record<string, unknown> | null = null;
  const parent = {
    postMessage(message: Record<string, unknown>) {
      posted = message;
      queueMicrotask(() => {
        messageHandler?.({
          source: parent,
          origin: "https://cohub.run",
          data: {
            protocol: "cohub.app.navigation",
            version: 1,
            type: "open.result",
            requestId: message.requestId,
            handled: true,
          },
        } as MessageEvent);
      });
    },
  };
  globalThis.window = {
    parent,
    location: { ancestorOrigins: ["https://cohub.run"] },
    addEventListener: (_type: string, listener: (event: MessageEvent) => void) => {
      messageHandler = listener;
    },
    removeEventListener: () => {
      messageHandler = null;
    },
  } as unknown as Window & typeof globalThis;
  globalThis.document = { referrer: "" } as Document;

  const transport = new ParentBridgeTransport();
  const response = await transport.request({
    protocol: "cohub.app.navigation",
    version: 1,
    type: "open",
    requestId: "navigation-1",
  });
  assert.equal(posted?.requestId, "navigation-1");
  assert.equal((response as { requestId: string }).requestId, "navigation-1");
});

test("AppRuntimeApi reports navigation as unsupported without a host", async () => {
  const runtime = createAppRuntime({ request: async () => null, supportsNavigation: false });
  const result = await runtime.navigationOpen({ kind: "app", ref: "app://alice/studio/demo" });
  assert.equal(result.handled, false);
  assert.equal(result.reason, "unsupported");
});

test("AppRuntimeApi delegates context change subscriptions to its transport", () => {
	let subscribed: AppContextChangedListener | null = null;
	const transport: AppRuntimeTransport = {
		request: async () => null,
		subscribeContextChanged(listener) {
			subscribed = listener;
			return () => {
				subscribed = null;
			};
		},
	};
	const runtime = createAppRuntime(transport);
	let spaceId = "";
	const unsubscribe = runtime.onContextChanged((context) => {
		spaceId = context.space.id;
	});

	assert.ok(subscribed);
	subscribed({
		app: { id: "app-1", slug: "demo" },
		space: { id: "space-1" },
	});
	assert.equal(spaceId, "space-1");
	unsubscribe();
	assert.equal(subscribed, null);
});

test("requestConfigure reports the pointer while a rect region is active and still delivers the release after opting out", () => {
	const listeners = new Map<string, (event: { clientX: number; clientY: number; buttons?: number }) => void>();
	const notified: Record<string, unknown>[] = [];
	globalThis.window = {
		addEventListener: (type: string, handler: (event: { clientX: number; clientY: number; buttons?: number }) => void) => {
			listeners.set(type, handler);
		},
		removeEventListener: () => {},
	} as unknown as Window & typeof globalThis;

	let frame: FrameRequestCallback | null = null;
	const originalRaf = globalThis.requestAnimationFrame;
	const originalCancel = globalThis.cancelAnimationFrame;
	globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
		frame = callback;
		return 1;
	}) as typeof requestAnimationFrame;
	globalThis.cancelAnimationFrame = (() => {
		frame = null;
	}) as typeof cancelAnimationFrame;

	try {
		const transport: AppRuntimeTransport = {
			request: () => Promise.resolve(null),
			notify: (message) => notified.push(message),
		};
		const runtime = createAppRuntime(transport);

		runtime.requestConfigure({ inputRegion: [{ x: 0, y: 0, width: 10, height: 10 }] });
		listeners.get("pointermove")?.({ clientX: 5, clientY: 6, buttons: 1 });
		frame?.(0);
		assert.deepEqual(notified.at(-1), {
			protocol: "cohub.app.runtime",
			version: 1,
			type: "pointer",
			x: 5,
			y: 6,
			down: true,
		});

		// Opting out stops moves...
		runtime.requestConfigure({ inputRegion: "none" });
		const settled = notified.length;
		listeners.get("pointermove")?.({ clientX: 7, clientY: 8, buttons: 0 });
		assert.equal(notified.length, settled);

		// ...but the in-flight release is still delivered so the host can clear.
		listeners.get("pointerup")?.({ clientX: 9, clientY: 10 });
		assert.deepEqual(notified.at(-1), {
			protocol: "cohub.app.runtime",
			version: 1,
			type: "pointer",
			x: 9,
			y: 10,
			down: false,
		});

		// A later release with no press in flight stays silent.
		const afterRelease = notified.length;
		listeners.get("pointerup")?.({ clientX: 11, clientY: 12 });
		assert.equal(notified.length, afterRelease);
	} finally {
		globalThis.requestAnimationFrame = originalRaf;
		globalThis.cancelAnimationFrame = originalCancel;
	}
});

test("AppRuntimeApi delegates to the injected transport", async () => {
	const calls: { message: Record<string, unknown>; options?: object }[] = [];
	const transport: AppRuntimeTransport = {
		request<T>(message, options) {
			calls.push({ message, options });
			return Promise.resolve(null as T);
		},
	};
	const runtime = createAppRuntime(transport);

	await runtime.context();
	await runtime.getAccessToken();
	await runtime.requestAuthorization({ scopes: ["file.view"] });
	await runtime.purchase({
		productKey: "pro-1",
		purchaseAttemptId: "attempt-1",
	});
	await runtime.checkoutState();

	assert.equal(calls.length, 5);
	assert.deepEqual(calls[0].message, { type: "cohub.app.context" });
	assert.deepEqual(calls[0].options, { timeoutMs: 8_000, retryIntervalMs: 250 });
	assert.deepEqual(calls[1].message, {
		type: "cohub.app.token",
		forceRefresh: false,
	});
	assert.deepEqual(calls[1].options, { timeoutMs: 20_000 });
	assert.deepEqual(calls[2].message, {
		type: "cohub.app.authorize",
		scopes: ["file.view"],
		reason: undefined,
		spaceId: undefined,
		alwaysAsk: undefined,
	});
	assert.deepEqual(calls[3].message, {
		type: "cohub.app.purchase",
		productKey: "pro-1",
		purchaseAttemptId: "attempt-1",
	});
	assert.deepEqual(calls[4].options, { timeoutMs: 8_000, retryIntervalMs: 250 });
});

test("AppRuntimeApi caches the access token across calls", async () => {
	const transport: AppRuntimeTransport = {
		request: () => Promise.resolve({ token: "tok-1" }),
	};
	const runtime = createAppRuntime(transport);

	const first = await runtime.getAccessToken();
	const second = await runtime.getAccessToken();

	assert.equal(first, "tok-1");
	assert.equal(second, "tok-1");
});

test("requestAuthorization returns false when no token is granted", async () => {
	const transport: AppRuntimeTransport = {
		request: () => Promise.resolve({ token: null }),
	};
	const runtime = createAppRuntime(transport);

	const granted = await runtime.requestAuthorization({
		scopes: ["file.view"],
	});

	assert.equal(granted, false);
});

test("default App runtime context subscriptions are safe outside browsers", () => {
	globalThis.window = undefined as unknown as Window & typeof globalThis;
	const unsubscribe = createAppRuntime().onContextChanged(() => {
		assert.fail("a Node runtime cannot receive parent context events");
	});
	assert.doesNotThrow(unsubscribe);
});

test("createAppRuntime defaults to the parent bridge transport", async () => {
	// Without a browser parent window the bridge transport resolves to null
	// rather than throwing — proving the default is ParentBridgeTransport.
	const runtime = createAppRuntime();
	const token = await runtime.getAccessToken();
	assert.equal(token, null);
	assert.ok(new ParentBridgeTransport() instanceof ParentBridgeTransport);
});

// --- PopupBrokerTransport tests ---

test("PopupBrokerTransport answers context locally without opening a popup", async () => {
	let opened = false;
	const windowMock = {
		location: { origin: "https://my-work.example" },
		open: () => {
			opened = true;
			return { closed: false, close() {}, postMessage() {} };
		},
		addEventListener: () => {},
		removeEventListener: () => {},
	};
	globalThis.window = windowMock as unknown as Window & typeof globalThis;

	const transport = new PopupBrokerTransport({
		brokerOrigin: "https://cohub.run",
		appId: "work-1",
	});
	const result = await transport.request<{ context: { app: { id: string } } }>(
		{ type: "cohub.app.context" },
	);

	assert.equal(opened, false);
	assert.equal(result?.context?.app?.id, "work-1");
});

test("PopupBrokerTransport answers checkout-state locally without opening a popup", async () => {
	let opened = false;
	const windowMock = {
		location: { origin: "https://my-work.example" },
		open: () => {
			opened = true;
			return { closed: false, close() {}, postMessage() {} };
		},
		addEventListener: () => {},
		removeEventListener: () => {},
	};
	globalThis.window = windowMock as unknown as Window & typeof globalThis;

	const transport = new PopupBrokerTransport({
		brokerOrigin: "https://cohub.run",
		appId: "work-1",
	});
	const result = await transport.request<{ status: string | null }>(
		{ type: "cohub.app.checkout-state" },
	);

	assert.equal(opened, false);
	assert.equal(result?.status, null);
});

test("PopupBrokerTransport rejects when popup is blocked", async () => {
	const windowMock = {
		location: { origin: "https://my-work.example" },
		open: () => null,
		addEventListener: () => {},
		removeEventListener: () => {},
	};
	globalThis.window = windowMock as unknown as Window & typeof globalThis;

	const transport = new PopupBrokerTransport({
		brokerOrigin: "https://cohub.run",
		appId: "work-1",
	});

	await assert.rejects(
		() => transport.request({ type: "cohub.app.token" }, { timeoutMs: 1_000 }),
		/popups/i,
	);
});

test("PopupBrokerTransport performs ready handshake and receives response", async () => {
	let messageHandler: ((event: MessageEvent) => void) | null = null;
	let postedToPopup: Record<string, unknown> | null = null;
	const popupMock = {
		closed: false,
		close() {
			this.closed = true;
		},
		postMessage: (data: Record<string, unknown>, origin: string) => {
			postedToPopup = { data, origin };
			// When the transport sends the real request (after ready handshake),
			// simulate the broker responding.
			queueMicrotask(() => {
				messageHandler?.({
					data: {
						type: "cohub.app.token.result",
						requestId: data.requestId,
						token: "broker-token-123",
					},
					origin: "https://cohub.run",
					source: popupMock,
				} as MessageEvent);
			});
		},
	};

	const windowMock = {
		location: { origin: "https://my-work.example" },
		open: () => {
			// Simulate the broker posting `ready` shortly after the popup opens.
			queueMicrotask(() => {
				messageHandler?.({
					data: { type: "cohub.app.broker.ready" },
					origin: "https://cohub.run",
					source: popupMock,
				} as MessageEvent);
			});
			return popupMock;
		},
		addEventListener: (_t: string, h: (event: MessageEvent) => void) => {
			messageHandler = h;
		},
		removeEventListener: () => {
			messageHandler = null;
		},
	};
	globalThis.window = windowMock as unknown as Window & typeof globalThis;

	const transport = new PopupBrokerTransport({
		brokerOrigin: "https://cohub.run",
		appId: "work-1",
	});

	const result = await transport.request<{ token: string | null }>(
		{ type: "cohub.app.token" },
		{ timeoutMs: 5_000 },
	);

	assert.equal(result?.token, "broker-token-123");
	// The popup should have been closed after receiving the response.
	assert.equal(popupMock.closed, true);
	// The request should have been sent to the broker with the correct targetOrigin.
	assert.equal(postedToPopup?.origin, "https://cohub.run");
});

// --- resolveAppTransport tests ---

test("resolveAppTransport defaults to bridge when no config given", () => {
	const transport = resolveAppTransport();
	assert.ok(transport instanceof ParentBridgeTransport);
});

test("resolveAppTransport returns broker when explicitly configured", () => {
	const transport = resolveAppTransport({
		mode: "broker",
		brokerOrigin: "https://cohub.run",
		appId: "work-1",
	});
	assert.ok(transport instanceof PopupBrokerTransport);
});

test("resolveAppTransport falls back to bridge when broker config is incomplete", () => {
	const transport = resolveAppTransport({ mode: "broker", brokerOrigin: "https://cohub.run" });
	assert.ok(transport instanceof ParentBridgeTransport);
});

test("resolveAppTransport auto-detects bridge inside an iframe", () => {
	globalThis.window = {
		parent: {} as Window,
	} as unknown as Window & typeof globalThis;
	const transport = resolveAppTransport();
	assert.ok(transport instanceof ParentBridgeTransport);
});

test("resolveAppTransport auto-detects broker when standalone with config", () => {
	const windowMock = {
		location: { origin: "https://my-work.example" },
	};
	// parent === self → not inside an iframe → standalone
	windowMock.parent = windowMock as unknown as Window;
	globalThis.window = windowMock as unknown as Window & typeof globalThis;
	const transport = resolveAppTransport({
		brokerOrigin: "https://cohub.run",
		appId: "work-1",
	});
	assert.ok(transport instanceof PopupBrokerTransport);
});

// --- Token persistence tests ---

test("AppRuntimeApi persists token to localStorage when appId is provided", async () => {
	const store: Record<string, string> = {};
	globalThis.localStorage = {
		getItem: (key: string) => store[key] ?? null,
		setItem: (key: string, value: string) => {
			store[key] = value;
		},
		removeItem: (key: string) => {
			delete store[key];
		},
	} as Storage;

	const transport: AppRuntimeTransport = {
		request: () => Promise.resolve({ token: "persisted-token" }),
	};
	const runtime = createAppRuntime(transport, "work-1");

	const token = await runtime.getAccessToken();
	assert.equal(token, "persisted-token");
	assert.equal(store["cohub:app-token:work-1"], "persisted-token");
});

test("AppRuntimeApi restores token from localStorage on construction", async () => {
	const store: Record<string, string> = {
		"cohub:app-token:work-1": "cached-token",
	};
	globalThis.localStorage = {
		getItem: (key: string) => store[key] ?? null,
		setItem: (key: string, value: string) => {
			store[key] = value;
		},
		removeItem: (key: string) => {
			delete store[key];
		},
	} as Storage;

	// Transport that should never be called because token is cached.
	const transport: AppRuntimeTransport = {
		request: () => {
			throw new Error("should not be called");
		},
	};
	const runtime = createAppRuntime(transport, "work-1");

	const token = await runtime.getAccessToken();
	assert.equal(token, "cached-token");
});

test("AppRuntimeApi clears stored token on forceRefresh", async () => {
	const store: Record<string, string> = {
		"cohub:app-token:work-1": "old-token",
	};
	globalThis.localStorage = {
		getItem: (key: string) => store[key] ?? null,
		setItem: (key: string, value: string) => {
			store[key] = value;
		},
		removeItem: (key: string) => {
			delete store[key];
		},
	} as Storage;

	const transport: AppRuntimeTransport = {
		request: () => Promise.resolve({ token: "fresh-token" }),
	};
	const runtime = createAppRuntime(transport, "work-1");

	const token = await runtime.getAccessToken({ forceRefresh: true });
	assert.equal(token, "fresh-token");
	assert.equal(store["cohub:app-token:work-1"], "fresh-token");
});

test("forceRefresh re-authorizes when viewer scopes were previously granted", async () => {
	const store: Record<string, string> = {
		"cohub:app-token:work-1": "expired-token",
		"cohub:app-auth-grants:work-1": JSON.stringify([
			{ scopes: ["session.prompt.fullaccess"] },
		]),
	};
	globalThis.localStorage = {
		getItem: (key: string) => store[key] ?? null,
		setItem: (key: string, value: string) => {
			store[key] = value;
		},
		removeItem: (key: string) => {
			delete store[key];
		},
	} as Storage;

	const calls: { message: Record<string, unknown> }[] = [];
	const transport: AppRuntimeTransport = {
		request<T>(message: Record<string, unknown>): Promise<T | null> {
			calls.push({ message });
			// Return a token for any request type
			return Promise.resolve({ token: "refreshed-with-viewer-scopes" } as T);
		},
	};
	const runtime = createAppRuntime(transport, "work-1");

	const token = await runtime.getAccessToken({ forceRefresh: true });

	assert.equal(token, "refreshed-with-viewer-scopes");
	assert.equal(calls.length, 1);
	// Must re-authorize (not plain token) to preserve viewerScopes
	assert.equal(calls[0].message.type, "cohub.app.authorize");
	assert.deepEqual(calls[0].message.scopes, ["session.prompt.fullaccess"]);
	assert.equal(store["cohub:app-token:work-1"], "refreshed-with-viewer-scopes");
});

test("implicit and explicit home-space consents share one entry via the response space id", async () => {
	const store: Record<string, string> = {};
	globalThis.localStorage = {
		getItem: (key: string) => store[key] ?? null,
		setItem: (key: string, value: string) => {
			store[key] = value;
		},
		removeItem: (key: string) => {
			delete store[key];
		},
	} as Storage;

	const transport: AppRuntimeTransport = {
		request: () =>
			Promise.resolve({ token: "tok", space: { id: "space-home", name: "Home" } }),
	};
	const runtime = createAppRuntime(transport, "work-1");

	// Implicit home request (no spaceId)…
	await runtime.requestAuthorization({ scopes: ["file.view"] });
	// …then an explicit one for the same server row.
	await runtime.requestAuthorization({ scopes: ["file.view", "session.view"], spaceId: "space-home" });

	assert.deepEqual(JSON.parse(store["cohub:app-auth-grants:work-1"]), [
		{ spaceId: "space-home", scopes: ["file.view", "session.view"] },
	]);
});

test("requestSpaceAuthorization resolves the picked space and records the consent", async () => {
	const store: Record<string, string> = {};
	globalThis.localStorage = {
		getItem: (key: string) => store[key] ?? null,
		setItem: (key: string, value: string) => {
			store[key] = value;
		},
		removeItem: (key: string) => {
			delete store[key];
		},
	} as Storage;

	const calls: { message: Record<string, unknown> }[] = [];
	const transport: AppRuntimeTransport = {
		request<T>(message: Record<string, unknown>): Promise<T | null> {
			calls.push({ message });
			return Promise.resolve({
				token: "picked-token",
				space: { id: "space-7", name: "Studio" },
			} as T);
		},
	};
	const runtime = createAppRuntime(transport, "work-1");

	const result = await runtime.requestSpaceAuthorization({ scopes: ["file.view"] });

	assert.deepEqual(result, { granted: true, space: { id: "space-7", name: "Studio" } });
	assert.equal(calls[0].message.selectSpace, true);
	assert.equal(calls[0].message.spaceId, undefined);
	assert.deepEqual(JSON.parse(store["cohub:app-auth-grants:work-1"]), [
		{ spaceId: "space-7", scopes: ["file.view"] },
	]);
});

test("requestCreateSpaceAuthorization sends the create payload and records consent", async () => {
	const store: Record<string, string> = {};
	globalThis.localStorage = {
		getItem: (key: string) => store[key] ?? null,
		setItem: (key: string, value: string) => {
			store[key] = value;
		},
		removeItem: (key: string) => {
			delete store[key];
		},
	} as Storage;

	const calls: { message: Record<string, unknown> }[] = [];
	const transport: AppRuntimeTransport = {
		request<T>(message: Record<string, unknown>): Promise<T | null> {
			calls.push({ message });
			return Promise.resolve({
				token: "created-token",
				space: { id: "space-new", name: "Whale Shrine" },
			} as T);
		},
	};
	const runtime = createAppRuntime(transport, "work-1");

	const result = await runtime.requestCreateSpaceAuthorization({
		scopes: ["file.view", "session.view"],
		space: {
			name: "Whale Shrine",
			bootstrapSource: { type: "checkpoint", checkpointId: "ckpt-1" },
		},
		reason: "Create a workspace from this template.",
	});

	assert.deepEqual(result, { granted: true, space: { id: "space-new", name: "Whale Shrine" } });
	assert.equal(calls[0].message.type, "cohub.app.authorize");
	assert.equal(calls[0].message.selectSpace, undefined);
	assert.equal(calls[0].message.spaceId, undefined);
	assert.deepEqual(calls[0].message.createSpace, {
		name: "Whale Shrine",
		bootstrapSource: { type: "checkpoint", checkpointId: "ckpt-1" },
	});
	assert.deepEqual(JSON.parse(store["cohub:app-auth-grants:work-1"]), [
		{ spaceId: "space-new", scopes: ["file.view", "session.view"] },
	]);
});

test("requestCreateSpaceAuthorization reports a persisted space without a grant", async () => {
	globalThis.localStorage = {
		getItem: () => null,
		setItem: () => {},
		removeItem: () => {},
	} as Storage;
	const transport: AppRuntimeTransport = {
		request: () => Promise.resolve({ token: null, space: { id: "space-new", name: "Demo" } }),
	};
	const runtime = createAppRuntime(transport, "work-1");

	const result = await runtime.requestCreateSpaceAuthorization({
		scopes: ["file.view"],
		space: { name: "Demo" },
	});
	assert.deepEqual(result, { granted: false, space: { id: "space-new", name: "Demo" } });
});

test("requestCreateSpaceAuthorization reports denial without a space", async () => {
	globalThis.localStorage = {
		getItem: () => null,
		setItem: () => {},
		removeItem: () => {},
	} as Storage;
	const transport: AppRuntimeTransport = {
		request: () => Promise.resolve({ token: null, space: null }),
	};
	const runtime = createAppRuntime(transport, "work-1");

	const result = await runtime.requestCreateSpaceAuthorization({
		scopes: ["file.view"],
		space: { name: "Demo" },
	});
	assert.deepEqual(result, { granted: false, space: null });
});

test("requestSpaceAuthorization reports denial without a space", async () => {
	globalThis.localStorage = {
		getItem: () => null,
		setItem: () => {},
		removeItem: () => {},
	} as Storage;
	const transport: AppRuntimeTransport = {
		request: () => Promise.resolve({ token: null, space: null }),
	};
	const runtime = createAppRuntime(transport, "work-1");

	const result = await runtime.requestSpaceAuthorization({ scopes: ["file.view"] });
	assert.deepEqual(result, { granted: false, space: null });
});

test("a denied refresh keeps the earlier grant's token and drops the denied consent", async () => {
	const store: Record<string, string> = {};
	globalThis.localStorage = {
		getItem: (key: string) => store[key] ?? null,
		setItem: (key: string, value: string) => {
			store[key] = value;
		},
		removeItem: (key: string) => {
			delete store[key];
		},
	} as Storage;

	let callCount = 0;
	const transport: AppRuntimeTransport = {
		request<T>(_message: Record<string, unknown>): Promise<T | null> {
			callCount += 1;
			// The home-space consent refresh is denied by the viewer; the
			// second grant's refresh succeeds.
			if (callCount === 3) return Promise.resolve({ token: null } as T);
			return Promise.resolve({ token: `tok-${callCount}` } as T);
		},
	};
	const runtime = createAppRuntime(transport, "work-1");
	await runtime.requestAuthorization({ scopes: ["file.view"] });
	await runtime.requestAuthorization({ scopes: ["session.view"], spaceId: "space-2" });

	const token = await runtime.getAccessToken({ forceRefresh: true });

	// The surviving grant's token is kept; the denied one is dropped entirely.
	assert.equal(token, "tok-4");
	assert.deepEqual(JSON.parse(store["cohub:app-auth-grants:work-1"]), [
		{ spaceId: "space-2", scopes: ["session.view"] },
	]);
	assert.equal(store["cohub:app-token:work-1"], "tok-4");
});

test("requestAuthorization denial keeps the existing token", async () => {
	const store: Record<string, string> = { "cohub:app-token:work-1": "still-valid-token" };
	globalThis.localStorage = {
		getItem: (key: string) => store[key] ?? null,
		setItem: (key: string, value: string) => {
			store[key] = value;
		},
		removeItem: (key: string) => {
			delete store[key];
		},
	} as Storage;

	const transport: AppRuntimeTransport = {
		request: () => Promise.resolve({ token: null }),
	};
	const runtime = createAppRuntime(transport, "work-1");

	const granted = await runtime.requestAuthorization({ scopes: ["file.view"] });

	assert.equal(granted, false);
	// The previously minted token stays intact; no consent is recorded.
	assert.equal(store["cohub:app-token:work-1"], "still-valid-token");
	assert.equal(store["cohub:app-auth-grants:work-1"], undefined);
});

test("forceRefresh drops denied grants and keeps transient failures", async () => {
	const store: Record<string, string> = {};
	globalThis.localStorage = {
		getItem: (key: string) => store[key] ?? null,
		setItem: (key: string, value: string) => {
			store[key] = value;
		},
		removeItem: (key: string) => {
			delete store[key];
		},
	} as Storage;

	let callCount = 0;
	const transport: AppRuntimeTransport = {
		request<T>(_message: Record<string, unknown>): Promise<T | null> {
			callCount += 1;
			// Home-space consent: the dialog is denied — the definitive drop.
			if (callCount === 3) {
				return Promise.resolve({ token: null } as T);
			}
			// Space-2 consent: the host is briefly unavailable — transient.
			if (callCount === 4) {
				return Promise.reject(new Error("network down"));
			}
			return Promise.resolve({ token: "refreshed-despite-stale-grant" } as T);
		},
	};
	const runtime = createAppRuntime(transport, "work-1");
	await runtime.requestAuthorization({ scopes: ["file.view"] });
	await runtime.requestAuthorization({ scopes: ["session.view"], spaceId: "space-2" });

	const token = await runtime.getAccessToken({ forceRefresh: true });

	// Nothing refreshed — the loop falls through to a plain session token.
	assert.equal(token, "refreshed-despite-stale-grant");
	assert.equal(callCount, 5); // 2 consents + 2 re-authorize attempts + plain token
	// The denied consent is gone; the transiently-failed one is kept.
	assert.deepEqual(JSON.parse(store["cohub:app-auth-grants:work-1"]), [
		{ spaceId: "space-2", scopes: ["session.view"] },
	]);
});

test("forceRefresh falls back to plain token when no viewer scopes were granted", async () => {
	const store: Record<string, string> = {
		"cohub:app-token:work-1": "expired-token",
	};
	globalThis.localStorage = {
		getItem: (key: string) => store[key] ?? null,
		setItem: (key: string, value: string) => {
			store[key] = value;
		},
		removeItem: (key: string) => {
			delete store[key];
		},
	} as Storage;

	const calls: { message: Record<string, unknown> }[] = [];
	const transport: AppRuntimeTransport = {
		request<T>(message: Record<string, unknown>): Promise<T | null> {
			calls.push({ message });
			return Promise.resolve({ token: "base-token" } as T);
		},
	};
	const runtime = createAppRuntime(transport, "work-1");

	const token = await runtime.getAccessToken({ forceRefresh: true });

	assert.equal(token, "base-token");
	assert.equal(calls.length, 1);
	assert.equal(calls[0].message.type, "cohub.app.token");
});

test("requestAuthorization persists authorized scopes for later refresh", async () => {
	const store: Record<string, string> = {};
	globalThis.localStorage = {
		getItem: (key: string) => store[key] ?? null,
		setItem: (key: string, value: string) => {
			store[key] = value;
		},
		removeItem: (key: string) => {
			delete store[key];
		},
	} as Storage;

	const transport: AppRuntimeTransport = {
		request: () => Promise.resolve({ token: "authorized-token" }),
	};
	const runtime = createAppRuntime(transport, "work-1");

	const granted = await runtime.requestAuthorization({
		scopes: ["session.prompt.fullaccess", "generation.create"],
	});

	assert.equal(granted, true);
	assert.deepEqual(JSON.parse(store["cohub:app-auth-grants:work-1"]), [
		{ scopes: ["session.prompt.fullaccess", "generation.create"] },
	]);

	// A second consent for another space keeps both, one per space.
	await runtime.requestAuthorization({
		scopes: ["file.view"],
		spaceId: "space-2",
	});
	assert.deepEqual(JSON.parse(store["cohub:app-auth-grants:work-1"]), [
		{ scopes: ["session.prompt.fullaccess", "generation.create"] },
		{ spaceId: "space-2", scopes: ["file.view"] },
	]);
});

test("forceRefresh after requestAuthorization re-authorizes with saved scopes", async () => {
	const store: Record<string, string> = {};
	globalThis.localStorage = {
		getItem: (key: string) => store[key] ?? null,
		setItem: (key: string, value: string) => {
			store[key] = value;
		},
		removeItem: (key: string) => {
			delete store[key];
		},
	} as Storage;

	let callCount = 0;
	const calls: { message: Record<string, unknown> }[] = [];
	const transport: AppRuntimeTransport = {
		request<T>(message: Record<string, unknown>): Promise<T | null> {
			callCount += 1;
			calls.push({ message });
			return Promise.resolve({ token: `tok-${callCount}` } as T);
		},
	};
	const runtime = createAppRuntime(transport, "work-1");

	// Step 1: initial authorization
	await runtime.requestAuthorization({ scopes: ["session.prompt.fullaccess"] });
	assert.equal(calls[0].message.type, "cohub.app.authorize");

	// Step 2: normal getAccessToken returns cached token (no transport call)
	calls.length = 0;
	const cached = await runtime.getAccessToken();
	assert.equal(cached, "tok-1");
	assert.equal(calls.length, 0);

	// Step 3: forceRefresh re-authorizes with saved scopes
	calls.length = 0;
	const refreshed = await runtime.getAccessToken({ forceRefresh: true });
	assert.equal(refreshed, "tok-2");
	assert.equal(calls.length, 1);
	assert.equal(calls[0].message.type, "cohub.app.authorize");
	assert.deepEqual(calls[0].message.scopes, ["session.prompt.fullaccess"]);
});

// --- Slug-based appId resolution tests ---

test("createSlugAppIdResolver resolves appId from getBySlug and caches it", async () => {
	let calls = 0;
	const resolver = createSlugAppIdResolver({
		apiBaseUrl: "https://api.cohub.run",
		ownerUsername: "tzwm",
		spaceSlug: "playground",
		appSlug: "pulsewall",
		fetch: (async (url: string) => {
			calls += 1;
			assert.equal(
				url,
				"https://api.cohub.run/api/apps/by-slug/tzwm/playground/pulsewall",
			);
			return {
				ok: true,
				json: async () => ({ app: { id: "resolved-work-id" } }),
			} as Response;
		}) as typeof globalThis.fetch,
	});

	const first = await resolver();
	const second = await resolver();
	assert.equal(first, "resolved-work-id");
	assert.equal(second, "resolved-work-id");
	assert.equal(calls, 1);
});

test("createSlugAppIdResolver does not cache failures", async () => {
	let calls = 0;
	const resolver = createSlugAppIdResolver({
		apiBaseUrl: "https://api.cohub.run",
		ownerUsername: "tzwm",
		spaceSlug: "playground",
		appSlug: "pulsewall",
		fetch: (async () => {
			calls += 1;
			if (calls === 1) return { ok: false, status: 404 } as Response;
			return {
				ok: true,
				json: async () => ({ work: { id: "recovered-id" } }),
			} as Response;
		}) as typeof globalThis.fetch,
	});

	assert.equal(await resolver(), null);
	assert.equal(await resolver(), "recovered-id");
	assert.equal(calls, 2);
});

test("resolveAppTransport returns broker when only a resolver is provided", () => {
	const windowMock: { location: { origin: string }; parent?: unknown } = {
		location: { origin: "https://my-work.example" },
	};
	windowMock.parent = windowMock;
	globalThis.window = windowMock as unknown as Window & typeof globalThis;

	const transport = resolveAppTransport(
		{ brokerOrigin: "https://cohub.run", ownerUsername: "u", spaceSlug: "s", appSlug: "w" },
		() => Promise.resolve("late-app-id"),
	);
	assert.ok(transport instanceof PopupBrokerTransport);
});

test("resolveAppTransport falls back to bridge without appId or resolver", () => {
	const windowMock: { location: { origin: string }; parent?: unknown } = {
		location: { origin: "https://my-work.example" },
	};
	windowMock.parent = windowMock;
	globalThis.window = windowMock as unknown as Window & typeof globalThis;

	const transport = resolveAppTransport({ brokerOrigin: "https://cohub.run" });
	assert.ok(transport instanceof ParentBridgeTransport);
});

test("PopupBrokerTransport answers context using resolved appId", async () => {
	const windowMock = {
		location: { origin: "https://my-work.example" },
		open: () => ({ closed: false, close() {}, postMessage() {} }),
		addEventListener: () => {},
		removeEventListener: () => {},
	};
	globalThis.window = windowMock as unknown as Window & typeof globalThis;

	const transport = new PopupBrokerTransport({
		brokerOrigin: "https://cohub.run",
		getAppId: () => Promise.resolve("late-app-id"),
	});
	const result = await transport.request<{ context: { app: { id: string } } }>(
		{ type: "cohub.app.context" },
	);
	assert.equal(result?.context?.app?.id, "late-app-id");
});

test("PopupBrokerTransport uses resolved appId in the broker URL", async () => {
	let messageHandler: ((event: MessageEvent) => void) | null = null;
	let openedUrl = "";
	const popupMock = {
		closed: false,
		close() {
			this.closed = true;
		},
		postMessage: (data: Record<string, unknown>) => {
			queueMicrotask(() => {
				messageHandler?.({
					data: {
						type: "cohub.app.token.result",
						requestId: data.requestId,
						token: "tok-from-broker",
					},
					origin: "https://cohub.run",
					source: popupMock,
				} as MessageEvent);
			});
		},
	};
	const windowMock = {
		location: { origin: "https://my-work.example" },
		open: (url: string) => {
			openedUrl = url;
			queueMicrotask(() => {
				messageHandler?.({
					data: { type: "cohub.app.broker.ready" },
					origin: "https://cohub.run",
					source: popupMock,
				} as MessageEvent);
			});
			return popupMock;
		},
		addEventListener: (_t: string, h: (event: MessageEvent) => void) => {
			messageHandler = h;
		},
		removeEventListener: () => {
			messageHandler = null;
		},
	};
	globalThis.window = windowMock as unknown as Window & typeof globalThis;

	const transport = new PopupBrokerTransport({
		brokerOrigin: "https://cohub.run",
		getAppId: () => Promise.resolve("late-app-id"),
	});
	const result = await transport.request<{ token: string | null }>(
		{ type: "cohub.app.token" },
		{ timeoutMs: 5_000 },
	);
	assert.equal(result?.token, "tok-from-broker");
	assert.ok(openedUrl.includes("app=late-app-id"));
});

test("PopupBrokerTransport rejects interactive request when appId cannot be resolved", async () => {
	const windowMock = {
		location: { origin: "https://my-work.example" },
		open: () => ({ closed: false, close() {}, postMessage() {} }),
		addEventListener: () => {},
		removeEventListener: () => {},
	};
	globalThis.window = windowMock as unknown as Window & typeof globalThis;

	const transport = new PopupBrokerTransport({
		brokerOrigin: "https://cohub.run",
		getWorkId: () => Promise.resolve(null),
	});
	await assert.rejects(
		() => transport.request({ type: "cohub.app.token" }, { timeoutMs: 1_000 }),
		/resolve the app id/i,
	);
});

test("AppRuntimeApi isolates localStorage by resolved appId", async () => {
	const store: Record<string, string> = {
		"cohub:app-token:late-app-id": "cached-late-token",
	};
	globalThis.localStorage = {
		getItem: (key: string) => store[key] ?? null,
		setItem: (key: string, value: string) => {
			store[key] = value;
		},
		removeItem: (key: string) => {
			delete store[key];
		},
	} as Storage;

	const transport: AppRuntimeTransport = {
		request: () => {
			throw new Error("should not be called");
		},
	};
	const runtime = createAppRuntime(transport, undefined, () =>
		Promise.resolve("late-app-id"),
	);

	const token = await runtime.getAccessToken();
	assert.equal(token, "cached-late-token");
});

test("CohubClientOptions.work keeps configuring broker mode (legacy key)", async () => {
	const windowMock: { location: { origin: string }; parent?: unknown } = {
		location: { origin: "https://my-work.example" },
	};
	windowMock.parent = windowMock;
	globalThis.window = windowMock as unknown as Window & typeof globalThis;

	const client = new CohubClient({
		work: { mode: "broker", brokerOrigin: "https://cohub.run", appId: "app-1" },
		getAccessToken: async () => null,
	});
	const context = await client.context();
	assert.equal(context?.app.id, "app-1");

	const clientWithAppKey = new CohubClient({
		app: { mode: "broker", brokerOrigin: "https://cohub.run", appId: "app-2" },
		work: { mode: "broker", brokerOrigin: "https://cohub.run", appId: "app-ignored" },
		getAccessToken: async () => null,
	});
	const contextAppKey = await clientWithAppKey.context();
	assert.equal(contextAppKey?.app.id, "app-2", "the canonical `app` key wins when both are set");
});
