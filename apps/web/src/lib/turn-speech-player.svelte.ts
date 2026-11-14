import {
	readTurnSpeech,
	type SessionTurnRecord,
	type TurnSpeech,
} from "@cohub/protocol";

export type TurnSpeechPhase =
	| "idle"
	| "loading"
	| "playing"
	| "paused"
	| "error";

export type TurnSpeechSource = {
	speak(spaceId: string, turn: SessionTurnRecord): Promise<TurnSpeech>;
	handleError?(error: unknown): boolean;
};

// Played inside the click so mobile browsers let this element play later without a gesture.
const SILENCE =
	"data:audio/wav;base64,UklGRnQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YVAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==";

const RECHECK_MS = 12_000;

function awaitingRetry(speech: TurnSpeech): TurnSpeech {
	return {
		...speech,
		segments: speech.segments.map((segment) =>
			segment.status === "failed" ? { ...segment, status: "pending" } : segment,
		),
	};
}

export class TurnSpeechPlayer {
	turnId = $state<string | null>(null);
	phase = $state<TurnSpeechPhase>("idle");
	readonly #source: TurnSpeechSource;
	#target: { spaceId: string; turn: SessionTurnRecord } | null = null;
	#voice: string | null = null;
	#speech: TurnSpeech | null = null;
	#index = 0;
	#run = 0;
	#recheck: ReturnType<typeof setTimeout> | undefined;
	#audio: HTMLAudioElement | null = null;
	#preload: HTMLAudioElement | null = null;

	constructor(source: TurnSpeechSource) {
		this.#source = source;
	}

	phaseOf(turnId: string): TurnSpeechPhase {
		return this.turnId === turnId ? this.phase : "idle";
	}

	toggle(spaceId: string, voice: string, turn: SessionTurnRecord) {
		if (this.turnId === turn.id && this.phase !== "error") {
			if (this.phase === "playing") {
				this.phase = "paused";
				this.#audio?.pause();
			} else if (this.phase === "paused") {
				this.phase = "playing";
				void this.#audio?.play().catch(() => this.#fail());
			} else this.stop();
			return;
		}
		this.stop();
		this.turnId = turn.id;
		this.phase = "loading";
		this.#target = { spaceId, turn };
		this.#voice = voice;
		const audio = this.#element();
		audio.src = SILENCE;
		void audio.play().catch(() => undefined);

		const stored = readTurnSpeech(turn.meta, voice);
		const complete = stored?.segments.every(
			(segment) => segment.status !== "failed",
		);
		this.#speech = stored && !complete ? awaitingRetry(stored) : stored;
		if (!complete) void this.#request(this.#run);
		this.#advance();
	}

	sync(turn: SessionTurnRecord) {
		if (turn.id !== this.turnId || !this.#voice) return;
		const speech = readTurnSpeech(turn.meta, this.#voice);
		if (speech) this.#update(speech);
	}

	stop() {
		this.#run += 1;
		clearTimeout(this.#recheck);
		this.#audio?.pause();
		this.#preload = null;
		this.#target = null;
		this.#voice = null;
		this.#speech = null;
		this.#index = 0;
		this.turnId = null;
		this.phase = "idle";
	}

	async #request(run: number, quiet = false) {
		const target = this.#target;
		if (!target) return;
		try {
			const speech = await this.#source.speak(target.spaceId, target.turn);
			if (run === this.#run) this.#update(speech);
		} catch (error) {
			if (run !== this.#run) return;
			if (this.#source.handleError?.(error)) this.stop();
			else if (quiet) this.#scheduleRecheck();
			else this.#fail();
		}
	}

	#update(speech: TurnSpeech) {
		this.#voice = speech.voice;
		const current = this.#speech;
		// Responses and realtime updates race: a settled segment never returns to pending.
		this.#speech =
			current?.voice === speech.voice
				? {
						...speech,
						segments: speech.segments.map((segment, index) => {
							const known = current.segments[index];
							return segment.status === "pending" &&
								known?.taskId === segment.taskId &&
								known.status !== "pending"
								? known
								: segment;
						}),
					}
				: speech;
		if (this.phase === "loading") this.#advance();
	}

	#advance() {
		const speech = this.#speech;
		if (!speech) return;
		const segment = speech.segments[this.#index];
		if (!segment) return this.stop();
		if (segment.status === "pending") {
			this.phase = "loading";
			this.#scheduleRecheck();
			return;
		}
		if (segment.status === "failed" || !segment.url) return this.#fail();
		const audio = this.#element();
		audio.src = segment.url;
		this.phase = "playing";
		void audio.play().catch((error: unknown) => {
			if (!(error instanceof DOMException && error.name === "AbortError"))
				this.#fail();
		});
		const next = speech.segments[this.#index + 1];
		if (next?.url) {
			this.#preload = new Audio();
			this.#preload.preload = "auto";
			this.#preload.src = next.url;
		}
	}

	/** Realtime normally settles a segment; ask again while it stays quiet. */
	#scheduleRecheck() {
		clearTimeout(this.#recheck);
		const run = this.#run;
		this.#recheck = setTimeout(() => {
			if (run === this.#run && this.phase === "loading")
				void this.#request(run, true);
		}, RECHECK_MS);
	}

	#fail() {
		clearTimeout(this.#recheck);
		this.#audio?.pause();
		this.phase = "error";
	}

	#element() {
		if (this.#audio) return this.#audio;
		const audio = new Audio();
		audio.preload = "auto";
		audio.addEventListener("ended", () => {
			if (!this.turnId || audio.src === SILENCE) return;
			this.#index += 1;
			this.#advance();
		});
		audio.addEventListener("pause", () => {
			if (this.phase === "playing" && !audio.ended) this.phase = "paused";
		});
		audio.addEventListener("play", () => {
			if (this.phase === "paused") this.phase = "playing";
		});
		audio.addEventListener("error", () => {
			if (this.phase === "playing") this.#fail();
		});
		this.#audio = audio;
		return audio;
	}
}
