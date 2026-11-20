import { formatDiagnostic, type Diagnostic } from "@neta-art/score-editor";
import type { HostFailure } from "../host/host.ts";
import { folderOf } from "../host/path.ts";
import { fillCopy, frameCopy, type Language } from "./copy.ts";
import type { HandoffOutcome } from "./handoff.ts";

export type FrameStateName = "loading" | "no-file" | "no-host";
export type ScoreKind = "scoreFile" | "generated";
export type FailureAction = "access" | "retry" | "none" | "close";

/** The line the frame keeps after a handoff: ready, or the reason nothing went. */
export type HandoffNotice =
  | { readonly kind: "ready" }
  | { readonly kind: "check"; readonly problem: Diagnostic | null }
  | { readonly kind: "long" }
  | { readonly kind: "failed" }
  | { readonly kind: "elsewhere"; readonly spaceName: string; readonly path: string }
  | { readonly kind: "elsewhere-failed"; readonly spaceName: string; readonly path: string }
  | { readonly kind: "saved"; readonly path: string }
  | { readonly kind: "saved-elsewhere"; readonly spaceName: string; readonly path: string };

/** What the frame says about a handoff result; a notice the package showed is not a refusal. */
export function handoffNoticeFor(
  outcome: HandoffOutcome,
  navigation?: { readonly spaceName: string | null },
  options: { readonly composer?: boolean } = {},
): HandoffNotice | null {
  if (outcome.ok) {
    if (options.composer === false) {
      const spaceName = navigation?.spaceName;
      return spaceName === undefined || spaceName === null
        ? { kind: "saved", path: outcome.path }
        : { kind: "saved-elsewhere", spaceName, path: outcome.path };
    }
    if (outcome.navigation === "handled") return null;
    if (outcome.navigation === "not-handled" || outcome.navigation === "failed") {
      const spaceName = navigation?.spaceName ?? "";
      return {
        kind: outcome.navigation === "not-handled" ? "elsewhere" : "elsewhere-failed",
        spaceName,
        path: outcome.path,
      };
    }
    return { kind: "ready" };
  }
  if (outcome.reason === "check") return { kind: "check", problem: outcome.problem };
  return { kind: outcome.reason };
}

/** The handoff line in the host's language. */
export function handoffNoticeText(notice: HandoffNotice, language: Language): string {
  const copy = frameCopy(language);
  if (notice.kind === "ready") return copy.handoffReady;
  if (notice.kind === "long") return copy.handoffTooLong;
  if (notice.kind === "failed") return copy.handoffFailed;
  if (notice.kind === "saved") return fillCopy(copy.handoffSaved, { path: notice.path });
  if (notice.kind === "saved-elsewhere") {
    return fillCopy(copy.handoffSavedElsewhere, { space: notice.spaceName, path: notice.path });
  }
  if (notice.kind === "elsewhere") {
    return fillCopy(copy.handoffElsewhere, { space: notice.spaceName, path: notice.path });
  }
  if (notice.kind === "elsewhere-failed") {
    return fillCopy(copy.handoffElsewhereFailed, { space: notice.spaceName, path: notice.path });
  }
  if (notice.problem === null) return copy.handoffUnreadable;
  if (language === "zh") {
    const line = notice.problem.at.line;
    if (line === undefined) return copy.handoffUnreadable;
    return fillCopy(copy.handoffBlocked, {
      reason: fillCopy(copy.handoffLine, { line: String(line) }),
    });
  }
  return fillCopy(copy.handoffBlocked, { reason: formatDiagnostic(notice.problem, language) });
}

export type StateContent = { readonly title: string; readonly body: string };

export function stateCopy(
  state: FrameStateName,
  name: string | null,
  language: Language,
  kind: ScoreKind = "scoreFile",
): StateContent {
  const copy = frameCopy(language);
  if (state === "loading") {
    const fallback = kind === "generated" ? copy.generatedScoreTag : copy.scoreFileTag;
    return { title: fillCopy(copy.opening, { name: name ?? fallback }), body: "" };
  }
  if (state === "no-file") return { title: copy.noFileTitle, body: copy.noFileBody };
  return { title: copy.noHostTitle, body: copy.noHostBody };
}

export type FailurePresentation = StateContent & {
  /** Unsaved edits keep the editor mounted; without them the state replaces it. */
  readonly keepEditor: boolean;
  readonly action: FailureAction;
};

