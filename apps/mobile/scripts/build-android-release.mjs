import { join } from "node:path";
import { run } from "./native-project.mjs";

await run("./gradlew", ["bundleRelease", "--no-daemon", "--stacktrace"], {
  cwd: join(process.cwd(), "android"),
});
