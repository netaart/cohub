import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type AppSurfaceCallTarget,
	type AppSurfaceInvoker,
	createAppSurfaceRegistry,
} from "$lib/features/app/surface-registry";

const APP = { id: "app-1", surface: "overlay" as const };
const invocation = { surface: "overlay" as const, spaceId: "space-1" };

function webTarget(): AppSurfaceCallTarget {
	return {
		detail: { content: { kind: "web" } } as never,
		error: null,
		invocation,
	};
}

function recordingInvoker(): {
	invoker: AppSurfaceInvoker;
	calls: Parameters<AppSurfaceInvoker>[0][];
} {
	const calls: Parameters<AppSurfaceInvoker>[0][] = [];
	return {
		calls,
		invoker: async (input) => {
			calls.push(input);
			return { ok: true };
		},
	};
}

test("a call issued before the surface mounts is delivered once it does", async () => {
	const registry = createAppSurfaceRegistry();
	const { invoker, calls } = recordingInvoker();
	const pending = registry.call({
		key: APP,
		method: "hud.ping",
		input: { message: "hi" },
		commandId: "cmd-1",
		getTarget: webTarget,
	});
	registry.register(APP, invoker);
	assert.deepEqual(await pending, { ok: true });
	assert.equal(calls.length, 1);
	assert.equal(calls[0].method, "hud.ping");
	assert.equal(calls[0].commandId, "cmd-1");
	assert.equal(calls[0].invocation, invocation);
});

test("the call waits for the detail fetch before inspecting the target", async () => {
	const registry = createAppSurfaceRegistry();
	registry.register(APP, recordingInvoker().invoker);
	let target: AppSurfaceCallTarget = { detail: null, error: null, invocation };
	let settle: () => void = () => {};
	const settled = new Promise<void>((resolve) => {
		settle = resolve;
	});
	const pending = registry.call({
		key: APP,
		method: "m",
		commandId: "c",
		settled,
		getTarget: () => target,
	});
	target = webTarget();
	settle();
	assert.deepEqual(await pending, { ok: true });
});

test("native and failed surfaces are refused without waiting", async () => {
	const registry = createAppSurfaceRegistry();
	const board = await registry.call({
		key: APP,
		method: "m",
		commandId: "c",
		getTarget: () => ({
			detail: { content: { kind: "board" } } as never,
			error: null,
			invocation,
		}),
	});
	assert.equal(board.ok, false);
	assert.equal(!board.ok && board.code, "surface_not_supported");

	const failed = await registry.call({
		key: APP,
		method: "m",
		commandId: "c",
		getTarget: () => ({ detail: null, error: "boom", invocation }),
	});
	assert.equal(!failed.ok && failed.code, "preview_failed");

	const closed = await registry.call({
		key: APP,
		method: "m",
		commandId: "c",
		getTarget: () => null,
	});
	assert.equal(!closed.ok && closed.code, "preview_not_open");
});

test("waiters give up when the surface never mounts or the registry is cleared", async () => {
	const registry = createAppSurfaceRegistry();
	assert.equal(await registry.waitFor(APP, 5), null);

	const waiting = registry.waitFor(APP, 10_000);
	registry.clear();
	assert.equal(await waiting, null);
});

test("unregister only removes the invoker it was given", () => {
	const registry = createAppSurfaceRegistry();
	const first = recordingInvoker().invoker;
	const second = recordingInvoker().invoker;
	const disposeFirst = registry.register(APP, first);
	registry.register(APP, second);
	disposeFirst();
	return registry
		.waitFor(APP, 5)
		.then((invoker) => assert.equal(invoker, second));
});

test("the same App mounted as a tab and as an overlay keeps two independent surfaces", async () => {
	const registry = createAppSurfaceRegistry();
	const tab = recordingInvoker();
	const overlay = recordingInvoker();
	registry.register({ id: "app-1", surface: "app" }, tab.invoker);
	registry.register({ id: "app-1", surface: "overlay" }, overlay.invoker);
	await registry.call({
		key: APP,
		method: "m",
		commandId: "c",
		getTarget: webTarget,
	});
	assert.equal(tab.calls.length, 0);
	assert.equal(overlay.calls.length, 1);
	registry.unregister({ id: "app-1", surface: "overlay" });
	assert.equal(
		await registry.waitFor({ id: "app-1", surface: "app" }, 5),
		tab.invoker,
	);
});
