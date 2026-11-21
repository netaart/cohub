import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";
import {
  collectSpaceContext,
  formatSessionTranscriptMarkdown,
  formatSpaceContextMarkdown,
  readSessionTranscript,
  type SessionReadClient,
  type SpaceContextClient,
} from "../src/space-context.js";
import { explicitSpaceFlag, parseSearchInput } from "../src/commands/search.js";

function createMockSpaceContextClient(overrides?: {
  failDiff?: boolean;
  failTurns?: boolean;
  readmeContent?: string;
}): SpaceContextClient {
  const observedTurnOptions: Array<Record<string, unknown>> = [];
  const client: SpaceContextClient & { observedTurnOptions: typeof observedTurnOptions } = {
    observedTurnOptions,
    spaces: {
      async get(spaceId) {
        return {
          id: spaceId,
          name: "Growth Ops",
          slug: "growth-ops",
          description: "Shared space for weekly launch analytics and scripts.",
          status: "active",
          createdAt: "2026-11-01T00:00:00.000Z",
          updatedAt: "2026-11-20T00:00:00.000Z",
        } as Awaited<ReturnType<SpaceContextClient["spaces"]["get"]>>;
      },
    },
    space() {
      return {
        files: {
          async list() {
            return {
              path: "",
              entries: [
                { name: "notes.md", type: "file", size: 512, mtimeMs: 1700000000000 },
                { name: "scripts", type: "dir", size: 0, mtimeMs: 1700000000000 },
                { name: "README.md", type: "file", size: 1200, mtimeMs: 1700000000000 },
                { name: "AGENTS.md", type: "file", size: 300, mtimeMs: 1700000000000 },
              ],
            } as Awaited<ReturnType<ReturnType<SpaceContextClient["space"]>["files"]["list"]>>;
          },
          async diff() {
            if (overrides?.failDiff) throw new Error("diff unavailable");
            return {
              files: [
                { status: "M", path: "scripts/report.py", additions: 14, deletions: 3 },
                { status: "A", path: "assets/chart.png", binary: true },
              ],
              stats: { changedFileCount: 2, additions: 14, deletions: 3 },
            };
          },
          async read(path) {
            if (path === "AGENTS.md") {
              return { content: "Always run pytest before saving.", encoding: "utf-8" };
            }
            return {
              content: overrides?.readmeContent ?? "# Growth Ops\nWeekly metrics pipeline.",
              encoding: "utf-8",
            };
          },
        },
        sessions: {
          async list() {
            return {
              sessions: [
                {
                  id: "sess-old",
                  title: "Older chat",
                  status: "idle",
                  totalMessages: 4,
                  createdAt: "2026-11-18T10:00:00.000Z",
                  updatedAt: "2026-11-18T11:00:00.000Z",
                },
                {
                  id: "sess-new",
                  title: "Weekly release prep",
                  status: "running",
                  totalMessages: 12,
                  createdAt: "2026-11-20T08:00:00.000Z",
                  updatedAt: "2026-11-20T09:30:00.000Z",
                },
              ],
            } as Awaited<ReturnType<ReturnType<SpaceContextClient["space"]>["sessions"]["list"]>>;
          },
        },
        turns: {
          async list(options) {
            observedTurnOptions.push(options as Record<string, unknown>);
            if (overrides?.failTurns) throw new Error("turns unavailable");
            return {
              turns: [
                {
                  id: "turn-9",
                  sessionId: "sess-new",
                  sequence: 3,
                  status: "completed",
                  createdAt: "2026-11-20T09:20:00.000Z",
                  userPreview: "Please verify the funnel SQL query",
                  assistantPreview: "Verified all 3 CTEs; zero discrepancies.",
                  authorProfile: { displayName: "Alice", username: "alice" },
                  session: { id: "sess-new", title: "Weekly release prep" },
                },
              ],
              snapshotAt: "2026-11-20T09:30:00.000Z",
              pageInfo: { hasMore: false, nextCursor: null },
            } as Awaited<ReturnType<ReturnType<SpaceContextClient["space"]>["turns"]["list"]>>;
          },
        },
        checkpoints: {
          async list() {
            return {
              checkpoints: [
                {
                  id: "cp-1",
                  description: "Baseline before v2 launch",
                  createdAt: "2026-11-19T18:00:00.000Z",
                },
              ],
            } as Awaited<ReturnType<ReturnType<SpaceContextClient["space"]>["checkpoints"]["list"]>>;
          },
        },
      };
    },
  };
  return client;
}

