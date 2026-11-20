import assert from "node:assert/strict";
import { test } from "node:test";
import { handoffInstruction, type MountOptions } from "@neta-art/score-editor";
import { song2Dialect } from "@neta-art/score-dialect-song2";
import { createApp, type AppHost } from "../src/app/app.ts";
import type { TaskRunSnapshot } from "../src/host/task.ts";
import { createFakeClient } from "./fake-client.ts";
import { FakeElement, fakeMount } from "./helpers.ts";

const SCORE = `X:1
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

function all(root: FakeElement): FakeElement[] {
  return [root, ...root.children.flatMap((child) => all(child))];
}

function hasRow(root: FakeElement, title: string): boolean {
  return all(root).some(
    (node) => node.className === "home-row-title-text" && node.textContent === title,
  );
}

function rowMain(root: FakeElement, title: string): FakeElement | null {
  for (const node of all(root)) {
    if (node.className !== "home-row-main") continue;
    const match = node.children.some((titleLine) =>
      titleLine.children.some(
        (label) => label.className === "home-row-title-text" && label.textContent === title,
      ),
    );
    if (match) return node;
  }
  return null;
}

function handoffLine(root: FakeElement): FakeElement | null {
  return all(root).find((node) => node.className === "frame-handoff-text") ?? null;
}

async function waitFor<T>(read: () => T | null): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for the App home");
}

function installDocument(): { restore(): void; doc: { title: string } } {
  const previous = globalThis.document;
  const doc = {
    documentElement: { lang: "" },
    title: "",
    activeElement: null,
    createElement: () => new FakeElement(),
  } as unknown as Document;
  globalThis.document = doc;
  return {
    doc: doc as unknown as { title: string },
    restore() {
      if (previous === undefined) delete (globalThis as { document?: Document }).document;
      else globalThis.document = previous;
    },
  };
}

function hostFor(
  client: ReturnType<typeof createFakeClient>,
  doc: { title: string },
  taskRunId: string | null = null,
  options: {
    readonly composer?: boolean;
    readonly file?: { readonly spaceId: string; readonly path: string } | null;
  } = {},
): AppHost {
  return {
    client,
    initial: {
      locale: "en",
      appearance: { colorScheme: "light", tokens: {} },
      spaceId: "space-1",
      file: options.file ?? null,
      taskRunId,
      composer: options.composer ?? true,
    },
    onLaunch() {
      return () => {};
    },
    onContext() {
      return () => {};
    },
    setTitle(title) {
      doc.title = title;
    },
    setDirty() {},
    onBeforeClose() {},
    close() {},
  };
}

test("the App's first home load never shows the refresh-failed line", async () => {
  const dom = installDocument();
  const client = createFakeClient({ files: { "scores/intro.abc": SCORE } });
  const root = new FakeElement();
  const app = createApp({ root: root as unknown as HTMLElement, host: hostFor(client, dom.doc) });
  try {
    await waitFor(() =>
      all(root).some(
        (node) => node.className === "home-row-title-text" && node.textContent === "intro.abc",
      )
        ? true
        : null,
    );
    const line = all(root).find((node) => node.className === "home-refresh");
    assert.ok(line);
    assert.equal(line.hidden, true);
    assert.notEqual(dom.doc.title, "");
  } finally {
    app.destroy();
    dom.restore();
  }
});

const INSTRUMENTAL = "[Instrumental]";

const INSTRUCTION = "Regenerate with this version.";

function handoffPayload() {
  return {
    attachment: { name: "score.abc" as const, mediaType: "text/plain" as const, text: SCORE },
    instruction: INSTRUCTION,
    project: {
      style: "",
      lyrics: "",
      score: SCORE,
      scoreMode: "full" as const,
      seed: null,
      modelId: "song2",
      sourceKey: "score-file:space-1:scores/intro.abc",
    },
  };
}

function task(lyrics: string | null): TaskRunSnapshot {
  return {
    id: "task-1",
    spaceId: "space-1",
    status: "completed",
    payload: {
      data: {
        model: "song2",
        content: [
          { type: "text", text: "warm synthwave", meta: { role: "prompt" } },
          ...(lyrics === null ? [] : [{ type: "text", text: lyrics, meta: { role: "lyrics" } }]),
        ],
        parameters: {},
      },
    },
    result: { output: [{ type: "text", text: SCORE, meta: { role: "abc" } }] },
  };
}

test("an instrumental generated score can be handed off", async () => {
  const dom = installDocument();
  const client = createFakeClient({ tasks: { "task-1": task(INSTRUMENTAL) } });
  const root = new FakeElement();
  const mounts: MountOptions[] = [];
  const app = createApp({
    root: root as unknown as HTMLElement,
    host: hostFor(client, dom.doc, "task-1"),
    mount: fakeMount(mounts),
  });
  try {
    await waitFor(() => (mounts.length > 0 ? true : null));
    const mounted = mounts[0];
    assert.ok(mounted);
    assert.deepEqual(mounted.requiredInputs, ["style"]);

    const project = {
      style: "warm synthwave",
      lyrics: INSTRUMENTAL,
      score: SCORE,
      scoreMode: "full" as const,
      seed: null,
      modelId: "song2",
      sourceKey: "task-1",
    };
    const instruction = handoffInstruction({
      original: project,
      current: project,
      title: "Night walk",
      language: "en",
      dialect: song2Dialect,
      scorePath: ".cohub/score-drafts/task-1.abc",
    });
    mounted.onHandoff?.({
      attachment: { name: "score.abc", mediaType: "text/plain", text: SCORE },
      instruction,
      project,
    });
    await waitFor(() => (client.chips.length > 0 ? true : null));
    const content = client.chips[0]?.content ?? "";
    assert.match(content, /\[Instrumental\]/);
    assert.doesNotMatch(content, /carries no lyrics/);
  } finally {
    app.destroy();
    dom.restore();
  }
});

test("a generated score with no or empty lyrics still requires lyrics", async () => {
  for (const lyrics of [null, ""] as const) {
    const dom = installDocument();
    const client = createFakeClient({ tasks: { "task-1": task(lyrics) } });
    const root = new FakeElement();
    const mounts: MountOptions[] = [];
    const app = createApp({
      root: root as unknown as HTMLElement,
      host: hostFor(client, dom.doc, "task-1"),
      mount: fakeMount(mounts),
    });
    try {
      await waitFor(() => (mounts.length > 0 ? true : null));
      assert.deepEqual(mounts[0]?.requiredInputs, ["style", "lyrics"]);
    } finally {
      app.destroy();
      dom.restore();
    }
  }
});

test("the context snapshot is not shown after copy or New score in a working Space", async () => {
  for (const action of ["copy", "new-score"] as const) {
    const dom = installDocument();
    const context = { ...task("[Verse]\nContext song"), id: "task-1", spaceId: "space-1" };
    const working = { ...task("[Verse]\nWorking song"), id: "task-2", spaceId: "space-2" };
    const client = createFakeClient({
      tasks: { "task-1": context, "task-2": working },
      files: { "scores/intro.abc": SCORE },
      scopes: ["file.view", "taskrun.view"],
      pickedSpace: { id: "space-2", name: "My Space" },
    });
    const root = new FakeElement();
    const mounts: MountOptions[] = [];
    const app = createApp({
      root: root as unknown as HTMLElement,
      host: hostFor(client, dom.doc),
      mount: fakeMount(mounts),
    });
    try {
      await waitFor(() => (hasRow(root, "Context song") ? true : null));
      const pick = all(root).find((node) => node.dataset.homeAction === "pick-space");
      assert.ok(pick);
      pick.onclick?.();
      await waitFor(() => (hasRow(root, "Working song") ? true : null));
      const backContext = all(root).find((node) => node.dataset.homeAction === "back-context");
      assert.ok(backContext);
      backContext.onclick?.();
      await waitFor(() => (hasRow(root, "Context song") ? true : null));

      const start =
        action === "copy"
          ? all(root).find((node) => node.dataset.action === "copy-row")
          : all(root).find((node) => node.dataset.homeAction === "new-score");
      assert.ok(start);
      start.onclick?.();
      await waitFor(() => (mounts.length > 0 ? true : null));
      const back = all(root).find((node) => node.className === "frame-back");
      assert.ok(back);
      back.onclick?.();
      assert.equal(hasRow(root, "Context song"), false);
      await waitFor(() => (hasRow(root, "Working song") ? true : null));
      assert.equal(hasRow(root, "Context song"), false);
    } finally {
      app.destroy();
      dom.restore();
    }
  }
});

test("a handoff without a composer shows the handoff file and never sets a chip", async () => {
  const dom = installDocument();
  const client = createFakeClient({ files: { "scores/intro.abc": SCORE } });
  const root = new FakeElement();
  const mounts: MountOptions[] = [];
  const app = createApp({
    root: root as unknown as HTMLElement,
    host: hostFor(client, dom.doc, null, {
      composer: false,
      file: { spaceId: "space-1", path: "scores/intro.abc" },
    }),
    mount: fakeMount(mounts),
  });
  try {
    await waitFor(() => (mounts.length > 0 ? true : null));
    mounts[0]?.onHandoff?.(handoffPayload());

    const line = await waitFor(() => {
      const text = handoffLine(root)?.textContent ?? "";
      return text.includes("scores/intro.handoff.md") ? (handoffLine(root) ?? null) : null;
    });
    assert.equal(
      line.textContent,
      "Saved for the agent at scores/intro.handoff.md. In the chat, ask the agent to read that file and sing the score it names. Add anything else you want changed.",
    );
    assert.equal(
      client.fileAt("scores/intro.handoff.md")?.text,
      `Score file in this Space: \`scores/intro.abc\`\n\n${INSTRUCTION}`,
    );
    assert.equal(
      client.calls.some((call) => call.kind === "chip-set" || call.kind === "chip-clear"),
      false,
    );
  } finally {
    app.destroy();
    dom.restore();
  }
});

