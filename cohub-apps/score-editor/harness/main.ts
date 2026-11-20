import {
  DRAFT_FORMAT_VERSION,
  contentHash,
  draftText,
} from "@neta-art/score-editor";
import { createApp, type AppHost } from "../src/app/app.ts";
import { frameCopy, languageFor } from "../src/app/copy.ts";
import { createHomeView } from "../src/app/home-view.ts";
import { homeFileRow, homeSong } from "../src/app/home.ts";
import { stateCopy } from "../src/app/policy.ts";
import { createFrameView } from "../src/app/view.ts";
import "../src/app/styles.css";
import { draftPath } from "../src/host/drafts.ts";
import { projectFromTask } from "../src/host/task.ts";
import type { TaskRunSnapshot } from "../src/host/task.ts";
import { createFakeClient, FakeRequestError, type FakeClient } from "../tests/fake-client.ts";
import { homeActions } from "../tests/helpers.ts";

const SAMPLE = `X:1
T:
M:4/4
L:1/16
Q:1/4=190
V: Vocal clef=treble name="Vocal Melody" snm="Vocal"
V: Ins clef=treble name="Ins Melody" snm="Inst."
K:E
% Verse
V: Vocal
z12e2e2|b6b4e4f2-|f4g4z4e4|b6b4e2-e2f2-|
V: Ins
Z4|
`;
const THEIRS = SAMPLE.replace("z12e2e2", "z12d2e2");
const EDITED = SAMPLE.replace("z12e2e2", "z12f2e2");
const LYRICS = "[Verse]\nNeon lights";
const SPACE = "space-1";
const TASK_ID = "task-1";
const TASK: TaskRunSnapshot = {
  id: TASK_ID,
  spaceId: SPACE,
  status: "completed",
  createdAt: "2026-10-28T09:30:00.000Z",
  payload: {
    data: {
      model: "song2",
      content: [
        { type: "text", text: "warm synthwave", meta: { role: "prompt" } },
        { type: "text", text: LYRICS, meta: { role: "lyrics" } },
      ],
      parameters: { seed: 42 },
    },
  },
  result: {
    output: [{ type: "text", text: SAMPLE, meta: { role: "abc" } }],
  },
};
const INSTRUMENTAL_TASK: TaskRunSnapshot = {
  ...TASK,
  payload: {
    data: {
      model: "song2",
      content: [
        { type: "text", text: "warm synthwave", meta: { role: "prompt" } },
        { type: "text", text: "[Instrumental]", meta: { role: "lyrics" } },
      ],
      parameters: { seed: 42 },
    },
  },
};
const TASK_2: TaskRunSnapshot = {
  ...TASK,
  id: "task-2",
  spaceId: "space-2",
  payload: {
    data: {
      model: "song2",
      content: [{ type: "text", text: "city pop", meta: { role: "prompt" } }],
      parameters: { seed: 7 },
    },
  },
};
const LONG_NAME = "morning-walk-in-the-rain-with-a-very-long-name-that-keeps-going-and-going.abc";
const PATHS = {
  default: "scores/intro.abc",
  root: "intro.abc",
  deep: "projects/2026/morning-walk/scores/drafts/intro.abc",
  long: `scores/${LONG_NAME}`,
} as const;

const LIGHT = {
  "bg-primary": "#ffffff",
  "bg-content": "#ffffff",
  "bg-surface": "#f4f4f5",
  "bg-hover": "#ececee",
  "text-primary": "#18181b",
  "text-secondary": "#52525b",
  "text-tertiary": "#71717a",
  "border-subtle": "#e4e4e7",
  "border-primary": "#a1a1aa",
  brand: "#FF3E00",
  "brand-hover": "#E63700",
  "brand-contrast-fg": "#1b1c1f",
  "font-sans": 'system-ui, -apple-system, "Segoe UI", sans-serif',
};
const DARK = {
  "bg-primary": "#1b1c1f",
  "bg-content": "#1b1c1f",
  "bg-surface": "#26262a",
  "bg-hover": "#2f2f34",
  "text-primary": "#ececee",
  "text-secondary": "#b4b4bb",
  "text-tertiary": "#a1a1aa",
  "border-subtle": "#2c2c30",
  "border-primary": "#52525b",
  brand: "#FF3E00",
  "brand-hover": "#FF5520",
  "brand-contrast-fg": "#1b1c1f",
  "font-sans": 'system-ui, -apple-system, "Segoe UI", sans-serif',
};

