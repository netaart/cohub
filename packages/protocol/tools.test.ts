import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { presentTool } from "./src/tools/index.js";

const fieldsOf = (view: ReturnType<typeof presentTool>) => Object.fromEntries(view.fields.map((field) => [field.label, field.value]));

describe("presentTool", () => {
  it("maps each harness's own shapes onto the same parts", () => {
    const cohub = presentTool("cohub", "read", { path: "/workspace/src/a.ts", offset: 10, limit: 5 });
    assert.deepEqual([cohub.target?.text, cohub.primary?.text, fieldsOf(cohub)], ["/workspace/src/a.ts", "src/a.ts", { lines: "10–14" }]);

    const bash = presentTool("claude", "Bash", { command: "pnpm test", description: "Run tests", timeout: 600000 });
    assert.deepEqual([bash.target, bash.subtitle, fieldsOf(bash)], [{ kind: "command", text: "pnpm test" }, "Run tests", { timeout: "10m" }]);

    const patch = presentTool("codex", "apply_patch", { input: "*** Begin Patch\n*** Update File: a.sql\n@@\n--- note\n+-- note\n*** End Patch" });
    assert.deepEqual(patch.sections[0]?.kind === "diff" && patch.sections[0].lines.map((line) => line.sign + line.text), [" @@", "--- note", "+-- note"]);
  });

  it("shows summarized inputs by their previews and never hides what a call carries", () => {
    assert.equal(presentTool("cohub", "bash", { command: { preview: "cat <<'EOF'…", _truncated: true, originalLength: 999 } }).target?.text, "cat <<'EOF'…");
    const unknown = presentTool("claude", "Frobnicate", { level: 3, nested: { a: 1 } });
    assert.deepEqual([unknown.verb, fieldsOf(unknown), unknown.sections.map((section) => section.label)], ["run", { level: "3" }, ["nested"]]);
  });
});
