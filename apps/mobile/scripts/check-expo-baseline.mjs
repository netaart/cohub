import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function run(module, args, env) {
  const result = spawnSync(process.execPath, [require.resolve(module), ...args], {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Validate the locked SDK baseline instead of a moving upstream recommendation.
run("expo/bin/cli", ["install", "--check"], { EXPO_OFFLINE: "1", CI: "1" });
// The version check above replaces only Doctor's remote version check.
run("expo-doctor/build/index.js", [], { EXPO_DOCTOR_SKIP_DEPENDENCY_VERSION_CHECK: "1" });
