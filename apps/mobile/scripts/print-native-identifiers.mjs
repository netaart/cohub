import { appendFile } from "node:fs/promises";
import { getNativeIdentifiers } from "./native-project.mjs";

const identifiers = await getNativeIdentifiers();
const output = `ios_bundle_id=${identifiers.iosBundleId}\nandroid_package=${identifiers.androidPackage}\n`;
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, output);
process.stdout.write(output);
