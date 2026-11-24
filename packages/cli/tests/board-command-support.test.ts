import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  readBoardJsonObject,
  writeBoardOutput,
} from "../src/board-command-support.js";

test("Board JSON input enforces the streamed size limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-board-input-"));
  const input = join(root, "input.json");
  try {
    await writeFile(input, '{"value":"large"}');
    await assert.rejects(readBoardJsonObject(input, 4), /input limit/);
    await assert.rejects(readBoardJsonObject(root, 1024), /a file or a pipe/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Board output refuses overwrite unless forced", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-board-output-"));
  const output = join(root, "board.png");
  try {
    await writeFile(output, "old");
    await assert.rejects(writeBoardOutput(output, new Uint8Array([1])), /already exists/);
    assert.equal(await readFile(output, "utf8"), "old");
    await writeBoardOutput(output, new Uint8Array([1, 2]), true);
    assert.deepEqual([...await readFile(output)], [1, 2]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
