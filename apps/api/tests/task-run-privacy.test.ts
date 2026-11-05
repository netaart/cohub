import assert from "node:assert/strict";
import { test } from "node:test";
import {
  sanitizeTaskRunPricingForViewer,
  sanitizeTaskRunProgressForViewer,
} from "../src/task-run-privacy.js";

function generationRun() {
  return {
    taskType: "generation",
    userUuid: "creator_1",
    payload: {
      type: "generation",
      data: {
        model: "gpt-image-2",
        modelDiscount: { multiplier: 0, resolvedAt: "2026-07-13T00:00:00.000Z" },
        reserveHold: { payer: { type: "personal", id: "creator_1" }, amountUsd: 5.7 },
      },
    },
    result: {
      model: "gpt-image-2",
      cost: 0.04,
      billing: {
        officialCostUsd: 0.04,
        amountUsd: 0,
        discountMultiplier: 0,
        status: "skipped",
        reason: "discounted_free",
      },
    },
  };
}

test("generation creator can view their own pricing", () => {
  const run = generationRun();
  assert.equal(sanitizeTaskRunPricingForViewer(run, "creator_1"), run);
});

test("generation pricing is removed from collaborator task views without mutating storage", () => {
  const run = generationRun();
  const sanitized = sanitizeTaskRunPricingForViewer(run, "collaborator_1");

  assert.deepEqual(sanitized.payload, {
    type: "generation",
    data: { model: "gpt-image-2" },
  });
  assert.deepEqual(sanitized.result, {
    model: "gpt-image-2",
    cost: 0.04,
  });
  assert.equal((run.payload.data as Record<string, unknown>).modelDiscount !== undefined, true);
  assert.equal((run.result as Record<string, unknown>).billing !== undefined, true);
});

test("Space creation Git tokens are removed for every viewer without mutating storage", () => {
  const run = {
    taskType: "create_space",
    userUuid: "creator_1",
    payload: {
      data: {
        source: {
          type: "git_repo",
          repoUrl: "https://example.test/repo.git",
          ref: "main",
        },
        gitToken: "secret",
      },
    },
    result: null,
  };

  for (const viewer of ["creator_1", "collaborator_1"]) {
    assert.deepEqual(sanitizeTaskRunPricingForViewer(run, viewer).payload, {
      data: {
        source: {
          type: "git_repo",
          repoUrl: "https://example.test/repo.git",
          ref: "main",
        },
      },
    });
  }
  assert.equal((run.payload.data as Record<string, unknown>).gitToken, "secret");
});

test("App Action internals are visible only to the App owner", () => {
  const run = {
    taskType: "run_command",
    userUuid: "viewer_1",
    payload: {
      type: "run_command",
      data: {
        source: "app_action",
        appId: "app_1",
        appVersionId: "version_1",
        action: "summarize",
        actionInput: { text: "Hello" },
        actorUserId: "owner_1",
        executionScopes: ["command.execute"],
        command: "secret command",
      },
    },
    result: {
      command: "secret command",
      output: "safe output",
      content: [{ type: "tool_use", input: { command: "secret command" }, _meta: { command: "secret command" } }],
    },
  };
  const progress = {
    command: "secret command",
    output: "safe progress",
    content: [{ type: "tool_use", input: { command: "secret command" }, _meta: { command: "secret command" } }],
  };

  assert.equal(sanitizeTaskRunPricingForViewer(run, "viewer_1", { canViewSpaceData: true }), run);
  assert.deepEqual(sanitizeTaskRunPricingForViewer(run, "viewer_1", { canViewSpaceData: false }), {
    ...run,
    payload: {
      type: "run_command",
      data: {
        source: "app_action",
        appId: "app_1",
        appVersionId: "version_1",
        action: "summarize",
      },
    },
    result: { output: "safe output" },
  });
  assert.deepEqual(sanitizeTaskRunProgressForViewer(run, progress, false), {
    output: "safe progress",
  });
});

test("run command execution fields are hidden from malformed payloads", () => {
  const run = {
    taskType: "run_command",
    userUuid: "owner_1",
    payload: { type: "run_command", data: null },
    result: { command: "secret command", content: [{ type: "tool_use", input: { command: "secret command" } }], output: "safe output" },
  };
  const progress = { command: "secret command", content: [{ type: "tool_use", input: { command: "secret command" } }], output: "safe progress" };

  assert.deepEqual(sanitizeTaskRunPricingForViewer(run, "viewer_1", { canViewSpaceData: false }), {
    ...run,
    result: { output: "safe output" },
  });
  assert.deepEqual(sanitizeTaskRunProgressForViewer(run, progress, false), {
    output: "safe progress",
  });
});

test("non-generation task responses are unchanged", () => {
  const run = {
    taskType: "echo",
    userUuid: "creator_1",
    payload: { data: { modelDiscount: { multiplier: 0 } } },
    result: { billing: { amountUsd: 0 } },
  };
  assert.equal(sanitizeTaskRunPricingForViewer(run, "collaborator_1"), run);
});

test("generation billing retry pricing is removed from collaborator task views", () => {
  const run = {
    taskType: "generation.billing_retry",
    userUuid: "creator_1",
    payload: {
      data: {
        taskRunId: "generation_1",
        model: "gpt-image-2",
        officialCostUsd: 0.04,
        amountUsd: 0.024,
        modelDiscount: { multiplier: 0.6, resolvedAt: "2026-07-13T00:00:00.000Z" },
      },
    },
    result: {
      status: "recorded",
      taskRunId: "generation_1",
      officialCostUsd: 0.04,
      amountUsd: 0.024,
      discountMultiplier: 0.6,
    },
  };

  assert.deepEqual(sanitizeTaskRunPricingForViewer(run, "collaborator_1"), {
    ...run,
    payload: { data: { taskRunId: "generation_1", model: "gpt-image-2" } },
    result: { status: "recorded", taskRunId: "generation_1" },
  });
});
