import assert from "node:assert/strict";
import { test } from "node:test";
import { createHomeController, type HomeOpenTarget } from "../src/app/home-controller.ts";
import type { TaskRunSnapshot } from "../src/host/task.ts";
import { createFakeClient, FakeRequestError, type FakeClient } from "./fake-client.ts";
import { FakeElement } from "./helpers.ts";

function all(root: FakeElement): FakeElement[] {
  return [root, ...root.children.flatMap((child) => all(child))];
}

function texts(root: FakeElement, className: string): string[] {
  return all(root)
    .filter((node) => node.className.split(" ").includes(className))
    .map((node) => node.textContent);
}

function button(root: FakeElement, action: string): FakeElement | null {
  return all(root).find((node) => node.dataset.homeAction === action) ?? null;
}

async function waitFor<T>(read: () => T | null): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for the home");
}

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

const TASK: TaskRunSnapshot = {
  id: "task-1",
  spaceId: "space-1",
  status: "completed",
  createdAt: "2026-10-28T09:30:00.000Z",
  payload: {
    data: {
      model: "song2",
      content: [
        { type: "text", text: "warm synthwave", meta: { role: "prompt" } },
        { type: "text", text: "[Verse]\nNeon lights", meta: { role: "lyrics" } },
      ],
      parameters: {},
    },
  },
  result: { output: [{ type: "text", text: SCORE, meta: { role: "abc" } }] },
};

const TASK_2: TaskRunSnapshot = {
  ...TASK,
  id: "task-2",
  spaceId: "space-2",
  createdAt: "2026-10-27T09:30:00.000Z",
};

function harness(options: {
  readOnly: boolean;
  scopes?: readonly string[];
  pickedScopes?: readonly string[];
  fallbackSpace?: { id: string; name: string | null };
  inaccessibleSpaces?: readonly string[];
  ignoreFallback?: boolean;
  files?: Record<string, string>;
  wrapClient?: (client: FakeClient) => void;
}) {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => new FakeElement() } as unknown as Document;
  const root = new FakeElement();
  const opened: HomeOpenTarget[] = [];
  const titles: string[] = [];
  const client = createFakeClient({
    tasks: { "task-1": TASK, "task-2": TASK_2 },
    files: options.files ?? { "scores/intro.abc": SCORE, "world/theme.abc": SCORE },
    scopes:
      options.scopes ??
      (options.readOnly
        ? ["file.view", "taskrun.view"]
        : ["file.view", "taskrun.view", "file.edit"]),
    pickedSpace: { id: "space-2", name: "My Space" },
    pickedScopes: options.pickedScopes,
    ...(options.fallbackSpace === undefined ? {} : { fallbackSpace: options.fallbackSpace }),
    ...(options.inaccessibleSpaces === undefined ? {} : { inaccessibleSpaces: options.inaccessibleSpaces }),
    ...(options.ignoreFallback === undefined ? {} : { ignoreFallback: options.ignoreFallback }),
  });
  options.wrapClient?.(client);
  const controller = createHomeController({
    root: root as unknown as HTMLElement,
    client,
    language: "en",
    onOpen: (target) => opened.push(target),
    onTitle: (title) => titles.push(title),
  });
  return {
    root,
    client,
    opened,
    titles,
    controller,
    restore() {
      if (previous === undefined) delete (globalThis as { document?: Document }).document;
      else globalThis.document = previous;
    },
  };
}

test("the home lists songs and files, and a copy opens the song", async () => {
  const { root, opened, controller, restore } = harness({ readOnly: true });
  try {
    await controller.start("space-1");
    await waitFor(() => (texts(root, "home-row-title-text").length >= 2 ? true : null));
    assert.ok(texts(root, "home-row-title-text").includes("Neon lights"));
    assert.ok(texts(root, "home-row-title-text").includes("intro.abc"));
    assert.ok(texts(root, "home-tag").includes("Generated copy"));

    const row = all(root).find(
      (node) =>
        node.className === "home-row-main" &&
        all(node).some(
          (child) => child.className === "home-row-title-text" && child.textContent === "intro.abc",
        ),
    );
    assert.ok(row);
    row.onclick?.();
    await waitFor(() => (opened.length > 0 ? true : null));
    assert.equal(opened[0]?.kind, "generated");
    assert.equal(opened[0]?.taskRunId, "task-1");
  } finally {
    restore();
  }
});

