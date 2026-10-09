import { type BoardDocument, type BoardScene, type BoardSceneItem, buildBoardScene, parseBoardDocument } from "@neta-art/cohub/board";

/** A parsed document from loose input; throws on invalid input. */
export function boardDocument(input: { board?: Record<string, unknown>; items?: Record<string, unknown>; animations?: Record<string, unknown> } = {}): BoardDocument {
	const parsed = parseBoardDocument({ board: input.board ?? {}, items: input.items ?? {}, animations: input.animations ?? {} });
	if (!parsed.ok) throw new Error(parsed.diagnostics.map((entry) => `${entry.path}: ${entry.message}`).join("; "));
	return parsed.document;
}

export function boardScene(items: Record<string, unknown>): BoardScene {
	return buildBoardScene(boardDocument({ items }));
}

/** One scene item, resolved alone. */
export function sceneItem(id: string, item: Record<string, unknown>): BoardSceneItem {
	return boardScene({ [id]: item }).get(id) as BoardSceneItem;
}
