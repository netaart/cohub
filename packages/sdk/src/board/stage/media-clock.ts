import { Texture, VideoSource } from "pixi.js";
import { type BoardMediaState, boardMediaRate } from "../model/media-spans.js";
import { type BoardAssetSource, resolveBoardMediaUrl } from "../model/media-playback.js";

type FrameVideo = HTMLVideoElement & {
	requestVideoFrameCallback?: (callback: () => void) => number;
	cancelVideoFrameCallback?: (handle: number) => void;
};

type Sample = { at: number; time: number; rate: number };

type Entry = {
	id: string;
	kind: "video" | "audio";
	src: string;
	element: HTMLMediaElement;
	texture: Texture | null;
	ready: boolean;
	failed: boolean;
	pendingSeek: number | null;
	loop: boolean;
	frameHandle: number;
	idleSince: number | null;
	dispose: () => void;
};

export type BoardMediaLoop = { id: string; src: string };

export type BoardMediaClock = {
	/** Returns how far the leading audio is ahead of `now`, in timeline milliseconds. */
	sync(input: { media: readonly BoardMediaState[]; loops: readonly BoardMediaLoop[]; now: number; scrubbing: boolean; onScreen: (id: string) => boolean }): number | null;
	texture(id: string): Texture | null;
	readonly blocked: boolean;
	readonly muted: boolean;
	setMuted(muted: boolean): void;
	unlock(): void;
	subscribe(listener: () => void): () => void;
	pause(): void;
	destroy(): void;
};

const SEEK_DRIFT_S = 0.25;
const HOLD_DRIFT_S = 1 / 60;
const NUDGE = 0.05;
const RELEASE_MS = 2500;
const WATCHDOG_MS = 300;
const HAVE_FUTURE_DATA = 3;

