import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SESSION_SOURCE_KEYS,
  sessionSourceMatchSpec,
} from "@cohub/core/labels/session-source";
import { PgDialect } from "drizzle-orm/pg-core";
import { sessionListSourceCondition } from "./session-source-filter.js";

const dialect = new PgDialect();

/** Sources as the gateway's per-provider sourceChannel builders store them. */
const CHANNEL_STORED_SOURCES: Array<{ key: string; stored: string[] }> = [
  { key: "feishu", stored: ["feishu:dm:alice", "feishu:group:eng"] },
  { key: "wechat", stored: ["wechat:dm:user-1"] },
  { key: "discord", stored: ["discord:dm:bob", "discord:Acme:#general"] },
  { key: "qq", stored: ["qq:dm:openid", "qq:group:gid", "qq:guild:chan"] },
];

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

  // Every channel provider stores `provider:<conversation>` (see the gateway
  // sourceChannel builders), so an exact match on the kind name would silently
  // drop every chat from every provider, not just Feishu.
  it("matches every channel kind by head segment and channel spellings", () => {
    for (const { key, stored } of CHANNEL_STORED_SOURCES) {
      for (const value of stored) {
        assert.ok(value.startsWith(`${key}:`), `fixture drift: ${value}`);
      }
      const { sql, params } = render({ keys: [key] });
      assert.match(sql, /split_part/, `${key}: expected a head-segment clause`);
      assert.ok(params.includes(key), `${key}: expected the plain spelling`);
      assert.ok(params.includes(`channel:${key}`), `${key}: expected channel: spelling`);
      assert.ok(params.includes(`channel_${key}`), `${key}: expected channel_ spelling`);
    }
  });

  it("generates the spellings a kind is stored as", () => {
    for (const key of SESSION_SOURCE_KEYS) {
      const spec = sessionSourceMatchSpec(key);
      const { sql, params } = render({ keys: [key] });
      for (const value of [...spec.exact, ...spec.channel]) {
        assert.ok(params.includes(value), `${key}: missing spelling ${value}`);
      }
      if (spec.nullSource) {
        assert.match(sql, /is null/i, `${key}: expected the legacy null branch`);
      }
    }
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
    for (const { key } of CHANNEL_STORED_SOURCES) {
      assert.ok(params.includes(key), `other must exclude ${key}`);
    }
  });

  it("combines several kinds with or", () => {
    const { sql, params } = render({ keys: ["web", "feishu"] });
    assert.match(sql, / or /i);
    assert.ok(params.includes("feishu"));
    assert.ok(params.includes("web"));
  });
});
