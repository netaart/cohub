#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { control } from "./runtime-bridge.mjs";

const disconnectMarker = process.env.COHUB_TEST_BRIDGE_DISCONNECT_MARKER;
if (disconnectMarker) {
  appendFileSync(`${disconnectMarker}.pids`, `${process.pid}\n`);
  setInterval(() => {
    if (existsSync(disconnectMarker) && !existsSync(`${disconnectMarker}.handled`)) {
      writeFileSync(`${disconnectMarker}.handled`, "bridge disconnected and waiting for its five-minute retry");
      control.write(`${JSON.stringify({ type: "disconnected" })}\n`);
      if (readFileSync(disconnectMarker, "utf8") === "recover") {
        setTimeout(() => control.write(`${JSON.stringify({ type: "connected" })}\n`), 250);
      }
    }
  }, 20);
}