test("a read-only context picks a working Space and copies a song into it", async () => {
  const { root, opened, controller, client, restore } = harness({ readOnly: true });
  try {
    await controller.start("space-1");
    const copyButton = await waitFor(() =>
      all(root).find((node) => node.dataset.action === "copy-row") ?? null,
    );
    copyButton.onclick?.();
    await waitFor(() => (opened.length > 0 ? true : null));
    assert.equal(controller.workingSpace()?.id, "space-2");
    assert.equal(opened[0]?.spaceId, "space-2");
    assert.equal(opened[0]?.kind, "file");
    assert.equal(opened[0]?.path, "scores/Neon lights.abc");
    assert.equal(client.writes[0]?.spaceId, "space-2");
  } finally {
    restore();
  }
});

test("a picked working Space lists itself and New score writes there", async () => {
  const { root, opened, controller, client, restore } = harness({ readOnly: true });
  try {
    await controller.start("space-1");
    const pick = await waitFor(() => button(root, "pick-space"));
    pick.onclick?.();
    await waitFor(() => (texts(root, "home-row-title-text").includes("Neon lights") ? true : null));
    assert.equal(controller.workingSpace()?.id, "space-2");

    const newScore = await waitFor(() => {
      const candidate = button(root, "new-score");
      return candidate && !candidate.disabled ? candidate : null;
    });
    newScore.onclick?.();
    await waitFor(() => (opened.length > 0 ? true : null));
    assert.equal(opened[0]?.spaceId, "space-2");
    assert.equal(opened[0]?.kind, "file");
    assert.equal(opened[0]?.path, "scores/new-score.abc");
    assert.equal(client.writes[0]?.spaceId, "space-2");
  } finally {
    restore();
  }
});

test("a file that matches no loaded song opens as a file after scanning the pages", async () => {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => new FakeElement() } as unknown as Document;
  const root = new FakeElement();
  const opened: HomeOpenTarget[] = [];
  const client = createFakeClient({
    tasks: { "task-1": TASK },
    files: { "scores/intro.abc": SCORE.replace("D16", "E16") },
    scopes: ["file.view", "taskrun.view", "file.edit"],
  });
  const controller = createHomeController({
    root: root as unknown as HTMLElement,
    client,
    language: "en",
    onOpen: (target) => opened.push(target),
    onTitle: () => {},
  });
  try {
    await controller.start("space-1");
    const row = await waitFor(
      () =>
        all(root).find(
          (node) =>
            node.className === "home-row-main" &&
            all(node).some(
              (child) => child.className === "home-row-title-text" && child.textContent === "intro.abc",
            ),
        ) ?? null,
    );
    row.onclick?.();
    await waitFor(() => (opened.length > 0 ? true : null));
    assert.equal(opened[0]?.kind, "file");
    assert.equal(opened[0]?.path, "scores/intro.abc");
    assert.ok(
      client.calls.some(
        (call) =>
          call.kind === "task-list" &&
          call.taskType === "generation" &&
          call.status === "completed",
      ),
    );
  } finally {
    if (previous === undefined) delete (globalThis as { document?: Document }).document;
    else globalThis.document = previous;
  }
});

