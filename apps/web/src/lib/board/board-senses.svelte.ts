import {
	BOARD_CONSENT_SENSES,
	type BoardConsentSense,
} from "@neta-art/cohub/board/stage";
import { untrack } from "svelte";

// Cohub asks per Board: every Board shares one origin, so the browser's own grant covers them all.
const STORAGE_KEY_PREFIX = "cohub:board:senses:v1";

const storageKey = (board: string, viewerUuid: string | null) =>
	`${STORAGE_KEY_PREFIX}:${viewerUuid ?? "anonymous"}:${board}`;

export function readBoardSenseConsent(
	board: string,
	viewerUuid: string | null,
): BoardConsentSense[] {
	if (typeof localStorage === "undefined") return [];
	try {
		const stored: unknown = JSON.parse(
			localStorage.getItem(storageKey(board, viewerUuid)) ?? "[]",
		);
		return Array.isArray(stored)
			? BOARD_CONSENT_SENSES.filter((sense) => stored.includes(sense))
			: [];
	} catch {
		return [];
	}
}

export function writeBoardSenseConsent(
	board: string,
	viewerUuid: string | null,
	senses: readonly BoardConsentSense[],
) {
	if (typeof localStorage === "undefined") return;
	try {
		if (senses.length === 0)
			localStorage.removeItem(storageKey(board, viewerUuid));
		else
			localStorage.setItem(
				storageKey(board, viewerUuid),
				JSON.stringify(senses),
			);
	} catch {}
}

export function createBoardSenseConsent(input: {
	board: () => string | null;
	viewer: () => string | null;
	onChange: () => void;
}) {
	let consent = $state.raw<BoardConsentSense[]>([]);
	$effect(() => {
		const board = input.board();
		consent = board ? readBoardSenseConsent(board, input.viewer()) : [];
		untrack(input.onChange);
	});
	function set(next: BoardConsentSense[]) {
		const board = input.board();
		consent = next;
		if (board) writeBoardSenseConsent(board, input.viewer(), next);
		input.onChange();
	}
	return {
		has: (sense: BoardConsentSense) => consent.includes(sense),
		allow: (senses: readonly BoardConsentSense[]) =>
			set([...new Set([...consent, ...senses])]),
		revoke: (sense: BoardConsentSense) =>
			set(consent.filter((item) => item !== sense)),
	};
}

export type BoardSenseConsent = ReturnType<typeof createBoardSenseConsent>;
