import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const root = new URL("../", import.meta.url);
const runner = fileURLToPath(
	new URL("../../../scripts/test/run.mjs", import.meta.url),
);
const forwardedArguments = process.argv.slice(2).filter((argument) => argument !== "--");
const groups = [
	[
		"--test-isolation=none",
		"--test-concurrency=1",
		"src/**/*.test.ts",
		"tests/*.test.ts",
		"tests/board/!(text-measurement).test.ts",
	],
];

function runGroup(arguments_) {
	const child = spawn(
		process.execPath,
		[runner, ...arguments_, ...forwardedArguments],
		{
			cwd: root,
			env: process.env,
			stdio: ["inherit", "pipe", "pipe"],
		},
	);
	const stdout = [];
	const stderr = [];
	child.stdout.on("data", (chunk) => stdout.push(chunk));
	child.stderr.on("data", (chunk) => stderr.push(chunk));
	return new Promise((resolve) => {
		child.once("close", (code, signal) => {
			resolve({
				exitCode: code ?? (signal ? 1 : 0),
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
			});
		});
		child.once("error", (error) => {
			resolve({ exitCode: 1, stdout: "", stderr: `${error.stack ?? error.message}\n` });
		});
	});
}

const startedAt = performance.now();
const results = await Promise.all(groups.map(runGroup));
const failed = results.some(({ exitCode }) => exitCode !== 0);
const reporterIsDot = !forwardedArguments.some(
	(argument, index) =>
		(argument === "--test-reporter" && forwardedArguments[index + 1] !== "dot") ||
		(argument.startsWith("--test-reporter=") && argument !== "--test-reporter=dot"),
);

if (failed || !reporterIsDot) {
	for (const result of results) {
		process.stdout.write(result.stdout);
		process.stderr.write(result.stderr);
	}
	process.exitCode = failed ? 1 : 0;
} else {
	const packageName = process.env.npm_package_name ?? "@neta-art/cohub";
	const escapedPackageName = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const summaryPattern = new RegExp(
		`^${escapedPackageName} ok (\\d+) tests [\\d.]+s$`,
		"gm",
	);
	let tests = 0;
	let summaries = 0;
	for (const result of results) {
		const matches = [...result.stdout.matchAll(summaryPattern)];
		for (const match of matches) tests += Number(match[1]);
		summaries += matches.length;
		const output = result.stdout.replace(summaryPattern, "").trim();
		if (output) process.stdout.write(`${output}\n`);
		if (result.stderr) process.stderr.write(result.stderr);
	}
	if (summaries !== groups.length) {
		process.stderr.write(`${packageName} failed: grouped test summaries were not reported\n`);
		process.exitCode = 1;
	} else {
		const duration = ((performance.now() - startedAt) / 1000).toFixed(1);
		process.stdout.write(`${packageName} ok ${tests} tests ${duration}s\n`);
	}
}