const BROKEN = "this is not a song2 score";

const params = new URLSearchParams(location.search);
const state = params.get("state") ?? "editable";
const locale = params.get("lang") === "zh" ? "zh-CN" : "en-US";
const colorScheme = params.get("theme") === "light" ? "light" : "dark";
const pathKind = (params.get("path") ?? "default") as keyof typeof PATHS;
const PATH = PATHS[pathKind] ?? PATHS.default;
// `?composer=0` runs any state on a host with no composer. The file handoff states default to one.
const composerParam = params.get("composer");
const fileHandoff = state === "handoff-file" || state === "handoff-file-elsewhere";
const composer = composerParam === null ? !fileHandoff : composerParam !== "0";
const tokens = colorScheme === "light" ? LIGHT : DARK;
document.documentElement.lang = locale;
document.documentElement.style.colorScheme = colorScheme;
for (const [token, value] of Object.entries(tokens)) {
  document.documentElement.style.setProperty(`--cohub-${token}`, value);
}

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("The harness page has no #app element.");
const chipPanel = document.querySelector<HTMLElement>("#chip");

/** Polls for something the App renders asynchronously; the harness has no test framework. */
async function until<T>(read: () => T | null): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The harness gave up waiting for the handoff controls.");
}

/** The dev-only readout of the chip the fake composer received, with how often it was replaced. */
function watchChip(client: FakeClient): void {
  if (!chipPanel) return;
  let seen = -1;
  setInterval(() => {
    const chip = client.chips.at(-1);
    if (chip === undefined) {
      if (client.chips.length !== seen) chipPanel.hidden = true;
      return;
    }
    if (client.chips.length === seen) return;
    seen = client.chips.length;
    const title = document.createElement("div");
    title.className = "chip-title";
    title.textContent = `Fake composer chip · set ${client.chips.length}×`;
    const label = document.createElement("div");
    label.className = "chip-label";
    label.textContent = chip.label;
    const content = document.createElement("pre");
    content.className = "chip-content";
    content.textContent = chip.content;
    chipPanel.replaceChildren(title, label, content);
    chipPanel.hidden = false;
  }, 100);
}

/** Presses the package's handoff trigger and confirms its review, as a person would. */
async function handOff(hostRoot: HTMLElement): Promise<void> {
  const trigger = await until(() =>
    hostRoot.querySelector<HTMLButtonElement>(".sce-handoff-button:not([disabled])"),
  );
  trigger.click();
  const confirm = await until(() =>
    hostRoot.querySelector<HTMLButtonElement>(".sce-handoff-confirm"),
  );
  confirm.click();
}

/** The open button on the home row whose title is exactly `title`. */
function rowMain(hostRoot: HTMLElement, title: string): HTMLButtonElement | null {
  for (const row of hostRoot.querySelectorAll<HTMLElement>(".home-row")) {
    const label = row.querySelector<HTMLElement>(".home-row-title-text")?.textContent;
    if (label !== title) continue;
    const main = row.querySelector<HTMLButtonElement>(".home-row-main");
    if (main && !main.disabled) return main;
  }
  return null;
}

async function draftFor(score: string): Promise<string> {
  const project = projectFromTask(TASK);
  return draftText({
    version: DRAFT_FORMAT_VERSION,
    sourceKey: TASK_ID,
    sourceHash: await contentHash(project.lyrics, project.score),
    project: {
      style: project.style,
      lyrics: project.lyrics,
      lyricLines: [],
      score,
      scoreMode: project.scoreMode,
      seed: project.seed,
    },
    handoffHash: null,
    updatedAt: 1_000,
  });
}

