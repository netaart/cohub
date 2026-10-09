import { parseFileTargetId, WORKSPACE_ROOT } from "@cohub/core/references";
import type { ReferenceKind } from "@cohub/db";
import type { SessionFileChangeKind, SessionFileRecord } from "@cohub/protocol/model";

/** Reference kinds that mean an agent tool changed a file. */
export const SESSION_FILE_REFERENCE_KINDS = [
  "agent_tool_file_write",
  "agent_tool_file_edit",
] as const satisfies readonly ReferenceKind[];

const CHANGE_KIND_BY_REFERENCE: Record<(typeof SESSION_FILE_REFERENCE_KINDS)[number], SessionFileChangeKind> = {
  agent_tool_file_write: "write",
  agent_tool_file_edit: "edit",
};

const KIND_ORDER: readonly SessionFileChangeKind[] = ["write", "edit"];

export type SessionFileReferenceGroup = {
  targetId: string;
  kinds: string[];
  lastKind: string;
  changeCount: number;
  firstChangedAt: Date;
  lastChangedAt: Date;
  lastTurnId: string;
  lastTurnSequence: number;
};

export function workspacePathFromFileTarget(spaceId: string, targetId: string): string | null {
  const target = parseFileTargetId(targetId);
  if (!target || target.spaceId !== spaceId) return null;
  const prefix = `${WORKSPACE_ROOT}/`;
  if (!target.path.startsWith(prefix)) return null;
  const path = target.path.slice(prefix.length);
  return path.length > 0 ? path : null;
}

function isReferenceKind(kind: string): kind is keyof typeof CHANGE_KIND_BY_REFERENCE {
  return Object.hasOwn(CHANGE_KIND_BY_REFERENCE, kind);
}

/** Latest turn first; files outside the Space workspace are dropped. */
export function projectSessionFiles(input: {
  spaceId: string;
  references: readonly SessionFileReferenceGroup[];
}): SessionFileRecord[] {
  return input.references
    .flatMap((group) => {
      const path = workspacePathFromFileTarget(input.spaceId, group.targetId);
      if (!path || !isReferenceKind(group.lastKind)) return [];
      const kinds = new Set(group.kinds.filter(isReferenceKind).map((kind) => CHANGE_KIND_BY_REFERENCE[kind]));
      return [{
        path,
        lastKind: CHANGE_KIND_BY_REFERENCE[group.lastKind],
        kinds: KIND_ORDER.filter((kind) => kinds.has(kind)),
        changeCount: Math.max(1, group.changeCount),
        firstChangedAt: group.firstChangedAt.toISOString(),
        lastChangedAt: group.lastChangedAt.toISOString(),
        lastTurnId: group.lastTurnId,
        lastTurnSequence: group.lastTurnSequence,
      }];
    })
    .sort((a, b) => b.lastTurnSequence - a.lastTurnSequence || a.path.localeCompare(b.path));
}
