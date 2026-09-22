#!/usr/bin/env node
import { createWriteStream, existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const control = createWriteStream(null, { fd: 3 });
control.write(`${JSON.stringify({ type: "hello" })}\n`);
control.write(`${JSON.stringify({ type: "connected" })}\n`);
const marker = process.env.COHUB_TEST_BRIDGE_EXIT_MARKER;
if (marker && !existsSync(marker)) {
  writeFileSync(marker, "first bridge started");
  setTimeout(() => process.exit(1), 250);
}
createInterface({ input: process.stdin }).on("line", () => {}).on("close", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
