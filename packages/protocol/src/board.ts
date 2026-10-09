import { z } from "zod";
import {
	type BoardDelta,
	type BoardDiagnostic,
	BoardIdSchema,
	type BoardPatch,
	BoardPatchSchema,
} from "./board-model.js";
import type { RequestSource } from "./provenance.js";

export const BOARD_EXTENSION = ".board" as const;
export const BOARD_MIME_TYPE = "application/json" as const;
export const BOARD_MANIFEST_KIND = "cohub.board.manifest" as const;
export const BOARD_SNAPSHOT_KIND = "cohub.board.snapshot" as const;
export const BOARD_CLIPBOARD_KIND = "cohub.board.clipboard" as const;
export const BOARD_CLIPBOARD_MIME = "application/x-cohub-board" as const;
export const BOARD_MANIFEST_VERSION = 1 as const;
export const BOARD_PROTOCOL_VERSION = 3 as const;


export const BoardManifestSchema = z.object({
	kind: z.literal(BOARD_MANIFEST_KIND),
	version: z.literal(BOARD_MANIFEST_VERSION),
	boardId: z.string().uuid(),
	title: z.string().min(1).max(255),
});
export type BoardManifest = z.infer<typeof BoardManifestSchema>;

export class InvalidBoardFileError extends Error {
	readonly code = "INVALID_BOARD_FILE";
	constructor(message = "Board file is invalid") {
		super(message);
		this.name = "InvalidBoardFileError";
	}
}

export function parseBoardManifest(input: string | unknown): BoardManifest {
	let value = input;
	if (typeof input === "string") {
		try {
			value = JSON.parse(input);
		} catch {
			throw new InvalidBoardFileError("Board file must contain valid JSON");
		}
	}
	const parsed = BoardManifestSchema.safeParse(value);
	if (!parsed.success) throw new InvalidBoardFileError("Board file must contain a valid boardId");
	return parsed.data;
}

export function serializeBoardManifest(manifest: BoardManifest): string {
	return `${JSON.stringify(BoardManifestSchema.parse(manifest), null, 2)}\n`;
}

export function isBoardPath(path: string): boolean {
	return path.toLowerCase().endsWith(BOARD_EXTENSION);
}


export const BOARD_READ_SECTIONS = ["items", "animations"] as const;
export type BoardReadSection = (typeof BOARD_READ_SECTIONS)[number];

const rectSchema = z
	.object({
		x: z.number().finite(),
		y: z.number().finite(),
		width: z.number().finite().positive(),
		height: z.number().finite().positive(),
	})
	.strict();

export const BoardReadInputSchema = z
	.object({
		only: z.array(z.enum(BOARD_READ_SECTIONS)).optional(),
		rect: rectSchema.optional(),
		within: BoardIdSchema.optional(),
		items: z.array(z.string().min(1)).max(50_000).optional(),
		animations: z.array(z.string().min(1)).max(10_000).optional(),
		limit: z.number().int().min(1).max(50_000).optional(),
		cursor: z.string().min(1).optional(),
	})
	.strict()
	.refine((read) => !(read.cursor && (read.rect || read.within)), {
		path: ["cursor"],
		message: "cursor pages by id, so it cannot be combined with rect or within",
	});
export type BoardReadInput = z.infer<typeof BoardReadInputSchema>;

export type BoardRecord = {
	id: string;
	spaceId: string;
	title: string;
	version: number;
	createdAt: string | null;
	updatedAt: string | null;
};

export type BoardReadResult = {
	id: string;
	title: string;
	version: number;
	updatedAt: string | null;
	board: Record<string, unknown>;
	items?: Record<string, Record<string, unknown>>;
	animations?: Record<string, Record<string, unknown>>;
	playback: BoardPlaybackSnapshot | null;
	next?: string;
};


