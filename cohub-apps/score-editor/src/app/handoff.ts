import {
  APP_COMPOSER_CHIP_CONTENT_MAX_BYTES,
  APP_COMPOSER_CHIP_LABEL_MAX_LENGTH,
} from "@neta-art/cohub";
import type { Diagnostic, DialectRegistry, HandoffPayload } from "@neta-art/score-editor";
import { DRAFT_DIR } from "../host/drafts.ts";
import { statusOf, type CohubAppClient, type FileVersion } from "../host/host.ts";
import { fillCopy, frameCopy, type Language } from "./copy.ts";

/** Where a generated score's handoff goes: the same folder as its draft, named after the task run. */
export function draftScorePath(taskRunId: string): string {
  return `${DRAFT_DIR}/${taskRunId}.abc`;
}

/**
 * The one path a handoff names: the chip's first line and the instruction's `--text` path both come from here.
 * Null when the handoff cannot know a path (no task id, or no open file).
 */
export function handoffScorePath(input: {
  readonly kind: "scoreFile" | "generated";
  readonly taskRunId: string | null;
  readonly filePath: string | null;
}): string | null {
  if (input.kind === "generated") {
    return input.taskRunId === null ? null : draftScorePath(input.taskRunId);
  }
  return input.filePath;
}

/** Where a score's handoff file goes: its path with the final `.abc` replaced by `.handoff.md`. */
export function handoffFilePath(scorePath: string): string {
  return scorePath.endsWith(".abc")
    ? `${scorePath.slice(0, -".abc".length)}.handoff.md`
    : `${scorePath}.handoff.md`;
}

