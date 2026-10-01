import { and, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  BOARD_EXTENSION,
  BoardApplyInputSchema,
  BoardCreateInputSchema,
  BoardHistoryInputSchema,
  BoardPlaybackCommandSchema,
  BoardReadInputSchema,
  isBoardPath,
  serializeBoardManifest,
} from "@cohub/protocol";
import { boards } from "@cohub/db";
import {
  applyBoard,
  applyBoardPlayback,
  createBoard,
  deleteBoard,
  readBoard,
  readBoardHistory,
  restoreBoardVersion,
  type BoardApplyOutcome,
} from "@cohub/core/board";
import { buildBoardCreateIdentity } from "../../board-create-idempotency.js";
import {
  boardErrorBody as errorBody,
  boardErrorResponse as errorResponse,
  boardInputDiagnostics as zodDiagnostics,
} from "../../board-error.js";
import { dispatchBoardChanged, dispatchBoardPlaybackChanged } from "../../board-events.js";
import { db } from "../../db/index.js";
import { authzDenied, getOptionalAuth, requireValidId, useAuth } from "../../lib/middleware.js";
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

export const BOARD_WRITE_MAX_BYTES = 32 * 1024 * 1024;

const router = new Hono();
const boardNotFound = { code: "BOARD_NOT_FOUND", message: "Board not found." };
const writeBodyLimit = bodyLimit({
  maxSize: BOARD_WRITE_MAX_BYTES,
  onError: (c) => c.json({ code: "BOARD_INPUT_TOO_LARGE", message: `Board input exceeds ${BOARD_WRITE_MAX_BYTES} bytes.` }, 413),
});

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

function fail(c: Context, error: unknown) {
  const response = errorResponse(error);
  return c.json(errorBody(response), response.status as never);
}

function boardParams(c: { req: { param: (name: string) => string | undefined } }) {
  const spaceId = c.req.param("id");
  const boardId = c.req.param("boardId");
  return spaceId && boardId && requireValidId(spaceId) && requireValidId(boardId) ? { spaceId, boardId } : null;
}

async function announce(spaceId: string, boardId: string, actorId: string, outcome: BoardApplyOutcome, source: ReturnType<typeof getRequestSource>) {
  if (!outcome.written) return;
  await dispatchBoardChanged({
    spaceId,
    boardId,
    actorId,
    mutationId: outcome.result.mutationId,
    baseVersion: outcome.written.baseVersion,
    version: outcome.result.version,
    changed: outcome.result.changed,
    after: outcome.written.after,
    source,
  }).catch(() => undefined);
  if (outcome.written.playback !== undefined) {
    await dispatchBoardPlaybackChanged({ spaceId, boardId, playback: outcome.written.playback }).catch(() => undefined);
  }
}

router.post("/", writeBodyLimit, async (c) => {
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

  if (identity) {
    const [existing] = await db.select({ id: boards.id }).from(boards).where(and(eq(boards.id, boardId), eq(boards.spaceId, spaceId))).limit(1);
    if (existing) return c.json(await readBoard(db, { spaceId, boardId }));
  }

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
      ...(body.document ? { document: body.document } : {}),
      ...(identity ? { mutationId: identity.transactionId } : {}),
      source,
    });
    await dispatchSpaceFsChanged(spaceId, {
      source: "api-fs",
      mutationId: body.mutationId,
      changes: buildFileMutationChanges(written),
    }, written.executedBy === "sandbox" ? { skipHooks: true } : undefined).catch(() => undefined);
    return c.json(await readBoard(db, { spaceId, boardId }));
  } catch (error) {
    await deleteBoard(db, { spaceId, boardId }).catch(() => undefined);
    if (written?.created) await deleteSpaceNode(spaceId, written.path).catch(() => undefined);
    return fail(c, error);
  }
});

