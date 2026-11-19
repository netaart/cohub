#!/usr/bin/env node
// Replays the /dev/markdown benchmark in headless Chrome over CDP.
//
//   node scripts/bench-markdown.mjs --url http://127.0.0.1:5173 --runs 5 --cpu 4 --out after.json
//   node scripts/bench-markdown.mjs --compare before.json after.json

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		url: { type: "string", default: "http://127.0.0.1:5173" },
		runs: { type: "string", default: "5" },
		cpu: { type: "string", default: "4" },
		out: { type: "string" },
		compare: { type: "boolean", default: false },
		chrome: {
			type: "string",
			default: process.env.CHROME_PATH ?? "google-chrome",
		},
		only: { type: "string" },
		profile: { type: "boolean", default: false },
	},
});

const CASES = [
	...["reply", "code", "cjk", "long"].map((fixture) => ({
		name: `stream:${fixture}`,
		query: `scenario=stream&fixture=${fixture}&warm`,
	})),
	{ name: "history:cold", query: "scenario=history&count=24" },
	{ name: "history:warm", query: "scenario=history&count=24&warm" },
];

const CDP_METRICS = [
	"TaskDuration",
	"ScriptDuration",
	"LayoutDuration",
	"RecalcStyleDuration",
];

const REPORT = {
	stream: [
		"TaskDuration",
		"ScriptDuration",
		"LayoutDuration",
		"slowFrames",
		"p95FrameMs",
		"elementsDestroyed",
		"elementsCreated",
		"catchUpMs",
	],
	settle: [
		"TaskDuration",
		"elementsDestroyed",
		"heightJumpPx",
		"cls",
		"finalMs",
	],
	history: [
		"TaskDuration",
		"ScriptDuration",
		"LayoutDuration",
		"flashed",
		"heightJumpPx",
		"cls",
		"firstFrameMs",
		"finalMs",
	],
};

