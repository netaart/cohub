#!/usr/bin/env node
import "./runtime-bridge.mjs";
import { existsSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const inheritedMarker = process.env.COHUB_TEST_BRIDGE_INHERITED_MARKER;
if (inheritedMarker && !existsSync(inheritedMarker)) {
  const descendant = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 60000)"], {
    detached: true, stdio: ["ignore", "ignore", 2, 3],
  });
  writeFileSync(inheritedMarker, JSON.stringify({ descendantPid: descendant.pid }));
  descendant.unref();
  setTimeout(() => { process.stderr.write("last bridge diagnostic before exit\n"); process.exit(1); }, 250);
}
