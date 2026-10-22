import { proxyPortApp } from "../../lib/server/port-app-proxy.ts";

type WorkerSocket = WebSocket & { accept(): void };
declare const WebSocketPair: new () => { 0: WorkerSocket; 1: WorkerSocket };

const UPSTREAM =
	"https://s-550e8400-e29b-41d4-a716-446655440000-3000.cohub.live";

/** Stands in for the sandbox: echoes WebSocket messages and holds an SSE stream open. */
function sandbox(request: Request): Response {
	if (request.headers.get("upgrade") === "websocket") {
		const [client, server] = Object.values(new WebSocketPair());
		server.accept();
		server.addEventListener("message", (event) =>
			server.send(`echo:${event.data}`),
		);
		const init: ResponseInit & { webSocket: WorkerSocket } = {
			status: 101,
			webSocket: client,
		};
		return new Response(null, init);
	}
	if (new URL(request.url).pathname === "/events") {
		const { readable, writable } = new TransformStream();
		const writer = writable.getWriter();
		void writer.write(new TextEncoder().encode("data: first\n\n"));
		setTimeout(() => void writer.close(), 2_000);
		return new Response(readable, {
			headers: { "Content-Type": "text/event-stream" },
		});
	}
	return new Response(`${request.method} ${request.cache}`);
}

export default {
	fetch(request: Request) {
		return proxyPortApp({
			request,
			url: new URL(request.url),
			upstream: UPSTREAM,
			fetcher: async (input, init) => sandbox(new Request(input, init)),
		});
	},
};