async function boot(): Promise<void> {
  const hostRoot = root as HTMLElement;
  hostRoot.replaceChildren();
  const language = languageFor(locale);

  if (state === "no-host") {
    const view = createFrameView(hostRoot, language);
    view.setFile(null, null, false);
    view.showState(stateCopy("no-host", null, language));
    return;
  }
  if (state === "startup-failed") {
    const copy = frameCopy(language);
    const view = createFrameView(hostRoot, language);
    view.setFile(null, null, false);
    view.showState({
      title: copy.startupFailedTitle,
      body: copy.startupFailedBody,
      action: { label: copy.retry, run: () => void boot() },
    });
    return;
  }

  if (state === "home-copy-check" || state === "home-copy-failed") {
    const copy = frameCopy(language);
    const song = homeSong(TASK);
    if (!song) throw new Error("The harness task has no score.");
    const intro = homeFileRow(
      { name: "intro.abc", path: "scores/intro.abc", type: "file", mtimeMs: 1_790_000_000_000, size: SAMPLE.length },
      SAMPLE,
      [song],
    );
    const theme = homeFileRow(
      { name: "theme.abc", path: "world/theme.abc", type: "file", mtimeMs: 1_790_100_000_000, size: SAMPLE.length },
      SAMPLE,
      [song],
    );
    const view = createHomeView(hostRoot, language, homeActions);
    view.render({
      language,
      songs: [song],
      files: [theme, intro],
      songsState: "ready",
      filesState: "ready",
      refreshing: false,
      refreshFailed: false,
      songsHasMore: false,
      loadingSongs: false,
      canWrite: false,
      readOnly: true,
      workingName: null,
      listedIsContext: true,
      contextHasGrant: true,
      fileLimit: 20,
      checking: state === "home-copy-check" ? theme.path : null,
      copying: null,
      busy: null,
      accessRequired: false,
      slowSongs: false,
      slowFiles: false,
      allFailed: false,
      rowError:
        state === "home-copy-failed"
          ? { key: theme.path, text: copy.copyCheckFailed, retry: () => {} }
          : null,
      notice: null,
    });
    return;
  }

  if (state === "home-refresh" || state === "home-refresh-failed") {
    const song = homeSong(TASK);
    if (!song) throw new Error("The harness task has no score.");
    const file = homeFileRow(
      { name: "intro.abc", path: "scores/intro.abc", type: "file", mtimeMs: 1_790_000_000_000, size: SAMPLE.length },
      SAMPLE,
      [song],
    );
    const view = createHomeView(hostRoot, language, homeActions);
    view.render({
      language,
      songs: [song],
      files: [file],
      songsState: "ready",
      filesState: "ready",
      refreshing: state === "home-refresh",
      refreshFailed: state === "home-refresh-failed",
      songsHasMore: false,
      loadingSongs: false,
      canWrite: true,
      readOnly: false,
      workingName: null,
      listedIsContext: true,
      contextHasGrant: true,
      fileLimit: 20,
      checking: null,
      copying: null,
      busy: null,
      accessRequired: false,
      slowSongs: false,
      slowFiles: false,
      allFailed: false,
      rowError: null,
      notice: null,
    });
    return;
  }

  if (state === "home-revoked") {
    const view = createHomeView(hostRoot, language, homeActions);
    view.render({
      language,
      songs: [],
      files: [],
      songsState: "denied",
      filesState: "denied",
      refreshing: false,
      refreshFailed: false,
      songsHasMore: false,
      loadingSongs: false,
      canWrite: false,
      readOnly: true,
      workingName: null,
      listedIsContext: true,
      contextHasGrant: false,
      fileLimit: 20,
      checking: null,
      copying: null,
      busy: null,
      accessRequired: true,
      slowSongs: false,
      slowFiles: false,
      allFailed: false,
      rowError: null,
      notice: null,
    });
    return;
  }

  const homeStates = new Set([
    "home",
    "home-empty",
    "home-loading",
    "home-refresh",
    "home-songs-error",
    "home-files-error",
    "home-error",
    "home-songs-denied",
    "home-no-view",
    "home-readonly",
    "home-working-space",
    "home-working-view",
    "home-copy",
    "handoff-not-handled",
    "handoff-file-elsewhere",
  ]);
  const home = homeStates.has(state);
  const generated = state.startsWith("generated");
  const readOnly = state === "readonly" || state === "readonly-retry" || state === "generated-readonly" || state === "home-readonly";
  // These homes pick a second Space before opening a row.
  const multiSpaceHome =
    state === "home-working-space" ||
    state === "home-working-view" ||
    state === "home-copy" ||
    state === "handoff-not-handled" ||
    state === "handoff-file-elsewhere";
  const fileText = state === "handoff-refused" ? BROKEN : SAMPLE;
  const homeFiles: Record<string, string> =
    state === "home-empty"
      ? {}
      : {
          // A score file, not a copy of a listed song, so the handoff row opens the file itself.
          [PATH]: state === "handoff-file-elsewhere" ? SAMPLE.replace("z12e2e2", "z12a2e2") : fileText,
          "world/theme.abc": SAMPLE,
          "notes/readme.txt": "not a score",
        };
  const files: Record<string, string> = home
    ? homeFiles
    : generated
      ? {}
      : state === "file-gone"
        ? {}
        : { [PATH]: fileText };
  if (state === "generated-draft" || state === "generated-conflict") {
    files[draftPath(TASK_ID)] = await draftFor(EDITED);
  }
  const client = createFakeClient({
    files,
    tasks: home
      ? state === "home-empty"
        ? {}
        : multiSpaceHome
          ? { [TASK_ID]: TASK, "task-2": TASK_2 }
          : { [TASK_ID]: TASK }
      : generated
        ? { [TASK_ID]: state === "generated-instrumental" ? INSTRUMENTAL_TASK : TASK }
        : undefined,
    scopes:
      state === "home-no-view"
        ? ["taskrun.view"]
        : state === "home-songs-denied"
          ? ["file.view"]
          : readOnly || multiSpaceHome
            ? ["file.view", "taskrun.view"]
            : ["file.view", "file.edit", "taskrun.view"],
    pickedSpace: { id: "space-2", name: "My Space" },
    pickedScopes: state === "home-working-view" ? ["file.view"] : undefined,
    navigationHandled: state !== "handoff-not-handled",
    neverResolveWrite: state === "home-copy",
    neverResolveList: state === "home-loading",
    failNextTaskList:
      state === "home-songs-error" || state === "home-error"
        ? new FakeRequestError(500)
        : undefined,
    authorize: state.startsWith("no-permission") ? "cancelled" : "granted",
    authorizeSteps:
      state === "no-permission-retry"
        ? ["cancelled", "granted"]
        : state === "no-permission-declined"
          ? ["cancelled", "cancelled"]
          : undefined,
    neverResolveRead: state === "loading",
    afterRead:
      state === "generated-conflict"
        ? () => client.setFile(draftPath(TASK_ID), THEIRS)
        : state === "conflict"
          ? () => {
              client.setFile(PATH, THEIRS);
              client.failNextWrite(new FakeRequestError(409, "file_conflict"));
            }
          : state === "conflict-deleted"
            ? () => client.setFile(PATH, THEIRS)
            : state === "save-failed"
              ? () => client.failNextWrite(new FakeRequestError(500))
              : state === "revoked-save"
                ? () => client.revoke()
                : state === "revoked-viewonly"
                  ? () => {
                      client.revoke();
                      client.grant(["file.view"]);
                    }
                  : state === "gone-save" || state === "gone-returned"
                    ? () => client.deleteFile(PATH)
                    : state === "readonly-retry"
                      ? () => client.grant(["file.view", "file.edit"])
                      : undefined,
    afterReadError:
      state === "gone-returned" ? () => client.setFile(PATH, THEIRS) : undefined,
    afterWriteError:
      state === "conflict-deleted" ? () => client.deleteFile(PATH) : undefined,
  });
  if (state === "revoked") client.failNextRead(new FakeRequestError(403));
  if (state === "failed") client.failNextRead(new FakeRequestError(500));
  if (state === "home-files-error" || state === "home-error") {
    client.failNextList(new FakeRequestError(500));
  }

  const host: AppHost = {
    client,
    initial: {
      locale,
      appearance: { colorScheme, tokens },
      spaceId: SPACE,
      file: generated || home || state === "no-file" ? null : { spaceId: SPACE, path: PATH },
      taskRunId: generated ? TASK_ID : null,
      composer,
    },
    onLaunch() {
      return () => {};
    },
    onContext() {
      return () => {};
    },
    setTitle(title) {
      document.title = `${title} · score editor harness`;
    },
    setDirty() {},
    onBeforeClose() {},
    close() {},
  };

  createApp({ root: hostRoot, host });

  if (state === "home-guard" || state === "home-guard-conflict") {
    if (state === "home-guard-conflict") client.failNextWrite(new FakeRequestError(409, "file_conflict"));
    void (async () => {
      const textView = await until(() => hostRoot.querySelector<HTMLButtonElement>(".sce-view-text"));
      textView.click();
      const box = await until(() => hostRoot.querySelector<HTMLTextAreaElement>("textarea.sce-text-box"));
      box.value = EDITED;
      box.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 900));
      const back = hostRoot.querySelector<HTMLButtonElement>(".frame-back");
      back?.click();
      if (state === "home-guard-conflict") {
        await new Promise((resolve) => setTimeout(resolve, 200));
        hostRoot.querySelector<HTMLButtonElement>(".frame-guard-actions button")?.click();
      }
    })();
  }

  if (state === "home-copy") {
    const timer = setInterval(() => {
      const copy = hostRoot.querySelector<HTMLButtonElement>('[data-action="copy-row"]');
      if (!copy) return;
      clearInterval(timer);
      copy.click();
    }, 50);
    setTimeout(() => clearInterval(timer), 5_000);
  }

  if (
    state === "home-working-space" ||
    state === "home-working-view" ||
    state === "handoff-not-handled" ||
    state === "handoff-file-elsewhere"
  ) {
    const timer = setInterval(() => {
      const button = hostRoot.querySelector<HTMLButtonElement>('[data-home-action="pick-space"]');
      if (!button) return;
      clearInterval(timer);
      button.click();
      if (state === "handoff-file-elsewhere") {
        void (async () => {
          await until(() => hostRoot.querySelector('[data-home-action="back-context"]'));
          const row = await until(() => rowMain(hostRoot, "intro.abc"));
          row.click();
          await until(() => hostRoot.querySelector<HTMLButtonElement>(".sce-handoff-button:not([disabled])"));
          await handOff(hostRoot);
        })();
      } else if (state === "handoff-not-handled") {
        void (async () => {
          const row = await until(() => {
            const candidate = hostRoot.querySelector<HTMLButtonElement>(".home-row-main");
            return candidate && !candidate.disabled ? candidate : null;
          });
          row.click();
          await until(() => hostRoot.querySelector<HTMLButtonElement>(".sce-handoff-button:not([disabled])"));
          await handOff(hostRoot);
        })();
      }
    }, 50);
    setTimeout(() => clearInterval(timer), 8_000);
  }

  if (state === "generated-saved") {
    // Press the editor's Save as once it appears, so the state is the reopened score file.
    const timer = setInterval(() => {
      const button = hostRoot.querySelector<HTMLButtonElement>(".sce-save-button");
      if (!button) return;
      clearInterval(timer);
      button.click();
    }, 50);
    setTimeout(() => clearInterval(timer), 5_000);
  }

  if (state.startsWith("handoff") && state !== "handoff-file-elsewhere") {
    watchChip(client);
    void (async () => {
      await handOff(hostRoot);
      if (state === "handoff-twice") {
        await until(() => (client.chips.length >= 1 ? true : null));
        await handOff(hostRoot);
      }
    })();
  }
}

void boot();
