import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import type { Job } from "bullmq";
import type { TaskHandler } from "../src/tasks/registry.js";

let handler: TaskHandler;
const submissions: Array<{ sessionId: string; context: Record<string, unknown> }> = [];
const createdSessions: unknown[] = [];
const mocks: Array<{ restore(): void }> = [];
const unexpected = () => { throw new Error("Unexpected dependency call"); };
function replace(specifier: string, namedExports: Record<string, unknown>) {
  mocks.push(mock.module(specifier, { namedExports }));
}

replace("../src/tasks/registry.js", {
  registerTask: (type: string, taskHandler: TaskHandler) => {
    assert.equal(type, "send_message");
    handler = taskHandler;
  },
});
replace("@cohub/core/labels", { assignLabelsToSession: unexpected });
replace("@cohub/core/labels/session-source", { assignSessionSourceSystemLabel: async () => {} });
replace("@cohub/core/sessions", { parsePromptEnv: () => null });
replace("@cohub/core/apps", { resolveDelegatedAppScopesAtUseTime: unexpected });
replace("../src/tasks/send-message-auth.js", { sanitizeTaskPromptAuth: async () => null });
replace("../src/prompt-templates.js", { getPromptTemplateService: () => ({}) });
replace("../src/skills.js", { getSkillService: () => ({}) });
replace("../src/session-services.js", {
  getSessionDomainServices: () => ({
    registerCronjobSession: async (...args: unknown[]) => {
      createdSessions.push(args);
      return { id: "created-session" };
    },
    submitPrompt: async (input: typeof submissions[number]) => {
      submissions.push(input);
      return { turnId: "submitted-turn", userMessageId: "submitted-message" };
    },
  }),
});
replace("@cohub/infra/logging", { createLogger: () => ({ warn: unexpected }) });
replace("../src/db.js", { db: {} });
replace("../src/label-events.js", { dispatchLabelAssignmentsUpdated: async () => {} });
replace("../src/models.js", { validatePromptModel: unexpected });

await import("../src/tasks/send-message-task.js");
after(() => { for (const item of mocks.reverse()) item.restore(); });

function run(data: Record<string, unknown>) {
  submissions.length = createdSessions.length = 0;
  return handler({
    id: "queued-job",
    data: {
      spaceId: "space-1",
      userId: "user-1",
      cronJobId: "cron-1",
      data: { content: [{ type: "text", text: "Update memory" }], ...data },
    },
  } as Job, { taskRunId: "run-1" });
}

test("scheduled send_message tasks carry their success notification choice into the submitted turn", async () => {
  for (const notifyOnSuccess of [false, true]) {
    const result = await run({ sessionId: "existing-session", notifyOnSuccess });
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0]?.sessionId, "existing-session");
    assert.deepEqual(submissions[0]?.context, {
      kind: "scheduled_task", taskRunId: "run-1", cronJobId: "cron-1", auth: null, notifyOnSuccess,
    });
    assert.deepEqual(createdSessions, []);
    assert.deepEqual(result, {
      sessionId: "existing-session", spaceId: "space-1", turnId: "submitted-turn",
      userMessageId: "submitted-message", messageSent: true,
    });
  }
});

test("legacy tasks still create and submit a session with success notifications enabled by default", async () => {
  await run({});
  assert.equal(createdSessions.length, 1);
  assert.equal(submissions.length, 1);
  const submission = submissions[0];
  assert.ok(submission);
  assert.equal(submission.sessionId, "created-session");
  const { notifyOnSuccess, ...context } = submission.context;
  assert.ok(notifyOnSuccess === undefined || notifyOnSuccess === true);
  assert.deepEqual(context, { kind: "scheduled_task", taskRunId: "run-1", cronJobId: "cron-1", auth: null });
});

test("invalid notification settings fail before creating a session or submitting a prompt", async () => {
  for (const notifyOnSuccess of ["false", null, 0, 1, {}, []]) {
    await assert.rejects(run({ notifyOnSuccess }), /notifyOnSuccess/);
    assert.deepEqual(createdSessions, []);
    assert.deepEqual(submissions, []);
  }
});
