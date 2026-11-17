import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { spaces } from "@cohub/db";
import { toSessionSpace } from "./session-space.js";

describe("toSessionSpace", () => {
  it("drops Space secrets and internals", () => {
    const space = toSessionSpace({
      id: "space-1",
      name: "Home",
      storageRepoName: "space-1-repo",
      meta: {
        extraEnv: [{ name: "TOKEN", value: "secret" }],
        config: { sandbox: { image: null } },
        bootstrap: { status: "ready", source: { type: "git_repo", repoUrl: "https://user:pass@example.com/r.git", gitToken: "ghp_x" } },
        publicProfile: { avatarUrl: "https://example.com/a.webp" },
      },
    } as unknown as typeof spaces.$inferSelect);

    assert.deepEqual(space, {
      id: "space-1",
      name: "Home",
      meta: {
        bootstrap: { status: "ready", source: { type: "git_repo", repoUrl: "https://example.com/r.git" } },
        publicProfile: { avatarUrl: "https://example.com/a.webp" },
      },
    });
  });

  it("keeps only display fields for non-members", () => {
    const space = toSessionSpace({
      id: "space-1",
      headCheckpointId: "cp-1",
      storageRepoName: "space-1-repo",
      meta: { config: {}, bootstrap: { status: "ready", stage: null, taskRunId: "run-1" }, publicProfile: null },
    } as unknown as typeof spaces.$inferSelect, false);

    assert.deepEqual(space, {
      id: "space-1",
      baseCheckpointId: null,
      headCheckpointId: null,
      meta: { bootstrap: { status: "ready", stage: null }, publicProfile: null },
    });
  });
});
