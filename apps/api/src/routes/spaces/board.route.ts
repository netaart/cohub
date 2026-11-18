import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import {
  BOARD_EXTENSION,
  BoardCreateInputSchema,
  isBoardPath,
  serializeBoardManifest,
} from "@cohub/protocol";
import { boards } from "@cohub/db";
import { createBoard, readBoard } from "@cohub/core/board";
import { boardViewers } from "../../board-access.js";
import { buildBoardCreateIdentity } from "../../board-create-idempotency.js";
import { boardInputDiagnostics as zodDiagnostics } from "../../board-error.js";
import { db } from "../../db/index.js";
import { authzDenied, requireValidId, useAuth } from "../../lib/middleware.js";
import { getRequestSource } from "../../lib/request-source.js";
import { hasPermission } from "../../permissions.js";
import {
  assertSafeRelativePath,
  createSpaceFileExclusive,
  deleteSpaceNode,
  readSpaceFile,
  SpaceFsError,
} from "../../space-fs-backend.js";
import { buildFileMutationChanges } from "../../space-fs-change.js";
import { dispatchSpaceFsChanged } from "../../space-events.js";
import boardsRouter, { boardWriteBodyLimit, failBoard } from "../boards.route.js";

const router = new Hono();

type BoardManifestWrite = Awaited<ReturnType<typeof createSpaceFileExclusive>>;

async function readOwnedBoardManifest(spaceId: string, path: string, boardId: string): Promise<BoardManifestWrite | null> {
  try {
    const file = await readSpaceFile(spaceId, path);
    if (!("content" in file)) return null;
    const manifest = JSON.parse(file.content) as { boardId?: unknown };
    if (manifest.boardId !== boardId) return null;
    return { path, size: file.size, mtimeMs: file.mtimeMs, created: false, createdDirs: [], executedBy: "api" };
  } catch {
    return null;
  }
}

async function createOrReuseBoardManifest(
  spaceId: string,
  input: Parameters<typeof createSpaceFileExclusive>[1],
  boardId: string,
): Promise<BoardManifestWrite> {
  try {
    return await createSpaceFileExclusive(spaceId, input);
  } catch (error) {
    if (!(error instanceof SpaceFsError) || error.status !== 409) throw error;
    const owned = await readOwnedBoardManifest(spaceId, input.path, boardId);
    if (owned) return owned;
    throw error;
  }
}

async function boardExists(spaceId: string, boardId: string) {
  const [row] = await db.select({ id: boards.id }).from(boards).where(and(eq(boards.id, boardId), eq(boards.spaceId, spaceId))).limit(1);
  return Boolean(row);
}

router.post("/", boardWriteBodyLimit, async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!spaceId || !requireValidId(spaceId)) return c.json({ code: "SPACE_NOT_FOUND", message: "Space not found." }, 404);
  if (!(await hasPermission(user, "file.edit", { spaceId }))) return authzDenied(c);

  const parsed = BoardCreateInputSchema.safeParse(await c.req.json<unknown>().catch(() => null));
  if (!parsed.success) {
    return c.json({ code: "INVALID_BOARD_INPUT", message: "Board input is invalid.", diagnostics: zodDiagnostics(parsed.error) }, 400);
  }
  const body = parsed.data;
  let path: string;
  try {
    path = assertSafeRelativePath(body.path);
  } catch {
    return c.json({ code: "INVALID_BOARD_PATH", message: "Invalid path: use a path relative to the Space root." }, 400);
  }
  if (!isBoardPath(path)) return c.json({ code: "INVALID_BOARD_PATH", message: `Board path must end with ${BOARD_EXTENSION}.` }, 400);
  const title = (body.title?.trim() || path.split("/").at(-1)?.replace(/\.board$/i, "") || "Board").slice(0, 255);
  const identity = buildBoardCreateIdentity({ spaceId, mutationId: body.mutationId, payload: { path, title, document: body.document ?? {} } });
  const boardId = identity?.boardId ?? crypto.randomUUID();
  const source = getRequestSource(c);

  if (identity && (await boardExists(spaceId, boardId))) return c.json(await readBoard(db, { boardId }));

  let written: BoardManifestWrite | null = null;
  try {
    written = await createOrReuseBoardManifest(spaceId, {
      path,
      content: serializeBoardManifest({ kind: "cohub.board.manifest", version: 1, boardId, title }),
      encoding: "utf-8",
      mutationId: body.mutationId,
    }, boardId);
    await createBoard(db, {
      spaceId,
      boardId,
      title,
      actorId: user.uuid,
      ...boardViewers(user),
      ...(body.document ? { document: body.document } : {}),
      ...(identity ? { mutationId: identity.transactionId } : {}),
      source,
    });
  } catch (error) {
    if (identity && (await boardExists(spaceId, boardId))) return c.json(await readBoard(db, { boardId }));
    if (written?.created) await deleteSpaceNode(spaceId, written.path).catch(() => undefined);
    return failBoard(c, error);
  }

  await dispatchSpaceFsChanged(spaceId, {
    source: "api-fs",
    mutationId: body.mutationId,
    changes: buildFileMutationChanges(written),
  }, written.executedBy === "sandbox" ? { skipHooks: true } : undefined).catch(() => undefined);

  try {
    return c.json(await readBoard(db, { boardId }));
  } catch (error) {
    return failBoard(c, error);
  }
});

router.route("/", boardsRouter);

export default router;
