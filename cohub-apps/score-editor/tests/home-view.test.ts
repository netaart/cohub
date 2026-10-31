import assert from "node:assert/strict";
import { test } from "node:test";
import { createHomeView, type HomeModel } from "../src/app/home-view.ts";
import type { HomeFile, HomeSong } from "../src/app/home.ts";
import { FakeElement, homeActions } from "./helpers.ts";

function find(root: FakeElement, className: string): FakeElement[] {
  const found: FakeElement[] = [];
  if (root.className === className) found.push(root);
  for (const child of root.children) found.push(...find(child, className));
  return found;
}

function render(model: Partial<HomeModel>): FakeElement {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => new FakeElement() } as unknown as Document;
  try {
    const root = new FakeElement();
    const view = createHomeView(root as unknown as HTMLElement, "en", homeActions);
    view.render({
      language: "en",
      songs: [],
      files: [],
      songsState: "ready",
      filesState: "ready",
      refreshing: false,
      refreshFailed: false,
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
      ...model,
    });
    return root;
  } finally {
    if (previous === undefined) delete (globalThis as { document?: Document }).document;
    else globalThis.document = previous;
  }
}

const SONG: HomeSong = {
  id: "task-1",
  title: "Neon lights",
  style: "warm synthwave",
  createdAt: "2026-10-28T09:30:00.000Z",
  score: "X:1\n",
  requestScore: "",
  outputScore: "X:1\n",
};
const FILE: HomeFile = {
  name: "intro.abc",
  path: "scores/intro.abc",
  folder: "scores",
  mtimeMs: 1_790_000_000_000,
  size: 5,
  text: "X:1\n",
  copyTaskId: "task-1",
};

test("the home renders song and file rows with a generated copy tag", () => {
  const root = render({ songs: [SONG], files: [FILE] });
  assert.equal(find(root, "home-row-title-text")[0]?.textContent, "Neon lights");
  assert.equal(find(root, "home-row-title-text")[1]?.textContent, "intro.abc");
  assert.equal(find(root, "home-tag")[0]?.textContent, "Generated copy");
});

test("the home shows one access panel instead of sections when access is missing", () => {
  const root = render({
    accessRequired: true,
    songsState: "denied",
    filesState: "denied",
  });
  assert.equal(find(root, "home-access")[0]?.hidden, false);
  assert.equal(find(root, "home-section")[0]?.hidden, true);
  assert.equal(find(root, "home-section")[1]?.hidden, true);
});

test("the home empty state replaces two empty sections", () => {
  const root = render({});
  assert.equal(find(root, "home-empty")[0]?.hidden, false);
  assert.equal(find(root, "home-section")[0]?.hidden, true);
  assert.equal(find(root, "home-section")[1]?.hidden, true);
});

test("a file without a time has no time line", () => {
  const root = render({ files: [{ ...FILE, mtimeMs: 0 }] });
  assert.equal(find(root, "home-row-time")[0]?.hidden, true);
});

test("the home announces a section that failed", () => {
  const root = render({ songsState: "error" });
  assert.match(find(root, "frame-live")[0]?.textContent ?? "", /Couldn’t load songs/);
});

test("the banner returns to the context only while the context holds a grant", () => {
  const withGrant = render({ workingName: "Mine", listedIsContext: false, contextHasGrant: true });
  assert.ok(
    find(withGrant, "home-text-action").some(
      (node) => node.textContent === "Back to the Space you opened",
    ),
  );
  const withoutGrant = render({ workingName: "Mine", listedIsContext: false, contextHasGrant: false });
  assert.equal(
    find(withoutGrant, "home-text-action").some(
      (node) => node.textContent === "Back to the Space you opened",
    ),
    false,
  );
});

test("an untitled song keeps its task id in the row title", () => {
  const root = render({ songs: [{ ...SONG, title: "" }] });
  assert.equal(find(root, "home-row-main")[0]?.title, SONG.id);
});

test("a refresh shows its progress bar and its failure line", () => {
  const refreshing = render({ refreshing: true });
  assert.equal(find(refreshing, "home-progress")[0]?.hidden, false);
  const failed = render({ refreshFailed: true, songs: [SONG], files: [FILE] });
  assert.equal(find(failed, "home-refresh")[0]?.hidden, false);
  assert.ok(find(failed, "home-section-note").some((node) => node.textContent.includes("Couldn’t refresh")));
});

test("the read-only home gives its pick action the brand fill", () => {
  const root = render({ readOnly: true, canWrite: false, workingName: null, listedIsContext: true });
  const actions = find(root, "home-banner-actions")[0];
  assert.ok(actions?.children.some((node) => node.className.includes("home-primary")));
});

test("a notice and the access state are both announced", () => {
  const root = render({
    accessRequired: true,
    songsState: "denied",
    filesState: "denied",
    notice: { text: "Access was not given.", tone: "problem" },
  });
  const live = find(root, "frame-live")[0]?.textContent ?? "";
  assert.ok(live.includes("Access was not given."));
  assert.ok(live.includes("Access needed to browse this Space"));
});
