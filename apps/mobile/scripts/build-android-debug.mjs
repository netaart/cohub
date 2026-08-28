import process from "node:process";
import { join } from "node:path";
import { run } from "./native-project.mjs";

// Direct APK distribution targets current 64-bit Android devices by default; override locally when needed.
const architectures = process.env.COHUB_ANDROID_ARCHITECTURES?.trim() || "arm64-v8a";
if (!/^(armeabi-v7a|arm64-v8a|x86|x86_64)(,(armeabi-v7a|arm64-v8a|x86|x86_64))*$/.test(architectures)) {
  throw new Error(`Invalid COHUB_ANDROID_ARCHITECTURES value: ${architectures}`);
}
const args = [`-PreactNativeArchitectures=${architectures}`, "assembleDebug", "--no-daemon", "--stacktrace"];

await run("./gradlew", args, {
  cwd: join(process.cwd(), "android"),
});
