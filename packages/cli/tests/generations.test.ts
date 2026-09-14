import assert from "node:assert/strict";
import { test } from "node:test";
import { Command } from "commander";
import { contentFromPathOrUrl, registerGenerations } from "../src/commands/generations.js";

test("generation audio input supports the reference_audio role", async () => {
  const input = await contentFromPathOrUrl(
    "audio",
    "reference_audio=https://example.com/reference.mp3?token=a=b",
  );

  assert.deepEqual(input, {
    type: "audio",
    source: {
      type: "url",
      url: "https://example.com/reference.mp3?token=a=b",
    },
    meta: { role: "reference_audio" },
  });
});

test("generation help documents reference_audio", () => {
  const program = new Command("cohub");
  registerGenerations(program);

  const generate = program.commands.find((command) => command.name() === "generate");
  assert.ok(generate);
  assert.match(generate.helpInformation(), /reference_audio=/);
});
