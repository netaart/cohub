import process from "node:process";
import { join } from "node:path";
import { configureAndroidAbiSplits, run } from "./native-project.mjs";

const root = process.cwd();
const architectures = await configureAndroidAbiSplits(
  root,
  process.env.COHUB_ANDROID_ARCHITECTURES?.trim() || "armeabi-v7a,arm64-v8a,x86,x86_64",
);
await run("./gradlew", [`-PreactNativeArchitectures=${architectures}`, "assembleDebug", "--no-daemon", "--stacktrace"], {
  cwd: join(root, "android"),
});
