import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionTurnRecord, TurnSpeech } from "@cohub/protocol";

(globalThis as unknown as { $state: <T>(value: T) => T }).$state = <T>(
	value: T,
) => value;

const played: string[] = [];

class FakeAudio {
	src = "";
	preload = "";
	ended = false;
	addEventListener() {}
	play() {
		played.push(this.src);
		return Promise.resolve();
	}
	pause() {}
}
(globalThis as unknown as { Audio: typeof FakeAudio }).Audio = FakeAudio;

const { TurnSpeechPlayer } = await import(
	"../lib/turn-speech-player.svelte.ts"
);

function turn(speech?: TurnSpeech): SessionTurnRecord {
	return {
		id: "turn-1",
		sessionId: "session-1",
		meta: speech ? { speech: { [speech.voice]: speech.segments } } : null,
	} as SessionTurnRecord;
}

test("stored audio plays only for its own voice", async () => {
	let requests = 0;
	const player = new TurnSpeechPlayer({
		speak: async () => {
			requests += 1;
			return { voice: "new", segments: [{ taskId: "a", status: "pending" }] };
		},
	});
	const stored: TurnSpeech = {
		voice: "old",
		segments: [{ taskId: "a", status: "completed", url: "https://old" }],
	};
	try {
		player.toggle("space-1", "old", turn(stored));
		assert.equal(player.phase, "playing");
		assert.equal(requests, 0);
		player.stop();

		played.length = 0;
		player.toggle("space-1", "new", turn(stored));
		await Promise.resolve();
		assert.equal(requests, 1);
		assert.equal(player.phase, "loading");
		assert.ok(!played.includes("https://old"));
	} finally {
		player.stop();
	}
});