const median = (list) => {
	const sorted = [...list].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const round = (value) =>
	typeof value !== "number"
		? value
		: Math.abs(value) >= 100
			? Math.round(value)
			: Number(value.toFixed(value < 1 ? 3 : 1));

async function launchChrome() {
	const userDataDir = mkdtempSync(join(tmpdir(), "bench-markdown-"));
	const chrome = spawn(
		values.chrome,
		[
			"--headless=new",
			"--no-sandbox",
			"--disable-dev-shm-usage",
			"--disable-extensions",
			"--remote-debugging-port=0",
			"--window-size=1280,960",
			`--user-data-dir=${userDataDir}`,
			"about:blank",
		],
		{ stdio: ["ignore", "ignore", "pipe"] },
	);
	const wsUrl = await new Promise((resolve, reject) => {
		let buffer = "";
		chrome.stderr.on("data", (data) => {
			buffer += data;
			const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
			if (match) resolve(match[1]);
		});
		chrome.on("exit", () => reject(new Error(`Chrome exited: ${buffer}`)));
	});
	return {
		port: new URL(wsUrl).port,
		async close() {
			const exited = new Promise((resolve) => chrome.once("exit", resolve));
			chrome.kill();
			await exited;
			rmSync(userDataDir, {
				recursive: true,
				force: true,
				maxRetries: 5,
				retryDelay: 200,
			});
		},
	};
}

function connect(wsUrl) {
	const socket = new WebSocket(wsUrl);
	let id = 0;
	const pending = new Map();
	const listeners = new Set();
	socket.addEventListener("message", (event) => {
		const message = JSON.parse(event.data);
		if (message.id && pending.has(message.id)) {
			const { resolve, reject } = pending.get(message.id);
			pending.delete(message.id);
			if (message.error) reject(new Error(message.error.message));
			else resolve(message.result);
		} else {
			for (const listener of listeners) listener(message);
		}
	});
	return new Promise((resolve) => {
		socket.addEventListener("open", () =>
			resolve({
				send(method, params = {}) {
					id += 1;
					socket.send(JSON.stringify({ id, method, params }));
					return new Promise((resolve, reject) =>
						pending.set(id, { resolve, reject }),
					);
				},
				on(listener) {
					listeners.add(listener);
				},
				close() {
					socket.close();
				},
			}),
		);
	});
}

async function runCase(port, testCase) {
	const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
		method: "PUT",
	}).then((response) => response.json());
	const cdp = await connect(target.webSocketDebuggerUrl);
	try {
		await cdp.send("Performance.enable");
		await cdp.send("Runtime.enable");
		await cdp.send("Emulation.setCPUThrottlingRate", {
			rate: Number(values.cpu),
		});
		await cdp.send("Runtime.addBinding", { name: "benchMark" });

		const readMetrics = async () => {
			const { metrics } = await cdp.send("Performance.getMetrics");
			return Object.fromEntries(
				metrics
					.filter((metric) => CDP_METRICS.includes(metric.name))
					.map((metric) => [metric.name, metric.value * 1000]),
			);
		};

		const phases = [];
		const done = new Promise((resolve, reject) => {
			const timeout = setTimeout(
				() => reject(new Error(`${testCase.name} timed out`)),
				180_000,
			);
			cdp.on(async (message) => {
				if (message.method === "Runtime.exceptionThrown") {
					console.warn(
						`  ! ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`,
					);
				}
				if (message.method !== "Runtime.bindingCalled") return;
				const payload = JSON.parse(message.params.payload);
				phases.push({ phase: payload.phase, cdp: await readMetrics() });
				if (values.profile && phases.length === 1)
					await cdp.send("Profiler.start");
				await cdp.send("Runtime.evaluate", {
					expression: "window.benchAck?.()",
				});
				if (payload.phase === "done") {
					clearTimeout(timeout);
					resolve(payload.result);
				}
			});
		});

		if (values.profile) {
			await cdp.send("Profiler.enable");
			await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
		}
		await cdp.send("Page.navigate", {
			url: `${values.url}/dev/markdown?${testCase.query}`,
		});
		const result = await done;
		if (values.profile) {
			const { profile } = await cdp.send("Profiler.stop");
			printProfile(profile);
		}

		for (let index = 0; index < phases.length - 1; index += 1) {
			const { phase, cdp: start } = phases[index];
			const end = phases[index + 1].cdp;
			if (!result[phase]) continue;
			for (const name of CDP_METRICS)
				result[phase][name] = end[name] - start[name];
		}
		return result;
	} finally {
		cdp.close();
		await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`);
	}
}

function printProfile(profile) {
	const self = new Map();
	const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
	const interval = new Map();
	profile.samples.forEach((id, index) => {
		interval.set(
			id,
			(interval.get(id) ?? 0) + (profile.timeDeltas[index] ?? 0),
		);
	});
	for (const [id, micros] of interval) {
		const { callFrame } = nodes.get(id);
		const file = callFrame.url.split("/").pop()?.split("?")[0] || "";
		const key = `${callFrame.functionName || "(anonymous)"} ${file}:${callFrame.lineNumber + 1}`;
		self.set(key, (self.get(key) ?? 0) + micros / 1000);
	}
	const top = [...self].sort((a, b) => b[1] - a[1]).slice(0, 25);
	for (const [key, ms] of top)
		console.log(`  ${ms.toFixed(1).padStart(8)} ms  ${key}`);
}

function summarize(runs) {
	const summary = {};
	for (const phase of Object.keys(runs[0])) {
		summary[phase] = {};
		for (const key of Object.keys(runs[0][phase])) {
			const list = runs.map((run) => run[phase][key]);
			summary[phase][key] =
				typeof list[0] === "boolean"
					? list.filter(Boolean).length / list.length
					: round(median(list));
		}
	}
	return summary;
}

function printTable(results) {
	for (const [name, phases] of Object.entries(results)) {
		for (const [phase, metrics] of Object.entries(phases)) {
			const keys = REPORT[phase] ?? Object.keys(metrics);
			console.log(
				`${name} ${phase}: ${keys.map((key) => `${key}=${round(metrics[key])}`).join("  ")}`,
			);
		}
	}
}

function compare(beforePath, afterPath) {
	const before = JSON.parse(readFileSync(beforePath, "utf8"));
	const after = JSON.parse(readFileSync(afterPath, "utf8"));
	const rows = [["case", "metric", "before", "after", "change"]];
	for (const [name, phases] of Object.entries(after.results)) {
		for (const [phase, metrics] of Object.entries(phases)) {
			for (const key of REPORT[phase] ?? []) {
				const a = before.results[name]?.[phase]?.[key];
				const b = metrics[key];
				if (typeof a !== "number" || typeof b !== "number") continue;
				const change =
					a === 0
						? b === 0
							? "="
							: "new"
						: `${b <= a ? "" : "+"}${Math.round(((b - a) / a) * 100)}%`;
				rows.push([`${name} ${phase}`, key, round(a), round(b), change]);
			}
		}
	}
	const widths = rows[0].map((_, column) =>
		Math.max(...rows.map((row) => String(row[column]).length)),
	);
	for (const row of rows)
		console.log(
			row.map((cell, column) => String(cell).padEnd(widths[column])).join("  "),
		);
}

if (values.compare) {
	compare(positionals[0], positionals[1]);
} else {
	const chrome = await launchChrome();
	const results = {};
	try {
		const cases = values.only
			? CASES.filter((testCase) => testCase.name.includes(values.only))
			: CASES;
		await runCase(chrome.port, cases[0]);
		for (const testCase of cases) {
			const runs = [];
			for (let run = 0; run < Number(values.runs); run += 1)
				runs.push(await runCase(chrome.port, testCase));
			results[testCase.name] = summarize(runs);
			printTable({ [testCase.name]: results[testCase.name] });
		}
	} finally {
		await chrome.close();
	}
	if (values.out) {
		writeFileSync(
			values.out,
			`${JSON.stringify({ url: values.url, cpu: Number(values.cpu), runs: Number(values.runs), results }, null, 2)}\n`,
		);
	}
}
