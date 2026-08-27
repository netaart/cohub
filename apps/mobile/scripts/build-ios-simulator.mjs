import { join } from "node:path";
import { ensureDirectory, findBuiltIosApp, findIosScheme, findIosWorkspace, run } from "./native-project.mjs";

const root = process.cwd();
const workspace = await findIosWorkspace(root);
const scheme = await findIosScheme(workspace);
await run("xcodebuild", [
  "-workspace", workspace,
  "-scheme", scheme,
  "-configuration", "Debug",
  "-sdk", "iphonesimulator",
  "-derivedDataPath", join(root, "build", "ios"),
  "CODE_SIGNING_ALLOWED=NO",
  "build",
]);
const app = await findBuiltIosApp(root, scheme);
const artifacts = join(root, "build", "artifacts");
await ensureDirectory(artifacts);
await run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, join(artifacts, "Cohub-ios-simulator.zip")]);
console.log(`Built ${scheme} simulator artifact.`);
