import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadSpaceModModelLayers } from "./index.js";

const modRow = (id: string, sortOrder: number) => ({
  mod: {
    id: `row-${id}`, spaceId: "space", modSpaceId: id, mountSlug: `mod-${id}`,
    enabled: true, sortOrder, createdAt: new Date(), updatedAt: new Date(), addedBy: null,
  },
  modSpaceName: null,
  modSpaceDescription: null,
});

function fakeDb(rows: ReturnType<typeof modRow>[]) {
  return {
    select: () => ({
      from: () => ({
        leftJoin: () => ({
          where: () => ({ orderBy: async () => rows }),
        }),
      }),
    }),
  } as never;
}

test("loads enabled mod models.json files and reports bad ones without failing", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-mod-models-"));
  try {
    const good = join(root, "good", "latest", ".cohub");
    await mkdir(good, { recursive: true });
    await writeFile(join(good, "models.json"), JSON.stringify({ providers: { cohub: { models: [{ id: "chat", contextWindow: 120000 }] } } }));
    const bad = join(root, "bad", "latest", ".cohub");
    await mkdir(bad, { recursive: true });
    await writeFile(join(bad, "models.json"), "{not json");

    const warnings: string[] = [];
    const layers = await loadSpaceModModelLayers(fakeDb([modRow("good", 0), modRow("bad", 1), modRow("missing", 2)]), "space", {
      checkpointCacheRoot: root,
      warn: (message) => warnings.push(message),
    });

    assert.equal(layers.length, 1);
    assert.equal(layers[0]?.ref, "mod-good");
    assert.equal(layers[0]?.config.providers.cohub?.models?.[0]?.contextWindow, 120000);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /invalid mod models\.json/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
