export type PhaseMetrics = {
	durationMs: number;
	elementsDestroyed: number;
	elementsCreated: number;
	textEdits: number;
	longFrames: number;
	blockingMs: number;
	slowFrames: number;
	p95FrameMs: number;
	cls: number;
};

type Counters = Omit<PhaseMetrics, "durationMs" | "p95FrameMs"> & {
	frames: number[];
};

function emptyCounters(): Counters {
	return {
		elementsDestroyed: 0,
		elementsCreated: 0,
		textEdits: 0,
		longFrames: 0,
		blockingMs: 0,
		slowFrames: 0,
		cls: 0,
		frames: [],
	};
}

function elementCount(node: Node) {
	if (!(node instanceof Element) || node.matches('[data-markdown-fade="text"]'))
		return 0;
	return node.getElementsByTagName("*").length + 1;
}

function percentile(values: number[], p: number) {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

export function createRecorder(root: HTMLElement) {
	let counters = emptyCounters();
	let phaseStart = performance.now();
	let lastMutationAt = performance.now();
	let frame = 0;
	let lastFrameAt = 0;

	const onMutations = (records: MutationRecord[]) => {
		if (records.length === 0) return;
		lastMutationAt = performance.now();
		for (const record of records) {
			if (record.type === "characterData") {
				counters.textEdits += 1;
				continue;
			}
			for (const node of record.removedNodes)
				counters.elementsDestroyed += elementCount(node);
			for (const node of record.addedNodes)
				counters.elementsCreated += elementCount(node);
		}
	};
	const mutations = new MutationObserver(onMutations);
	mutations.observe(root, {
		subtree: true,
		childList: true,
		characterData: true,
	});

	const observers: {
		observer: PerformanceObserver;
		onEntry: (entry: PerformanceEntry) => void;
	}[] = [];
	function observe(type: string, onEntry: (entry: PerformanceEntry) => void) {
		if (!PerformanceObserver.supportedEntryTypes.includes(type)) return;
		const observer = new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) onEntry(entry);
		});
		observer.observe({ type, buffered: false });
		observers.push({ observer, onEntry });
	}
	observe("long-animation-frame", (entry) => {
		counters.longFrames += 1;
		counters.blockingMs +=
			(entry as PerformanceEntry & { blockingDuration?: number })
				.blockingDuration ?? 0;
	});
	observe("layout-shift", (entry) => {
		const shift = entry as PerformanceEntry & {
			value: number;
			hadRecentInput: boolean;
		};
		if (!shift.hadRecentInput) counters.cls += shift.value;
	});

	const tickFrame = (now: number) => {
		if (lastFrameAt) {
			const interval = now - lastFrameAt;
			counters.frames.push(interval);
			if (interval > 25) counters.slowFrames += 1;
		}
		lastFrameAt = now;
		frame = requestAnimationFrame(tickFrame);
	};
	frame = requestAnimationFrame(tickFrame);

	return {
		phase(): PhaseMetrics {
			for (const { observer, onEntry } of observers) {
				for (const entry of observer.takeRecords()) onEntry(entry);
			}
			onMutations(mutations.takeRecords());
			const { frames, ...rest } = counters;
			const metrics = {
				...rest,
				durationMs: performance.now() - phaseStart,
				p95FrameMs: percentile(frames, 0.95),
				cls: Number(rest.cls.toFixed(4)),
				blockingMs: Math.round(rest.blockingMs),
			};
			counters = emptyCounters();
			phaseStart = performance.now();
			return metrics;
		},
		async idle(quietMs: number, timeoutMs = 20_000) {
			const startedAt = performance.now();
			while (performance.now() - startedAt < timeoutMs) {
				const quietFor = performance.now() - lastMutationAt;
				if (quietFor >= quietMs) return lastMutationAt;
				await new Promise((resolve) => setTimeout(resolve, quietMs - quietFor));
			}
			return lastMutationAt;
		},
		async textIdle(quietMs: number, timeoutMs = 20_000) {
			const startedAt = performance.now();
			let text = root.textContent ?? "";
			let changedAt = startedAt;
			while (performance.now() - startedAt < timeoutMs) {
				await new Promise((resolve) => setTimeout(resolve, 16));
				const next = root.textContent ?? "";
				if (next !== text) {
					text = next;
					changedAt = performance.now();
				} else if (performance.now() - changedAt >= quietMs) break;
			}
			return changedAt;
		},
		dispose() {
			cancelAnimationFrame(frame);
			mutations.disconnect();
			for (const { observer } of observers) observer.disconnect();
		},
	};
}
