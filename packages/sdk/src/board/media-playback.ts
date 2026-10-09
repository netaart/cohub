import type { BoardSceneItem, } from "./core/scene.js";
import { rankedTaskArtifacts } from "./task.js";

export type BoardAssetSource = {
	resolveFileUrl: (path: string) => Promise<string | null>;
	resolvePlaybackUrl?: (path: string) => Promise<string | null>;
};

export type BoardPlayableMedia = {
	id: string;
	kind: "video" | "audio";
	title: string;
	durationMs?: number;
	resolveUrl: () => Promise<string | null>;
	invalidateUrl: () => void;
};

const resolvedUrls = new Map<string, Promise<string | null>>();
const sourceIds = new WeakMap<BoardAssetSource, number>();
const URL_CACHE_LIMIT = 64;
let nextSourceId = 1;

function sourceId(source: BoardAssetSource) {
	let id = sourceIds.get(source);
	if (id === undefined) {
		id = nextSourceId;
		nextSourceId += 1;
		sourceIds.set(source, id);
	}
	return id;
}

function invalidateCachedUrl(key: string) {
	resolvedUrls.delete(key);
}

function cachedUrl(key: string, resolve: () => Promise<string | null>) {
	let pending = resolvedUrls.get(key);
	if (!pending) {
		if (resolvedUrls.size >= URL_CACHE_LIMIT) {
			const oldest = resolvedUrls.keys().next().value;
			if (oldest !== undefined) resolvedUrls.delete(oldest);
		}
		pending = resolve()
			.catch(() => null)
			.then((url) => {
				if (!url) resolvedUrls.delete(key);
				return url;
			});
		resolvedUrls.set(key, pending);
	}
	return pending;
}

export function playableBoardMediaList(
	item: BoardSceneItem | null,
	assetSource: BoardAssetSource,
): BoardPlayableMedia[] {
	if (item?.type === "video" || item?.type === "audio") {
		const path = item.props.src;
		const version = item.props.snapshot?.mtimeMs ?? "unknown";
		const cacheKey = `${sourceId(assetSource)}:${item.type}:file:${path}:${version}`;
		const durationMs = item.type === "audio" ? item.props.snapshot?.durationMs : undefined;
		return [
			{
				id: item.id,
				kind: item.type,
				title: item.props.snapshot?.title ?? path.split("/").pop() ?? item.type,
				...(durationMs ? { durationMs } : {}),
				resolveUrl: () =>
					cachedUrl(cacheKey, () =>
						(assetSource.resolvePlaybackUrl ?? assetSource.resolveFileUrl)(path),
					),
				invalidateUrl: () => invalidateCachedUrl(cacheKey),
			},
		];
	}
	if (item?.type !== "task") return [];
	return rankedTaskArtifacts(item.props.snapshot.artifacts)
		.filter(
			(artifact) => artifact.type === "video" || artifact.type === "audio",
		)
		.map((artifact) => ({
			id: artifact.id,
			kind: artifact.type,
			title: artifact.title ?? item.props.snapshot.title,
			...(artifact.durationMs ? { durationMs: artifact.durationMs } : {}),
			resolveUrl: () => Promise.resolve(artifact.url),
			invalidateUrl: () => {},
		}));
}

export function playableBoardMedia(
	item: BoardSceneItem | null,
	assetSource: BoardAssetSource,
	artifactId?: string | null,
): BoardPlayableMedia | null {
	const media = playableBoardMediaList(item, assetSource);
	return media.find((entry) => entry.id === artifactId) ?? media[0] ?? null;
}

export function resetBoardPlaybackUrlCache() {
	resolvedUrls.clear();
}
