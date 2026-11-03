import type { BoardDocument } from "@cohub/protocol";
import { sameJson } from "./json.js";

export type BoardFieldChange = { path: string; from?: unknown; to?: unknown };

export type BoardElementChange = {
  kind: "board" | "item" | "animation";
  id: string;
  change: "added" | "removed" | "changed";
  type?: string;
  fields: BoardFieldChange[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function fieldChanges(before: unknown, after: unknown, path: string, out: BoardFieldChange[]) {
  if (isRecord(before) && isRecord(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)]))
      fieldChanges(before[key], after[key], path ? `${path}.${key}` : key, out);
    return;
  }
  if (sameJson(before, after)) return;
  out.push({ path, ...(before === undefined ? {} : { from: before }), ...(after === undefined ? {} : { to: after }) });
}

function compare(
  kind: BoardElementChange["kind"],
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  typeOf: (value: unknown) => string | undefined = () => undefined,
): BoardElementChange[] {
  const changes: BoardElementChange[] = [];
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const from = before[id];
    const to = after[id];
    if (from === to || sameJson(from, to)) continue;
    const type = typeOf(to ?? from);
    const typed = type ? { type } : {};
    if (from === undefined) changes.push({ kind, id, change: "added", ...typed, fields: [] });
    else if (to === undefined) changes.push({ kind, id, change: "removed", ...typed, fields: [] });
    else {
      const fields: BoardFieldChange[] = [];
      fieldChanges(from, to, "", fields);
      changes.push({ kind, id, change: "changed", ...typed, fields });
    }
  }
  return changes;
}

export function diffBoardVersions(before: BoardDocument, after: BoardDocument): BoardElementChange[] {
  const board: BoardFieldChange[] = [];
  fieldChanges(before.board, after.board, "", board);
  return [
    ...(board.length ? [{ kind: "board" as const, id: "board", change: "changed" as const, fields: board }] : []),
    ...compare("item", before.items, after.items, (item) => (item as { type?: string }).type),
    ...compare("animation", before.animations, after.animations),
  ];
}
