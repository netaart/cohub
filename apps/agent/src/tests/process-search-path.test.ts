import assert from "node:assert/strict";
import { toProcessSearchPath } from "../sandbox/process-search-path.js";

assert.deepEqual(toProcessSearchPath("/workspace/apps/x", false), { cwd: "/workspace", arg: "/workspace/apps/x" }, "cloud argv stays as before");
assert.deepEqual(toProcessSearchPath("src", true), { cwd: "/workspace", arg: "src" }, "relative paths already resolve from the mapped cwd");
assert.deepEqual(toProcessSearchPath("/workspace/apps/x", true), { cwd: "/workspace", arg: "apps/x", base: "/workspace" });
assert.deepEqual(toProcessSearchPath("/workspace/", true), { cwd: "/workspace", arg: ".", base: "/workspace" }, "a trailing slash must not leave an empty path argument");
assert.deepEqual(toProcessSearchPath("/mods/demo/.agents/", true), { cwd: "/mods", arg: "demo/.agents", base: "/mods" });
assert.deepEqual(toProcessSearchPath("/tmp/x", true), { cwd: "/workspace", arg: "/tmp/x" }, "unmapped host paths pass through");
