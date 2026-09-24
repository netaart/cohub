import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentBlock, SessionTurnRecord } from "@neta-art/cohub";
import type { SessionTurnProjectionClient } from "../../src/runtime/turn-projection.js";

export type RuntimeProjectionSourceFixture = SessionTurnProjectionClient & {
  addTurn(sessionId: string, turnId: string, options?: {
    sequence?: number;
    userContent?: ContentBlock[];
    assistantContent?: ContentBlock[] | null;
    status?: SessionTurnRecord["status"];
    intent?: SessionTurnRecord["intent"];
  }): SessionTurnRecord;
};

const timestamp = "2026-01-01T00:00:00.000Z";
process.env.PI_CODING_AGENT_SESSION_DIR ??= join(tmpdir(), `cohub-runtime-pi-${process.pid}`);
process.env.CODEX_HOME ??= join(tmpdir(), `cohub-runtime-codex-${process.pid}`);

export function runtimeProjectionSource(): RuntimeProjectionSourceFixture {
  const sessions = new Map<string, SessionTurnRecord[]>();

  const addTurn: RuntimeProjectionSourceFixture["addTurn"] = (sessionId, turnId, options = {}) => {
    const turns = sessions.get(sessionId) ?? [];
    const existing = turns.find((turn) => turn.id === turnId);
    if (existing) return existing;
    const sequence = options.sequence ?? Math.max(0, ...turns.map((turn) => turn.sequence)) + 1;
    const turn: SessionTurnRecord = {
      id: turnId,
      sessionId,
      sourceSessionId: sessionId,
      sourceTurnId: turnId,
      userUuid: null,
      sequence,
      status: options.status ?? "completed",
      intent: options.intent ?? "followup",
      userContent: options.userContent ?? [],
      userText: null,
      assistantContent: options.assistantContent ?? null,
      assistantText: null,
      provider: "fixture",
      model: "test",
      stopReason: "stop",
      errorMessage: null,
      finalUsage: null,
      totalUsage: null,
      summary: null,
      intermediateIndex: null,
      intermediateSummary: null,
      harnessIndex: null,
      meta: null,
      startedAt: timestamp,
      completedAt: timestamp,
      durationMs: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    turns.push(turn);
    turns.sort((left, right) => left.sequence - right.sequence);
    sessions.set(sessionId, turns);
    return turn;
  };

  return {
    addTurn,
    session: (sessionId) => ({
      turns: {
        async listPaginated(options, request) {
          request?.signal?.throwIfAborted();
          const direction = options?.direction ?? "older";
          const limit = options?.limit ?? 100;
          const candidates = (sessions.get(sessionId) ?? []).filter((turn) => options?.cursor === undefined
            || (direction === "newer" ? turn.sequence > options.cursor : turn.sequence < options.cursor));
          const ordered = direction === "newer" ? candidates : [...candidates].reverse();
          const page = ordered.slice(0, limit);
          const turns = direction === "newer" ? page : page.reverse();
          return { turns, hasMore: candidates.length > limit, nextCursor: turns.at(direction === "newer" ? -1 : 0)?.sequence };
        },
        async get(turnId, request) {
          request?.signal?.throwIfAborted();
          return { turn: addTurn(sessionId, turnId) };
        },
        intermediate: {
          async get() { return null; },
          async getToolCalls() { return null; },
        },
      },
    }),
  };
}
