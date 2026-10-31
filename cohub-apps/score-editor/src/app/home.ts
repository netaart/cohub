import { saveAsPath } from "../host/save-as.ts";
import { nameOfTask, projectFromTask, scoresOfTask, type TaskRunSnapshot } from "../host/task.ts";
import type { Language } from "./copy.ts";

/** The smallest complete song2 score; a new document starts here. */
export const NEW_SCORE_TEXT = `X:1
T:
M:4/4
L:1/16
Q:1/4=100
V: Vocal clef=treble name="Vocal Melody" snm="Vocal"
K:C
% verse
V: Vocal
C16|D16|
`;

export type HomeSong = {
  readonly id: string;
  readonly title: string;
  readonly style: string;
  readonly createdAt: string;
  readonly score: string;
  readonly requestScore: string;
  readonly outputScore: string;
};


export type HomeFile = {
  readonly name: string;
  readonly path: string;
  readonly folder: string;
  readonly mtimeMs: number;
  readonly size: number;
  readonly text: string;
  readonly copyTaskId: string | null;
};

export function homeFileRow(
  entry: {
    readonly name: string;
    readonly path: string;
    readonly mtimeMs: number;
    readonly size: number;
    readonly type?: "file" | "dir" | "symlink";
  },
  text: string | null,
  songs: readonly HomeSong[],
): HomeFile {
  const folder = entry.path.replace(/\/+$/, "").split("/").slice(0, -1).join("/");
  return {
    name: entry.name,
    path: entry.path,
    folder,
    mtimeMs: entry.mtimeMs,
    size: entry.size,
    text: text ?? "",
    copyTaskId: text === null ? null : copySongId(text, songs),
  };
}

function firstLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
}

export function homeSong(run: TaskRunSnapshot): HomeSong | null {
  if ((run.status ?? "completed") !== "completed") return null;
  const project = projectFromTask(run);
  if (project.score.trim() === "") return null;
  const scores = scoresOfTask(run);
  const title = nameOfTask(run, project);
  const style = firstLine(project.style);
  return {
    id: run.id,
    title: title === run.id ? "" : title,
    style: title === style ? "" : style,
    createdAt: run.createdAt ?? "",
    score: project.score,
    outputScore: scores.output,
    requestScore: scores.request,
  };
}

export function homeSongRows(runs: readonly TaskRunSnapshot[]): HomeSong[] {
  return runs.flatMap((run) => {
    const song = homeSong(run);
    return song === null ? [] : [song];
  });
}

/** Newest first, and a song with no time last, as the file rows do. */
export function sortHomeSongs(rows: readonly HomeSong[]): HomeSong[] {
  return [...rows].sort((a, b) => {
    const at = timeValue(a.createdAt) ?? Number.NEGATIVE_INFINITY;
    const bt = timeValue(b.createdAt) ?? Number.NEGATIVE_INFINITY;
    return bt - at || a.id.localeCompare(b.id);
  });
}

/**
 * The song a score file is a copy of. Both the request score and the output score count: one
 * host saves the input score beside a song. Trailing whitespace is ignored, as the package's
 * handoff hash does.
 */
export function copySongId(text: string, songs: readonly HomeSong[]): string | null {
  const normalized = text.trimEnd();
  if (normalized.trim() === "") return null;
  const matches = songs.filter(
    (song) =>
      (song.outputScore.trim() !== "" && song.outputScore.trimEnd() === normalized) ||
      (song.requestScore.trim() !== "" && song.requestScore.trimEnd() === normalized),
  );
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  return matches[0]?.id ?? null;
}

export function newScorePath(taken: ReadonlySet<string>): string {
  return saveAsPath({ sourceFile: null, taskRunId: "", name: "new-score" }, taken);
}

const localeFor = (language: Language) => (language === "zh" ? "zh-CN" : "en-US");

function timeValue(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function formatHomeTime(
  value: string | number | null | undefined,
  language: Language,
  options: { readonly now?: number; readonly timeZone?: string } = {},
): string {
  const time = timeValue(value);
  if (time === null) return "";
  const date = new Date(time);
  const now = new Date(options.now ?? Date.now());
  const zone = options.timeZone;
  const day = (input: Date) =>
    new Intl.DateTimeFormat(localeFor(language), {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      ...(zone ? { timeZone: zone } : {}),
    }).format(input);
  const sameDay = day(date) === day(now);
  const sameYear = date.getUTCFullYear() === now.getUTCFullYear();
  if (sameDay) {
    return new Intl.DateTimeFormat(localeFor(language), {
      hour: "2-digit",
      minute: "2-digit",
      ...(zone ? { timeZone: zone } : {}),
    }).format(date);
  }
  return new Intl.DateTimeFormat(localeFor(language), {
    ...(sameYear ? {} : { year: "numeric" }),
    month: "short",
    day: "numeric",
    ...(zone ? { timeZone: zone } : {}),
  }).format(date);
}

export function timeIso(value: string | number | null | undefined): string {
  const time = timeValue(value);
  return time === null ? "" : new Date(time).toISOString();
}

export function formatHomeFullTime(
  value: string | number | null | undefined,
  language: Language,
  options: { readonly timeZone?: string } = {},
): string {
  const time = timeValue(value);
  if (time === null) return "";
  const date = new Date(time);
  return new Intl.DateTimeFormat(localeFor(language), {
    dateStyle: "medium",
    timeStyle: "short",
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  }).format(date);
}
