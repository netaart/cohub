import process from "node:process";
import { buildAndroid } from "./native-project.mjs";

await buildAndroid(process.cwd(), {
  architectures: process.env.COHUB_ANDROID_ARCHITECTURES?.trim() || "armeabi-v7a,arm64-v8a,x86,x86_64",
  variant: "debug",
});
