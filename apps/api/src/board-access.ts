import { eq } from "drizzle-orm";
import { boards } from "@cohub/db";
import type { BoardWriteInput } from "@cohub/core/board";
import { db } from "./db/index.js";
import type { AuthUser } from "./lib/middleware.js";
import { hasPermission, isTaskRunOwner } from "./permissions.js";

export type BoardAccess = "view" | "edit";

const SPACE_PERMISSION = { view: "file.view.filtered", edit: "file.edit" } as const;

export async function readBoardSpace(boardId: string): Promise<string | null> {
  const [row] = await db.select({ spaceId: boards.spaceId }).from(boards).where(eq(boards.id, boardId)).limit(1);
  return row?.spaceId ?? null;
}

export function canAccessBoard(user: AuthUser | null, spaceId: string, access: BoardAccess): Promise<boolean> {
  return hasPermission(user, SPACE_PERMISSION[access], { spaceId });
}

export function boardViewers(user: AuthUser): Pick<BoardWriteInput, "taskViewer" | "sessionViewer"> {
  return {
    taskViewer: async ({ spaceId, sessionId, userUuid }) =>
      isTaskRunOwner(user, { userUuid }) || hasPermission(user, "taskrun.view", { spaceId, sessionId: sessionId ?? undefined }),
    sessionViewer: ({ id, spaceId }) => hasPermission(user, "session.view", { spaceId, sessionId: id }),
  };
}
