import assert from "node:assert/strict";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { getCurrentToolExecutionContext, runWithToolExecutionContext } from "../tool-context.js";
import { createSpaceAwareReadTool } from "../runtime/tools/space-aware-query-tools.js";
import type { AgentFileVisibility } from "../runtime/workspace-visibility.js";

function createStubTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: {} as never,
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: name }],
        details: { params, spaceId: getCurrentToolExecutionContext()?.spaceId },
      };
    },
  } as AgentTool;
}

const CURRENT_SPACE_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_SPACE_ID = "22222222-2222-4222-8222-222222222222";
const SHORT_TARGET_SPACE_ID = "33333333333343338333333333333333";

async function runReadTool(input: {
  targetProvider: "cloud" | "local";
  visibility?: AgentFileVisibility;
  spaceId?: string | null;
}) {
  const tool = createSpaceAwareReadTool({
    sandboxTool: createStubTool("sandbox"),
    crossSpaceTool: createStubTool("pvc"),
    checkAccess: async () => input.visibility ?? "full",
    resolveSandboxProvider: async () => input.targetProvider,
  });

  return runWithToolExecutionContext({ spaceId: CURRENT_SPACE_ID, sessionId: "session-a" }, () =>
    tool.execute("tool-call-a", { path: "README.md", space_id: input.spaceId === undefined ? TARGET_SPACE_ID : input.spaceId }));
}

const schemaTool = createSpaceAwareReadTool({
  sandboxTool: createStubTool("read"),
  crossSpaceTool: createStubTool("read"),
  checkAccess: async () => "full",
  resolveSandboxProvider: async () => "cloud",
});
assert.equal(validateToolArguments(schemaTool, {
  type: "toolCall", id: "call-null", name: "read", arguments: { path: "README.md", space_id: null },
}).space_id, null);

const nullResult = await runReadTool({ targetProvider: "cloud", spaceId: null });
assert.deepEqual(nullResult.content, [{ type: "text", text: "sandbox" }]);
assert.deepEqual(nullResult.details, { params: { path: "README.md" }, spaceId: CURRENT_SPACE_ID });

const cloudResult = await runReadTool({ targetProvider: "cloud" });
assert.equal(cloudResult.content[0]?.type, "text");
assert.equal(cloudResult.content[0]?.text, "pvc");
assert.deepEqual(cloudResult.details, { params: { path: "README.md" }, spaceId: TARGET_SPACE_ID });

const localResult = await runReadTool({ targetProvider: "local" });
assert.equal(localResult.content[0]?.type, "text");
assert.equal(localResult.content[0]?.text, "sandbox");
assert.deepEqual(localResult.details, { params: { path: "README.md" }, spaceId: TARGET_SPACE_ID });

const shortUuidResult = await runReadTool({ targetProvider: "cloud", spaceId: SHORT_TARGET_SPACE_ID });
assert.equal(shortUuidResult.content[0]?.type, "text");
assert.equal(shortUuidResult.content[0]?.text, "pvc");
assert.deepEqual(shortUuidResult.details, { params: { path: "README.md" }, spaceId: SHORT_TARGET_SPACE_ID });

await assert.rejects(
  runReadTool({ targetProvider: "local", visibility: "filtered" }),
  /Filtered file access is not available for local sandboxes\./,
);

await assert.rejects(
  runReadTool({ targetProvider: "cloud", spaceId: "limit\u200b=30" }),
  /Invalid space_id: expected a UUID/,
);
