import type { BoardHistoryInput, BoardHistoryPage } from "@cohub/protocol";
import type { BoardSceneItem } from "@neta-art/cohub/board";
import {
	ExternalLink,
	Link,
	MessageSquare,
	Reply,
	ScanSearch,
	Square,
} from "lucide-svelte";
import { untrack } from "svelte";
import { sessionChangedItems } from "#lib/board/board-session.ts";
import type { BoardEditor } from "#lib/board/editor.svelte.ts";
import { copyTextToClipboard } from "#lib/clipboard.ts";
import type { BoardMenuAction } from "#lib/components/board/BoardContextMenu.svelte";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";
import { sdk } from "#lib/sdk.ts";
import { buildSpaceSessionRoute } from "#lib/space-routes.ts";
import { sessionStore } from "#lib/stores/session-store.ts";

type SessionItem = Extract<BoardSceneItem, { type: "session" }>;
type SessionTarget = { sessionId: string; spaceId: string };

const HISTORY_PAGES = 2;
const HISTORY_LIMIT = 500;

export function createBoardSessionActions(options: {
	editor: BoardEditor;
	home: string | null;
	live: boolean;
	isMobile: () => boolean;
	fetchHistory?: (input: BoardHistoryInput) => Promise<BoardHistoryPage>;
	onOpen: () =>
		| ((sessionId: string, spaceId: string) => void | Promise<void>)
		| undefined;
	notice: (text: string, error?: boolean) => void;
}) {
	const { editor, home, live } = options;
	let replyItemId = $state<string | null>(null);

	const selected = $derived.by<SessionItem | null>(() => {
		const [item] = editor.selectedItems;
		return editor.selectedItems.length === 1 && item?.type === "session"
			? item
			: null;
	});
	const reply = $derived.by(() => {
		const target =
			live && selected?.id === replyItemId ? targetOf(selected) : null;
		return selected && target ? { id: selected.id, ...target } : null;
	});

	function targetOf(item: SessionItem): SessionTarget | null {
		const spaceId = item.props.snapshot.spaceId ?? home;
		return spaceId ? { sessionId: item.props.sessionId, spaceId } : null;
	}

	$effect(() => {
		const id = selected?.id ?? null;
		untrack(() => {
			if (replyItemId !== id) replyItemId = null;
		});
	});

	function open(item: SessionItem): boolean {
		const handler = options.onOpen();
		const target = targetOf(item);
		if (!handler || !target) return false;
		void handler(target.sessionId, target.spaceId);
		return true;
	}

	function route({ spaceId, sessionId }: SessionTarget) {
		return new URL(buildSpaceSessionRoute(spaceId, sessionId), location.origin)
			.href;
	}

	async function stop({ spaceId, sessionId }: SessionTarget) {
		const session = sessionStore.get(sessionId);
		if (!session?.activeTurn) return;
		await sdk
			.space(spaceId)
			.session(sessionId)
			.abort({ turnId: session.activeTurn.id })
			.catch(() =>
				options.notice(
					m.board_session_stop_failed({}, { locale: getLocale() }),
					true,
				),
			);
	}

	async function selectChanges(sessionId: string) {
		const fetchHistory = options.fetchHistory;
		if (!fetchHistory) return;
		const pages: BoardHistoryPage[] = [];
		let before: number | undefined;
		for (let index = 0; index < HISTORY_PAGES; index += 1) {
			const page = await fetchHistory({ before, limit: HISTORY_LIMIT }).catch(
				() => null,
			);
			if (!page) break;
			pages.push(page);
			if (page.nextBefore === null) break;
			before = page.nextBefore;
		}
		const ids = sessionChangedItems(pages, sessionId).filter((id) =>
			editor.itemById(id),
		);
		if (!ids.length) {
			options.notice(m.board_session_no_changes({}, { locale: getLocale() }));
			return;
		}
		editor.setSelection(ids);
		editor.focusItems(ids);
	}

	const primary = $derived.by<BoardMenuAction[]>(() => {
		const item = selected;
		const target = live && item ? targetOf(item) : null;
		if (!item || !target) return [];
		const locale = getLocale();
		const actions: BoardMenuAction[] = [];
		if (options.onOpen())
			actions.push({
				id: "session-open",
				label: m.board_open_session({}, { locale }),
				icon: MessageSquare,
				run: () => open(item),
			});
		if (!options.isMobile())
			actions.push({
				id: "session-reply",
				label: m.board_session_reply({}, { locale }),
				icon: Reply,
				expanded: replyItemId === item.id,
				run: () => {
					replyItemId = replyItemId === item.id ? null : item.id;
				},
			});
		if (sessionStore.get(target.sessionId)?.activeTurn)
			actions.push({
				id: "session-stop",
				label: m.board_session_stop({}, { locale }),
				icon: Square,
				run: () => void stop(target),
			});
		return actions;
	});

	const secondary = $derived.by<BoardMenuAction[]>(() => {
		const item = selected;
		const target = live && item ? targetOf(item) : null;
		if (!item || !target) return [];
		const url = route(target);
		const locale = getLocale();
		const actions: BoardMenuAction[] = [
			{
				id: "session-open-tab",
				label: m.board_session_open_tab({}, { locale }),
				icon: ExternalLink,
				run: () => window.open(url, "_blank", "noopener,noreferrer"),
			},
			{
				id: "session-copy-link",
				label: m.board_session_copy_link({}, { locale }),
				icon: Link,
				run: () => {
					void copyTextToClipboard(url)
						.then(() =>
							options.notice(m.board_view_link_copied({}, { locale })),
						)
						.catch(() => undefined);
				},
			},
		];
		if (options.fetchHistory)
			actions.push({
				id: "session-select-changes",
				label: m.board_session_select_changes({}, { locale }),
				icon: ScanSearch,
				run: () => void selectChanges(item.props.sessionId),
			});
		return actions;
	});

	return {
		open,
		get toolbar() {
			return primary;
		},
		get menu() {
			return [...primary, ...secondary];
		},
		get reply() {
			return reply;
		},
		closeReply() {
			replyItemId = null;
		},
	};
}
