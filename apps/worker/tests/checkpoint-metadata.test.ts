import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import { updateCheckpointMeta } from "../src/checkpoint/metadata.js";

test("checkpoint stages merge their own fields into the current database row", () => {
  const db = drizzle.mock();
  const id = "00000000-0000-0000-0000-000000000001";
  const patches = [
    { board: { snapshotCount: 2 }, timings: { saveBoard: 10 } },
    { mirror: { status: "disabled" }, timings: { mirror: 0 } },
    { publishWarnings: [{ target: "models_cache" }], timings: { publish: 5 } },
  ];
  for (const patch of patches) {
    const query = updateCheckpointMeta(db, id, patch).toSQL();
    assert.match(query.sql, /coalesce\("v2"\."checkpoints"\."meta", '\{\}'::jsonb\) \|\| \$1::jsonb/);
    assert.match(query.sql, /where "v2"\."checkpoints"\."id" = \$2/);
    assert.deepEqual(query.params, [JSON.stringify(patch), id]);
  }
});
