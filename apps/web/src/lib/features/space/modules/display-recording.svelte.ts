import type { DisplayInfo, DisplayRecordingMeta } from "@neta-art/cohub";
import { untrack } from "svelte";
import { sdk } from "$lib/sdk";
import { loadRecordings } from "./display-replay";

const SAVED_MS = 8_000;
// sandboxd closes the files a moment after the snapshot says the recording ended.
const FINISH_MS = 600;

export function createDisplayRecording(options: {
	spaceId: () => string;
	displayId: () => string;
	display: () => DisplayInfo | null;
	onError: () => void;
}) {
	const recording = $derived(options.display()?.recording ?? null);
	let intent = $state<"start" | "stop" | null>(null);
	let startedAt = $state(0);
	let clock = $state(Date.now());
	let saved = $state<DisplayRecordingMeta | null>(null);
	let ended = $state("");
	let savedTimer: ReturnType<typeof setTimeout> | null = null;
	const running = $derived(
		intent ? intent === "start" : Boolean(recording?.id),
	);

	$effect(() => {
		if (!running) return;
		const timer = setInterval(() => (clock = Date.now()), 1_000);
		return () => clearInterval(timer);
	});

	$effect(() => {
		if (intent === "start" && recording?.id) intent = null;
		if (intent === "stop" && !recording?.id) intent = null;
	});

	let last: string | null = null;
	$effect(() => {
		const id = recording?.id ?? null;
		untrack(() => {
			if (last && last !== id) announce(last);
			last = id;
		});
	});

	function announce(id: string) {
		setTimeout(() => {
			void loadRecordings(options.spaceId(), (list, fresh) => {
				ended = id;
				const found =
					fresh && list.find((item) => item.id === id && item.endedAt);
				if (!found) return;
				saved = found;
				if (savedTimer) clearTimeout(savedTimer);
				savedTimer = setTimeout(() => (saved = null), SAVED_MS);
			}).catch(() => undefined);
		}, FINISH_MS);
	}

	return {
		get running() {
			return running;
		},
		get paused() {
			return recording?.paused === true;
		},
		get auto() {
			return recording?.auto === true;
		},
		get elapsed() {
			return clock - (recording?.since ?? startedAt);
		},
		get saved() {
			return saved;
		},
		get ended() {
			return ended;
		},
		dismissSaved() {
			saved = null;
		},
		async toggle(auto = false) {
			const displays = sdk.space(options.spaceId()).displays;
			const stopping = auto ? recording?.auto === true : running;
			if (!auto) intent = stopping ? "stop" : "start";
			if (!stopping && !auto) clock = startedAt = Date.now();
			try {
				if (stopping)
					await displays.stopRecording(
						options.displayId(),
						auto ? { auto } : {},
					);
				else await displays.record(options.displayId(), auto ? { auto } : {});
			} catch {
				intent = null;
				options.onError();
			}
		},
		dispose() {
			if (savedTimer) clearTimeout(savedTimer);
		},
	};
}
