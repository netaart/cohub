import { type BoardDocument, parseBoardDocument } from "@neta-art/cohub/board";
import { createClient } from "./client.js";

export type BoardSource = {
  document: BoardDocument;
  boardId: string;
  title: string | null;
};

export async function loadBoardDocument(spaceId: string, target: string): Promise<BoardSource> {
  const board = await createClient().space(spaceId).boards.open(target);
  let result = await board.get();
  const snapshot = result;
  const items = { ...result.items };
  while (result.next) {
    result = await board.get({ only: ["items"], cursor: result.next });
    if (result.version !== snapshot.version) throw new Error("Board changed while reading. Retry the export.");
    Object.assign(items, result.items);
  }
  const parsed = parseBoardDocument({ board: snapshot.board, items, animations: snapshot.animations ?? {} }, { keepUnknown: true });
  if (!parsed.ok) throw new Error(`Board ${result.id} could not be read: ${parsed.diagnostics[0]?.path}: ${parsed.diagnostics[0]?.message}`);
  return { document: parsed.document, boardId: result.id, title: result.title };
}
