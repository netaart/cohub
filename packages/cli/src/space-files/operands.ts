import { posix, resolve } from "node:path";
import { parseSpaceRef } from "@neta-art/cohub";

export type SpaceOperand = { kind: "space"; space: string | null; path: string };
export type LocalOperand = { kind: "local"; path: string };
export type FileOperand = SpaceOperand | LocalOperand;

export class InvalidFileOperandError extends Error {
  override name = "InvalidFileOperandError";
}

const WORKSPACE_ROOT = "/workspace";

const isWorkspacePath = (path: string) => path === WORKSPACE_ROOT || path.startsWith(`${WORKSPACE_ROOT}/`);

export function normalizeSpacePath(raw: string) {
  let path = raw.trim();
  if (isWorkspacePath(path)) path = path.slice(WORKSPACE_ROOT.length + 1);
  else if (path.startsWith("/")) throw new InvalidFileOperandError(`'${raw}' is not a Space path`);
  const normalized = posix.normalize(path || ".").replace(/\/+$/, "");
  return normalized === "." ? "" : normalized;
}

function parseSpacePrefix(raw: string): SpaceOperand | null {
  const colon = raw.indexOf(":");
  if (colon <= 0) return null;
  const space = raw.slice(0, colon);
  return parseSpaceRef(space) ? { kind: "space", space, path: normalizeSpacePath(raw.slice(colon + 1)) } : null;
}

export function parseSpaceFileOperand(raw: string): SpaceOperand {
  return parseSpacePrefix(raw) ?? { kind: "space", space: null, path: normalizeSpacePath(raw) };
}

export function parseCopyOperand(raw: string, currentSpaceDeclared: boolean): FileOperand {
  const space = parseSpacePrefix(raw);
  if (space) return space;
  const local = !currentSpaceDeclared || (raw.startsWith("/") && !isWorkspacePath(raw));
  return local ? { kind: "local", path: resolve(raw) } : { kind: "space", space: null, path: normalizeSpacePath(raw) };
}
