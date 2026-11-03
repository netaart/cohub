import type { Command } from "commander";
import { describeCli } from "../about.js";
import { json, jsonRequested } from "../output.js";
import { isNewerVersion } from "../self-update.js";
import { currentIdentityKey } from "../space.js";

export function registerVersion(program: Command): void {
  program
    .command("version")
    .description("This CLI, the cohub on PATH, and the versions running Runtimes serve")
    .option("--json", "JSON output")
    .action(async (options: { json?: boolean }) => {
      const about = await describeCli(process.env, currentIdentityKey());
      if (jsonRequested(options)) return json(about);
      const rows = [
        `cohub     ${about.version}${about.commit ? ` (${about.commit})` : ""} · Node ${about.node}`,
        `PATH      ${about.path ? `${about.path.path} · ${about.path.version ?? "unknown"}` : "No cohub on PATH"}`,
        ...about.runtimes.map((runtime, index) =>
          `${index ? "         " : "Runtimes "} ${runtime.version ?? "older"} · ${runtime.root}${isNewerVersion(about.version, runtime.version ?? undefined) ? " (reconnect to update)" : ""}`),
      ];
      process.stdout.write(`${rows.join("\n")}\n`);
    });
}
