import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Isolate `homedir()` for tests that exercise identity-scoped Runtime paths.
 *
 * `auth.ts` and `space.ts` resolve `~/.config/cohub` once at module load, so this fixture
 * must be the first import of a test file. Otherwise the suite would read (and could write)
 * the developer's real Cohub configuration.
 */
export const nativeFixtureHome = mkdtempSync(join(tmpdir(), "cohub-native-home-"));
process.env.HOME = nativeFixtureHome;
