import type { BoardSessionLive } from "@neta-art/cohub/board/render";
import { untrack } from "svelte";
import { SvelteSet } from "svelte/reactivity";
import { boardSessionLive } from "#lib/board/board-session.ts";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { sdk } from "#lib/sdk.ts";
import { unreadTracker } from "#lib/stores/session-state.svelte.ts";
import { sessionStore } from "#lib/stores/session-store.ts";

const FETCH_LIMIT = 100;

type LiveView = BoardSessionLive | "unavailable";

export function createBoardLiveSessions(input: {
	spaceId: string;
	sessionIds: () => readonly string[];
	onChange: (sessionIds: ReadonlySet<string>) => void;
}) {
	const views = new Map<string, LiveView>();
	const keys = new Map<string, string>();
	const unavailable = new SvelteSet<string>();
	const requested = new Set<string>();
	let pending: string[] = [];
	let timer: ReturnType<typeof setTimeout> | null = null;
	let destroyed = false;

	async function refresh(ids: string[]) {
		await sessionStore.hydrate(input.spaceId, ids);
		for (let offset = 0; offset < ids.length; offset += FETCH_LIMIT) {
			const chunk = ids.slice(offset, offset + FETCH_LIMIT);
			const response = await sdk
				.space(input.spaceId)
				.sessions.list({ ids: chunk })
				.catch(() => null);
			if (destroyed) return;
			if (!response) {
				for (const id of chunk) requested.delete(id);
				continue;
			}
			sessionStore.mergeAll(response.sessions);
			const found = new Set(response.sessions.map((session) => session.id));
			for (const id of chunk) {
				if (found.has(id)) unavailable.delete(id);
				else unavailable.add(id);
			}
		}
	}

	function request(ids: readonly string[]) {
		for (const id of ids) {
			if (requested.has(id)) continue;
			requested.add(id);
			pending.push(id);
		}
		if (!pending.length || timer) return;
		timer = setTimeout(() => {
			timer = null;
			const batch = pending;
			pending = [];
			void refresh(batch);
		}, 0);
	}

	const stop = $effect.root(() => {
		$effect(() => {
			const ids = input.sessionIds();
			const locale = getLocale();
			const changed = new Set<string>();
			for (const id of ids) {
				const session = sessionStore.get(id);
				const view: LiveView | null = unavailable.has(id)
					? "unavailable"
					: session && session.spaceId === input.spaceId
						? boardSessionLive(
								session,
								unreadTracker.isUnread(session, session.lastMessageId),
								locale,
							)
						: null;
				const key = view ? JSON.stringify(view) : "";
				if (keys.get(id) === key) continue;
				keys.set(id, key);
				if (view) views.set(id, view);
				else views.delete(id);
				changed.add(id);
			}
			untrack(() => {
				if (changed.size) input.onChange(changed);
				request(ids);
			});
		});
	});

	return {
		get: (sessionId: string) => views.get(sessionId) ?? null,
		destroy() {
			destroyed = true;
			if (timer) clearTimeout(timer);
			stop();
		},
	};
}
