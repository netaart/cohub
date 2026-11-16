import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyLocalBoard, createLocalBoard, localBoardHistory, readLocalBoard, restoreLocalBoard } from "../src/board-local.js";

const text = (id: string, value: string) => ({ items: { [id]: { type: "text", props: { text: value } } } });

test("local Boards keep every version, including edits made outside the CLI", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "board-local-")), "plan.board.json");
  await createLocalBoard(path, { title: "Plan", patch: text("a", "one") });
  await applyLocalBoard(path, text("a", "two"), { by: "cli" });
  await writeFile(path, (await readFile(path, "utf8")).replace('"two"', '"by hand"'));
  const { result } = await applyLocalBoard(path, text("b", "three"), { by: "viewer" });
  assert.equal(result.version, 4);

  const { versions } = await localBoardHistory(path, { limit: 10 });
  assert.deepEqual(versions.map(({ version, by }) => [version, by]), [[4, "viewer"], [3, "external"], [2, "cli"], [1, "cli"]]);

  await restoreLocalBoard(path, 3);
  const restored = await readLocalBoard(path);
  assert.equal(restored.version, 5);
  assert.equal((restored.document.items.a?.props as { text?: string } | undefined)?.text, "by hand");
  assert.equal(restored.document.items.b, undefined);

  await assert.rejects(applyLocalBoard(path, text("c", "stale"), { by: "cli", baseVersion: 4 }), /version 5, not 4/);
});
