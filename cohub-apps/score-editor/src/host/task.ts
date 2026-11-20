import type { SongProject } from "@neta-art/score-editor";

/** The fields of a Task Run this App reads; the SDK keeps the payload and result untyped. */
export type TaskRunSnapshot = {
  readonly id: string;
  readonly spaceId: string | null;
  readonly status?: string;
  /** When the run was created; the home orders songs by it. */
  readonly createdAt?: string;
  readonly payload: unknown;
  readonly result: unknown;
};

export type TaskScores = {
  readonly output: string;
  readonly request: string;
  /** The score a song carries: the output when it is not blank, else the request. */
  readonly score: string;
};

type Block = Record<string, unknown>;

const MODEL_ID = "song2";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function blocks(value: unknown): Block[] {
  return Array.isArray(value)
    ? (value.filter((item): item is Block => record(item) !== null))
    : [];
}

function textOf(block: Block): string {
  // Full text, not an excerpt: lyrics and scores must not be shortened at 240 characters.
  for (const value of [block.text, block.content, block.value]) {
    if (typeof value === "string") return value;
  }
  return "";
}

function roleOf(block: Block): string | null {
  const role = record(block.meta)?.role;
  return typeof role === "string" ? role : null;
}

function blockWithRole(list: Block[], role: string): Block | null {
  return list.find((block) => roleOf(block) === role) ?? null;
}

/** `payload.data` carries the request the CLI sent; a bare payload is accepted too. */
function taskData(payload: unknown): Record<string, unknown> {
  const outer = record(payload);
  return record(outer?.data) ?? outer ?? {};
}

function outputBlocks(result: unknown): Block[] {
  return blocks(record(result)?.output);
}

function seedOf(parameters: Record<string, unknown>): number | null {
  const seed = parameters.seed;
  return typeof seed === "number" && Number.isSafeInteger(seed) ? seed : null;
}

function scoreModeOf(parameters: Record<string, unknown>): SongProject["scoreMode"] {
  const mode = parameters.abc_mode ?? parameters.abcMode;
  return mode === "melody" ? "melody" : "full";
}

/**
 * The song project a generation records: style from the `prompt` role, lyrics from `lyrics`,
 * the score from the output's `abc` role (or the input's when the output has none), the seed
 * and score mode from the request parameters.
 */
export function scoresOfTask(run: TaskRunSnapshot): TaskScores {
  const data = taskData(run.payload);
  const content = blocks(data.content);
  const inputScore = blockWithRole(content, "abc");
  const outputScore = blockWithRole(outputBlocks(run.result), "abc");
  // A blank score block is "none": the input then carries what the song was made from.
  const outputText = outputScore ? textOf(outputScore) : "";
  const inputText = inputScore ? textOf(inputScore) : "";
  return {
    output: outputText,
    request: inputText,
    score: outputText.trim() ? outputText : inputText,
  };
}

export function projectFromTask(run: TaskRunSnapshot): SongProject {
  const data = taskData(run.payload);
  const content = blocks(data.content);
  const parameters = record(data.parameters) ?? {};
  const model = data.model;
  const scores = scoresOfTask(run);

  return {
    style: textOf(blockWithRole(content, "prompt") ?? {}),
    lyrics: textOf(blockWithRole(content, "lyrics") ?? {}),
    score: scores.score,
    scoreMode: scoreModeOf(parameters),
    seed: seedOf(parameters),
    modelId: typeof model === "string" && model ? model : MODEL_ID,
    sourceKey: run.id,
  };
}

/** The first line that is a lyric, not a section marker like `[Verse]`. */
function firstLyricLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !/^\[[^\]]*\]$/.test(line)) ?? ""
  );
}

/** A readable name for the window: the first lyric line, then the style, then the task. */
export function nameOfTask(run: TaskRunSnapshot, project: SongProject): string {
  return firstLyricLine(project.lyrics) || firstLyricLine(project.style) || run.id;
}
