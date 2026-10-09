import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { isCohubHostOrigin, AppSurfaceApi } from "../src/app-surface.js";

/** A published Work is publicly embeddable, so these pin the trust boundary. */

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const COHUB = "https://cohub.live";

afterEach(() => {
	globalThis.window = originalWindow;
	globalThis.document = originalDocument;
});

function mountWork(embedder: string, self = "https://work.example") {
	const posted: Array<{ message: Record<string, unknown>; origin: string }> = [];
	let handler: ((event: MessageEvent) => void) | null = null;
	const parent = {
		postMessage: (message: Record<string, unknown>, origin: string) =>
			posted.push({ message, origin }),
	};
	globalThis.window = {
		parent,
		location: { origin: self, ancestorOrigins: [embedder] },
		addEventListener: (_t: "message", fn: (event: MessageEvent) => void) => {
			handler = fn;
		},
		removeEventListener: () => {
			handler = null;
		},
	} as unknown as Window & typeof globalThis;
	globalThis.document = { referrer: "" } as Document;

	const surface = new AppSurfaceApi();
	const send = async (
		method: string,
		origin: string,
		source: unknown = parent,
		commandId = "command-1",
	) => {
		handler?.({
			data: {
				protocol: "cohub.app.surface",
				version: 1,
				type: "request",
				requestId: "r1",
				method,
				commandId,
			},
			origin,
			source,
		} as MessageEvent);
		await new Promise((resolve) => setTimeout(resolve, 0));
	};
	const announce = () =>
		handler?.({
			data: { protocol: "cohub.app.runtime", version: 1, type: "announce" },
			origin: embedder,
			source: parent,
		} as MessageEvent);
	return { surface, posted, parent, send, announce };
}

test("a Work receives the originating command id as handler context", async () => {
	const { surface, parent, send } = mountWork(COHUB);
	let received: string | null = null;
	surface.handle("open", (_input, context) => {
		received = context.commandId;
	});

	await send("open", COHUB, parent, "command-1");
	assert.equal(received, "command-1");
});

test("a Work can set and clear composer context for its trusted Cohub host", () => {
	const { surface, posted } = mountWork(COHUB);
	const chip = {
		key: "selection",
		label: "3 selected",
		content: "Selected records:\n- customer_123",
	};

	surface.setComposerChip(chip);
	assert.deepEqual(posted.at(-1), {
		origin: COHUB,
		message: {
			protocol: "cohub.app.surface",
			version: 1,
			type: "composer.chip.set",
			chip,
		},
	});

	surface.clearComposerChip(chip.key);
	assert.deepEqual(posted.at(-1), {
		origin: COHUB,
		message: {
			protocol: "cohub.app.surface",
			version: 1,
			type: "composer.chip.clear",
			key: chip.key,
		},
	});
});

test("invalid composer context is rejected before posting", () => {
	const { surface, posted } = mountWork(COHUB);
	assert.throws(
		() => surface.setComposerChip({ key: "selection", label: "", content: "value" }),
		/Invalid App composer chip/,
	);
	assert.equal(posted.length, 0);
});

test("a Cohub host can call a method and gets a reply addressed to its origin", async () => {
	const { surface, posted, send } = mountWork(COHUB);
	surface.handle("ping", () => "pong");
	assert.deepEqual(
		{ origin: posted.at(-1)?.origin, type: posted.at(-1)?.message.type },
		{ origin: COHUB, type: "ready" },
	);

	await send("ping", COHUB);
	assert.deepEqual(posted.at(-1), {
		origin: COHUB,
		message: { protocol: "cohub.app.surface", version: 1, type: "response", requestId: "r1", ok: true },
	});
});

// Each case must reach neither the handler nor `postMessage` — not even the
// method list may leak. `works.cohub.live` matters most: Works are served from
// there, so a suffix match would let one Work call into another.
for (const [name, embedder, origin, otherWindow] of [
	["a third-party embedder", "https://evil.example", "https://evil.example", false],
	["a spoofed origin from the real parent", COHUB, "https://evil.example", false],
	["another window claiming the host origin", COHUB, COHUB, true],
	["a Cohub content origin", "https://works.cohub.live", "https://works.cohub.live", false],
] as const) {
	test(`${name} cannot invoke a Work's methods`, async () => {
		const { surface, posted, send } = mountWork(embedder, "https://sessions.cohub.run");
		let calls = 0;
		surface.handle("ping", () => {
			calls += 1;
		});
		posted.length = 0;

		await send("ping", origin, otherWindow ? { postMessage() {} } : undefined);
		assert.equal(calls, 0);
		assert.equal(posted.length, 0);
	});
}

test("same-origin embedding stays trusted, since such a parent can already script us", async () => {
	const { surface, posted, send } = mountWork("http://localhost:5173", "http://localhost:5173");
	surface.handle("ping", () => "pong");
	await send("ping", "http://localhost:5173");

	assert.equal(posted.at(-1)?.message.ok, true);
	assert.equal(posted.at(-1)?.origin, "http://localhost:5173");
});

test("a self-hosted deployment can widen the allowlist", async () => {
	const { surface, posted, send } = mountWork("https://cohub.internal");
	surface.handle("ping", () => "pong");
	assert.equal(posted.length, 0, "not trusted by default");
	surface.allowHostOrigins(["https://cohub.internal"]);
	await send("ping", "https://cohub.internal");
	assert.equal(posted.at(-1)?.message.ok, true);
	assert.equal(posted.at(-1)?.origin, "https://cohub.internal");
});

test("an unknown method and a throwing handler both report instead of hanging", async () => {
	const { surface, posted, send } = mountWork(COHUB);
	surface.handle("boom", () => {
		throw new Error("nope");
	});

	await send("absent", COHUB);
	assert.deepEqual(posted.at(-1)?.message.error, {
		code: "method_not_found",
		message: 'This app does not expose "absent".',
	});

	await send("boom", COHUB);
	assert.deepEqual(posted.at(-1)?.message.error, { code: "handler_failed", message: "nope" });
});

test("only explicit app origins are trusted, not the whole subdomain space", () => {
	for (const origin of [
		COHUB,
		"https://dev.cohub.live",
		"https://cohub.run",
		"https://dev.cohub.run",
	]) {
		assert.equal(isCohubHostOrigin(origin), true, origin);
	}
	for (const origin of [
		"https://works.cohub.live",
		"https://public.cohub.run",
		"https://anything.cohub.live",
		"http://cohub.live",
		"https://cohub.live.evil.example",
		"https://notcohub.live",
		"garbage",
	]) {
		assert.equal(isCohubHostOrigin(origin), false, origin);
	}
});

test("a reloaded host hears the methods and chip again", () => {
	const { surface, posted, announce } = mountWork(COHUB);
	surface.handle("open", () => {});
	surface.setComposerChip({ key: "selection", label: "1 selected", content: "a" });
	posted.length = 0;

	announce();
	assert.deepEqual(
		posted.map(({ message }) => message.type),
		["ready", "composer.chip.set"],
	);

	surface.clearComposerChip("selection");
	posted.length = 0;
	announce();
	assert.deepEqual(posted.map(({ message }) => message.type), ["ready"]);
});