export function createBoardMediaClock(options: {
	source: BoardAssetSource;
	limit: number;
	onFrame: (id: string, changed: boolean) => void;
}): BoardMediaClock {
	const entries = new Map<string, Entry>();
	const samples = new Map<string, Sample>();
	const listeners = new Set<() => void>();
	let blocked = false;
	let muted = false;
	let destroyed = false;
	let syncs = 0;
	let watchdog: ReturnType<typeof setTimeout> | null = null;

	function notify() {
		for (const listener of listeners) listener();
	}

	function setBlocked(value: boolean) {
		if (blocked === value) return;
		blocked = value;
		notify();
	}

	function silent(entry: Entry): boolean {
		return entry.loop || muted || blocked || entry.element.volume === 0;
	}

	function seek(entry: Entry, seconds: number) {
		const { element } = entry;
		if (element.seeking || element.readyState < 1) {
			entry.pendingSeek = seconds;
			return;
		}
		entry.pendingSeek = null;
		element.currentTime = Math.max(0, seconds);
	}

	function watchFrames(entry: Entry) {
		const video = entry.element as FrameVideo;
		if (!video.requestVideoFrameCallback || entry.frameHandle) return;
		const next = () => {
			entry.frameHandle = 0;
			if (destroyed || !entries.has(entry.id)) return;
			presented(entry);
			if (!video.paused) entry.frameHandle = video.requestVideoFrameCallback?.(next) ?? 0;
		};
		entry.frameHandle = video.requestVideoFrameCallback(next);
	}

	function presented(entry: Entry) {
		entry.texture?.source.update();
		const first = !entry.ready && Boolean(entry.texture);
		if (first) entry.ready = true;
		options.onFrame(entry.id, first);
	}

	function create(state: BoardMediaState): Entry {
		const element = document.createElement(state.kind) as HTMLMediaElement;
		element.preload = "auto";
		element.muted = true;
		if (element instanceof HTMLVideoElement) {
			element.playsInline = true;
			element.disablePictureInPicture = true;
		}
		const entry: Entry = {
			id: state.id,
			kind: state.kind,
			src: state.src,
			element,
			texture: null,
			ready: false,
			failed: false,
			pendingSeek: null,
			loop: false,
			frameHandle: 0,
			idleSince: null,
			dispose: () => {},
		};
		const onSeeked = () => {
			if (entry.pendingSeek !== null) return seek(entry, entry.pendingSeek);
			if (entry.kind === "video" && element.paused) presented(entry);
		};
		const onMetadata = () => {
			if (entry.pendingSeek !== null) seek(entry, entry.pendingSeek);
		};
		const onPlay = () => {
			if (entry.kind === "video") watchFrames(entry);
		};
		const onError = () => {
			entry.failed = true;
			if (entry.ready) options.onFrame(entry.id, true);
			entry.ready = false;
		};
		element.addEventListener("seeked", onSeeked);
		element.addEventListener("loadedmetadata", onMetadata);
		element.addEventListener("play", onPlay);
		element.addEventListener("error", onError);
		entry.dispose = () => {
			element.removeEventListener("seeked", onSeeked);
			element.removeEventListener("loadedmetadata", onMetadata);
			element.removeEventListener("play", onPlay);
			element.removeEventListener("error", onError);
			if (entry.frameHandle) (element as FrameVideo).cancelVideoFrameCallback?.(entry.frameHandle);
			element.pause();
			if (entry.texture) entry.texture.destroy(true);
			else {
				element.removeAttribute("src");
				element.load();
			}
		};
		void resolveBoardMediaUrl(state.src, options.source, "playback").then((url) => {
			if (destroyed || entries.get(entry.id) !== entry) return;
			if (!url) {
				entry.failed = true;
				return;
			}
			if (/^https?:/i.test(url) && entry.kind === "video") element.crossOrigin = "anonymous";
			element.src = url;
			if (entry.kind === "video") {
				entry.texture = new Texture({ source: new VideoSource({ resource: element as HTMLVideoElement, autoPlay: false, autoLoad: true }) });
				element.addEventListener("loadeddata", () => presented(entry), { once: true });
			}
			options.onFrame(entry.id, true);
		});
		return entry;
	}

	function release(id: string) {
		const entry = entries.get(id);
		if (!entry) return;
		entries.delete(id);
		entry.dispose();
		if (entry.ready) options.onFrame(id, true);
	}

	function play(entry: Entry) {
		void entry.element.play().catch((error: unknown) => {
			if (!(error instanceof DOMException) || error.name !== "NotAllowedError" || entry.element.muted) return;
			setBlocked(true);
			entry.element.muted = true;
			void entry.element.play().catch(() => {});
		});
	}

	function loop(entry: Entry) {
		const { element } = entry;
		entry.loop = element.loop = element.muted = true;
		if (element.playbackRate !== 1) element.playbackRate = 1;
		if (element.paused) play(entry);
	}

	function drive(entry: Entry, state: BoardMediaState, rate: number, leads: boolean): number | null {
		const { element } = entry;
		if (entry.loop) entry.loop = element.loop = false;
		const target = state.time / 1000;
		const volume = Math.min(1, Math.max(0, state.volume));
		if (Math.abs(element.volume - volume) > 0.001) element.volume = volume;
		if (rate <= 0) {
			if (!element.paused) element.pause();
			if (entry.kind === "video" && Math.abs((entry.pendingSeek ?? element.currentTime) - target) > HOLD_DRIFT_S) seek(entry, target);
			return null;
		}
		if (element.muted !== silent(entry)) element.muted = silent(entry);
		const drift = target - element.currentTime;
		if (element.paused) {
			if (Math.abs(drift) > HOLD_DRIFT_S) seek(entry, target);
			element.playbackRate = rate;
			play(entry);
			return null;
		}
		if (Math.abs(drift) > SEEK_DRIFT_S) {
			seek(entry, target + 0.05 * rate);
			return null;
		}
		if (leads && !element.seeking && entry.pendingSeek === null && element.readyState >= HAVE_FUTURE_DATA) {
			if (Math.abs(element.playbackRate - rate) > 0.001) element.playbackRate = rate;
			return (-drift * 1000) / rate;
		}
		const nudged = rate * (1 + Math.min(NUDGE, Math.max(-NUDGE, drift)));
		if (Math.abs(element.playbackRate - nudged) > 0.004) element.playbackRate = nudged;
		return null;
	}

	function stopTimed() {
		for (const entry of entries.values()) if (!entry.loop && !entry.element.paused) entry.element.pause();
		samples.clear();
	}

	function stopAll() {
		for (const entry of entries.values()) if (!entry.element.paused) entry.element.pause();
		samples.clear();
	}

	function hide() {
		if (document.visibilityState === "hidden") stopTimed();
	}
	document.addEventListener("visibilitychange", hide);

	// A long task delays this timer as much as frames; only a frame without a sync means they stopped.
	function armWatchdog() {
		if (watchdog !== null) clearTimeout(watchdog);
		const seen = syncs;
		watchdog = setTimeout(() => {
			watchdog = null;
			requestAnimationFrame(() => {
				if (syncs === seen && !destroyed) stopTimed();
			});
		}, WATCHDOG_MS);
	}

	return {
		sync({ media, loops, now, scrubbing, onScreen }) {
			if (destroyed) return null;
			syncs += 1;
			const wanted: Array<{ state: BoardMediaState; rate: number; rank: number; loop?: true }> = [];
			const seen = new Set<string>();
			for (const state of media) {
				seen.add(state.id);
				const previous = samples.get(state.id);
				const rate = previous ? boardMediaRate(previous, { at: now, time: state.time }) : 0;
				samples.set(state.id, { at: now, time: state.time, rate });
				const steady = rate > 0 && previous !== undefined && previous.rate > 0 && Math.abs(rate - previous.rate) <= 0.1 * rate;
				const advancing = !scrubbing && state.shown && (steady || (rate > 0 && entries.get(state.id)?.element.paused === false));
				const known = entries.get(state.id);
				if (known?.failed && known.src === state.src) continue;
				const visible = state.kind === "video" && state.shown && onScreen(state.id);
				if (advancing || visible)
					wanted.push({ state, rate: advancing ? rate : 0, rank: state.kind === "audio" ? 0 : visible ? (advancing ? 1 : 2) : 3 });
			}
			for (const { id, src } of loops) {
				if (seen.has(id)) continue;
				seen.add(id);
				const known = entries.get(id);
				if (!(known?.failed && known.src === src))
					wanted.push({ state: { id, kind: "video", src, time: 0, volume: 0, shown: true }, rate: 0, rank: 2.5, loop: true });
			}
			for (const id of samples.keys()) if (!seen.has(id)) samples.delete(id);
			wanted.sort((a, b) => a.rank - b.rank);
			const kept = new Set<string>();
			let playing = false;
			let skew: number | null = null;
			for (const { state, rate, loop: looping } of wanted.slice(0, options.limit)) {
				let entry = entries.get(state.id);
				if (entry && (entry.src !== state.src || entry.kind !== state.kind)) {
					release(state.id);
					entry = undefined;
				}
				entry ??= entries.set(state.id, create(state)).get(state.id) as Entry;
				entry.idleSince = null;
				kept.add(state.id);
				if (!entry.element.src) continue;
				if (looping) {
					loop(entry);
					continue;
				}
				const lead = drive(entry, state, rate, skew === null && entry.kind === "audio");
				skew ??= lead;
				playing ||= rate > 0;
			}
			for (const [id, entry] of entries) {
				if (kept.has(id)) continue;
				if (!entry.element.paused) entry.element.pause();
				entry.idleSince ??= now;
				if (!seen.has(id) || (now - entry.idleSince > RELEASE_MS && !entry.failed)) release(id);
			}
			if (playing) armWatchdog();
			return skew;
		},
		texture(id) {
			const entry = entries.get(id);
			return entry?.ready && !entry.failed ? entry.texture : null;
		},
		get blocked() {
			return blocked;
		},
		get muted() {
			return muted;
		},
		setMuted(value) {
			if (muted === value) return;
			muted = value;
			for (const entry of entries.values()) if (!entry.loop) entry.element.muted = silent(entry);
			notify();
		},
		unlock() {
			if (!blocked) return;
			setBlocked(false);
			for (const entry of entries.values()) {
				if (entry.loop || entry.element.paused) continue;
				entry.element.muted = silent(entry);
				play(entry);
			}
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		pause: stopAll,
		destroy() {
			destroyed = true;
			document.removeEventListener("visibilitychange", hide);
			if (watchdog !== null) clearTimeout(watchdog);
			for (const id of [...entries.keys()]) release(id);
			listeners.clear();
		},
	};
}
