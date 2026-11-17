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

const HISTORY_PAGES = 2;
const HISTORY_LIMIT = 500;

export function createBoardSessionActions(options: {
	editor: BoardEditor;
	spaceId: string | null;
	isMobile: () => boolean;
	fetchHistory?: (input: BoardHistoryInput) => Promise<BoardHistoryPage>;
	onOpen: () => ((sessionId: string) => void | Promise<void>) | undefined;
	notice: (text: string, error?: boolean) => void;
}) {
	const { editor, spaceId } = options;
	let replyItemId = $state<string | null>(null);

	const selected = $derived.by<SessionItem | null>(() => {
		const [item] = editor.selectedItems;
		return editor.selectedItems.length === 1 && item?.type === "session"
			? item
			: null;
	});
	const replyItem = $derived(
		selected && selected.id === replyItemId ? selected : null,
	);

	$effect(() => {
		const id = selected?.id ?? null;
		untrack(() => {
			if (replyItemId !== id) replyItemId = null;
		});
	});

	function open(item: SessionItem): boolean {
		const handler = options.onOpen();
		if (!handler) return false;
		void handler(item.props.sessionId);
		return true;
	}

	function route(sessionId: string) {
		return spaceId
			? new URL(buildSpaceSessionRoute(spaceId, sessionId), location.origin)
					.href
			: null;
	}

	async function stop(sessionId: string) {
		const session = sessionStore.get(sessionId);
		if (!spaceId || !session?.activeTurn) return;
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
		if (!item || !spaceId) return [];
		const locale = getLocale();
		const { sessionId } = item.props;
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
		if (sessionStore.get(sessionId)?.activeTurn)
			actions.push({
				id: "session-stop",
				label: m.board_session_stop({}, { locale }),
				icon: Square,
				run: () => void stop(sessionId),
			});
		return actions;
	});

	const secondary = $derived.by<BoardMenuAction[]>(() => {
		const item = selected;
		const url = item ? route(item.props.sessionId) : null;
		if (!item || !url) return [];
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
		get replyItem() {
			return replyItem;
		},
		closeReply() {
			replyItemId = null;
		},
	};
}
