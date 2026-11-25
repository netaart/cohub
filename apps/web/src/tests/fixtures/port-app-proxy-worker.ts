import { APP_BROWSER_SESSION_PATH } from "@cohub/protocol";
import { serveAppBrowserSession } from "../../lib/server/app-browser-session.ts";
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
		const url = new URL(request.url);
		if (url.pathname.startsWith(`${APP_BROWSER_SESSION_PATH}/`)) {
			return serveAppBrowserSession({
				request,
				url,
				apiOrigin: "https://api.example.com",
				fetcher: async (input, init) => {
					// Let workerd validate the subrequest before stubbing the API response.
					new Request(input, init);
					return new Response(null, { status: 401 });
				},
			});
		}
		return proxyPortApp({
			request,
			url,
			upstream: UPSTREAM,
			fetcher: async (input, init) => sandbox(new Request(input, init)),
		});
	},
};
