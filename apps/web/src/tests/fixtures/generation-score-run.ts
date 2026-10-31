import type { TaskRunRecord } from "@neta-art/cohub";

/** A hand-written score a run returned. */
export const returnedScore = "X:1\nT:returned\nK:C\nc16|\n";

/** A hand-written score sent with the request. */
export const requestedScore = "X:1\nT:requested\nK:C\nd16|\n";

export const AUDIO = {
	type: "audio",
	source: { type: "url", url: "https://media.example.test/song.mp3" },
};

export type ScoreRunOptions = {
	id?: string;
	status?: TaskRunRecord["status"];
	model?: string;
	requestScore?: string;
	returnScore?: string;
	content?: Record<string, unknown>[];
	output?: Record<string, unknown>[];
	parameters?: Record<string, unknown>;
};

/** A completed generation task run shaped like `GET /tasks/:id`. */
export function scoreRun(options: ScoreRunOptions = {}): TaskRunRecord {
	const model = options.model ?? "song2";
	const content = options.content ?? [
		...(options.requestScore === undefined
			? []
			: [
					{
						type: "text",
						text: options.requestScore,
						meta: { role: "abc" },
					},
				]),
	];
	const output = options.output ?? [
		AUDIO,
		...(options.returnScore === undefined
			? []
			: [
					{
						type: "text",
						text: options.returnScore,
						meta: { role: "abc" },
					},
				]),
	];
	return {
		id: options.id ?? "run-score",
		jobId: "job-score",
		cronJobId: null,
		taskType: "generation",
		status: options.status ?? "completed",
		payload: {
			type: "generation",
			userId: "user-1",
			spaceId: "space-1",
			data: {
				model,
				content,
				parameters: options.parameters ?? { return_abc: true },
			},
		},
		result: { model, output },
		errorMessage: null,
		attemptCount: 0,
		spaceId: "space-1",
		sessionId: null,
		turnId: null,
		userUuid: "user-1",
		scheduledAt: null,
		startedAt: "2026-01-01T00:00:00.000Z",
		finishedAt: "2026-01-01T00:00:00.000Z",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}
