import { adoptBoardNaturalSize, type BoardItem, featuredTaskArtifact, parseBoardMediaSource } from "@cohub/protocol";
import { probeMediaSize } from "../../media.js";

export type BoardMediaSize = { width: number; height: number };

export type BoardMediaTarget = {
	id: string;
	type: "image" | "video";
	source: { kind: "file" | "url"; value: string };
};

export type BoardMediaFileResolver = (
	path: string,
	type: BoardMediaTarget["type"],
	signal?: AbortSignal,
) => Promise<BoardMediaSize | string | null>;

export type BoardMediaSizeOptions = {
	resolveFile?: BoardMediaFileResolver;
	signal?: AbortSignal;
};

export function boardMediaTarget(id: string, item: BoardItem): BoardMediaTarget | null {
	if (item.type === "image" || item.type === "video") {
		if (item.props.snapshot?.naturalWidth && item.props.snapshot.naturalHeight) return null;
		const source = parseBoardMediaSource(item.props.src);
		return source ? { id, type: item.type, source } : null;
	}
	if (item.type !== "task") return null;
	const artifact = featuredTaskArtifact(item.props.snapshot.artifacts);
	if ((artifact?.type !== "image" && artifact?.type !== "video") || (artifact.naturalWidth && artifact.naturalHeight)) return null;
	return { id, type: artifact.type, source: { kind: "url", value: artifact.url } };
}

export async function probeBoardMediaSize(
	target: Omit<BoardMediaTarget, "id">,
	options: BoardMediaSizeOptions = {},
): Promise<BoardMediaSize | null> {
	const { type, source } = target;
	try {
		const resolved = source.kind === "url" ? source.value : await options.resolveFile?.(source.value, type, options.signal);
		if (typeof resolved !== "string") return resolved ?? null;
		return await probeMediaSize(resolved, type, { signal: options.signal });
	} catch {
		return null;
	}
}

const CONCURRENCY = 8;

/** Probes each unique media source once; unresolved items are left as is. */
export async function settleBoardMediaSizes(
	items: Readonly<Record<string, BoardItem>>,
	options: Omit<BoardMediaSizeOptions, "signal"> & { timeoutMs?: number } = {},
): Promise<Record<string, BoardItem>> {
	const targets = Object.entries(items).flatMap(([id, item]) => boardMediaTarget(id, item) ?? []);
	const signal = AbortSignal.timeout(options.timeoutMs ?? 5_000);
	const probes = new Map<string, Promise<BoardMediaSize | null>>();
	const settled: Record<string, BoardItem> = {};
	let next = 0;
	const work = async () => {
		for (let target = targets[next++]; target; target = targets[next++]) {
			const key = `${target.type}:${target.source.kind}:${target.source.value}`;
			const probe = probes.get(key) ?? probeBoardMediaSize(target, { ...options, signal });
			probes.set(key, probe);
			const size = await probe;
			const item = items[target.id];
			const adopted = size && item && adoptBoardNaturalSize(item, size);
			if (adopted) settled[target.id] = adopted;
		}
	};
	await Promise.all(Array.from({ length: CONCURRENCY }, work));
	return settled;
}
