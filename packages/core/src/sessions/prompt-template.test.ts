import assert from "node:assert/strict";
import test from "node:test";
import { expandPromptContent } from "./prompt.js";
import { renderPromptTemplate } from "./prompt-template.js";

test("renders Cohub IDs and prompt arguments", () => {
  const rendered = renderPromptTemplate(
    "Session {{cohub.session.id}} in {{ cohub.space.id }} for {{cohub.user.uuid}}: $1 / $@",
    ["first", "second"],
    { sessionId: "session-1", spaceId: "space-1", userUuid: "user-1" },
  );

  assert.equal(rendered, "Session session-1 in space-1 for user-1: first / first second");
});

test("preserves unknown and unavailable system variables", () => {
  const rendered = renderPromptTemplate(
    "{{cohub.session.id}} {{cohub.space.name}} {{other.value}}",
    [],
    { sessionId: null },
  );

  assert.equal(rendered, "{{cohub.session.id}} {{cohub.space.name}} {{other.value}}");
});

test("does not interpret system variables introduced through arguments", () => {
  const rendered = renderPromptTemplate("Value: $1", ["{{cohub.session.id}}"], { sessionId: "session-1" });
  assert.equal(rendered, "Value: {{cohub.session.id}}");
});

test("passes session context through prompt expansion", async () => {
  let receivedContext: Record<string, unknown> | undefined;
  await expandPromptContent({
    expandPromptTemplate: async (input) => {
      receivedContext = input;
      return null;
    },
  }, {
    content: [{ type: "text", text: "/handoff" }],
    userId: "user-1",
    spaceId: "space-1",
    sessionId: "session-1",
  });

  assert.deepEqual(receivedContext, {
    text: "/handoff",
    userId: "user-1",
    spaceId: "space-1",
    sessionId: "session-1",
  });
});

test("local harness expands prompt templates and forwards skills to the service", async () => {
  const calls: string[] = [];
  const deps = {
    expandPromptTemplate: async () => {
      calls.push("template");
      return {
        renderedText: "expanded text",
        template: { name: "plan", description: "d", scope: "user" as const },
        args: [],
        rawInput: "/plan",
      };
    },
    expandSkillCommand: async (input: { text: string }) => {
      calls.push(`skill:${input.text}`);
      return null;
    },
  };

  const template = await expandPromptContent(deps, {
    content: [{ type: "text", text: "/plan" }],
    userId: "user-1",
    spaceId: "space-1",
    harness: "pi",
    sandboxSemantics: false,
  });
  assert.deepEqual(calls, ["template"]);
  assert.equal(template.promptTemplate?.name, "plan");
  assert.equal(template.content[0] && template.content[0].type === "text" ? template.content[0].text : null, "expanded text");

  const skill = await expandPromptContent(deps, {
    content: [{ type: "text", text: "/skill:review" }],
    userId: "user-1",
    spaceId: "space-1",
    harness: "pi",
    sandboxSemantics: false,
  });
  assert.deepEqual(calls, ["template", "skill:/skill:review"]);
  assert.equal(skill.skillUsage, null);
  assert.equal(skill.promptTemplate, null);

  const shell = await expandPromptContent(deps, {
    content: [{ type: "text", text: "!ls -la" }],
    userId: "user-1",
    spaceId: "space-1",
    harness: "pi",
    sandboxSemantics: false,
  });
  assert.deepEqual(calls, ["template", "skill:/skill:review"]);
  assert.equal(shell.content[0]?.type, "text");
});

test("cohub harness keeps skill and shell command expansion", async () => {
  const deps = {
    expandPromptTemplate: async () => null,
    expandSkillCommand: async () => ({
      renderedText: "<skill>…</skill>",
      skill: {
        name: "review",
        description: "d",
        scope: "project" as const,
        sandboxFilePath: "/workspace/.agents/skills/review/SKILL.md",
        sandboxBaseDir: "/workspace/.agents/skills/review",
      },
      argsText: "",
      rawInput: "/skill:review",
    }),
  };

  const skill = await expandPromptContent(deps, {
    content: [{ type: "text", text: "/skill:review" }],
    userId: "user-1",
    spaceId: "space-1",
  });
  assert.equal(skill.skillUsage?.name, "review");

  const shell = await expandPromptContent(deps, {
    content: [{ type: "text", text: "!ls" }],
    userId: "user-1",
    spaceId: "space-1",
  });
  assert.equal(shell.content[0]?.type, "shell_command");
});

test("local harness forwards skill commands to the skill service with the harness", async () => {
  const skillCalls: Array<string | null | undefined> = [];
  const deps = {
    expandPromptTemplate: async () => null,
    expandSkillCommand: async (input: { text: string; harness?: string | null }) => {
      skillCalls.push(input.harness);
      return {
        renderedText: "<skill>project skill</skill>",
        skill: {
          name: "review",
          description: "d",
          scope: "project" as const,
          sandboxFilePath: ".agents/skills/review/SKILL.md",
          sandboxBaseDir: ".agents/skills/review",
        },
        argsText: "",
        rawInput: input.text,
      };
    },
  };

  const result = await expandPromptContent(deps, {
    content: [{ type: "text", text: "/skill:review" }],
    userId: "user-1",
    spaceId: "space-1",
    harness: "pi",
    sandboxSemantics: false,
  });

  assert.deepEqual(skillCalls, ["pi"]);
  assert.equal(result.skillUsage?.name, "review");
  assert.equal(result.promptTemplate, null);
});

test("local harness passes unknown-to-platform skills through when the service declines", async () => {
  const deps = {
    expandPromptTemplate: async () => null,
    expandSkillCommand: async () => null,
  };

  const result = await expandPromptContent(deps, {
    content: [{ type: "text", text: "/skill:local-only" }],
    userId: "user-1",
    spaceId: "space-1",
    harness: "pi",
    sandboxSemantics: false,
  });

  assert.equal(result.skillUsage, null);
  assert.equal(result.promptTemplate, null);
  assert.equal(result.content[0]?.type, "text");
  assert.equal(result.content[0] && result.content[0].type === "text" ? result.content[0].text : "", "/skill:local-only");
});
