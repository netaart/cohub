import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDirectory, findBuiltIpa, findIosScheme, findIosWorkspace, getNativeIdentifiers, run } from "./native-project.mjs";

const required = ["IOS_TEAM_ID", "IOS_PROFILE_NAME"];
const missing = required.filter((name) => !process.env[name]?.trim());
if (missing.length > 0) {
  throw new Error(`Missing iOS signing environment variables: ${missing.join(", ")}`);
}

const root = process.cwd();
const workspace = await findIosWorkspace(root);
const scheme = await findIosScheme(workspace);
const { iosBundleId } = await getNativeIdentifiers(root);
const buildDir = join(root, "build");
await ensureDirectory(buildDir);
await run("xcodebuild", [
  "-workspace", workspace,
  "-scheme", scheme,
  "-configuration", "Release",
  "-sdk", "iphoneos",
  "-archivePath", join(buildDir, "Cohub.xcarchive"),
  "CODE_SIGN_STYLE=Manual",
  `DEVELOPMENT_TEAM=${process.env.IOS_TEAM_ID}`,
  `PROVISIONING_PROFILE_SPECIFIER=${process.env.IOS_PROFILE_NAME}`,
  "CODE_SIGN_IDENTITY=Apple Distribution",
  "archive",
]);

const xml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
const exportOptions = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>destination</key><string>export</string>
<key>method</key><string>app-store</string>
<key>signingStyle</key><string>manual</string>
<key>stripSwiftSymbols</key><true/>
<key>teamID</key><string>${xml(process.env.IOS_TEAM_ID)}</string>
<key>provisioningProfiles</key><dict>
<key>${xml(iosBundleId)}</key><string>${xml(process.env.IOS_PROFILE_NAME)}</string>
</dict>
</dict></plist>
`;
await writeFile(join(buildDir, "ExportOptions.plist"), exportOptions);
const exportDir = join(buildDir, "export");
await ensureDirectory(exportDir);
await run("xcodebuild", [
  "-exportArchive",
  "-archivePath", join(buildDir, "Cohub.xcarchive"),
  "-exportPath", exportDir,
  "-exportOptionsPlist", join(buildDir, "ExportOptions.plist"),
]);
const ipa = await findBuiltIpa(root);
const normalized = join(exportDir, "Cohub.ipa");
if (ipa !== normalized) await copyFile(ipa, normalized);
console.log(`Built ${scheme} production IPA.`);
