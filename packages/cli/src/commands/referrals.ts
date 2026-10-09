import type { Command } from "commander";
import { createClient } from "../client.js";
import { error, handleHttp, json as outJson, jsonRequested, ok, table } from "../output.js";
import { webUrl } from "../web.js";

function referralUrl(code: string) {
  return webUrl(`/referrals/${code}`);
}

async function confirmRotate(opts: { yes?: boolean }): Promise<void> {
  if (opts.yes) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return error("Confirmation required", "Pass --yes to replace the referral link.");
  }
  process.stdout.write("The current referral link will stop working. Continue? [y/N] ");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
    break;
  }
  const answer = Buffer.concat(chunks).toString().trim().toLowerCase();
  if (answer !== "y" && answer !== "yes") return error("Cancelled");
}

export function registerReferrals(program: Command): void {
  const command = program
    .command("referrals")
    .description("View and manage your referral link")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const client = createClient();
      try {
        const result = await client.referrals.getMine();
        const output = { ...result, url: referralUrl(result.code) };
        if (jsonRequested(opts)) return outJson(output);
        console.log(`\nReferral link: ${output.url}`);
        console.log(`Rewarded: ${result.summary.rewarded}`);
        console.log(`Earned: $${result.summary.earnedUsd.toFixed(2)}\n`);
      } catch (error: unknown) {
        handleHttp(error);
      }
    });

  command
    .command("ls")
    .alias("list")
    .description("List your referrals")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const client = createClient();
      try {
        const result = await client.referrals.getMine();
        if (jsonRequested(opts)) return outJson(result);
        table(result.items, [
          { key: "id", label: "ID" },
          { key: "status", label: "Status" },
          { key: "claimedAt", label: "Claimed" },
          { key: "rewardedAt", label: "Rewarded" },
        ]);
      } catch (error: unknown) {
        handleHttp(error);
      }
    });

  command
    .command("rotate")
    .description("Replace your referral link")
    .option("-y, --yes", "Confirm replacement")
    .option("--json", "Output as JSON")
    .action(async (opts: { yes?: boolean; json?: boolean }) => {
      await confirmRotate(opts);
      const client = createClient();
      try {
        const result = await client.referrals.rotateCode();
        const output = { ...result, url: referralUrl(result.code) };
        if (jsonRequested(opts)) return outJson(output);
        ok(`Referral link rotated: ${output.url}`);
      } catch (error: unknown) {
        handleHttp(error);
      }
    });
}