test("without taskrun.view a file opens directly and the home says copies are unchecked", async () => {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => new FakeElement() } as unknown as Document;
  const root = new FakeElement();
  const opened: HomeOpenTarget[] = [];
  const client = createFakeClient({
    tasks: { "task-1": TASK },
    files: { "scores/intro.abc": SCORE },
    scopes: ["file.view"],
  });
  const controller = createHomeController({
    root: root as unknown as HTMLElement,
    client,
    language: "en",
    onOpen: (target) => opened.push(target),
    onTitle: () => {},
  });
  try {
    await controller.start("space-1");
    const row = await waitFor(
      () =>
        all(root).find(
          (node) =>
            node.className === "home-row-main" &&
            all(node).some(
              (child) => child.className === "home-row-title-text" && child.textContent === "intro.abc",
            ),
        ) ?? null,
    );
    row.onclick?.();
    await waitFor(() => (opened.length > 0 ? true : null));
    assert.equal(opened[0]?.kind, "file");
    assert.deepEqual(opened[0]?.scopes, ["file.view"]);
  } finally {
    if (previous === undefined) delete (globalThis as { document?: Document }).document;
    else globalThis.document = previous;
  }
});

test("the access state keeps a way into a Space of the viewer's own", async () => {
  const { root, controller, restore } = harness({ readOnly: true, scopes: [] });
  try {
    await controller.start("space-1");
    const pick = await waitFor(() => button(root, "pick-access"));
    pick.onclick?.();
    await waitFor(() => (controller.workingSpace()?.id === "space-2" ? true : null));
    assert.equal(controller.workingSpace()?.id, "space-2");
  } finally {
    restore();
  }
});

test("a picked Space that only grants view offers Ask for edit access", async () => {
  const { root, controller, client, restore } = harness({
    readOnly: true,
    pickedScopes: ["file.view"],
  });
  try {
    await controller.start("space-1");
    (await waitFor(() => button(root, "pick-space"))).onclick?.();
    const ask = await waitFor(() => button(root, "ask-edit"));
    ask.onclick?.();
    await waitFor(() => (client.calls.some((call) => call.kind === "authorize" && call.scopes.includes("file.edit")) ? true : null));
    assert.equal(client.fileAt("scores/new-score.abc"), null);
  } finally {
    restore();
  }
});

test("a copy check that finishes after another open does not open its file", async () => {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => new FakeElement() } as unknown as Document;
  const root = new FakeElement();
  const opened: HomeOpenTarget[] = [];
  const client = createFakeClient({
    tasks: { "task-1": TASK },
    files: { "scores/intro.abc": SCORE.replace("D16", "E16") },
    scopes: ["file.view", "taskrun.view", "file.edit"],
  });
  const controller = createHomeController({
    root: root as unknown as HTMLElement,
    client,
    language: "en",
    onOpen: (target) => opened.push(target),
    onTitle: () => {},
  });
  try {
    await controller.start("space-1");
    const fileRow = await waitFor(() =>
      all(root).find(
        (node) =>
          node.className === "home-row-main" &&
          all(node).some(
            (child) => child.className === "home-row-title-text" && child.textContent === "intro.abc",
          ),
      ) ?? null,
    );
    const songRow = all(root).find(
      (node) =>
        node.className === "home-row-main" &&
        all(node).some(
          (child) => child.className === "home-row-title-text" && child.textContent === "Neon lights",
        ),
    );
    assert.ok(songRow);
    let release: (() => void) | null = null;
    const original = client.listTasks.bind(client);
    client.listTasks = (input) => {
      if (release !== null) return original(input);
      return new Promise((resolve) => {
        release = () => resolve(original(input));
      });
    };
    fileRow.onclick?.();
    await waitFor(() => release);
    songRow.onclick?.();
    await waitFor(() => (opened.length > 0 ? true : null));
    const finish = release as (() => void) | null;
    finish?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(opened.length, 1);
    assert.equal(opened[0]?.kind, "generated");
  } finally {
    if (previous === undefined) delete (globalThis as { document?: Document }).document;
    else globalThis.document = previous;
  }
});

