import assert from "node:assert/strict";
import { SYSTEM_ENV_KEY_SET } from "./src/sandbox/constants.js";

assert.ok(SYSTEM_ENV_KEY_SET.has("SANDBOX_RPC_TOKEN"));
assert.ok(SYSTEM_ENV_KEY_SET.has("SANDBOX_REPORT_TOKEN"));