/** What a host failure looks like in the frame, with the person's unsaved work in mind. */
export function failurePresentation(
  state: HostFailure,
  options: {
    readonly unsaved: boolean;
    readonly name: string;
    readonly language: Language;
    readonly kind?: ScoreKind;
  },
): FailurePresentation {
  const copy = frameCopy(options.language);
  const fill = (template: string) => fillCopy(template, { name: options.name });

  let content: StateContent;
  let action: FailureAction;
  if (state.status === "file-gone") {
    content = { title: fill(copy.goneTitle), body: fill(copy.goneBody) };
    // A move arrives as a relaunch, so a file that is gone without one was deleted.
    if (options.unsaved) {
      content = { title: content.title, body: fill(copy.deletedEditsBody) };
      action = "none";
    } else {
      action = "close";
    }
  } else if (state.status === "task-gone") {
    content = { title: copy.taskGoneTitle, body: copy.taskGoneBody };
    action = "close";
  } else if (state.status === "failed") {
    content = { title: fill(copy.failedTitle), body: copy.failedBody };
    if (options.unsaved) {
      content = { title: content.title, body: fill(copy.checkFailedBody) };
      action = "none";
    } else {
      action = "retry";
    }
  } else {
    content = {
      title: fill(state.reason === "revoked" ? copy.revokedTitle : copy.noPermissionTitle),
      body:
        state.reason === "revoked"
          ? fill(copy.revokedBody)
          : options.kind === "generated"
            ? copy.generatedNoPermissionBody
            : copy.noPermissionBody,
    };
    action = "access";
    if (options.unsaved) {
      content = {
        title: content.title,
        body: fill(state.reason === "revoked" ? copy.revokedEditsBody : copy.needsAccessEditsBody),
      };
    }
  }

  if (!options.unsaved) return { ...content, keepEditor: false, action };
  return { title: content.title, body: content.body, keepEditor: true, action };
}

export type EditorNotice = { readonly text: string; readonly action: "edit" };

/**
 * The line above the editor: kept edits that cannot be saved ask for edit access; a read-only file
 * with nothing unsaved explains why; anything else has no line.
 */
export function editorNotice(options: {
  readonly unsaved: boolean;
  readonly editable: boolean;
  readonly message: string | null;
  readonly name: string;
  readonly language: Language;
  readonly kind?: ScoreKind;
}): EditorNotice | null {
  const copy = frameCopy(options.language);
  if (options.message) return { text: options.message, action: "edit" };
  if (options.unsaved && !options.editable) {
    return { text: fillCopy(copy.viewOnlyEdits, { name: options.name }), action: "edit" };
  }
  if (!options.unsaved && !options.editable) {
    return {
      text:
        options.kind === "generated"
          ? copy.readOnlyGeneratedBody
          : fillCopy(copy.readOnlyBody, { name: options.name }),
      action: "edit",
    };
  }
  return null;
}

/** A generated score keeps its edits in a draft; only a score file needs the guard. */
export function leaveNeedsGuard(
  kind: "scoreFile" | "generated" | null,
  unsaved: boolean,
): boolean {
  return kind === "scoreFile" && unsaved;
}

/** A retry never runs while the editor holds unsaved edits: reloading would discard them. */
export function canRetry(unsaved: boolean): boolean {
  return !unsaved;
}

/** Another file's launch would replace the editor, so it waits while edits are unsaved. */
export function launchChoice(
  relaunch: "same" | "moved" | "other",
  unsaved: boolean,
): "same" | "moved" | "other" | "hold" {
  return relaunch === "other" && unsaved ? "hold" : relaunch;
}

/** The header's folder line; a file at the Space root says so instead of leaving the row out. */
export function folderLine(path: string, language: Language): string | null {
  if (path === "") return null;
  return folderLabel(path) ?? frameCopy(language).spaceRoot;
}

/** A folder line that keeps the first and last folder when the path is long. */
export function folderLabel(path: string, max = 42): string | null {
  const folder = folderOf(path);
  if (folder === "" || folder.length <= max) return folder === "" ? null : folder;
  const parts = folder.split("/");
  const first = parts[0] ?? "";
  const last = parts[parts.length - 1] ?? "";
  if (parts.length > 1) {
    const marker = "/…/";
    const room = max - marker.length - first.length - last.length;
    if (room >= 0) return `${first}${marker}${last}`;
    const budget = Math.max(2, max - marker.length);
    const head = Math.max(1, Math.floor(budget / 2));
    const tail = Math.max(1, budget - head);
    return `${first.slice(0, head)}${marker}${last.slice(-tail)}`;
  }
  const budget = Math.max(2, max - 1);
  const head = Math.max(1, Math.floor(budget / 2));
  const tail = Math.max(1, budget - head);
  return `${last.slice(0, head)}…${last.slice(-tail)}`;
}