test("a handoff in another Space without a composer names that Space and its handoff file", async () => {
  const dom = installDocument();
  const client = createFakeClient({
    tasks: {
      "task-1": { ...task("[Verse]\nContext song"), id: "task-1", spaceId: "space-1" },
      "task-2": { ...task("[Verse]\nWorking song"), id: "task-2", spaceId: "space-2" },
    },
    files: { "scores/intro.abc": SCORE.replace("C16|D16|", "C16|E16|") },
    scopes: ["file.view", "taskrun.view"],
    pickedSpace: { id: "space-2", name: "My Space" },
    pickedScopes: ["file.view", "file.edit", "taskrun.view"],
  });
  const root = new FakeElement();
  const mounts: MountOptions[] = [];
  const app = createApp({
    root: root as unknown as HTMLElement,
    host: hostFor(client, dom.doc, null, { composer: false }),
    mount: fakeMount(mounts),
  });
  try {
    await waitFor(() => (hasRow(root, "Context song") ? true : null));
    const pick = all(root).find((node) => node.dataset.homeAction === "pick-space");
    assert.ok(pick);
    pick.onclick?.();
    await waitFor(() => (hasRow(root, "Working song") ? true : null));
    const row = rowMain(root, "intro.abc");
    assert.ok(row);
    row.onclick?.();
    await waitFor(() => (mounts.length > 0 ? true : null));
    mounts[0]?.onHandoff?.(handoffPayload());

    const line = await waitFor(() => {
      const text = handoffLine(root)?.textContent ?? "";
      return text.includes("scores/intro.handoff.md") ? (handoffLine(root) ?? null) : null;
    });
    assert.equal(
      line.textContent,
      "Saved for the agent in My Space at scores/intro.handoff.md. Open My Space, and in its chat ask the agent to read that file and sing the score it names.",
    );
    assert.equal(
      client.fileAt("scores/intro.handoff.md")?.text,
      `Score file in My Space: \`scores/intro.abc\`\n\n${INSTRUCTION}`,
    );
    assert.deepEqual(
      client.calls.find((call) => call.kind === "navigate"),
      { kind: "navigate", spaceId: "space-2", path: "scores/intro.abc" },
    );
    assert.equal(
      client.calls.some((call) => call.kind === "chip-set" || call.kind === "chip-clear"),
      false,
    );
  } finally {
    app.destroy();
    dom.restore();
  }
});
