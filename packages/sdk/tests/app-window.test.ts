import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
	APP_RUNTIME_PROTOCOL,
	APP_RUNTIME_VERSION,
	buildAppRuntimeAnnounce,
	buildAppRuntimeClosePrepare,
	buildAppRuntimeDrag,
} from "@cohub/protocol/app-runtime";
import type { AppRuntimeContext, AppRuntimeTransport } from "../src/app-runtime.js";
import { AppWindowApi, applyAppAppearance } from "../src/app-window.js";

const originalWindow = globalThis.window;
afterEach(() => {
	globalThis.window = originalWindow;
});

type Listener = (event: KeyboardEvent) => void;

function installWindow() {
	const keydown = new Set<Listener>();
	const parent = {};
	globalThis.window = {
		parent,
		addEventListener: (type: string, listener: Listener) => {
			if (type === "keydown") keydown.add(listener);
		},
		removeEventListener: (type: string, listener: Listener) => {
			if (type === "keydown") keydown.delete(listener);
		},
	} as unknown as Window & typeof globalThis;
	return {
		press: (init: Partial<KeyboardEvent>) => {
			const event = { key: "k", code: "KeyK", altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, defaultPrevented: false, isComposing: false, ...init } as KeyboardEvent;
			for (const listener of keydown) listener(event);
			return event;
		},
		keydownListeners: () => keydown.size,
	};
}

function createTransport(options: { connected?: boolean } = {}) {
	const sent: Array<Record<string, unknown>> = [];
	let host: ((data: unknown) => void) | null = null;
	const transport: AppRuntimeTransport = {
		request: async () => null,
		notify: (message) => sent.push(message),
		subscribeHostMessages: (listener) => {
			host = listener;
			return () => {
				host = null;
			};
		},
		isHostConnected: () => options.connected ?? true,
	};
	return { transport, sent, fromHost: (data: unknown) => host?.(data) };
}

