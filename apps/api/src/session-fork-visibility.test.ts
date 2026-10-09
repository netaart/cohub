import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redactCrossSpaceSessionForks, type SessionForkListItem } from "./session-fork-visibility.js";

const fork = (spaceId: string, childSessionId: string, parentSessionId: string): SessionForkListItem => ({
  id: `fork-${childSessionId}`,
  spaceId,
  parentSessionId,
  childSessionId,
  rootSessionId: parentSessionId,
  depth: 1,
  anchorSourceSessionId: parentSessionId,
  anchorTurnId: "turn-1",
  anchorSequence: 3,
  ancestorSessionIds: [parentSessionId],
  sessionPath: [parentSessionId, childSessionId],
  createdBy: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  firstUserTextAfterFork: "try another approach",
  parentTitle: "Private parent",
});

describe("redactCrossSpaceSessionForks", () => {
  it("keeps the full graph for spaces the viewer can fully see", () => {
    const [edge] = redactCrossSpaceSessionForks([fork("space-a", "child", "parent")], {
      fullViewSpaceIds: new Set(["space-a"]),
      visibleSessionIds: ["child"],
    });
    assert.equal(edge?.parentSessionId, "parent");
    assert.equal(edge?.parentTitle, "Private parent");
  });

  it("redacts parents outside the visible page in other spaces", () => {
    const [hidden, shown] = redactCrossSpaceSessionForks(
      [fork("space-b", "child", "parent"), fork("space-b", "child-2", "child")],
      { fullViewSpaceIds: new Set(["space-a"]), visibleSessionIds: ["child", "child-2"] },
    );
    assert.equal(hidden?.parentSessionId, null);
    assert.equal(hidden?.parentTitle, null);
    assert.deepEqual(hidden?.sessionPath, ["child"]);
    assert.equal(shown?.parentSessionId, "child");
  });
});
