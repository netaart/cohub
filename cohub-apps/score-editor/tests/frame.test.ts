import assert from "node:assert/strict";
import { test } from "node:test";
import { createDialectRegistry } from "@neta-art/score-editor";
import { song2Dialect } from "@neta-art/score-dialect-song2";
import { editorOptionsFor } from "../src/app/options.ts";
import { FRAME_COPY, languageFor } from "../src/app/copy.ts";
import { scoreThemeVars } from "../src/host/theme.ts";
import { createScoreHost, type OpenedScore } from "../src/host/host.ts";
import { createFakeClient } from "./fake-client.ts";

const SAMPLE = `X:1
T:
M:4/4
L:1/16
Q:1/4=190
V: Vocal clef=treble name="Vocal Melody" snm="Vocal"
V: Ins clef=treble name="Ins Melody" snm="Inst."
K:E
% intro
V: Vocal
z12e2e2|b6b4e4f2-|f4g4z4e4|b6b4e2-e2f2-|
V: Ins
Z4|
`;

async function opened(scopes: readonly string[]): Promise<OpenedScore & { kind: "scoreFile" }> {
  const client = createFakeClient({ files: { "scores/intro.abc": SAMPLE }, scopes });
  const host = createScoreHost({ client, language: "en" });
  const result = await host.openFile({ spaceId: "space-1", path: "scores/intro.abc" });
  assert.ok(result.ok);
  assert.equal(result.kind, "scoreFile");
  return result;
}

const dialects = createDialectRegistry([song2Dialect]);
assert.ok(dialects);

test("a read with only file.view opens editable: false with its file kind", async () => {
  const file = await opened(["file.view"]);
  assert.equal(file.editable, false);

  const options = editorOptionsFor(file, "en");

  assert.equal(options.editable, false);
  assert.equal(options.source, file.source);
  assert.equal(options.language, "en");
  assert.equal(options.title, "intro.abc");
});

test("an editable file gives the editor its save source", async () => {
  const file = await opened(["file.view", "file.edit"]);
  const options = editorOptionsFor(file, "zh");
  assert.equal(options.editable, true);
  assert.equal(options.source, file.source);
  assert.equal(options.language, "zh");
});

test("the host language follows the locale, Chinese only for zh", () => {
  assert.equal(languageFor("zh"), "zh");
  assert.equal(languageFor("zh-CN"), "zh");
  assert.equal(languageFor("ZH-TW"), "zh");
  assert.equal(languageFor("en-US"), "en");
  assert.equal(languageFor("ja"), "en");
  assert.equal(languageFor(""), "en");
  assert.equal(languageFor(undefined), "en");
});

test("every frame string exists in both languages", () => {
  for (const [key, value] of Object.entries(FRAME_COPY)) {
    assert.ok(value.zh.trim().length > 0, `${key} has no Chinese`);
    assert.ok(value.en.trim().length > 0, `${key} has no English`);
    assert.notEqual(value.zh, value.en, `${key} is not translated`);
  }
});

test("the score theme maps host appearance tokens onto --sce-* variables", () => {
  const light = scoreThemeVars({
    colorScheme: "light",
    tokens: {
      "bg-primary": "#ffffff",
      "text-primary": "#18181b",
      "bg-surface": "#f4f4f5",
      "text-secondary": "#71717a",
      "border-subtle": "#e4e4e7",
      "border-primary": "#a1a1aa",
      brand: "#2457d6",
      "font-sans": "Inter, sans-serif",
      "font-mono": "JetBrains Mono, monospace",
    },
  });
  assert.deepEqual(light, {
    colorScheme: "light",
    vars: {
      "--sce-color-bg": "#ffffff",
      "--sce-color-text": "#18181b",
      "--sce-color-surface": "#f4f4f5",
      "--sce-color-muted": "#71717a",
      "--sce-color-line": "#e4e4e7",
      "--sce-color-line-strong": "#a1a1aa",
      "--sce-color-accent": "#2457d6",
      "--sce-color-note": "#2457d6",
      "--sce-font-family": "Inter, sans-serif",
      "--sce-font-family-mono": "JetBrains Mono, monospace",
    },
  });

  const dark = scoreThemeVars({
    colorScheme: "dark",
    tokens: {
      "bg-primary": "#0b0b0c",
      "text-primary": "#fafafa",
      brand: "#8ab4ff",
    },
  });
  assert.deepEqual(dark, {
    colorScheme: "dark",
    vars: {
      "--sce-color-bg": "#0b0b0c",
      "--sce-color-text": "#fafafa",
      "--sce-color-accent": "#8ab4ff",
      "--sce-color-note": "#8ab4ff",
    },
  });
});
