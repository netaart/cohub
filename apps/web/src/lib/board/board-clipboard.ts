import {
	BOARD_CLIPBOARD_MIME,
	type BoardClipboardPayload,
	parseClipboard,
} from "@neta-art/cohub/board/editor";

/** Text selected on the page: copy and cut take that, not the Board selection. */
export function hasPageTextSelection(): boolean {
	return window.getSelection()?.isCollapsed === false;
}

export function writeBoardClipboard(
	data: Pick<DataTransfer, "setData">,
	payload: BoardClipboardPayload,
) {
	data.setData(BOARD_CLIPBOARD_MIME, JSON.stringify(payload));
}

/** Board items in a paste: ours, or JSON as text (older Cohub copies). */
export function readBoardClipboard(
	data: Pick<DataTransfer, "getData"> | null | undefined,
): BoardClipboardPayload | null {
	const raw = data?.getData(BOARD_CLIPBOARD_MIME);
	if (raw) return parseClipboard(raw);
	const text = data?.getData("text/plain")?.trim();
	return text?.startsWith("{") ? parseClipboard(text) : null;
}
