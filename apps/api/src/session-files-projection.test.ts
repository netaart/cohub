import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectSessionFiles } from "./session-files-projection.js";

const SPACE = "11111111-1111-4111-8111-111111111111";

function group(path: string, overrides: Partial<Parameters<typeof projectSessionFiles>[0]["references"][number]> = {}) {
  return {
    targetId: `${SPACE}:${path}`,
    kinds: ["agent_tool_file_edit"],
    lastKind: "agent_tool_file_edit",
    changeCount: 1,
    firstChangedAt: new Date("2026-09-01T00:00:00.000Z"),
    lastChangedAt: new Date("2026-09-01T00:00:00.000Z"),
    lastTurnId: "turn-1",
    lastTurnSequence: 1,
    ...overrides,
  };
}

describe("projectSessionFiles", () => {
  it("maps agent edits and sorts by latest turn", () => {
    const files = projectSessionFiles({
      spaceId: SPACE,
      references: [
        group("/workspace/old.ts"),
        group("/workspace/new.ts", {
          kinds: ["agent_tool_file_edit", "agent_tool_file_write"],
          lastKind: "agent_tool_file_write",
          changeCount: 3,
          lastChangedAt: new Date("2026-09-02T00:00:00.000Z"),
          lastTurnId: "turn-2",
          lastTurnSequence: 2,
        }),
        group("/tmp/scratch.ts"),
      ],
    });
    assert.deepEqual(files.map((file) => file.path), ["new.ts", "old.ts"]);
    assert.deepEqual(files[0], {
      path: "new.ts",
      lastKind: "write",
      kinds: ["write", "edit"],
      changeCount: 3,
      firstChangedAt: "2026-09-01T00:00:00.000Z",
      lastChangedAt: "2026-09-02T00:00:00.000Z",
      lastTurnId: "turn-2",
      lastTurnSequence: 2,
    });
  });
});
