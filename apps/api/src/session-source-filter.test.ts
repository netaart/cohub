import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { sessionListSourceCondition } from "./session-source-filter.js";

const dialect = new PgDialect();

function render(source: Parameters<typeof sessionListSourceCondition>[0]) {
  const condition = sessionListSourceCondition(source);
  assert.ok(condition, "expected a condition");
  const query = dialect.sqlToQuery(condition);
  return { sql: query.sql, params: query.params as string[] };
}

describe("sessionListSourceCondition", () => {
  it("returns no predicate when no source is selected", () => {
    assert.equal(sessionListSourceCondition(null), undefined);
    assert.equal(sessionListSourceCondition({ keys: [] }), undefined);
  });

  // A channel provider is stored as `feishu:<conversation>`, so an exact match on
  // the kind name would silently drop every Feishu chat.
  it("matches channel kinds by head segment and channel spellings", () => {
    const { sql, params } = render({ keys: ["feishu"] });
    assert.match(sql, /split_part/);
    assert.ok(params.includes("feishu"), "expected the plain spelling");
    assert.ok(params.includes("channel:feishu"), "expected channel: spelling");
    assert.ok(params.includes("channel_feishu"), "expected channel_ spelling");
  });

  it("treats a null source as a legacy web row", () => {
    const { sql, params } = render({ keys: ["web"] });
    assert.match(sql, /is null/i);
    assert.ok(params.includes("web"));
    assert.ok(params.includes("web_app"));
  });

  it("scopes other to values no known kind claims", () => {
    const { sql, params } = render({ keys: ["other"] });
    // `other` is the complement: a non-null source that no known kind matches.
    // It has to exclude the prefixed spellings too, or `feishu:oc_…` would be
    // counted as Other as well as Feishu.
    assert.match(sql, /is not null/i);
    assert.match(sql, /not /i);
    assert.match(sql, /split_part/);
    assert.ok(params.includes("feishu"));
    assert.ok(params.includes("channel:feishu"));
  });

  it("combines several kinds with or", () => {
    const { sql, params } = render({ keys: ["web", "feishu"] });
    assert.match(sql, / or /i);
    assert.ok(params.includes("feishu"));
    assert.ok(params.includes("web"));
  });
});
