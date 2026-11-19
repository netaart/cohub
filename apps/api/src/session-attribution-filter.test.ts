import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getSessionInitiatorLabelSystemKey, getSessionSourceLabelSystemKey } from "@cohub/core/labels/session-attribution";
import { PgDialect } from "drizzle-orm/pg-core";
import { sessionAttributionCondition } from "./session-attribution-filter.js";

const dialect = new PgDialect();

function render(filter: Parameters<typeof sessionAttributionCondition>[0]) {
  const condition = sessionAttributionCondition(filter);
  assert.ok(condition, "expected a condition");
  const query = dialect.sqlToQuery(condition);
  return { sql: query.sql, params: query.params as string[] };
}

describe("sessionAttributionCondition", () => {
  it("returns no predicate when nothing is selected", () => {
    assert.equal(sessionAttributionCondition(null), undefined);
    assert.equal(sessionAttributionCondition({ source: [], initiator: [] }), undefined);
  });

  it("filters by system labels in the session's own space, not the raw source column", () => {
    const { sql, params } = render({ source: ["feishu"], initiator: [] });
    assert.match(sql, /label_assignments/);
    assert.match(sql, /space_sessions"\."space_id/);
    assert.ok(params.includes(getSessionSourceLabelSystemKey("feishu")));
    assert.ok(!/space_sessions"\."source"/.test(sql));
  });

  it("matches any kind within a param in one probe", () => {
    const { sql, params } = render({ source: ["web", "desktop"], initiator: [] });
    assert.equal(sql.match(/exists/gi)?.length, 1);
    assert.ok(params.includes(getSessionSourceLabelSystemKey("web")));
    assert.ok(params.includes(getSessionSourceLabelSystemKey("desktop")));
  });

  it("requires both params when both are given", () => {
    const { sql, params } = render({ source: ["cli"], initiator: ["human"] });
    assert.equal(sql.match(/exists/gi)?.length, 2);
    assert.match(sql, / and \(?exists/i);
    assert.ok(params.includes(getSessionInitiatorLabelSystemKey("human")));
  });
});
