import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  SpaceTurnListItem,
  SpaceTurnListOptions,
  SpaceTurnsResponse,
} from "@neta-art/cohub";
import { Command } from "commander";
import {
  InvalidSpaceTurnCliOptionsError,
  parseSpaceTurnListOptions,
  parseSessionTurnCursor,
  registerSpaceTurns,
  toSpaceTurnRows,
  validateSpaceTurnListMode,
} from "../src/commands/space-turns.js";

const turn: SpaceTurnListItem = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  sessionId: "session-1",
  sequence: 7,
  status: "completed",
  intent: "followup",
  userUuid: "user-1",
  authorProfile: {
    userUuid: "user-1",
    username: "ada",
    displayName: "Ada",
    avatarUrl: null,
  },
  startedAt: "2026-07-31T08:00:00.000Z",
  completedAt: "2026-07-31T08:00:02.000Z",
  durationMs: 2000,
  createdAt: "2026-07-31T08:00:00.000Z",
  updatedAt: "2026-07-31T08:00:02.000Z",
  userPreview: "Review the release",
  assistantPreview: "The release is ready",
  provider: "openai",
  model: "gpt-5",
  finalUsage: null,
  totalUsage: null,
  errorMessage: null,
  session: {
    id: "session-1",
    title: "Release",
    source: "web",
  },
};

const response: SpaceTurnsResponse = {
  turns: [turn],
  snapshotAt: "2026-07-31T09:00:00.000Z",
  snapshotCursor: "snapshot-cursor",
  pageInfo: { hasMore: true, nextCursor: "next-cursor" },
};

test("space turn CLI options preserve filters and stable cursors", () => {
  assert.deepEqual(
    parseSpaceTurnListOptions({
      author: "others",
      after: "after-cursor",
      before: "2026-07-31T09:00:00.000Z",
      cursor: "page-cursor",
      limit: "50",
      session: "session-1",
    }),
    {
      author: "others",
      after: "after-cursor",
      before: "2026-07-31T09:00:00.000Z",
      cursor: "page-cursor",
      limit: 50,
      sessionId: "session-1",
    },
  );
});

test("space turn CLI options reject invalid author, time, and limit", () => {
  assert.throws(
    () => parseSpaceTurnListOptions({ author: "team" }),
    InvalidSpaceTurnCliOptionsError,
  );
  assert.throws(
    () => parseSpaceTurnListOptions({ before: "not-a-time" }),
    InvalidSpaceTurnCliOptionsError,
  );
  assert.throws(
    () => parseSpaceTurnListOptions({ limit: "101" }),
    InvalidSpaceTurnCliOptionsError,
  );
});

test("session cursors start at the first turn sequence", () => {
  assert.equal(parseSessionTurnCursor("1"), 1);
  assert.throws(() => parseSessionTurnCursor("0"), InvalidSpaceTurnCliOptionsError);
  assert.throws(() => parseSessionTurnCursor("-1"), InvalidSpaceTurnCliOptionsError);
});

test("turn list rejects direction outside session mode", () => {
  assert.throws(
    () => validateSpaceTurnListMode({ direction: "newer" }),
    InvalidSpaceTurnCliOptionsError,
  );
  assert.doesNotThrow(() => validateSpaceTurnListMode({ session: "session-1", direction: "newer" }));
});

test("space turn table rows retain identifiers, authors, and previews", () => {
  assert.deepEqual(toSpaceTurnRows([turn]), [
    {
      createdAt: turn.createdAt,
      author: "Ada",
      sessionTitle: "Release",
      sessionId: "session-1",
      sequence: 7,
      id: turn.id,
      status: "completed",
      userPreview: "Review the release",
      assistantPreview: "The release is ready",
    },
  ]);
});

test("spaces turns ls forwards parsed options to the selected space", async () => {
  const program = new Command("cohub")
    .option("-s, --space <id>", "Target space ID")
    .helpOption("-h, --help", "Show help");
  const spaces = program.command("spaces");
  let calledSpaceId = "";
  let calledOptions: SpaceTurnListOptions | null = null;
  const turns = registerSpaceTurns(spaces, {
    createClient: () => ({
      space: (spaceId) => ({
        turns: {
          list: async (options) => {
            calledSpaceId = spaceId;
            calledOptions = options;
            return response;
          },
        },
        session: () => ({
          turns: {
            listPaginated: async () => {
              calledSpaceId = spaceId;
              return { session: {}, turns: [turn], hasMore: true, nextCursor: 6 };
            },
            get: async () => ({ turn }),
            intermediate: { get: async () => null },
          },
        }),
      }),
    }),
  });
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => {
    logs.push(values.join(" "));
  };
  try {
    await program.parseAsync([
      "node",
      "cohub",
      "-s",
      "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      "spaces",
      "turns",
      "ls",
      "--limit",
      "25",
      "--session",
      "session-1",
    ]);
  } finally {
    console.log = originalLog;
  }

  assert.equal(calledSpaceId, "7c9e6679-7425-40de-944b-e07fc1f90ae7");
  assert.equal(calledOptions, null);
  assert.match(logs.join("\n"), /next cursor: 6/);
  assert.match(turns.helpInformation(), /Browse turns across the space/);
  assert.match(turns.commands[0]?.helpInformation() ?? "", /--after <cursor>/);
});