function createRuntime(initial: AppRuntimeContext | null = null) {
	const listeners = new Set<(context: AppRuntimeContext) => void>();
	return {
		context: async () => initial,
		onContextChanged: (listener: (context: AppRuntimeContext) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		push: (context: AppRuntimeContext) => {
			for (const listener of listeners) listener(context);
		},
	};
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const baseContext = { app: { id: "app-1", slug: "board" }, space: { id: "home" } } as AppRuntimeContext;
const withFile = (path: string, id?: string): AppRuntimeContext => ({
	...baseContext,
	invocation: { surface: "app", source: "user", spaceId: "space-1", file: { path }, ...(id ? { id } : {}) },
});

test("close.prepare waits for the App before answering", async () => {
	const { transport, sent, fromHost } = createTransport();
	const api = new AppWindowApi(transport, createRuntime());
	let flushed = false;
	api.onBeforeClose(async () => {
		await settle();
		flushed = true;
	});
	fromHost(buildAppRuntimeClosePrepare("close-1"));
	await settle();
	await settle();
	assert.equal(flushed, true);
	assert.deepEqual(sent.at(-1), { protocol: APP_RUNTIME_PROTOCOL, version: APP_RUNTIME_VERSION, type: "close.prepared", requestId: "close-1", ok: true });

	api.onBeforeClose(() => false);
	fromHost(buildAppRuntimeClosePrepare("close-2"));
	await settle();
	assert.equal(sent.at(-1)?.ok, false);

	api.onBeforeClose(() => {
		throw new Error("disk full");
	});
	fromHost(buildAppRuntimeClosePrepare("close-3"));
	await settle();
	assert.equal(sent.at(-1)?.ok, false);
});

test("without a close handler, only a clean window may close", async () => {
	const { transport, sent, fromHost } = createTransport();
	const api = new AppWindowApi(transport, createRuntime());
	const stop = api.onDrop({ accept: ["file"], drop: () => {} });
	api.setState({ dirty: true });
	fromHost(buildAppRuntimeClosePrepare("dirty"));
	await settle();
	assert.equal(sent.at(-1)?.ok, false);
	api.setState({ dirty: false });
	fromHost(buildAppRuntimeClosePrepare("clean"));
	await settle();
	assert.equal(sent.at(-1)?.ok, true);
	stop();
});

test("onDrop declares accepted kinds and receives resources on drop only", () => {
	const { transport, sent, fromHost } = createTransport();
	const api = new AppWindowApi(transport, createRuntime());
	const events: unknown[] = [];
	const stop = api.onDrop({
		accept: ["file", "task"],
		over: (point) => events.push({ over: point }),
		leave: () => events.push("leave"),
		drop: (event) => events.push({ drop: event }),
	});
	assert.deepEqual(sent.at(-1)?.accept, ["file", "task"]);

	const resource = { type: "file" as const, ref: "a.png", path: "a.png" };
	fromHost(buildAppRuntimeDrag({ phase: "over", x: 4, y: 5, types: ["file"] }));
	fromHost(buildAppRuntimeDrag({ phase: "leave", x: 0, y: 0, types: [] }));
	fromHost(buildAppRuntimeDrag({ phase: "drop", x: 4, y: 5, types: ["file"], resources: [resource] }));
	assert.deepEqual(events, [
		{ over: { x: 4, y: 5, types: ["file"] } },
		"leave",
		{ drop: { x: 4, y: 5, types: ["file"], resources: [resource] } },
	]);

	stop();
	assert.deepEqual(sent.at(-1)?.accept, []);
	fromHost(buildAppRuntimeDrag({ phase: "drop", x: 0, y: 0, types: ["file"], resources: [resource] }));
	assert.equal(events.length, 3);
});

test("onLaunch fires when the file opens, opens again, or moves", async () => {
	const runtime = createRuntime(withFile("boards/a.board", "open-1"));
	const api = new AppWindowApi(createTransport().transport, runtime);
	const launches: string[] = [];
	api.onLaunch(({ file }) => launches.push(`${file.spaceId}:${file.path}`));
	await settle();
	runtime.push(withFile("boards/a.board", "open-1"));
	runtime.push({ ...withFile("boards/a.board", "open-1"), locale: "zh-CN" });
	runtime.push(withFile("archive/a.board", "open-1"));
	runtime.push(withFile("archive/a.board", "open-2"));
	assert.deepEqual(launches, ["space-1:boards/a.board", "space-1:archive/a.board", "space-1:archive/a.board"]);
});

test("drops and close requests only come from a host that answered the runtime", async () => {
	const { transport, sent, fromHost } = createTransport({ connected: false });
	let contextRequests = 0;
	const api = new AppWindowApi(transport, {
		...createRuntime(),
		context: async () => {
			contextRequests += 1;
			return null;
		},
	});
	const drops: unknown[] = [];
	api.onDrop({ accept: ["file"], drop: (event) => drops.push(event) });
	assert.equal(contextRequests, 1, "listening starts the handshake");
	sent.length = 0;
	fromHost(buildAppRuntimeDrag({ phase: "drop", x: 0, y: 0, types: ["file"], resources: [{ type: "file", ref: "a" }] }));
	fromHost(buildAppRuntimeClosePrepare("close-1"));
	await settle();
	assert.deepEqual(drops, []);
	assert.deepEqual(sent, []);
	fromHost(buildAppRuntimeAnnounce());
	assert.deepEqual(sent.map((message) => message.type), ["drop.config"]);
});

test("a reloaded host hears the reported tab state and drops again", () => {
	const reporter = createTransport();
	const api = new AppWindowApi(reporter.transport, createRuntime());
	api.setState({ title: "Roadmap", dirty: true });
	api.onDrop({ accept: ["file"], drop: () => {} });
	reporter.sent.length = 0;
	reporter.fromHost(buildAppRuntimeAnnounce());
	assert.deepEqual(
		reporter.sent.map((message) => message.type),
		["window.state", "drop.config"],
	);
	assert.equal(reporter.sent[0]?.dirty, true);

	const silent = createTransport();
	new AppWindowApi(silent.transport, createRuntime()).onBeforeClose(() => true);
	silent.fromHost(buildAppRuntimeAnnounce());
	assert.deepEqual(silent.sent, []);
});

test("unhandled Ctrl/Meta chords reach a connected host; typing and editing stay local", async () => {
	const keys = installWindow();
	const { transport, sent } = createTransport();
	const api = new AppWindowApi(transport, createRuntime());
	keys.press({ key: "k", metaKey: true });
	keys.press({ key: "k" });
	keys.press({ key: "c", metaKey: true });
	keys.press({ key: "Z", ctrlKey: true, shiftKey: true });
	keys.press({ key: "p", metaKey: true, defaultPrevented: true });
	keys.press({ key: "p", metaKey: true, isComposing: true });
	keys.press({ key: "b", ctrlKey: true, shiftKey: true });
	const late = keys.press({ key: "s", metaKey: true });
	(late as { defaultPrevented: boolean }).defaultPrevented = true;
	await settle();
	assert.deepEqual(sent.map((message) => `${message.type}:${message.key}`), ["key:k", "key:b"]);

	api.dispose();
	assert.equal(keys.keydownListeners(), 0);
});

test("a chord reaches the host once however many clients the App creates", async () => {
	const keys = installWindow();
	const first = createTransport();
	const second = createTransport();
	const apis = [new AppWindowApi(first.transport, createRuntime()), new AppWindowApi(second.transport, createRuntime())];
	assert.equal(keys.keydownListeners(), 1);
	keys.press({ key: "k", metaKey: true });
	await settle();
	assert.equal(first.sent.length + second.sent.length, 1);
	apis[0]?.dispose();
	assert.equal(keys.keydownListeners(), 1);
	apis[1]?.dispose();
	assert.equal(keys.keydownListeners(), 0);
});

test("applyAppAppearance writes tokens, color scheme, and lang, and clears missing tokens", () => {
	const properties = new Map<string, string>([["--cohub-brand", "stale"]]);
	const root = {
		style: {
			setProperty: (name: string, value: string) => properties.set(name, value),
			removeProperty: (name: string) => properties.delete(name),
			colorScheme: "",
		},
		dataset: {} as Record<string, string>,
		lang: "",
	};
	applyAppAppearance(root as unknown as HTMLElement, {
		locale: "zh-CN",
		appearance: { colorScheme: "dark", theme: "solarized-dark", tokens: { "bg-primary": "#002b36" }, reducedMotion: true },
	});
	assert.deepEqual([...properties], [["--cohub-bg-primary", "#002b36"]]);
	assert.equal(root.style.colorScheme, "dark");
	assert.equal(root.dataset.cohubColorScheme, "dark");
	assert.equal(root.dataset.cohubReducedMotion, "true");
	assert.equal(root.lang, "zh-CN");
});
