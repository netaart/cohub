import type { BoardDocument, BoardItem, BoardPatch, BoardScript } from "@cohub/protocol";

export type BoardScriptAttachment = {
  readonly id: string;
  readonly script: BoardScript;
  readonly item: BoardItem | null;
};

type ScriptSource = Pick<BoardDocument, "items"> & { board?: Pick<BoardDocument["board"], "scripts"> };

const attachmentsByItems = new WeakMap<BoardDocument["items"], { scripts: BoardDocument["board"]["scripts"]; list: readonly BoardScriptAttachment[] }>();

export function boardScriptAttachments(document: ScriptSource): readonly BoardScriptAttachment[] {
  const scripts = document.board?.scripts;
  const cached = attachmentsByItems.get(document.items);
  if (cached && cached.scripts === scripts) return cached.list;
  const list: BoardScriptAttachment[] = [];
  for (const [id, script] of Object.entries(scripts ?? {}))
    if (script.enabled) list.push({ id, script, item: null });
  for (const [id, item] of Object.entries(document.items))
    if (item.script?.enabled) list.push({ id, script: item.script, item });
  attachmentsByItems.set(document.items, { scripts, list });
  return list;
}

export function hasBoardScripts(document: ScriptSource): boolean {
  return boardScriptAttachments(document).length > 0;
}

export function isBoardRootScript(document: ScriptSource, id: string): boolean {
  return Boolean(document.board?.scripts && Object.hasOwn(document.board.scripts, id));
}

export function removeBoardScriptPatch(document: BoardDocument, id: string): BoardPatch {
  const animations: NonNullable<BoardPatch["animations"]> = {};
  for (const [animationId, animation] of Object.entries(document.animations)) {
    const tracks = Object.keys(animation.tracks).filter((trackId) => animation.tracks[trackId]?.target === id);
    if (tracks.length) animations[animationId] = { tracks: Object.fromEntries(tracks.map((trackId) => [trackId, null])) };
  }
  return { board: { scripts: { [id]: null } }, ...(Object.keys(animations).length ? { animations } : {}) };
}
