<script lang="ts">
import { onMount, tick } from "svelte";
import MarkdownView from "#lib/components/MarkdownView.svelte";
import { page } from "$app/state";
import {
	historyMessages,
	MARKDOWN_FIXTURES,
	type MarkdownFixture,
	uniquify,
} from "./fixtures.ts";
import { createRecorder } from "./recorder.ts";

type BenchWindow = {
	benchMark?: (payload: string) => void;
	benchAck?: () => void;
};

function benchMark(payload: object) {
	const bench = window as BenchWindow;
	return new Promise<void>((resolve) => {
		if (!bench.benchMark) return resolve();
		bench.benchAck = resolve;
		bench.benchMark(JSON.stringify(payload));
	});
}

const params = page.url.searchParams;
const scenario = params.get("scenario") === "history" ? "history" : "stream";
const fixtureName = (params.get("fixture") ?? "reply") as MarkdownFixture;
const chunkSize = Number(params.get("chunk") ?? 256);
const intervalMs = Number(params.get("interval") ?? 40);
const messageCount = Number(params.get("count") ?? 24);
const warm = params.has("warm");

let root = $state<HTMLElement | null>(null);
let streamSource = $state("");
let warmupSource = $state("");
let streaming = $state(true);
let history = $state<string[]>([]);
let output = $state("Running…");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const nextFrame = () =>
	new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

async function settleRecorder(recorder: ReturnType<typeof createRecorder>) {
	await sleep(300);
	await nextFrame();
	recorder.phase();
}

async function warmUp() {
	if (!warm) return;
	warmupSource = "Warm up.";
	const { renderMarkdown } = await import("#lib/markdown.ts");
	await renderMarkdown(uniquify(MARKDOWN_FIXTURES.long, "warmup"));
	await sleep(300);
	warmupSource = "";
}

async function runStream(recorder: ReturnType<typeof createRecorder>) {
	const text = uniquify(MARKDOWN_FIXTURES[fixtureName], "stream");
	await warmUp();
	await settleRecorder(recorder);
	await benchMark({ phase: "stream" });
	const startedAt = performance.now();
	for (let end = chunkSize; ; end += chunkSize) {
		streamSource = text.slice(0, end);
		if (end >= text.length) break;
		await sleep(intervalMs);
	}
	const deliveredAt = performance.now();
	const caughtUpAt = await recorder.textIdle(400);
	await recorder.idle(400);
	const stream = {
		...recorder.phase(),
		deliveryMs: Math.round(deliveredAt - startedAt),
		catchUpMs: Math.round(Math.max(0, caughtUpAt - deliveredAt)),
	};

	const contentBefore = root?.textContent ?? "";
	const heightBefore = root?.getBoundingClientRect().height ?? 0;
	await benchMark({ phase: "settle" });
	const settleStartedAt = performance.now();
	streaming = false;
	await tick();
	await nextFrame();
	const firstFrameText = root?.textContent ?? "";
	const settledAt = await recorder.idle(800);
	const settle = {
		...recorder.phase(),
		finalMs: Math.round(Math.max(0, settledAt - settleStartedAt)),
		textChangedAtFirstFrame: firstFrameText !== contentBefore,
		heightJumpPx: Math.round(
			Math.abs((root?.getBoundingClientRect().height ?? 0) - heightBefore),
		),
	};
	return { stream, settle };
}

async function runHistory(recorder: ReturnType<typeof createRecorder>) {
	await warmUp();
	const messages = historyMessages(messageCount, "history");
	await settleRecorder(recorder);
	await benchMark({ phase: "history" });
	const startedAt = performance.now();
	history = messages;
	await tick();
	await nextFrame();
	const firstFrameAt = performance.now();
	const items = Array.from(
		root?.querySelectorAll<HTMLElement>("[data-bench-message]") ?? [],
	);
	const visibleText = (item: HTMLElement) =>
		(item.textContent ?? "").replace(/\s+/g, "");
	const firstFrame = items.map((item) => ({
		text: visibleText(item),
		height: item.getBoundingClientRect().height,
	}));
	const settledAt = await recorder.idle(800);
	let flashed = 0;
	let heightJumpPx = 0;
	items.forEach((item, index) => {
		if (visibleText(item) !== firstFrame[index].text) flashed += 1;
		heightJumpPx += Math.abs(
			item.getBoundingClientRect().height - firstFrame[index].height,
		);
	});
	return {
		history: {
			...recorder.phase(),
			firstFrameMs: Math.round(firstFrameAt - startedAt),
			finalMs: Math.round(Math.max(0, settledAt - startedAt)),
			messages: items.length,
			flashed,
			heightJumpPx: Math.round(heightJumpPx),
		},
	};
}

onMount(() => {
	const element = root;
	if (!element) return;
	const recorder = createRecorder(element);
	void (async () => {
		await sleep(300);
		const result =
			scenario === "history"
				? await runHistory(recorder)
				: await runStream(recorder);
		recorder.dispose();
		output = JSON.stringify(result, null, 2);
		await benchMark({ phase: "done", result });
	})();
	return () => recorder.dispose();
});
</script>

<main class="bench">
	<div class="bench-root" bind:this={root}>
		{#if scenario === "stream"}
			<MarkdownView source={streamSource} isStreaming={streaming} variant="chat" />
		{:else}
			{#each history as source, index (index)}
				<div data-bench-message><MarkdownView {source} variant="chat" /></div>
			{/each}
		{/if}
	</div>
	{#if warmupSource}
		<div hidden><MarkdownView source={warmupSource} variant="chat" /></div>
	{/if}
	<pre class="bench-output">{output}</pre>
</main>

<style>
.bench {
	display: grid;
	grid-template-columns: 720px minmax(0, 1fr);
	gap: 2rem;
	padding: 2rem;
	align-items: start;
}

.bench-root {
	display: grid;
	min-width: 0;
	gap: 1.5rem;
}

.bench-output {
	position: sticky;
	top: 2rem;
	font-size: 12px;
	white-space: pre-wrap;
}
</style>
