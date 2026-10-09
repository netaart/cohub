import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import {
	__resetDesktopCommandBusForTests,
	__setDesktopCommandTransportForTests,
	type DesktopCommandTransport,
	handleDesktopCommand,
	registerDesktopCommandHost,
} from "$lib/features/desktop-command/bus";

const payload = {
	commandId: "cmd-1",
	targetClientId: "client-1",
	command: {
		type: "desktop.open" as const,
		target: { kind: "file" as const, path: "a.board" },
	},
	source: null,
};

function setup(accept: DesktopCommandTransport["accept"]) {
	const calls = { runs: 0, reports: [] as string[] };
	__setDesktopCommandTransportForTests({
		accept,
		report: async (_id, body) => {
			calls.reports.push(body.status);
		},
	});
	registerDesktopCommandHost(async () => {
		calls.runs += 1;
		return { status: "applied" };
	});
	return calls;
}

beforeEach(() => {
	__resetDesktopCommandBusForTests({ retryMs: 0 });
	mock.method(console, "warn", () => {});
});

test("runs an accepted command once and reports it", async () => {
	const calls = setup(async () => ({ accepted: true }));
	await handleDesktopCommand(payload);
	await handleDesktopCommand(payload);
	assert.equal(calls.runs, 1);
	assert.deepEqual(calls.reports, ["applied"]);
});

test("drops a command the server refuses", async () => {
	const calls = setup(async () => ({ accepted: false }));
	await handleDesktopCommand(payload);
	assert.equal(calls.runs, 0);
	assert.deepEqual(calls.reports, []);
});

test("retries a failed accept on redelivery", async () => {
	let online = false;
	const calls = setup(async () => {
		if (!online) throw new Error("offline");
		return { accepted: true };
	});
	await handleDesktopCommand(payload);
	online = true;
	await handleDesktopCommand(payload);
	assert.equal(calls.runs, 1);
});
