import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import { createRequestedThinkingLevelReader } from "../runtime/context-reader.js";
import type { CohubModel } from "../runtime/model-registry.js";
import { resolveInitialThinkingLevel } from "../runtime/thinking-level.js";

const model = (overrides: Partial<CohubModel> = {}) => ({
  id: "m", name: "m", api: "openai-completions", provider: "cohub", baseUrl: "", reasoning: true,
  input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1, maxTokens: 1,
  ...overrides,
}) as CohubModel;

const unexpectedLoad = async (): Promise<string | null> => {
  throw new Error("selection must not be loaded");
};

test("a brand-new session starts at the model default", async () => {
  assert.equal(await resolveInitialThinkingLevel(model(), { recorded: null, resumed: false, loadSelected: unexpectedLoad }), "high");
  assert.equal(await resolveInitialThinkingLevel(model({ defaultThinkingLevel: "medium" }), { recorded: null, resumed: false }), "medium");
});

test("a recorded level wins without reading the selection", async () => {
  assert.equal(await resolveInitialThinkingLevel(model(), { recorded: "low", resumed: true, loadSelected: unexpectedLoad }), "low");
});

test("a lost record falls back to the explicit selection, clamped to the model", async () => {
  assert.equal(await resolveInitialThinkingLevel(model(), { recorded: null, resumed: true, loadSelected: async () => "medium" }), "medium");
  assert.equal(await resolveInitialThinkingLevel(model(), { recorded: "bogus", resumed: true, loadSelected: async () => "minimal" }), "minimal");
  // max is opt-in, so an unsupported selection is clamped to the nearest supported level.
  assert.equal(await resolveInitialThinkingLevel(model(), { recorded: null, resumed: true, loadSelected: async () => "max" }), "high");
});

test("without any selection a lost record uses the lowest supported level", async () => {
  assert.equal(await resolveInitialThinkingLevel(model(), { recorded: null, resumed: true, loadSelected: async () => null }), "off");
  assert.equal(await resolveInitialThinkingLevel(model(), { recorded: null, resumed: true }), "off");
  const alwaysThinks = model({ thinkingLevelMap: { off: null, minimal: null } });
  assert.equal(await resolveInitialThinkingLevel(alwaysThinks, { recorded: null, resumed: true, loadSelected: async () => null }), "low");
  assert.equal(await resolveInitialThinkingLevel(model({ reasoning: false }), { recorded: null, resumed: true, loadSelected: async () => "high" }), "off");
});

/** Real drizzle builders (for SQL assertions) answering from a scripted result queue. */
function scriptedDatabase(results: unknown[][]) {
  const mock = drizzle.mock();
  const queries: string[] = [];
  const wrap = <T extends object>(builder: T): T => new Proxy(builder, {
    get(target, prop, receiver) {
      if (prop === "then") {
        queries.push((target as unknown as { toSQL(): { sql: string } }).toSQL().sql);
        const result = results.shift() ?? [];
        return (resolve: (value: unknown) => void) => resolve(result);
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? (...args: unknown[]) => wrap(value.apply(target, args)) : value;
    },
  });
  const database = { select: ((fields?: never) => wrap(fields ? mock.select(fields) : mock.select())) as typeof mock.select };
  return { database, queries };
}

test("the selection reader returns the newest explicit level before the batch", async () => {
  const { database, queries } = scriptedDatabase([[], [{ level: "medium" }]]);
  const load = createRequestedThinkingLevelReader(database);
  assert.equal(await load({ sessionId: "s1", beforeSequence: 7 }), "medium");
  assert.equal(queries.length, 2);
  const turnQuery = queries[1] ?? "";
  assert.match(turnQuery, /->>'requestedThinkingLevel' is not null/);
  assert.match(turnQuery, /"status" <> \$/);
  assert.match(turnQuery, /"sequence" < \$/);
  assert.match(turnQuery, /order by "v2"\."session_turns"\."sequence" desc limit/);
});

test("the selection reader walks fork segments from newest to oldest", async () => {
  const segments = [
    { sessionId: "fork", sourceSessionId: "fork", ordinal: 1, fromSequence: 4, toSequence: null },
    { sessionId: "fork", sourceSessionId: "source", ordinal: 0, fromSequence: 1, toSequence: 3 },
  ];
  const { database, queries } = scriptedDatabase([segments, [], [{ level: "low" }], [{ level: "never-read" }]]);
  const load = createRequestedThinkingLevelReader(database);
  assert.equal(await load({ sessionId: "fork" }), "low");
  assert.equal(queries.length, 3, "stops at the first segment with a selection");
});

test("the selection reader returns null when nothing was selected", async () => {
  const { database } = scriptedDatabase([[], []]);
  assert.equal(await createRequestedThinkingLevelReader(database)({ sessionId: "s1" }), null);
});
