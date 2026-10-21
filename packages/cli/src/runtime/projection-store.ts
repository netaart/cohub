import type { NativeProjection, ProjectionTarget } from "@neta-art/cohub";
import { harnessAdapter } from "./harnesses/index.js";
import { listSessionProjectionTurns, projectTurnBatch, type ProjectionSourceTurn, type SessionTurnProjectionClient } from "./turn-projection.js";

export type ProjectionStoreInput = {
  spaceId: string;
  sessionId: string;
  turnId: string;
  nativeSessionId: string;
  cwd: string;
  provider?: string | null;
  target: ProjectionTarget;
  throughTurnId: string | null;
};

export type ProjectionStoreResult = { projection: NativeProjection; turns: ProjectionSourceTurn[] };

/** Give the projection's own records (the native header) the identity of the file it becomes. */
export function rebindProjectionNativeSession(result: ProjectionStoreResult, nativeSessionId: string): ProjectionStoreResult {
  const records = harnessAdapter(result.projection.target).session.rebind(result.projection.records, nativeSessionId);
  return { ...result, projection: { ...result.projection, records } };
}

/**
 * Materializes a Session's durable Turns into one harness-specific native file. Cohub never appends
 * to a native file it did not just write, so every projection is complete up to the Session head.
 */
export class ProjectionStore {
  constructor(private readonly source: SessionTurnProjectionClient) {}

  async project(input: ProjectionStoreInput, signal?: AbortSignal): Promise<ProjectionStoreResult> {
    const throughSequence = input.throughTurnId ? (await this.source.session(input.sessionId).turns.get(input.throughTurnId, { signal })).turn.sequence : 0;
    const turns = await listSessionProjectionTurns(this.source, input.sessionId, { throughSequence, excludeTurnId: input.turnId, signal });
    const projection = projectTurnBatch({
      spaceId: input.spaceId,
      sessionId: input.sessionId,
      nativeSessionId: input.nativeSessionId,
      cwd: input.cwd,
      provider: input.provider,
      turns,
    }, input.target);
    return { projection, turns };
  }
}