router.get("/:boardId", async (c) => {
  const params = boardParams(c);
  if (!params) return c.json(boardNotFound, 404);
  if (!(await hasPermission(getOptionalAuth(c), "file.view", { spaceId: params.spaceId }))) return authzDenied(c);
  const list = (name: string) => c.req.query(name)?.split(",").map((value) => value.trim()).filter(Boolean);
  const rect = list("rect")?.map(Number);
  const limit = c.req.query("limit");
  const only = list("only");
  const items = list("items");
  const animations = list("animations");
  const within = c.req.query("within");
  const cursor = c.req.query("cursor");
  const read = BoardReadInputSchema.safeParse({
    ...(only ? { only } : {}),
    ...(rect ? { rect: { x: rect[0], y: rect[1], width: rect[2], height: rect[3] } } : {}),
    ...(within ? { within } : {}),
    ...(items ? { items } : {}),
    ...(animations ? { animations } : {}),
    ...(limit !== undefined ? { limit: Number(limit) } : {}),
    ...(cursor ? { cursor } : {}),
  });
  if (!read.success) return c.json({ code: "INVALID_BOARD_INPUT", message: "Board query is invalid.", diagnostics: zodDiagnostics(read.error, "query") }, 400);
  try {
    return c.json(await readBoard(db, { ...params, read: read.data }));
  } catch (error) {
    return fail(c, error);
  }
});

router.post("/:boardId/apply", writeBodyLimit, async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const params = boardParams(c);
  if (!params) return c.json(boardNotFound, 404);
  if (!(await hasPermission(user, "file.edit", { spaceId: params.spaceId }))) return authzDenied(c);
  const parsed = BoardApplyInputSchema.safeParse(await c.req.json<unknown>().catch(() => null));
  if (!parsed.success) return c.json({ code: "INVALID_PATCH", message: "Board patch is invalid.", diagnostics: zodDiagnostics(parsed.error) }, 400);
  const source = getRequestSource(c);
  try {
    const outcome = await applyBoard(db, { ...params, actorId: user.uuid, apply: parsed.data, source });
    await announce(params.spaceId, params.boardId, user.uuid, outcome, source);
    return c.json(outcome.result);
  } catch (error) {
    return fail(c, error);
  }
});

router.get("/:boardId/history", async (c) => {
  const params = boardParams(c);
  if (!params) return c.json(boardNotFound, 404);
  if (!(await hasPermission(getOptionalAuth(c), "file.view", { spaceId: params.spaceId }))) return authzDenied(c);
  const before = c.req.query("before");
  const limit = c.req.query("limit");
  const history = BoardHistoryInputSchema.safeParse({
    ...(before !== undefined ? { before: Number(before) } : {}),
    ...(limit !== undefined ? { limit: Number(limit) } : {}),
  });
  if (!history.success) return c.json({ code: "INVALID_BOARD_INPUT", message: "Board history query is invalid.", diagnostics: zodDiagnostics(history.error, "query") }, 400);
  try {
    return c.json(await readBoardHistory(db, { ...params, history: history.data }));
  } catch (error) {
    return fail(c, error);
  }
});

router.post("/:boardId/restore", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const params = boardParams(c);
  if (!params) return c.json(boardNotFound, 404);
  if (!(await hasPermission(user, "file.edit", { spaceId: params.spaceId }))) return authzDenied(c);
  const body = (await c.req.json<{ version?: unknown }>().catch(() => null)) ?? {};
  const version = Number(body.version);
  if (!Number.isInteger(version) || version < 0) return c.json({ code: "INVALID_BOARD_INPUT", message: "version must be a non-negative integer." }, 400);
  const source = getRequestSource(c);
  try {
    const outcome = await restoreBoardVersion(db, { ...params, actorId: user.uuid, version, source });
    await announce(params.spaceId, params.boardId, user.uuid, outcome, source);
    return c.json(outcome.result);
  } catch (error) {
    return fail(c, error);
  }
});

router.post("/:boardId/playback", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const params = boardParams(c);
  if (!params) return c.json(boardNotFound, 404);
  if (!(await hasPermission(user, "file.edit", { spaceId: params.spaceId }))) return authzDenied(c);
  const parsed = BoardPlaybackCommandSchema.safeParse(await c.req.json<unknown>().catch(() => null));
  if (!parsed.success) return c.json({ code: "INVALID_BOARD_INPUT", message: "Board playback command is invalid.", diagnostics: zodDiagnostics(parsed.error) }, 400);
  try {
    const playback = await applyBoardPlayback(db, { ...params, command: parsed.data });
    await dispatchBoardPlaybackChanged({ ...params, playback }).catch(() => undefined);
    return c.json({ playback });
  } catch (error) {
    return fail(c, error);
  }
});

export default router;
