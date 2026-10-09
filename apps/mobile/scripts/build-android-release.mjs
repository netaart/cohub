import { join } from "node:path";
import { configureAndroidGradleMemory, run } from "./native-project.mjs";

await configureAndroidGradleMemory(process.cwd());
await run("./gradlew", ["bundleRelease", "--no-daemon", "--stacktrace"], {
  cwd: join(process.cwd(), "android"),
});
