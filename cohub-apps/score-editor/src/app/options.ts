import type { ScoreSource } from "@neta-art/score-editor";
import type { OpenedScore } from "../host/host.ts";
import type { Language } from "./copy.ts";

export type EditorOptions = {
  readonly language: Language;
  readonly editable: boolean;
  readonly title: string;
  /** The kind is always passed so the package can label a read-only score file. */
  readonly source?: ScoreSource;
};

export function editorOptionsFor(opened: OpenedScore, language: Language): EditorOptions {
  const source = opened.kind === "scoreFile" ? opened.source : { kind: "generated" as const };
  return { language, editable: opened.editable, title: opened.name, source };
}
