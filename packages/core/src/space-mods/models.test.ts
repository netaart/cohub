import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadSpaceModModelsConfigs } from "./index.js";

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
    await writeFile(join(good, "models.json"), JSON.stringify({ providers: { cohub: { models: [{ id: "chat", maxContext: 120000 }] } } }));
    const bad = join(root, "bad", "latest", ".cohub");
    await mkdir(bad, { recursive: true });
    await writeFile(join(bad, "models.json"), "{not json");

    const loaded = await loadSpaceModModelsConfigs(fakeDb([modRow("good", 0), modRow("bad", 1), modRow("missing", 2)]), "space", {
      checkpointCacheRoot: root,
    });

    assert.equal(loaded.configs.length, 1);
    assert.equal(loaded.configs[0]?.ref, "mod-good");
    assert.equal(loaded.configs[0]?.config.providers.cohub?.models?.[0]?.maxContext, 120000);
    assert.equal(loaded.warnings.length, 1);
    assert.match(loaded.warnings[0] ?? "", /invalid mod models\.json/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