/** A chip label within the protocol's limit, keeping the start and the end of a long name. */
export function fitLabel(label: string): string {
  const text = label.trim();
  if (text.length <= APP_COMPOSER_CHIP_LABEL_MAX_LENGTH) return text;
  const room = APP_COMPOSER_CHIP_LABEL_MAX_LENGTH - 1;
  const head = Math.ceil(room / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - (room - head))}`;
}

export type HandoffTarget =
  | { readonly kind: "scoreFile"; readonly path: string }
  | { readonly kind: "generated"; readonly taskRunId: string };

export type HandoffRequest = {
  readonly spaceId: string;
  readonly target: HandoffTarget;
  readonly title: string;
  readonly language: Language;
  readonly payload: HandoffPayload;
  /** Set when the working Space is not the context Space: navigate there after the chip. */
  readonly navigation?: { readonly spaceName: string | null } | null;
};

/**
 * The package's no-style and no-lyrics sentences. These are protocol text, not drawn copy; they
 * track @neta-art/score-editor 0.4.6 and the tests run them against its `handoffInstruction`.
 */
export const PACKAGE_NO_LYRICS = {
  en: "This score carries no lyrics",
  zh: "这份乐谱没有歌词",
} as const;
export const PACKAGE_NO_LYRICS_WITH_STYLE = {
  en: "This score carries no style description and no lyrics",
  zh: "这份乐谱没有风格描述和歌词",
} as const;
export const PACKAGE_NO_STYLE = {
  zh: "这份乐谱没有风格描述：从用户的消息或这段对话里取，都没有就先问用户，再生成。",
  en: "This score carries no style description: take it from the person's message or this conversation; if neither has it, ask the person before generating.",
} as const;

/**
 * The package rebuilds lyrics from lyric lines and drops section-only text such as
 * `[Instrumental]`. The task's original lyrics are still the words the song was made with, so
 * put them back in the instruction the agent reads.
 */
type PackageSentence =
  | { readonly index: number; readonly kind: "noStyleAndNoLyrics" }
  | { readonly index: number; readonly kind: "noLyrics" };

function findPackageSentence(instruction: string, language: Language): PackageSentence | null {
  const lines = instruction.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.startsWith(PACKAGE_NO_LYRICS_WITH_STYLE[language])) {
      return { index, kind: "noStyleAndNoLyrics" };
    }
    if (line.startsWith(PACKAGE_NO_LYRICS[language])) {
      return { index, kind: "noLyrics" };
    }
  }
  return null;
}

export function withOriginalLyrics(
  payload: HandoffPayload,
  lyrics: string,
  language: Language,
): HandoffPayload {
  const text = lyrics.trim();
  if (text === "") return payload;
  const match = findPackageSentence(payload.instruction, language);
  if (match === null) return payload;
  const copy = frameCopy(language);
  const replacement =
    match.kind === "noStyleAndNoLyrics"
      ? [PACKAGE_NO_STYLE[language], "", `${copy.handoffLyrics}:`, ...text.split("\n")]
      : [`${copy.handoffLyrics}:`, ...text.split("\n")];
  const lines = payload.instruction.split("\n");
  lines.splice(match.index, 1, ...replacement);
  return { ...payload, instruction: lines.join("\n") };
}

/** Read the path's version (404 means create) and write at that version, so a changed file is a conflict. */
async function writeVersioned(
  client: CohubAppClient,
  spaceId: string,
  path: string,
  text: string,
): Promise<boolean> {
  let expected: FileVersion | null = null;
  try {
    expected = (await client.read({ spaceId, path })).version;
  } catch (error) {
    if (statusOf(error) !== 404) return false;
  }
  try {
    await client.write({ spaceId, path, text, expected });
    return true;
  } catch {
    return false;
  }
}

/** Opens the score after a handoff; a host that refuses navigation still has the written file. */
async function navigateTo(
  client: CohubAppClient,
  spaceId: string,
  scorePath: string,
): Promise<"handled" | "not-handled" | "failed"> {
  try {
    const result = await client.navigate({ spaceId, path: scorePath });
    return result.handled ? "handled" : "not-handled";
  } catch {
    return "failed";
  }
}

export type HandoffOutcome =
  | {
      readonly ok: true;
      readonly path: string;
      readonly navigation?: "handled" | "not-handled" | "failed";
    }
  | { readonly ok: false; readonly reason: "check"; readonly problem: Diagnostic | null }
  | { readonly ok: false; readonly reason: "long" }
  | { readonly ok: false; readonly reason: "failed" };

/**
 * The App's part of the checks: the dialect parse. The package's pre-handoff notices are not a gate — it shows them
 * in its own review above an enabled confirm, and the viewer who read them may hand off.
 */
function dialectCheck(
  payload: HandoffPayload,
  dialects: DialectRegistry,
): { readonly blocked: boolean; readonly problem: Diagnostic | null } {
  const dialect = dialects.find(payload.project.modelId);
  if (!dialect) return { blocked: false, problem: null };
  const parsed = dialect.parse(payload.project.score);
  return parsed.score === null
    ? { blocked: true, problem: parsed.diagnostics[0] ?? null }
    : { blocked: false, problem: null };
}

/**
 * The App's half of the handoff. The package saves a score file (a conflict stops it) and calls the host only when
 * the score may go; a generated score's draft keeper has recorded the handoff hash by then. The dialect check runs
 * before anything is written, then this module writes the file a generated score needs. A host with a composer
 * gets the agent-facing chip; one without gets the same text in a `.handoff.md` file beside the score.
 */
export function createHandoff(options: {
  readonly client: CohubAppClient;
  readonly dialects: DialectRegistry;
  /** A host without a composer gets a file beside the score instead of a chip. */
  readonly composer?: boolean;
}) {
  const { client } = options;
  const composer = options.composer !== false;
  let key: string | null = null;
  let handedOff = 0;

  return {
    async run(request: HandoffRequest): Promise<HandoffOutcome> {
      const { spaceId, payload } = request;
      const checked = dialectCheck(payload, options.dialects);
      if (checked.blocked) return { ok: false, reason: "check", problem: checked.problem };
      let scorePath: string;
      if (request.target.kind === "generated") {
        scorePath = draftScorePath(request.target.taskRunId);
        if (!(await writeVersioned(client, spaceId, scorePath, payload.attachment.text))) {
          return { ok: false, reason: "failed" };
        }
      } else {
        scorePath = request.target.path;
      }

      const copy = frameCopy(request.language);
      const pathLine =
        request.navigation?.spaceName != null
          ? fillCopy(copy.chipPathInSpace, {
              space: request.navigation.spaceName,
              path: scorePath,
            })
          : fillCopy(copy.chipPath, { path: scorePath });
      const content = `${pathLine}\n\n${payload.instruction}`;

      if (!composer) {
        const path = handoffFilePath(scorePath);
        if (!(await writeVersioned(client, spaceId, path, content))) {
          return { ok: false, reason: "failed" };
        }
        if (!request.navigation) return { ok: true, path };
        return { ok: true, path, navigation: await navigateTo(client, spaceId, scorePath) };
      }

      const nextKey = `score-handoff:${handedOff + 1}`;
      const contentBytes = new TextEncoder().encode(content).length;
      try {
        client.setComposerChip({ key: nextKey, label: fitLabel(request.title), content });
      } catch {
        // The protocol refuses content over its limit; the label was fitted, so a throw this size is the content.
        return { ok: false, reason: contentBytes > APP_COMPOSER_CHIP_CONTENT_MAX_BYTES ? "long" : "failed" };
      }
      key = nextKey;
      handedOff += 1;
      if (!request.navigation) return { ok: true, path: scorePath };
      return { ok: true, path: scorePath, navigation: await navigateTo(client, spaceId, scorePath) };
    },
    /** Takes the chip back when the file it names is no longer the file in this window. */
    clear(): void {
      if (key === null) return;
      client.clearComposerChip(key);
      key = null;
    },
  };
}
