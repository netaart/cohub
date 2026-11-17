import { BOARD_MODEL_CLIP_LIMIT, BOARD_MODEL_FADE_MS, BOARD_MODEL_NODE_LIMIT, type BoardItem, type BoardMediaSnapshot } from "@cohub/protocol/board-model";
import { isBoardModelItem } from "./media.js";

export type BoardModelClip = NonNullable<BoardMediaSnapshot["clips"]>[number];

export type BoardModelFacts = { clips: BoardModelClip[]; nodes: string[] };

export type BoardModelPlayback = {
	clip: string | null;
	time: number | null;
	loop: boolean;
	fade: number;
	running: boolean;
};

export function boardModelPlayback(item: BoardItem, reducedMotion: boolean): BoardModelPlayback | null {
	if (item.type !== "file" || !isBoardModelItem(item)) return null;
	const model = item.props.model;
	const time = model?.time ?? null;
	return {
		clip: model?.animation ?? null,
		time,
		loop: model?.loop !== false,
		fade: model?.fade ?? BOARD_MODEL_FADE_MS,
		running: time === null && item.autoplay === true && !reducedMotion,
	};
}

export function boardModelNodes(names: Iterable<unknown>): string[] {
	const nodes = new Set<string>();
	for (const name of names) {
		if (nodes.size >= BOARD_MODEL_NODE_LIMIT) break;
		if (typeof name === "string" && name && name.length <= 240) nodes.add(name);
	}
	return [...nodes];
}

export function readBoardModelFacts(bytes: Uint8Array): BoardModelFacts | null {
	const json = gltfJson(bytes);
	if (!json) return null;
	const accessors = Array.isArray(json.accessors) ? json.accessors : [];
	const animations = Array.isArray(json.animations) ? json.animations : [];
	const nodes = boardModelNodes((Array.isArray(json.nodes) ? json.nodes : []).map((node) => node?.name));
	const clips = animations.slice(0, BOARD_MODEL_CLIP_LIMIT).map((animation, index) => {
		let seconds = 0;
		for (const sampler of Array.isArray(animation?.samplers) ? animation.samplers : []) {
			const max = typeof sampler?.input === "number" ? accessors[sampler.input]?.max?.[0] : undefined;
			if (typeof max === "number" && Number.isFinite(max)) seconds = Math.max(seconds, max);
		}
		const name = typeof animation?.name === "string" && animation.name ? animation.name.slice(0, 240) : `anim_${index}`;
		return { name, durationMs: Math.round(seconds * 1000) };
	});
	return { clips, nodes };
}

export function withBoardModelFacts(snapshot: BoardMediaSnapshot | undefined, facts: BoardModelFacts): BoardMediaSnapshot | null {
	const { clips: _clips, nodes: _nodes, ...rest } = snapshot ?? {};
	const next = { ...rest, ...(facts.clips.length ? { clips: facts.clips } : {}), ...(facts.nodes.length ? { nodes: facts.nodes } : {}) };
	return sameBoardModelClips(snapshot?.clips, next.clips) && sameNodes(snapshot?.nodes, next.nodes) ? null : next;
}

function sameNodes(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
	if (!a || !b) return a === b;
	return a.length === b.length && a.every((name, index) => name === b[index]);
}

type GltfJson = {
	accessors?: Array<{ max?: number[] } | undefined>;
	nodes?: Array<{ name?: unknown } | undefined>;
	animations?: Array<{ name?: unknown; samplers?: Array<{ input: number } | undefined> } | undefined>;
};

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;

export function boardModelJsonLength(head: Uint8Array): number | null {
	if (head.byteLength < 20) return null;
	const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
	if (view.getUint32(0, true) !== GLB_MAGIC) return null;
	return view.getUint32(16, true) === JSON_CHUNK ? 20 + view.getUint32(12, true) : null;
}

function gltfJson(bytes: Uint8Array): GltfJson | null {
	const glb = boardModelJsonLength(bytes);
	const text = new TextDecoder().decode(glb === null ? bytes : bytes.subarray(20, glb));
	try {
		const json = JSON.parse(text) as unknown;
		return json && typeof json === "object" && "asset" in json ? (json as GltfJson) : null;
	} catch {
		return null;
	}
}

export function sameBoardModelClips(a: readonly BoardModelClip[] | undefined, b: readonly BoardModelClip[] | undefined): boolean {
	if (!a || !b) return a === b;
	return a.length === b.length && a.every((clip, index) => clip.name === b[index]?.name && clip.durationMs === b[index]?.durationMs);
}
