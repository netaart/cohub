import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** One temporary directory per test process, removed when it exits. */
export const scratch = mkdtempSync(join(tmpdir(), "cohub-test-"));
process.once("exit", () => rmSync(scratch, { recursive: true, force: true }));
