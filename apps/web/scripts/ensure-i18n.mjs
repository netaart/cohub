import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = new URL("../", import.meta.url);
const outputDirectory = new URL("../src/lib/paraglide/", import.meta.url);
const fingerprintFile = new URL(".cohub-input-hash", outputDirectory);
const requiredOutputs = ["messages.js", "registry.js", "runtime.js"];
const inputDirectories = ["messages", "project.inlang"];
const inputFiles = ["package.json"];

async function collectFiles(directory) {
	const entries = await readdir(new URL(`${directory}/`, root), {
		withFileTypes: true,
	});
	const files = [];
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await collectFiles(path)));
		else if (entry.isFile()) files.push(path);
	}
	return files;
}

async function listInputFiles() {
	return [
		...inputFiles,
		...(await Promise.all(inputDirectories.map(collectFiles))).flat(),
	].sort();
}

async function calculateFingerprint(files) {
	const hash = createHash("sha256");
	for (const file of files) {
		hash.update(relative(".", file));
		hash.update("\0");
		hash.update(await readFile(new URL(file, root)));
		hash.update("\0");
	}
	return hash.digest("hex");
}

async function outputsExist() {
	try {
		await Promise.all(
			requiredOutputs.map((file) => access(new URL(file, outputDirectory))),
		);
		return true;
	} catch {
		return false;
	}
}

const inputs = await listInputFiles();
const fingerprint = await calculateFingerprint(inputs);
const previousFingerprint = await readFile(fingerprintFile, "utf8").catch(
	() => "",
);
const generated = await outputsExist();
if (process.argv.includes("--stamp")) {
	if (!generated) {
		throw new Error("Cannot stamp missing Paraglide outputs");
	}
	await writeFile(fingerprintFile, fingerprint);
	process.exit(0);
}
const force = process.argv.includes("--force");
if (!force && previousFingerprint === fingerprint && generated) process.exit(0);

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const child = spawn(
	pnpm,
	[
		"exec",
		"paraglide-js",
		"compile",
		"--project",
		"./project.inlang",
		"--outdir",
		"./src/lib/paraglide",
		"--output-structure",
		"message-modules",
		"--strategy",
		"globalVariable",
		"baseLocale",
		"--emit-ts-declarations",
		"--silent",
	],
	{ cwd: root, stdio: "inherit" },
);
const exitCode = await new Promise((resolve, reject) => {
	child.once("close", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
	child.once("error", reject);
});
if (exitCode !== 0) process.exit(exitCode);

await writeFile(fingerprintFile, fingerprint);
