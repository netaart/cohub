import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  BoardApplyInputSchema,
  BoardHistoryInputSchema,
  BoardPlaybackCommandSchema,
  BoardReadInputSchema,
} from "@cohub/protocol";
import {
  applyBoard,
  applyBoardPlayback,
  readBoard,
  readBoardHistory,
  restoreBoardVersion,
  BOARD_TASK_MUTATION_PREFIX,
  type BoardApplyOutcome,
} from "@cohub/core/board";
import { type BoardAccess, boardViewers, canAccessBoard, readBoardSpace } from "../board-access.js";
import {
  boardErrorBody as errorBody,
  boardErrorResponse as errorResponse,
  boardInputDiagnostics as zodDiagnostics,
} from "../board-error.js";
import { dispatchBoardChanged, dispatchBoardPlaybackChanged } from "../board-events.js";
import { db } from "../db/index.js";
import { type AuthUser, authzDenied, getOptionalAuth, requireValidId, useAuth } from "../lib/middleware.js";
import { getRequestSource } from "../lib/request-source.js";
import { resolveRequestActor } from "../lib/request-actor.js";

const BOARD_WRITE_MAX_BYTES = 32 * 1024 * 1024;

const router = new Hono();
const boardNotFound = { code: "BOARD_NOT_FOUND", message: "Board not found." };
export const boardWriteBodyLimit = bodyLimit({
  maxSize: BOARD_WRITE_MAX_BYTES,
  onError: (c) => c.json({ code: "BOARD_INPUT_TOO_LARGE", message: `Board input exceeds ${BOARD_WRITE_MAX_BYTES} bytes.` }, 413),
});

type OpenedBoard = { boardId: string; spaceId: string };

export function failBoard(c: Context, error: unknown) {
  const response = errorResponse(error);
  return c.json(errorBody(response), response.status as never);
}

async function openBoard(c: Context, user: AuthUser | null, access: BoardAccess): Promise<OpenedBoard | Response> {
  const boardId = c.req.param("boardId");
  const spaceId = boardId && requireValidId(boardId) ? await readBoardSpace(boardId) : null;
  if (!boardId || !spaceId) return c.json(boardNotFound, 404);
  if (!(await canAccessBoard(user, spaceId, access))) return authzDenied(c);
  return { boardId, spaceId };
}

async function announce(c: Context, board: OpenedBoard, actorId: string, outcome: BoardApplyOutcome, source: ReturnType<typeof getRequestSource>) {
  if (!outcome.written) return;
  await dispatchBoardChanged({ ...board, actorId, actor: await resolveRequestActor(c), outcome, source }).catch(() => undefined);
  if (outcome.written.playback !== undefined) {
    await dispatchBoardPlaybackChanged({ ...board, playback: outcome.written.playback }).catch(() => undefined);
  }
}

router.get("/:boardId", async (c) => {
  const board = await openBoard(c, getOptionalAuth(c), "view");
  if (board instanceof Response) return board;
  const list = (name: string) => c.req.query(name)?.split(",").map((value) => value.trim()).filter(Boolean);
  const rect = list("rect")?.map(Number);
  const limit = c.req.query("limit");
  const only = list("only");
  const items = list("items");
  const animations = list("animations");
  const within = c.req.query("within");
  const cursor = c.req.query("cursor");
  const since = c.req.query("since");
  const read = BoardReadInputSchema.safeParse({
    ...(only ? { only } : {}),
    ...(rect ? { rect: { x: rect[0], y: rect[1], width: rect[2], height: rect[3] } } : {}),
    ...(within ? { within } : {}),
    ...(items ? { items } : {}),
    ...(animations ? { animations } : {}),
    ...(limit !== undefined ? { limit: Number(limit) } : {}),
    ...(cursor ? { cursor } : {}),
    ...(since !== undefined ? { since: Number(since) } : {}),
  });
  if (!read.success) return c.json({ code: "INVALID_BOARD_INPUT", message: "Board query is invalid.", diagnostics: zodDiagnostics(read.error, "query") }, 400);
  try {
    return c.json(await readBoard(db, { boardId: board.boardId, read: read.data }));
  } catch (error) {
    return failBoard(c, error);
  }
});

router.post("/:boardId/apply", boardWriteBodyLimit, async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const board = await openBoard(c, user, "edit");
  if (board instanceof Response) return board;
  const parsed = BoardApplyInputSchema.safeParse(await c.req.json<unknown>().catch(() => null));
  if (!parsed.success) return c.json({ code: "INVALID_PATCH", message: "Board patch is invalid.", diagnostics: zodDiagnostics(parsed.error) }, 400);
  if (parsed.data.mutationId?.startsWith(BOARD_TASK_MUTATION_PREFIX)) {
    return c.json({ code: "INVALID_PATCH", message: `mutationId must not start with "${BOARD_TASK_MUTATION_PREFIX}".` }, 400);
  }
  const source = getRequestSource(c);
  try {
    const outcome = await applyBoard(db, { boardId: board.boardId, actorId: user.uuid, apply: parsed.data, source, ...boardViewers(user) });
    await announce(c, board, user.uuid, outcome, source);
    return c.json(outcome.result);
  } catch (error) {
    return failBoard(c, error);
  }
});

router.get("/:boardId/history", async (c) => {
  const board = await openBoard(c, getOptionalAuth(c), "view");
  if (board instanceof Response) return board;
  const before = c.req.query("before");
  const limit = c.req.query("limit");
  const history = BoardHistoryInputSchema.safeParse({
    ...(before !== undefined ? { before: Number(before) } : {}),
    ...(limit !== undefined ? { limit: Number(limit) } : {}),
  });
  if (!history.success) return c.json({ code: "INVALID_BOARD_INPUT", message: "Board history query is invalid.", diagnostics: zodDiagnostics(history.error, "query") }, 400);
  try {
    return c.json(await readBoardHistory(db, { boardId: board.boardId, history: history.data }));
  } catch (error) {
    return failBoard(c, error);
  }
});

router.post("/:boardId/restore", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const board = await openBoard(c, user, "edit");
  if (board instanceof Response) return board;
  const body = (await c.req.json<{ version?: unknown }>().catch(() => null)) ?? {};
  const version = Number(body.version);
  if (!Number.isInteger(version) || version < 0) return c.json({ code: "INVALID_BOARD_INPUT", message: "version must be a non-negative integer." }, 400);
  const source = getRequestSource(c);
  try {
    const outcome = await restoreBoardVersion(db, { boardId: board.boardId, actorId: user.uuid, version, source });
    await announce(c, board, user.uuid, outcome, source);
    return c.json(outcome.result);
  } catch (error) {
    return failBoard(c, error);
  }
});

router.post("/:boardId/playback", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const board = await openBoard(c, user, "edit");
  if (board instanceof Response) return board;
  const parsed = BoardPlaybackCommandSchema.safeParse(await c.req.json<unknown>().catch(() => null));
  if (!parsed.success) return c.json({ code: "INVALID_BOARD_INPUT", message: "Board playback command is invalid.", diagnostics: zodDiagnostics(parsed.error) }, 400);
  try {
    const playback = await applyBoardPlayback(db, { boardId: board.boardId, command: parsed.data });
    await dispatchBoardPlaybackChanged({ ...board, playback }).catch(() => undefined);
    return c.json({ playback });
  } catch (error) {
    return failBoard(c, error);
  }
});

export default router;
