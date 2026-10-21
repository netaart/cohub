import { parseBoardMediaSource } from "@cohub/protocol/board-model";
import { getMediaResourceTitle } from "./media.js";
import type { BoardSceneItem, } from "./scene.js";
import { rankedTaskArtifacts } from "@cohub/protocol";

export type BoardAssetUrlOptions = {
	fresh?: boolean;
};

export type BoardAssetSource = {
	resolveFileUrl: (path: string, options?: BoardAssetUrlOptions) => Promise<string | null>;
	resolvePlaybackUrl?: (path: string, options?: BoardAssetUrlOptions) => Promise<string | null>;
};

export function resolveBoardMediaUrl(
	src: string,
	source: BoardAssetSource,
	purpose: "preview" | "playback" = "preview",
): Promise<string | null> {
	const parsed = parseBoardMediaSource(src);
	if (!parsed) return Promise.resolve(null);
	if (parsed.kind === "url") {
		return Promise.resolve(parsed.value);
	}
	return purpose === "playback" && source.resolvePlaybackUrl
		? source.resolvePlaybackUrl(parsed.value)
		: source.resolveFileUrl(parsed.value);
}

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
		const source = parseBoardMediaSource(path);
		if (!source) return [];
		const version = item.props.snapshot?.mtimeMs ?? "unknown";
		const cacheKey = `${sourceId(assetSource)}:${item.type}:${source.kind}:${path}:${version}`;
		const durationMs = item.type === "audio" ? item.props.snapshot?.durationMs : undefined;
		return [
			{
				id: item.id,
				kind: item.type,
				title: item.props.snapshot?.title ?? getMediaResourceTitle(path),
				...(durationMs ? { durationMs } : {}),
				resolveUrl: () =>
					cachedUrl(cacheKey, () =>
						resolveBoardMediaUrl(path, assetSource, "playback"),
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
