import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { settleTurnSpeechSegment, swapTurnSpeech } from "@cohub/core/sessions";
import { sessionTurns, taskRuns } from "@cohub/db";
import { createLogger } from "@cohub/infra/logging";
import {
  isUuidOrShortUuid,
  parseSpeechConfig,
  readTurnSpeech,
  SPEECH_CONFIG_PATH,
  toSpeechSegments,
  type RequestSource,
  type SessionTurnRecord,
  type SpeechVoice,
  type TurnSpeech,
  type TurnSpeechSegment,
} from "@cohub/protocol";
import type { GenerationContentBlock } from "@cohub/protocol/generation";
import { eq, inArray } from "drizzle-orm";
import { config } from "./config.js";
import { db } from "./db/index.js";
import { enqueueGeneration, validateGenerationRequest } from "./generations/enqueue.js";
import { dispatchTurnUpdated } from "./session-output.js";
import { toTimelineTurnRecord } from "./session-turns.js";
import { readSpaceFile, spaceFsJsonError } from "./space-fs-backend.js";

const logger = createLogger({ serviceName: "cohub-api" });

export class SpeechError extends Error {
  constructor(readonly status: 404 | 409 | 503, readonly code: string, message: string) {
    super(message);
    this.name = "SpeechError";
  }
}

const MAX_PUBLISHED_ENTRIES = 1000;
const published = new Map<string, { mtimeMs: number; size: number; voice: SpeechVoice | null }>();

async function readPublishedVoice(path: string): Promise<SpeechVoice | null> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch {
    published.delete(path);
    return null;
  }
  const cached = published.get(path);
  if (cached?.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.voice;
  let voice: SpeechVoice | null = null;
  try {
    voice = parseSpeechConfig(await readFile(path, "utf-8")).tts ?? null;
  } catch (error) {
    logger.warn("[Speech] ignoring invalid published speech config", { path, error });
  }
  if (!cached && published.size >= MAX_PUBLISHED_ENTRIES) published.delete(published.keys().next().value as string);
  published.set(path, { mtimeMs: info.mtimeMs, size: info.size, voice });
  return voice;
}

function readPlatformVoice() {
  return readPublishedVoice(join(config.platformConfigRoot, "platform", SPEECH_CONFIG_PATH));
}

function readUserVoice(userId: string) {
  return isUuidOrShortUuid(userId)
    ? readPublishedVoice(join(config.platformConfigRoot, "users", userId, SPEECH_CONFIG_PATH))
    : Promise.resolve(null);
}

async function readSpaceVoice(spaceId: string): Promise<SpeechVoice | null> {
  let raw: string;
  try {
    const file = await readSpaceFile(spaceId, SPEECH_CONFIG_PATH, { visibility: "full" });
    if (!("content" in file)) throw new SpeechError(503, "speech_config_preparing", "The Space is still preparing. Try again shortly.");
    raw = file.encoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content;
  } catch (error) {
    if (!(error instanceof SpeechError) && spaceFsJsonError(error).status === 404) return null;
    throw error;
  }
  try {
    return parseSpeechConfig(raw).tts ?? null;
  } catch {
    return null;
  }
}

export async function resolveSpeechVoice(userId: string, spaceId: string): Promise<SpeechVoice | null> {
  const [space, user, platform] = await Promise.all([readSpaceVoice(spaceId), readUserVoice(userId), readPlatformVoice()]);
  return space ?? user ?? platform;
}

function speechVoiceId(voice: SpeechVoice) {
  const source = JSON.stringify([voice.model, voice.meta ?? null, voice.parameters ?? null, voice.references ?? []]);
  return createHash("sha256").update(source).digest("base64url").slice(0, 22);
}

export async function resolveSpeechVoiceId(userId: string, spaceId: string): Promise<string | null> {
  const voice = await resolveSpeechVoice(userId, spaceId);
  return voice ? speechVoiceId(voice) : null;
}

function speechRequest(voice: SpeechVoice, text: string) {
  const content: GenerationContentBlock[] = [
    { type: "text", text },
    ...(voice.references ?? []).map((url): GenerationContentBlock => ({ type: "audio", source: { type: "url", url } })),
  ];
  return { model: voice.model, content, parameters: voice.parameters, meta: voice.meta };
}

const LOST_TASK_GRACE_MS = 60_000;

