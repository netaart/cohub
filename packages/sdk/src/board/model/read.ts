import type { BoardReadResult } from "@cohub/protocol";
import type { BoardDocument } from "@cohub/protocol/board-model";
import { applyBoardDelta, parseBoardDocument } from "@cohub/protocol/board-patch";
import { shareBoardDocument } from "./document-share.js";

export function readBoardDocument(result: BoardReadResult, base: BoardDocument | null = null): BoardDocument {
	if (result.changes) {
		if (!base) throw new Error(`Board ${result.id} returned changes without a document to apply them to.`);
		return result.changes.reduce(applyBoardDelta, base);
	}
	const parsed = parseBoardDocument({ board: result.board, items: result.items ?? {}, animations: result.animations ?? {} }, { keepUnknown: true });
	if (!parsed.ok) throw new Error(`Board ${result.id} could not be read.`);
	return shareBoardDocument(base, parsed.document);
}