test("the first ask answered with another Space works in that Space", async () => {
  const { root, client, controller, restore } = harness({
    readOnly: false,
    fallbackSpace: { id: "space-2", name: "My Space" },
  });
  try {
    await controller.start("space-1");
    assert.equal(controller.workingSpace()?.id, "space-2");
    assert.ok(texts(root, "home-banner-text").some((text) => text.includes("Working in My Space")));
    assert.equal(button(root, "back-context"), null);
    const first = client.calls.find((call) => call.kind === "authorize") as { fallback?: string } | undefined;
    assert.equal(first?.fallback, "allow");
    assert.equal(
      client.calls.some(
        (call) =>
          (call.kind === "list" || call.kind === "task-list" || call.kind === "read") &&
          call.spaceId === "space-1",
      ),
      false,
    );
    assert.equal(client.writes.some((write) => write.spaceId === "space-1"), false);
  } finally {
    restore();
  }
});

test("a new score after a fallback grant writes into the granted Space", async () => {
  const { root, client, opened, controller, restore } = harness({
    readOnly: false,
    fallbackSpace: { id: "space-2", name: "My Space" },
  });
  try {
    await controller.start("space-1");
    (await waitFor(() => button(root, "new-score"))).onclick?.();
    await waitFor(() => (opened.length > 0 ? true : null));
    assert.equal(opened[0]?.spaceId, "space-2");
    assert.ok(client.writes.length > 0);
    assert.ok(client.writes.every((write) => write.spaceId === "space-2"));
  } finally {
    restore();
  }
});

test("Ask for access refuses a Space other than the one asked for", async () => {
  const { root, client, controller, restore } = harness({
    readOnly: true,
    scopes: [],
    inaccessibleSpaces: ["space-1"],
  });
  try {
    await controller.start("space-1");
    (await waitFor(() => button(root, "ask-all"))).onclick?.();
    await waitFor(() =>
      all(root).some((node) => node.textContent.includes("Access was not given")) ? true : null,
    );
    const last = client.calls.at(-1);
    assert.equal(last?.kind === "authorize" ? last.fallback : undefined, "none");
  } finally {
    restore();
  }
});

test("Ask for edit access refuses a Space other than the working one", async () => {
  const { root, client, controller, restore } = harness({
    readOnly: true,
    pickedScopes: ["file.view"],
    inaccessibleSpaces: ["space-2"],
  });
  try {
    await controller.start("space-1");
    (await waitFor(() => button(root, "pick-space"))).onclick?.();
    (await waitFor(() => button(root, "ask-edit"))).onclick?.();
    await waitFor(() =>
      texts(root, "home-notice-text").some((text) => text.includes("Access was not given")) ? true : null,
    );
    const last = client.calls.at(-1);
    assert.equal(last?.kind === "authorize" ? last.fallback : undefined, "none");
  } finally {
    restore();
  }
});

test("returning home paints the snapshot before refreshing", async () => {
  const { root, client, controller, restore } = harness({ readOnly: false });
  try {
    await controller.start("space-1");
    await waitFor(() => (texts(root, "home-row-title-text").length >= 2 ? true : null));
    const before = texts(root, "home-row-title-text");
    const scroll = all(root).find((node) => node.className === "home-scroll");
    assert.ok(scroll);
    scroll.scrollTop = 120;

    controller.hide();
    controller.hide();
    controller.show();
    assert.deepEqual(texts(root, "home-row-title-text"), before);
    assert.equal(scroll.scrollTop, 120);

    const original = client.listTasks.bind(client);
    let release: (() => void) | null = null;
    client.listTasks = (input) =>
      new Promise((resolve) => {
        release = () => resolve(original(input));
      });
    const pending = controller.refresh();
    const progress = all(root).find((node) => node.className === "home-progress");
    assert.ok(progress);
    assert.equal(progress.hidden, false);
    await waitFor(() => release);
    (release as (() => void) | null)?.();
    await pending;
    assert.equal(progress.hidden, true);
    assert.deepEqual(texts(root, "home-row-title-text"), before);
  } finally {
    restore();
  }
});

