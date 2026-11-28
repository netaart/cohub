import "dotenv/config";
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: "apps/api/.env", override: false });

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const argv = process.argv.slice(2);
const batchSize = Math.min(Math.max(Number(argv[argv.indexOf("--batch-size") + 1]) || 1_000, 1), 10_000);
const dryRun = argv.includes("--dry-run");
const client = postgres(process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/cohub", { prepare: false, max: 2 });
const db = drizzle(client);

const sourceEmail = sql`nullif(btrim(coalesce(source->>'primaryEmail', source->>'email', source#>>'{profile,email}')), '')`;

async function main() {
  let cursor = "";
  let scanned = 0;
  let updated = 0;
  for (;;) {
    const rows = await db.execute<{ user_uuid: string }>(sql`
      select user_uuid from v2.user_profiles
      where user_uuid > ${cursor} and email is null
      order by user_uuid limit ${batchSize}`);
    if (rows.length === 0) break;
    const ids = rows.map((row) => row.user_uuid);
    cursor = ids.at(-1) ?? cursor;
    scanned += ids.length;
    if (!dryRun) {
      const result = await db.execute<{ user_uuid: string }>(sql`
        update v2.user_profiles set email = ${sourceEmail}
        where user_uuid in ${ids} and email is null
          and ${sourceEmail} like '%@%' and length(${sourceEmail}) <= 320
        returning user_uuid`);
      updated += result.length;
    }
    console.log(`[backfill-user-profile-emails] scanned=${scanned} updated=${updated} cursor=${cursor}`);
  }
  console.log(`[backfill-user-profile-emails] done scanned=${scanned} updated=${updated} dryRun=${dryRun}`);
}

main()
  .catch((error) => {
    console.error("[backfill-user-profile-emails] failed", error);
    process.exitCode = 1;
  })
  .finally(() => client.end());
