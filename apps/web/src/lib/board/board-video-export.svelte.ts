import type { SpaceRecord } from "@neta-art/cohub";
import type { BoardExportRegion } from "@neta-art/cohub/board";
import { sdk } from "$lib/sdk";
import {
	cacheSpaceRecordSoon,
	getCachedSpaceRecord,
} from "$lib/stores/space-record-cache";

const FRAME_MS = 40;
const POLL_MS = 1500;

export type BoardVideoExportRequest = {
	animationId: string;
	duration: number;
	region: BoardExportRegion;
	camera?: { width: number; height: number };
	scale: number;
	inputs?: string;
};

export type BoardVideoExportState =
	| { status: "running"; progress: number | null }
	| { status: "done"; path: string }
	| { status: "failed"; message: string };

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function outputPath(boardPath: string, animationName: string): string {
	const slash = boardPath.lastIndexOf("/");
	const dir = slash >= 0 ? boardPath.slice(0, slash + 1) : "";
	const base =
		`${boardPath.slice(slash + 1).replace(/\.board$/i, "")}-${animationName}`
			.replace(/[^\w\u4e00-\u9fff-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 80);
	const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
	return `${dir}${base || "board"}-${stamp}.mp4`;
}

export function boardVideoExportCommand(
	boardPath: string,
	output: string,
	request: BoardVideoExportRequest,
): string {
	const { region, camera } = request;
	const args = [
		"cohub",
		"boards",
		"export",
		boardPath,
		"--animation",
		request.animationId,
		"--at",
		`0:${Math.ceil(request.duration)}ms:${FRAME_MS}ms`,
		"-o",
		output,
	];
	if (request.inputs) args.push("--inputs", request.inputs);
	if (camera)
		args.push("--camera", "--size", `${camera.width}x${camera.height}`);
	else {
		args.push("--scale", String(request.scale));
		if (region.kind === "frame") args.push("--frame", region.id);
		else if (region.kind === "items")
			args.push("--items", region.ids.join(","));
	}
	return args.map(quote).join(" ");
}

type Block = { content?: unknown; _meta?: { partialResult?: unknown } };

function outputOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return (content as Block[])
		.map((block) =>
			typeof block.content === "string"
				? block.content
				: typeof block._meta?.partialResult === "string"
					? block._meta.partialResult
					: "",
		)
		.join("\n");
}

function renderedShare(output: string): number | null {
	const matches = [...output.matchAll(/Rendered (\d+)\/(\d+) frames/g)];
	const last = matches.at(-1);
	return last ? Number(last[1]) / Math.max(1, Number(last[2])) : null;
}

export async function readBoardVideoExportAccess(
	spaceId: string,
	apply: (allowed: boolean) => void,
): Promise<void> {
	const allows = (space: SpaceRecord) =>
		space.access?.permissions.includes("command.execute") === true;
	const cached = await getCachedSpaceRecord(spaceId).catch(() => null);
	if (cached) apply(allows(cached.space));
	const fresh = await sdk.spaces.get(spaceId).catch(() => null);
	if (!fresh) return;
	apply(allows(fresh));
	cacheSpaceRecordSoon(fresh);
}

export function createBoardVideoExport(spaceId: string) {
	let state = $state<BoardVideoExportState | null>(null);
	let timer: ReturnType<typeof setTimeout> | null = null;
	let generation = 0;

	function stop() {
		generation += 1;
		if (timer !== null) clearTimeout(timer);
		timer = null;
	}

	async function follow(taskRunId: string, path: string, current: number) {
		try {
			const { run, progress } = await sdk.tasks.get(taskRunId);
			if (current !== generation) return;
			const result = run.result as {
				exitCode?: number | null;
				content?: unknown;
			} | null;
			if (run.status === "completed" && result?.exitCode === 0) {
				state = { status: "done", path };
				return;
			}
			if (run.status === "completed" || run.status === "failed") {
				const lines = outputOf(result?.content).trim().split("\n");
				state = {
					status: "failed",
					message: lines.at(-1) || run.errorMessage || "",
				};
				return;
			}
			state = {
				status: "running",
				progress: renderedShare(
					outputOf((progress as { content?: unknown } | null)?.content),
				),
			};
		} catch {}
		if (current === generation)
			timer = setTimeout(() => void follow(taskRunId, path, current), POLL_MS);
	}

	return {
		get state() {
			return state;
		},
		get running() {
			return state?.status === "running";
		},
		async start(
			boardPath: string,
			animationName: string,
			request: BoardVideoExportRequest,
			ready: () => Promise<void>,
		) {
			stop();
			const current = generation;
			state = { status: "running", progress: null };
			const path = outputPath(boardPath, animationName);
			try {
				await ready();
				if (current !== generation) return;
				const { taskRunId } = await sdk.space(spaceId).runCommand({
					command: boardVideoExportCommand(boardPath, path, request),
				});
				if (current === generation) await follow(taskRunId, path, current);
			} catch (error) {
				if (current !== generation) return;
				state = {
					status: "failed",
					message: error instanceof Error ? error.message : "",
				};
			}
		},
		dismiss() {
			stop();
			state = null;
		},
		destroy: stop,
	};
}

export type BoardVideoExport = ReturnType<typeof createBoardVideoExport>;