async function withLostSegmentsFailed(speech: TurnSpeech, claimedAt: string): Promise<TurnSpeech> {
  const pending = speech.segments.filter((segment) => segment.status === "pending").map((segment) => segment.taskId);
  if (pending.length === 0) return speech;
  const rows = await db.select({ id: taskRuns.id, status: taskRuns.status }).from(taskRuns).where(inArray(taskRuns.id, pending));
  const statuses = new Map(rows.map((row) => [row.id, row.status]));
  const graceOver = Date.now() - Date.parse(claimedAt) > LOST_TASK_GRACE_MS;
  return {
    ...speech,
    segments: speech.segments.map((segment) => {
      if (segment.status !== "pending") return segment;
      const status = statuses.get(segment.taskId);
      // Finished tasks settle their segment first, so a finished task with a pending segment lost its write.
      const lost = status === "completed" || status === "failed" || (status === undefined && graceOver);
      return lost ? { ...segment, status: "failed" } : segment;
    }),
  };
}

function storedSegments(meta: unknown, voice: string): unknown {
  const speech = meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>).speech : null;
  return speech && typeof speech === "object" && !Array.isArray(speech) ? (speech as Record<string, unknown>)[voice] ?? null : null;
}

export async function speakTurn(input: {
  userId: string;
  spaceId: string;
  sessionId: string;
  turn: SessionTurnRecord;
  requestSource: RequestSource | null;
}): Promise<TurnSpeech> {
  const { turn } = input;
  const texts = turn.status === "completed" && (turn.executionKind ?? "agent") === "agent"
    ? toSpeechSegments(turn.assistantText ?? "")
    : [];
  if (texts.length === 0) throw new SpeechError(409, "turn_not_speakable", "This turn has no reply to read aloud.");
  const config = await resolveSpeechVoice(input.userId, input.spaceId);
  if (!config) throw new SpeechError(404, "speech_unavailable", "No read-aloud voice is configured.");
  const voice = speechVoiceId(config);

  let stored = storedSegments(turn.meta, voice);
  let claimedAt = turn.updatedAt;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = readTurnSpeech({ speech: { [voice]: stored } }, voice);
    const reusable = current ? await withLostSegmentsFailed(current, claimedAt) : null;
    if (reusable?.segments.every((segment) => segment.status !== "failed")) return reusable;
    // A broken voice config fails here, before anything is stored.
    if (attempt === 0) await validateGenerationRequest({ userId: input.userId, ...speechRequest(config, texts[0] as string) });

    const segments: TurnSpeechSegment[] = texts.map((_, index) => {
      const kept = reusable?.segments[index];
      return kept && kept.status !== "failed" ? kept : { taskId: randomUUID(), status: "pending" };
    });
    let row = await swapTurnSpeech(db, turn.id, voice, stored, segments);
    if (!row) {
      const [fresh] = await db.select({ meta: sessionTurns.meta, updatedAt: sessionTurns.updatedAt }).from(sessionTurns).where(eq(sessionTurns.id, turn.id)).limit(1);
      stored = storedSegments(fresh?.meta, voice);
      claimedAt = fresh?.updatedAt?.toISOString() ?? claimedAt;
      continue;
    }

    const kept = new Set(reusable?.segments.map((segment) => segment.taskId));
    let failure: unknown = null;
    for (const [index, segment] of segments.entries()) {
      if (kept.has(segment.taskId)) continue;
      const target = { sessionId: input.sessionId, turnId: turn.id, voice, index };
      if (!failure) {
        try {
          await enqueueGeneration({
            userId: input.userId,
            spaceId: input.spaceId,
            sessionId: input.sessionId,
            taskRunId: segment.taskId,
            requestSource: input.requestSource,
            speech: target,
            ...speechRequest(config, texts[index] as string),
          });
          continue;
        } catch (error) {
          failure = error;
        }
      }
      row = (await settleTurnSpeechSegment(db, target, { taskId: segment.taskId, status: "failed" })) ?? row;
    }

    await dispatchTurnUpdated({ spaceId: input.spaceId, sessionId: input.sessionId, turn: toTimelineTurnRecord(row, input.sessionId) })
      .catch((error) => logger.warn("[Speech] failed to dispatch turn update", { turnId: turn.id, error }));
    if (failure) throw failure;
    return readTurnSpeech(row.meta, voice) ?? { voice, segments };
  }
  throw new SpeechError(409, "speech_busy", "The reply is being prepared for reading. Try again.");
}
