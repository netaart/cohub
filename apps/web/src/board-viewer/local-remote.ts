import type {
	BoardApplyResult,
	BoardPatch,
	BoardReadResult,
} from "@cohub/protocol";
import type { BoardAssetSource, BoardImageSource } from "@neta-art/cohub/board";
import type { BoardRemote } from "@neta-art/cohub/board/replica";

export type LocalBoardRoute = { base: string; id: string };

/** The page lives at `/k/<key>/b/<id>`; every other URL hangs off the same key. */
export function readLocalBoardRoute(pathname: string): LocalBoardRoute | null {
	const match = /^(\/k\/[A-Za-z0-9_-]+)\/b\/([A-Za-z0-9_-]+)\/?$/.exec(
		pathname,
	);
	return match ? { base: match[1] as string, id: match[2] as string } : null;
}

class LocalBoardError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

async function readJson<T>(response: Response): Promise<T> {
	const body = (await response.json().catch(() => null)) as
		| (T & { message?: string })
		| null;
	if (!response.ok)
		throw new LocalBoardError(
			body?.message ?? `Request failed with ${response.status}`,
			response.status,
		);
	return body as T;
}

export function localBoardRemote({ base, id }: LocalBoardRoute): BoardRemote {
	const api = `${base}/api/b/${id}`;
	return {
		get: () =>
			fetch(api, { cache: "no-store" }).then(readJson<BoardReadResult>),
		apply: (patch: BoardPatch, options) =>
			fetch(`${api}/apply`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ patch, ...options }),
			}).then(readJson<BoardApplyResult>),
		subscribe(handlers) {
			const events = new EventSource(`${api}/events`);
			let opened = false;
			events.addEventListener("changed", (event) =>
				handlers.changed?.({ payload: JSON.parse(event.data) }),
			);
			events.addEventListener("resync", () => handlers.resync?.());
			// A reconnect may have missed changes; the first open needs nothing.
			events.addEventListener("open", () => {
				if (opened) handlers.resync?.();
				opened = true;
			});
			return () => events.close();
		},
	};
}

export function localBoardImageStore({ base, id }: LocalBoardRoute) {
	return (file: File): Promise<BoardImageSource> =>
		fetch(`${base}/api/b/${id}/assets`, {
			method: "POST",
			headers: {
				"Content-Type": file.type || "application/octet-stream",
				"X-File-Name": encodeURIComponent(file.name),
			},
			body: file,
		}).then(readJson<BoardImageSource>);
}

export function localBoardAssetSource({
	base,
	id,
}: LocalBoardRoute): BoardAssetSource {
	const root = new URL(`${base}/f/${id}/`, location.origin);
	return {
		resolveFile: async (path) => ({
			url: new URL(path.split("/").map(encodeURIComponent).join("/"), root)
				.href,
		}),
	};
}
