import { sdk } from "#lib/sdk.ts";
import { spacePreviewSessionCache } from "#lib/space-preview-session-cache.ts";

export type SpacePreviewTarget = {
	origin: string;
	spaceId: string;
	path: string;
};

type SpacePreviewSessionOptions = {
	getTarget: () => SpacePreviewTarget | null;
	errorMessage: () => string;
};

const RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;

function isSameTarget(
	left: SpacePreviewTarget | null,
	right: SpacePreviewTarget,
) {
	return (
		left?.origin === right.origin &&
		left.spaceId === right.spaceId &&
		left.path === right.path
	);
}

function buildPreviewSrc(target: SpacePreviewTarget, token: string) {
	const path = target.path.split("/").map(encodeURIComponent).join("/");
	return `${target.origin}/s/${encodeURIComponent(
		target.spaceId,
	)}/${path}?token=${encodeURIComponent(token)}`;
}

export function createSpacePreviewSessionController(
	options: SpacePreviewSessionOptions,
) {
	let src = $state<string | null>(null);
	let error = $state<string | null>(null);
	let loadVersion = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;

	function clearTimer() {
		if (!timer) return;
		clearTimeout(timer);
		timer = null;
	}

	async function load(loadOptions: { reset?: boolean; attempt?: number } = {}) {
		const current = ++loadVersion;
		clearTimer();
		if (loadOptions.reset) {
			src = null;
			error = null;
		}

		const target = options.getTarget();
		if (!target) return;
		const existingSrc = src;
		try {
			const session = await spacePreviewSessionCache.get(target.spaceId, () =>
				sdk.space(target.spaceId).files.createPreviewSession(),
			);
			if (current !== loadVersion || !isSameTarget(options.getTarget(), target))
				return;
			error = null;
			src = buildPreviewSrc(target, session.token);
			timer = setTimeout(
				() => void load(),
				Math.max(30_000, session.expiresAt - Date.now() - 60_000),
			);
		} catch (loadError) {
			if (current !== loadVersion || !isSameTarget(options.getTarget(), target))
				return;
			if (!existingSrc) {
				error =
					loadError instanceof Error
						? loadError.message
						: options.errorMessage();
			}
			const attempt = loadOptions.attempt ?? 0;
			timer = setTimeout(
				() => void load({ attempt: attempt + 1 }),
				Math.min(
					MAX_RETRY_DELAY_MS,
					RETRY_DELAY_MS * 2 ** Math.min(attempt, 5),
				),
			);
		}
	}

	function reset() {
		return load({ reset: true });
	}

	function stop() {
		loadVersion += 1;
		clearTimer();
	}

	return {
		get src() {
			return src;
		},
		get error() {
			return error;
		},
		reset,
		stop,
	};
}