test("a failed refresh keeps the rows and says it is showing the old ones", async () => {
  const { root, client, controller, restore } = harness({ readOnly: false });
  try {
    await controller.start("space-1");
    const before = await waitFor(() =>
      texts(root, "home-row-title-text").length >= 2 ? texts(root, "home-row-title-text") : null,
    );
    const original = client.listTasks.bind(client);
    client.listTasks = async () => {
      throw new FakeRequestError(500);
    };
    await controller.refresh();

    assert.deepEqual(texts(root, "home-row-title-text"), before);
    const line = all(root).find((node) => node.className === "home-refresh");
    assert.ok(line);
    assert.equal(line.hidden, false);
    assert.ok(all(root).some((node) => node.textContent.includes("Couldn’t refresh")));

    client.listTasks = original;
    (await waitFor(() => button(root, "retry-refresh"))).onclick?.();
    await waitFor(() => (line.hidden ? true : null));
    assert.deepEqual(texts(root, "home-row-title-text"), before);
  } finally {
    controller.destroy();
    restore();
  }
});

test("a revoked grant turns the next home read into the access state", async () => {
  const { root, client, controller, restore } = harness({ readOnly: false });
  try {
    await controller.start("space-1");
    await waitFor(() => (texts(root, "home-row-title-text").length >= 2 ? true : null));
    client.revoke();
    await controller.refresh();

    const access = all(root).find((node) => node.className === "home-access");
    assert.ok(access);
    assert.equal(access.hidden, false);
    assert.ok(all(root).filter((node) => node.className === "home-section").every((node) => node.hidden));
  } finally {
    restore();
  }
});

test("retrying the file walk lists each file once", async () => {
  let listCalls = 0;
  const { root, controller, restore } = harness({
    readOnly: false,
    files: { "root.abc": SCORE, "nested/deep.abc": SCORE },
    wrapClient: (client) => {
      const original = client.list.bind(client);
      client.list = async (input) => {
        listCalls += 1;
        if (listCalls === 2) throw new FakeRequestError(500);
        return original(input);
      };
    },
  });
  try {
    await controller.start("space-1");
    (await waitFor(() => button(root, "retry:files"))).onclick?.();
    await waitFor(() => {
      const names = texts(root, "home-row-title-text");
      return names.includes("root.abc") && names.includes("deep.abc") ? true : null;
    });
    const names = texts(root, "home-row-title-text");
    assert.equal(names.filter((name) => name === "root.abc").length, 1);
    assert.equal(names.filter((name) => name === "deep.abc").length, 1);
  } finally {
    restore();
  }
});

test("a tagged copy whose song is gone opens as the file", async () => {
  const { root, client, opened, controller, restore } = harness({ readOnly: false });
  try {
    await controller.start("space-1");
    const row = await waitFor(
      () =>
        all(root).find(
          (node) =>
            node.className === "home-row-main" &&
            all(node).some(
              (child) => child.className === "home-row-title-text" && child.textContent === "intro.abc",
            ),
        ) ?? null,
    );
    let confirms = 0;
    client.getTask = async () => {
      confirms += 1;
      throw new FakeRequestError(404);
    };
    row.onclick?.();
    await waitFor(() => (opened.length > 0 ? true : null));
    assert.equal(opened[0]?.kind, "file");
    assert.equal(opened[0]?.path, "scores/intro.abc");
    assert.equal(confirms, 1);
  } finally {
    restore();
  }
});

test("a revoked songs grant keeps the files and shows the songs access row", async () => {
  const { root, client, controller, restore } = harness({ readOnly: false });
  try {
    await controller.start("space-1");
    await waitFor(() => (texts(root, "home-row-title-text").length >= 2 ? true : null));
    client.listTasks = async () => {
      throw new FakeRequestError(403);
    };
    await controller.refresh();
    assert.ok(all(root).some((node) => node.textContent.includes("Songs need access")));
    assert.ok(texts(root, "home-row-title-text").some((name) => name === "intro.abc"));
  } finally {
    restore();
  }
});

