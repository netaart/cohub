import type { BoardScriptInputLog } from "@neta-art/cohub/board";
import type { BoardStage } from "@neta-art/cohub/board/stage";
import { formatBoardTime } from "#lib/board/animation-timeline.ts";

export type BoardInputRecording = {
	log: BoardScriptInputLog;
	duration: number;
	full: boolean;
};

export const formatRecordingTime = (ms: number) =>
	formatBoardTime(Math.floor(Math.max(0, ms) / 1000) * 1000, 1000);

export function createBoardInputRecorder(input: {
	stage: () => BoardStage | null;
	onStop: (recording: BoardInputRecording) => void;
}) {
	let available = $state(false);
	let startedAt = $state<number | null>(null);
	let session: { stop(): BoardScriptInputLog } | null = null;

	$effect(() => {
		const senses = input.stage()?.senses;
		if (!senses) {
			available = false;
			return;
		}
		const read = () => {
			available = senses.wanted.some((sense) => sense !== "camera");
		};
		read();
		return senses.subscribe(read);
	});

	function stop(full = false) {
		if (!session || startedAt === null) return;
		const log = session.stop();
		const duration = Date.now() - startedAt;
		session = null;
		startedAt = null;
		input.onStop({ log, duration, full });
	}

	return {
		get available() {
			return available;
		},
		get startedAt() {
			return startedAt;
		},
		toggle() {
			if (session) return stop();
			const stage = input.stage();
			if (!stage) return;
			session = stage.recordInputs(() => stop(true));
			startedAt = Date.now();
		},
		dispose() {
			session?.stop();
			session = null;
		},
	};
}

export type BoardInputRecorder = ReturnType<typeof createBoardInputRecorder>;