export const BoardApplyInputSchema = z
	.object({
		patch: BoardPatchSchema,
		replace: z.boolean().default(false),
		cascade: z.boolean().default(false),
		dryRun: z.boolean().default(false),
		baseVersion: z.number().int().nonnegative().optional(),
		mutationId: z.string().min(1).max(160).optional(),
		clientId: z.string().min(1).max(160).optional(),
	})
	.strict();
export type BoardApplyInput = z.input<typeof BoardApplyInputSchema>;

export type BoardChangeSummary = {
	board: boolean;
	items: string[];
	animations: string[];
};

export type BoardApplyResult = {
	mutationId: string;
	status: "applied" | "unchanged" | "validated";
	replayed: boolean;
	version: number;
	changed: BoardChangeSummary;
	diagnostics: BoardDiagnostic[];
};

export function summarizeBoardDelta(delta: BoardDelta): BoardChangeSummary {
	return {
		board: Boolean(delta.board),
		items: Object.keys(delta.items ?? {}),
		animations: [...new Set([...Object.keys(delta.animations ?? {}), ...Object.keys(delta.tracks ?? {})])],
	};
}

export const BoardCreateInputSchema = z
	.object({
		path: z.string().min(1),
		title: z.string().min(1).max(255).optional(),
		document: BoardPatchSchema.optional(),
		mutationId: z.string().max(160).optional(),
	})
	.strict();
export type BoardCreateInput = z.input<typeof BoardCreateInputSchema>;


export type BoardTransactionRecord = {
	id: string;
	mutationId: string;
	baseVersion: number;
	version: number;
	actorId: string;
	clientId: string | null;
	source: RequestSource | null;
	createdAt: string;
	before: BoardDelta | null;
	after: BoardDelta | null;
};

export const BOARD_HISTORY_DEFAULT_LIMIT = 200;
export const BOARD_HISTORY_MAX_LIMIT = 500;

export const BoardHistoryInputSchema = z
	.object({
		before: z.number().int().positive().optional(),
		limit: z.number().int().min(1).max(BOARD_HISTORY_MAX_LIMIT).default(BOARD_HISTORY_DEFAULT_LIMIT),
	})
	.strict();
export type BoardHistoryInput = z.input<typeof BoardHistoryInputSchema>;

export type BoardHistoryPage = {
	version: number;
	transactions: BoardTransactionRecord[];
	nextBefore: number | null;
};


export type BoardPlaybackStatus = "playing" | "paused" | "stopped";

export type BoardPlaybackSnapshot = {
	playbackId: string;
	animationId: string;
	animationRevision: number;
	revision: number;
	status: BoardPlaybackStatus;
	position: number;
	effectiveAt: number;
	timeScale: number;
	seed: string;
	commandId: string;
};

const commandId = z.string().min(1).max(160);
export const BoardPlaybackCommandSchema = z.discriminatedUnion("type", [
	z.object({
		commandId,
		type: z.literal("play"),
		animationId: z.string().min(1),
		position: z.number().finite().nonnegative().optional(),
		timeScale: z.number().finite().positive().max(4).optional(),
		seed: z.string().min(1).max(160).optional(),
	}).strict(),
	z.object({ commandId, type: z.literal("pause") }).strict(),
	z.object({ commandId, type: z.literal("resume") }).strict(),
	z.object({ commandId, type: z.literal("seek"), position: z.number().finite().nonnegative() }).strict(),
	z.object({ commandId, type: z.literal("next") }).strict(),
	z.object({ commandId, type: z.literal("stop") }).strict(),
]);
export type BoardPlaybackCommand = z.infer<typeof BoardPlaybackCommandSchema>;


export type BoardSnapshot = {
	kind: typeof BOARD_SNAPSHOT_KIND;
	version: typeof BOARD_PROTOCOL_VERSION;
	capturedAt: string;
	id: string;
	title: string;
	boardVersion: number;
	board: Record<string, unknown>;
	items: Record<string, Record<string, unknown>>;
	animations: Record<string, Record<string, unknown>>;
};

export type { BoardPatch };
