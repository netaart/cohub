import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRgPlanRuns,
  chunkArgs,
  escapeGlobPath,
  joinSearchPath,
  onlyVanishedTargets,
} from "../runtime/tools/search-plan.js";

const flags = ["rg", "--json"];

test("plans search text files explicitly and walk files through their parent", () => {
  const runs = buildRgPlanRuns({
    flags,
    globArgv: ["--glob", "*.ts"],
    pattern: "needle",
    searchPath: "src",
    plan: {
      root: "src",
      files: ["a.ts", "nested/b.ts"],
      walkFiles: ["nested/c.bin", "nested/d.log", "e.bin"],
      dirs: ["build"],
    },
  });

  assert.deepEqual(runs, [
    // rg applies no glob to explicit files; the index already did.
    { argv: ["rg", "--json", "--", "needle", "src/a.ts", "src/nested/b.ts"], targets: ["src/a.ts", "src/nested/b.ts"] },
    {
      argv: [
        "rg", "--json", "--max-depth", "1",
        "--glob", "/src/nested/c.bin", "--glob", "/src/nested/d.log", "--glob", "/src/e.bin",
        "--", "needle", "src/nested", "src",
      ],
      targets: ["src/nested", "src"],
    },
    { argv: ["rg", "--json", "--glob", "*.ts", "--", "needle", "src/build"], targets: ["src/build"] },
  ]);
});

test("plans print paths the way a walk of the search path prints them", () => {
  const runs = buildRgPlanRuns({
    flags,
    globArgv: [],
    pattern: "needle",
    searchPath: ".",
    plan: { root: "", files: ["a.ts"], walkFiles: ["b.bin"], dirs: [] },
  });
  assert.deepEqual(runs?.map((run) => run.targets), [["./a.ts"], ["."]]);
  assert.ok(runs?.[1]?.argv.includes("/b.bin"));

  const absolute = buildRgPlanRuns({
    flags,
    globArgv: [],
    pattern: "needle",
    searchPath: "/workspace/src/",
    plan: { root: "src", files: ["a.ts"], walkFiles: [], dirs: [] },
  });
  assert.deepEqual(absolute?.[0]?.targets, ["/workspace/src/a.ts"]);
});

test("empty plans produce no runs and unusual paths decline the plan", () => {
  assert.deepEqual(buildRgPlanRuns({
    flags,
    globArgv: [],
    pattern: "needle",
    searchPath: ".",
    plan: { root: "", files: [], walkFiles: [], dirs: [] },
  }), []);
  assert.equal(buildRgPlanRuns({
    flags,
    globArgv: [],
    pattern: "needle",
    searchPath: ".",
    plan: { root: "", files: ["line\nbreak.txt"], walkFiles: [], dirs: [] },
  }), null);
});

test("plans split into runs that fit the argv limits", () => {
  const files = Array.from({ length: 10 }, (_, index) => `file-${index}.ts`);
  const runs = buildRgPlanRuns({
    flags,
    globArgv: [],
    pattern: "needle",
    searchPath: "src",
    plan: { root: "src", files, walkFiles: files.map((file) => `dir-${file}/x.bin`), dirs: [] },
    limits: { maxItems: 10, maxBytes: 64 * 1024 },
  });
  assert.ok(runs);
  for (const run of runs) assert.ok(run.argv.length <= 10, `run has ${run.argv.length} items`);
  const explicit = runs.filter((run) => !run.argv.includes("--max-depth")).flatMap((run) => run.targets);
  assert.deepEqual(explicit, files.map((file) => `src/${file}`));
  const globs = runs.flatMap((run) => run.argv.filter((item) => item.startsWith("/src/dir-")));
  assert.equal(globs.length, 10);
});

test("walk globs escape glob syntax and trailing spaces", () => {
  assert.equal(escapeGlobPath("we[ir]d *?{a,b}\\.txt"), "we\\[ir\\]d \\*\\?\\{a,b\\}\\\\.txt");
  assert.equal(escapeGlobPath("trailing  "), "trailing\\ \\ ");
  assert.equal(escapeGlobPath("!#plain name"), "!#plain name");
});

test("chunking keeps every argument and respects both limits", () => {
  const head = ["rg", "--", "pattern"];
  const args = Array.from({ length: 7 }, (_, index) => `f${index}`);
  assert.deepEqual(chunkArgs(head, args, { maxItems: 6, maxBytes: 1024 }).map((chunk) => chunk.length), [3, 3, 1]);
  const bytes = head.join("").length + 4;
  assert.deepEqual(chunkArgs(head, args, { maxItems: 100, maxBytes: bytes }).map((chunk) => chunk.length), [2, 2, 2, 1]);
  assert.deepEqual(chunkArgs(head, [], { maxItems: 6, maxBytes: 1024 }), []);
});

test("only errors for vanished targets are ignorable", () => {
  const targets = ["src/a.ts", "src/b.ts"];
  assert.equal(onlyVanishedTargets("rg: src/a.ts: No such file or directory (os error 2)\n", targets), true);
  assert.equal(onlyVanishedTargets("rg: other.ts: No such file or directory (os error 2)", targets), false);
  assert.equal(onlyVanishedTargets("rg: src/a.ts: Permission denied (os error 13)", targets), false);
  assert.equal(onlyVanishedTargets("regex parse error", targets), false);
  assert.equal(onlyVanishedTargets("", targets), false);
});

test("joined paths mirror rg and fd output for the search path", () => {
  assert.equal(joinSearchPath(".", "src/a.ts"), "./src/a.ts");
  assert.equal(joinSearchPath("apps/agent", "src/a.ts"), "apps/agent/src/a.ts");
  assert.equal(joinSearchPath("/workspace/apps/", "src/a.ts"), "/workspace/apps/src/a.ts");
  assert.equal(joinSearchPath("/workspace/src", ""), "/workspace/src");
});
