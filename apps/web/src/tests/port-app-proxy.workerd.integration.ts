import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { unstable_startWorker } from "wrangler";

type Worker = Awaited<ReturnType<typeof unstable_startWorker>>;

/** Runs the port proxy inside workerd, which Node's fetch cannot stand in for. */
describe("port App proxy in workerd", () => {
	let worker: Worker;

	before(async () => {
		worker = await unstable_startWorker({
			entrypoint: fileURLToPath(
				new URL("./fixtures/port-app-proxy-worker.ts", import.meta.url),
			),
			compatibilityDate: "2025-03-05",
			compatibilityFlags: ["nodejs_compat"],
			dev: { server: { port: 0 }, inspector: false, logLevel: "none" },
		});
	});

	after(async () => {
		await worker?.dispose();
	});

	it("accepts the uncached, streamed subrequest", async () => {
		const response = await worker.fetch("https://app.example.com/upload", {
			method: "POST",
			body: "x",
		});
		assert.equal(await response.text(), "POST no-store");
	});

	it("passes WebSocket upgrades and messages through", async () => {
		const response = await worker.fetch("https://app.example.com/socket", {
			headers: { Upgrade: "websocket" },
		});
		assert.equal(response.status, 101);
		const socket = response.webSocket;
		assert.ok(socket);
		socket.accept();
		const reply = new Promise((resolve) =>
			socket.addEventListener("message", (event) => resolve(event.data)),
		);
		socket.send("hi");
		assert.equal(await reply, "echo:hi");
		socket.close();
	});

	it("delivers SSE events before the stream ends", async () => {
		const response = await worker.fetch("https://app.example.com/events");
		const reader = response.body?.getReader();
		assert.ok(reader);
		const first = await reader.read();
		assert.equal(first.done, false);
		assert.equal(new TextDecoder().decode(first.value), "data: first\n\n");
		await reader.cancel();
	});
});
