import assert from "node:assert/strict";
import test from "node:test";
import { createBashTool } from "../runtime/tools/basic-tools.js";

const CWD = "/workspace";

test("bash hides the background execution parameter from its schema", () => {
  const tool = createBashTool(CWD, { operations: { async exec() { return { exitCode: 0 }; } } });
  const schema = tool.parameters as { properties?: Record<string, unknown> };

  assert.deepEqual(Object.keys(schema.properties ?? {}), ["command", "timeout"]);
  assert.doesNotMatch(tool.description, /run_in_background/);
});

test("bash preserves transport output truncation without treating it as infrastructure failure", async () => {
  const tool = createBashTool(CWD, {
    operations: {
      async exec() {
        return { exitCode: 0, outputTruncated: true };
      },
    },
  });

  const result = await tool.execute("call-truncated", { command: "printf output" });
  const details = result.details as Record<string, unknown>;
  const termination = details.termination as Record<string, unknown>;
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";

  assert.equal(details.outputTruncated, true);
  assert.equal(termination.outputTruncated, true);
  assert.notEqual(details.isError, true);
  assert.match(text, /Output truncated by sandbox transport/);
});

test("bash keeps compatibility with the hidden background parameter", async () => {
  let request: { command: string; cwd: string; timeout?: number; toolCallId: string } | undefined;
  const tool = createBashTool(CWD, {
    operations: {
      async exec() {
        throw new Error("Foreground execution must not be used");
      },
      async startBackground(input) {
        request = input;
        return { taskRunId: "task-1" };
      },
    },
  });

  const result = await tool.execute("call-1", {
    command: "pnpm test",
    timeout: 12.8,
    run_in_background: true,
  });

  assert.equal(request?.command, "pnpm test");
  assert.equal(request?.cwd, CWD);
  assert.equal(request?.timeout, 12);
  assert.equal(request?.toolCallId, "call-1");
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /Task ID: task-1/);
});

test("bash explains output whose first line exceeds the size limit", async () => {
  const tool = createBashTool(CWD, {
    operations: {
      async exec({ onData }) {
        onData(Buffer.from(`${"x".repeat(60 * 1024)}\nshort\n`));
        return { exitCode: 0, outputTruncated: true };
      },
    },
  });

  const result = await tool.execute("call-long-line", { command: "grep -r x ." });
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";

  assert.match(text, /^\[Output omitted: first line exceeds 50\.0KB limit/);
  assert.match(text, /Output truncated by sandbox transport/);
});
