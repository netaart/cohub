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
});
