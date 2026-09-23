import assert from "node:assert/strict";
import test from "node:test";
import {
  chunkGrepFileArgs,
  extractRequiredGrepLiterals,
  filterGrepCandidatesByGlob,
  joinGrepCandidatePath,
} from "../runtime/tools/grep-index-candidates.js";

test("literal patterns are passed through when long enough", () => {
  assert.deepEqual(extractRequiredGrepLiterals("foo.bar", { literal: true }), ["foo.bar"]);
  assert.deepEqual(extractRequiredGrepLiterals("ab", { literal: true }), []);
  assert.deepEqual(extractRequiredGrepLiterals("  a  ", { literal: true }), []);
});

test("regex extraction keeps only fragments every match must contain", () => {
  assert.deepEqual(extractRequiredGrepLiterals("handleFSSearch"), ["handleFSSearch"]);
  assert.deepEqual(extractRequiredGrepLiterals("foo\\.bar"), ["foo.bar"]);
  assert.deepEqual(extractRequiredGrepLiterals("\\bfoo\\b"), ["foo"]);
  assert.deepEqual(extractRequiredGrepLiterals("foo.*bar"), ["foo", "bar"]);
  assert.deepEqual(extractRequiredGrepLiterals("foo\\s+bar"), ["foo", "bar"]);
  assert.deepEqual(extractRequiredGrepLiterals("^import .* from \"react\"$"), ["import ", " from \"react\""]);
  assert.deepEqual(extractRequiredGrepLiterals("[abc]def"), ["def"]);
  assert.deepEqual(extractRequiredGrepLiterals("(?i)Foo\\w+Bar"), ["Foo", "Bar"]);
  assert.deepEqual(extractRequiredGrepLiterals("(?:foo)bar"), ["foo", "bar"]);
});

test("regex extraction drops optional and repeated characters", () => {
  assert.deepEqual(extractRequiredGrepLiterals("colou?r"), ["colo"]);
  assert.deepEqual(extractRequiredGrepLiterals("foo(bar)?baz"), ["foo", "baz"]);
  assert.deepEqual(extractRequiredGrepLiterals("(foo(?i)bar)?baz"), ["baz"]);
  assert.deepEqual(extractRequiredGrepLiterals("(foo)*bar"), ["bar"]);
  assert.deepEqual(extractRequiredGrepLiterals("(foo){0,2}bar"), ["bar"]);
  assert.deepEqual(extractRequiredGrepLiterals("(foo)+bar"), ["foo", "bar"]);
  assert.deepEqual(extractRequiredGrepLiterals("abc+def"), ["abc", "def"]);
  assert.deepEqual(extractRequiredGrepLiterals("ab*cdef"), ["cdef"]);
});

test("regex extraction gives up on alternation and malformed input", () => {
  assert.deepEqual(extractRequiredGrepLiterals("foo|bar"), []);
  assert.deepEqual(extractRequiredGrepLiterals("handle(Search|Grep)"), []);
  assert.deepEqual(extractRequiredGrepLiterals("trailing\\"), []);
  assert.deepEqual(extractRequiredGrepLiterals("a.b.c"), []);
});

test("glob filtering follows ripgrep --glob semantics", () => {
  const candidates = ["src/a.ts", "src/nested/b.ts", "docs/c.md", "src/d.md"];
  assert.deepEqual(filterGrepCandidatesByGlob(candidates, undefined), candidates);
  assert.deepEqual(filterGrepCandidatesByGlob(candidates, "*.ts"), ["src/a.ts", "src/nested/b.ts"]);
  assert.deepEqual(filterGrepCandidatesByGlob(candidates, "src/*.ts"), ["src/a.ts"]);
  assert.deepEqual(filterGrepCandidatesByGlob(candidates, "src/**"), ["src/a.ts", "src/nested/b.ts", "src/d.md"]);
  assert.deepEqual(filterGrepCandidatesByGlob(candidates, "!*.md"), ["src/a.ts", "src/nested/b.ts"]);
});

test("candidate paths mirror rg output for the given search path", () => {
  assert.equal(joinGrepCandidatePath(".", "src/a.ts"), "./src/a.ts");
  assert.equal(joinGrepCandidatePath("apps/agent", "src/a.ts"), "apps/agent/src/a.ts");
  assert.equal(joinGrepCandidatePath("/workspace/apps/", "src/a.ts"), "/workspace/apps/src/a.ts");
  assert.equal(joinGrepCandidatePath("/workspace/README.md", "."), "/workspace/README.md");
});

test("argv chunking respects item and byte limits including the base argv", () => {
  const base = ["rg", "--json", "--", "pattern"];
  const files = Array.from({ length: 10 }, (_, index) => `file-${index}.ts`);
  const byItems = chunkGrepFileArgs(base, files, { maxItems: 8, maxBytes: 1024 * 1024 });
  assert.deepEqual(byItems.map((chunk) => chunk.length), [4, 4, 2]);

  const baseBytes = base.join("").length;
  const byBytes = chunkGrepFileArgs(base, files, { maxItems: 1000, maxBytes: baseBytes + 3 * "file-0.ts".length });
  assert.deepEqual(byBytes.map((chunk) => chunk.length), [3, 3, 3, 1]);

  assert.deepEqual(chunkGrepFileArgs(base, [], { maxItems: 8, maxBytes: 1024 }), []);
});
