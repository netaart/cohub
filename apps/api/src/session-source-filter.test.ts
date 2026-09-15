import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getSessionSourceLabelSystemKey } from "@cohub/core/labels/session-source";
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

  // Channel chats are stored as `feishu:dm:…` / `channel:feishu`, so matching the
  // raw column dropped every one of them. The label carries the attribution the
  // normalizer already made at creation, for every provider.
  it("filters by the source system label, not the raw source column", () => {
    for (const key of ["web", "feishu", "wechat", "discord", "qq", "scheduled_task", "other"]) {
      const { sql, params } = render({ keys: [key] });
      assert.match(sql, /label_assignments/, `${key}: expected the label join`);
      assert.match(sql, /system_key/, `${key}: expected the system key check`);
      assert.ok(
        params.includes(getSessionSourceLabelSystemKey(key)),
        `${key}: expected ${getSessionSourceLabelSystemKey(key)}`,
      );
      assert.ok(
        !/space_sessions"\."source"/.test(sql),
        `${key}: must not read the raw source column`,
      );
    }
  });

  it("scopes the probe to the session's own space", () => {
    const { sql } = render({ keys: ["web"] });
    assert.match(sql, /scope_id/);
    assert.match(sql, /space_sessions"\."space_id/);
  });

  it("combines several kinds with or", () => {
    const { sql, params } = render({ keys: ["web", "feishu"] });
    assert.match(sql, / or /i);
    assert.ok(params.includes(getSessionSourceLabelSystemKey("web")));
    assert.ok(params.includes(getSessionSourceLabelSystemKey("feishu")));
  });
});