test("collectSpaceContext aggregates workspace, guides, diffs, chats, turns, and saves into concise Markdown", async () => {
  const longReadme = "A".repeat(3_000);
  const client = createMockSpaceContextClient({ readmeContent: longReadme });
  const snapshot = await collectSpaceContext(client, "space-123", {
    author: "others",
    turnsLimit: 5,
    sessionsLimit: 1,
    includeDocs: true,
  });

  assert.equal(snapshot.workspaceEntries[0]?.name, "scripts");
  assert.equal(snapshot.workspaceEntries[0]?.type, "dir");
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.sessions[0]?.id, "sess-new");
  assert.equal(snapshot.guides.length, 2);
  assert.equal(snapshot.guides[0]?.path, "AGENTS.md");
  assert.equal(snapshot.guides[1]?.path, "README.md");
  assert.equal(snapshot.guides[1]?.truncated, true);
  assert.equal(snapshot.warnings.length, 0);

  const markdown = formatSpaceContextMarkdown(snapshot);
  assert.match(markdown, /# Space: Growth Ops/);
  assert.match(markdown, /## Pending Changes \(vs Last Save\)/);
  assert.match(markdown, /\[M\] `scripts\/report\.py` \(\+14\/-3\)/);
  assert.match(markdown, /\[A\] `assets\/chart\.png` \(binary\)/);
  assert.match(markdown, /### AGENTS\.md/);
  assert.match(markdown, /Always run pytest before saving\./);
  assert.match(markdown, /## Recent Turns \(author: others\)/);
  assert.match(markdown, /\*\*Alice\*\*/);
  assert.match(markdown, /Baseline before v2 launch/);
});

test("collectSpaceContext respects includeDocs=false and degrades gracefully when optional fetches fail", async () => {
  const client = createMockSpaceContextClient({ failDiff: true, failTurns: true });
  const snapshot = await collectSpaceContext(client, "space-123", {
    includeDocs: false,
  });

  assert.equal(snapshot.guides.length, 0);
  assert.equal(snapshot.pendingDiff, null);
  assert.equal(snapshot.turns.length, 0);
  assert.deepEqual(snapshot.warnings, ["Recent turns unavailable."]);

  const markdown = formatSpaceContextMarkdown(snapshot);
  assert.doesNotMatch(markdown, /## Space Guides/);
  assert.doesNotMatch(markdown, /## Pending Changes/);
  assert.match(markdown, /## Notes/);
  assert.match(markdown, /Recent turns unavailable\./);
});

test("readSessionTranscript paginates --all chronologically and formats merged/error turns + changed files", async () => {
  const pages: Record<string, {
    turns: Array<Record<string, unknown>>;
    hasMore: boolean;
    nextCursor: number | undefined;
  }> = {
    initial: {
      turns: [
        {
          id: "t-3",
          sequence: 3,
          status: "failed",
          createdAt: "2026-11-20T10:05:00.000Z",
          userText: "Deploy preview",
          assistantText: "",
          errorMessage: "Timeout contacting upstream",
        },
        {
          id: "t-2",
          sequence: 2,
          status: "merged",
          createdAt: "2026-11-20T10:02:00.000Z",
          userText: "Also update changelog",
          assistantText: "",
          summary: { mergedIntoTurnId: "t-3" },
        },
      ],
      hasMore: true,
      nextCursor: 1,
    },
    "1": {
      turns: [
        {
          id: "t-1",
          sequence: 1,
          status: "completed",
          provider: "cohub",
          model: "claude-sonnet",
          createdAt: "2026-11-20T10:00:00.000Z",
          userText: "Summarize the diff",
          assistantText: "Updated two scripts and added tests.",
        },
      ],
      hasMore: false,
      nextCursor: undefined,
    },
  };

  const client: SessionReadClient = {
    space() {
      return {
        session() {
          return {
            async get() {
              return {
                session: {
                  id: "sess-42",
                  title: "Release Handoff",
                  status: "idle",
                  createdAt: "2026-11-20T09:59:00.000Z",
                },
              } as Awaited<ReturnType<ReturnType<ReturnType<SessionReadClient["space"]>["session"]>["get"]>>;
            },
            async files() {
              return {
                files: [
                  {
                    path: "CHANGELOG.md",
                    lastKind: "modified",
                    changeCount: 2,
                    lastTurnSequence: 2,
                    lastChangedAt: "2026-11-20T10:02:00.000Z",
                  },
                ],
                truncated: false,
              } as Awaited<ReturnType<ReturnType<ReturnType<SessionReadClient["space"]>["session"]>["files"]>>;
            },
            turns: {
              async listPaginated(opts) {
                const key = opts?.cursor === undefined ? "initial" : String(opts.cursor);
                const page = pages[key] ?? { turns: [], hasMore: false, nextCursor: undefined };
                return { session: {}, ...page } as Awaited<
                  ReturnType<ReturnType<ReturnType<SessionReadClient["space"]>["session"]>["turns"]["listPaginated"]>
                >;
              },
            },
          };
        },
      };
    },
  };

  const snapshot = await readSessionTranscript(client, "space-1", "sess-42", {
    all: true,
    withFiles: true,
  });

  assert.deepEqual(snapshot.turns.map((turn) => turn.sequence), [1, 2, 3]);
  assert.equal(snapshot.hasMore, false);
  assert.equal(snapshot.files?.length, 1);

  const md = formatSessionTranscriptMarkdown(snapshot);
  assert.match(md, /# Chat: Release Handoff/);
  assert.match(md, /## Changed Files/);
  assert.match(md, /\[modified\] `CHANGELOG\.md` \(2x, last turn #2\)/);
  assert.ok(md.indexOf("Turn #1") < md.indexOf("Turn #2"));
  assert.ok(md.indexOf("Turn #2") < md.indexOf("Turn #3"));
  assert.match(md, /Updated two scripts and added tests\./);
  assert.match(md, /Merged into turn `t-3`/);
  assert.match(md, /\*\*Error:\*\* Timeout contacting upstream/);
});

test("parseSearchInput resolves -s and --space-id refs while keeping unscoped search global", async () => {
  const root = new Command().option("-s, --space <id>");
  const searchCmd = root.command("search");

  const resolvedRefs: string[] = [];
  const fakeResolve = async (value: string) => {
    resolvedRefs.push(value);
    return `resolved:${value}`;
  };

  // Unscoped stays undefined (global) even if COHUB_SPACE_ID is set in env.
  const prevEnv = process.env.COHUB_SPACE_ID;
  process.env.COHUB_SPACE_ID = "env-space-id";
  try {
    assert.equal(explicitSpaceFlag(searchCmd), null);
    const unscoped = await parseSearchInput({}, searchCmd, fakeResolve);
    assert.equal(unscoped.spaceId, undefined);
  } finally {
    if (prevEnv === undefined) delete process.env.COHUB_SPACE_ID;
    else process.env.COHUB_SPACE_ID = prevEnv;
  }

  // Ancestor -s flag is honored and resolved.
  root.setOptionValue("space", "alice/project");
  const fromGlobalFlag = await parseSearchInput({}, searchCmd, fakeResolve);
  assert.equal(fromGlobalFlag.spaceId, "resolved:alice/project");

  // Explicit --space-id takes precedence over -s.
  const fromSpaceId = await parseSearchInput({ spaceId: "home", types: "chat,label" }, searchCmd, fakeResolve);
  assert.equal(fromSpaceId.spaceId, "resolved:home");
  assert.deepEqual(fromSpaceId.types, ["chat", "label"]);
  assert.deepEqual(resolvedRefs, ["alice/project", "home"]);
});
