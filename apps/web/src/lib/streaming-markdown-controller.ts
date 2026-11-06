import type { StreamingMarkdownRender } from "$lib/markdown";

type StreamingMarkdownSnapshot = StreamingMarkdownRender & { source: string };

type StreamingMarkdownSubscriber = (
	snapshot: StreamingMarkdownSnapshot,
) => void;

// Reveal speed scales with the backlog and has no cap, so the display trails the stream by about this long.
const REVEAL_LAG_MS = 120;
const MIN_REVEAL_CHARS_PER_MS = 0.08;
const FIRST_FRAME_MS = 1000 / 60;
const WORD_SNAP_CHARS = 16;

function isWordBoundary(value: string) {
	return /[\s.,!?;:，。！？；：、）\]}"'`»]/u.test(value);
}

function revealLength(source: string, from: number, elapsedMs: number) {
	const backlog = source.length - from;
	const step = Math.ceil(
		Math.max(MIN_REVEAL_CHARS_PER_MS, backlog / REVEAL_LAG_MS) * elapsedMs,
	);
	const hardTarget = Math.min(source.length, from + step);
	if (hardTarget >= source.length) return source.length;

	let cursor = hardTarget;
	while (cursor < source.length && cursor - hardTarget < WORD_SNAP_CHARS) {
		if (isWordBoundary(source[cursor] ?? "")) return cursor + 1;
		cursor += 1;
	}
	return hardTarget;
}

function createEmptySnapshot(): StreamingMarkdownSnapshot {
	return { stableSources: [], stableBlocks: [], tailHtml: "", source: "" };
}

// One reveal and commit per display frame. A render in flight holds the loop
// (backpressure); the frame after it reveals everything that piled up meanwhile.
export class StreamingMarkdownController {
	#targetSource = "";
	#displayedSource = "";
	#snapshot = createEmptySnapshot();
	#subscribers = new Set<StreamingMarkdownSubscriber>();
	#frame = 0;
	#lastFrameAt = 0;
	#rendering = false;
	#disposed = false;

	subscribe(subscriber: StreamingMarkdownSubscriber) {
		this.#subscribers.add(subscriber);
		subscriber(this.#snapshot);
		return () => this.#subscribers.delete(subscriber);
	}

	setTarget(source: string) {
		if (this.#disposed) return;
		const nextSource = source.trimStart();
		if (nextSource === this.#targetSource) return;
		if (!nextSource.startsWith(this.#displayedSource)) {
			this.#displayedSource = "";
			this.#publish(createEmptySnapshot());
		}
		this.#targetSource = nextSource;
		this.#scheduleFrame();
	}

	dispose() {
		this.#disposed = true;
		if (this.#frame) cancelAnimationFrame(this.#frame);
		this.#frame = 0;
		this.#subscribers.clear();
	}

	#publish(snapshot: StreamingMarkdownSnapshot) {
		this.#snapshot = snapshot;
		for (const subscriber of this.#subscribers) subscriber(snapshot);
	}

	#scheduleFrame() {
		if (this.#frame || this.#rendering || this.#disposed) return;
		this.#frame = requestAnimationFrame((now) => this.#onFrame(now));
	}

	#onFrame(now: number) {
		this.#frame = 0;
		if (this.#disposed) return;
		const elapsed = this.#lastFrameAt
			? now - this.#lastFrameAt
			: FIRST_FRAME_MS;
		this.#lastFrameAt = now;
		const target = this.#targetSource;
		this.#displayedSource = target.startsWith(this.#displayedSource)
			? target.slice(
					0,
					revealLength(target, this.#displayedSource.length, elapsed),
				)
			: target;
		if (this.#displayedSource === this.#snapshot.source) {
			// Idle until the next target, so a stalled stream does not dump its next chunk at once.
			this.#lastFrameAt = 0;
			return;
		}
		void this.#commit(this.#displayedSource);
	}

	async #commit(source: string) {
		this.#rendering = true;
		try {
			if (!source.trim()) {
				this.#publish({ ...createEmptySnapshot(), source });
				return;
			}
			const { renderStreamingMarkdownSplit } = await import("$lib/markdown");
			const render = await renderStreamingMarkdownSplit(source, this.#snapshot);
			if (!this.#disposed && source === this.#displayedSource)
				this.#publish({ ...render, source });
		} catch {
			if (!this.#disposed && source === this.#displayedSource)
				this.#publish({ ...createEmptySnapshot(), source });
		} finally {
			this.#rendering = false;
			this.#scheduleFrame();
		}
	}
}
