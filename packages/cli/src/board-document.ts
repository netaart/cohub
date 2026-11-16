import { dirname } from "node:path";
import { type BoardDocument, parseBoardDocument } from "@neta-art/cohub/board";
import type { Command } from "commander";
import { type BoardFiles, isLocalBoard, localBoardFiles, spaceBoardFiles } from "./board-files.js";
import { createClient } from "./client.js";
import { resolveSpace, targetsSpace } from "./space.js";

export type BoardSource = {
  document: BoardDocument;
  files: BoardFiles;
  boardId: string;
  title: string | null;
};

export async function loadBoardSource(boards: Command, target: string): Promise<BoardSource> {
  if (await isLocalBoard(target, () => targetsSpace(boards))) {
    const { localBoardTitle, readLocalBoard } = await import("./board-local.js");
    const { document } = await readLocalBoard(target);
    return { document, files: localBoardFiles(dirname(target)), boardId: target, title: localBoardTitle(target, document) };
  }
  const spaceId = await resolveSpace(boards);
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
  return { document: parsed.document, files: spaceBoardFiles(spaceId), boardId: result.id, title: result.title };
}