test("a granted ask for edit access redraws the banner", async () => {
  const { root, client, controller, restore } = harness({ readOnly: true, pickedScopes: ["file.view"] });
  try {
    await controller.start("space-1");
    (await waitFor(() => button(root, "pick-space"))).onclick?.();
    await waitFor(() => (texts(root, "home-row-title-text").length >= 2 ? true : null));
    client.grant(["file.view", "file.edit"]);
    (await waitFor(() => button(root, "ask-edit"))).onclick?.();
    await waitFor(() => (button(root, "ask-edit") === null ? true : null));
    assert.equal(button(root, "ask-edit"), null);
  } finally {
    controller.destroy();
    restore();
  }
});

test("a failed ask says it could not ask, not that access was denied", async () => {
  const { root, client, controller, restore } = harness({ readOnly: true, scopes: [] });
  try {
    await controller.start("space-1");
    client.authorize = async () => {
      throw new Error("host failed");
    };
    (await waitFor(() => button(root, "ask-all"))).onclick?.();
    await waitFor(() =>
      all(root).some((node) => node.textContent.includes("Couldn’t ask for access")) ? true : null,
    );
  } finally {
    restore();
  }
});

test("the view-only line is drawn before edit access is granted", async () => {
  const { root, controller, restore } = harness({ readOnly: true, pickedScopes: ["file.view"] });
  try {
    await controller.start("space-1");
    (await waitFor(() => button(root, "pick-space"))).onclick?.();
    await waitFor(() => (texts(root, "home-row-title-text").length >= 2 ? true : null));
    await waitFor(() =>
      all(root).some((node) => node.textContent.includes("You can browse and open scores")) ? true : null,
    );
  } finally {
    controller.destroy();
    restore();
  }
});

test("a re-render keeps focus on the same row", async () => {
  const { root, controller, restore } = harness({ readOnly: false });
  try {
    await controller.start("space-1");
    const row = await waitFor(
      () => all(root).find((node) => node.className === "home-row-main") ?? null,
    );
    row.focus();
    controller.show();
    const active = (globalThis.document as unknown as { activeElement?: { dataset: Record<string, string> } })
      .activeElement;
    assert.ok(active);
    assert.equal(active?.dataset.focusKey, row.dataset.focusKey);
  } finally {
    controller.destroy();
    restore();
  }
});

test("a refresh superseded by a Space pick does not report failure", async () => {
  const { root, client, controller, restore } = harness({ readOnly: true, pickedScopes: ["file.view"] });
  try {
    await controller.start("space-1");
    await waitFor(() => (texts(root, "home-row-title-text").length >= 2 ? true : null));
    const originalTasks = client.listTasks.bind(client);
    const originalList = client.list.bind(client);
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    client.listTasks = async (input) => {
      await gate;
      return originalTasks(input);
    };
    client.list = async (input) => {
      await gate;
      return originalList(input);
    };
    (await waitFor(() => button(root, "pick-space"))).onclick?.();
    const refreshing = controller.refresh();
    await new Promise((resolve) => setTimeout(resolve, 10));
    (release as (() => void) | null)?.();
    await refreshing;
    await waitFor(() => button(root, "ask-edit"));
    const line = all(root).find((node) => node.className === "home-refresh");
    assert.ok(line);
    assert.equal(line.hidden, true);
  } finally {
    controller.destroy();
    restore();
  }
});

test("a failed open-time task check keeps the row retryable", async () => {
  const { root, client, opened, controller, restore } = harness({ readOnly: false });
  try {
    await controller.start("space-1");
    const row = await waitFor(
      () =>
        all(root).find(
          (node) =>
            node.className === "home-row-main" &&
            all(node).some(
              (child) => child.className === "home-row-title-text" && child.textContent === "intro.abc",
            ),
        ) ?? null,
    );
    client.getTask = async () => {
      throw new FakeRequestError(500);
    };
    row.onclick?.();
    await waitFor(() =>
      all(root).some((node) => node.textContent.includes("Couldn’t check this file")) ? true : null,
    );
    assert.equal(opened.length, 0);
  } finally {
    restore();
  }
});
