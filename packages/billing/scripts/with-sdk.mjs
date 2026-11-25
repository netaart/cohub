import { spawnSync } from "node:child_process";

const command = process.argv.slice(2);
try {
  import.meta.resolve("@talesofai-billing/sdk/base");
} catch (error) {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
  if (process.env.COHUB_REQUIRE_BILLING_SDK === "1") {
    console.error("@talesofai-billing/sdk is required (COHUB_REQUIRE_BILLING_SDK) but not installed");
    process.exit(1);
  }
  console.log(`skipped (@talesofai-billing/sdk not installed): ${command.join(" ")}`);
  process.exit(0);
}
const result = spawnSync(command[0], command.slice(1), { stdio: "inherit", shell: process.platform === "win32" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
