import {
	type ViewportMediaContext,
	type ViewportMediaMark,
	viewportContextId,
} from "@cohub/protocol";

/** Identifies an image for the agent: a workspace `path` or a durable `url`. */
export type MediaRef = Omit<ViewportMediaContext, "kind" | "marks">;

export type MediaMarkRect = Omit<ViewportMediaMark, "n">;

export function mediaRefId(ref: MediaRef) {
	return viewportContextId({ kind: "media", ...ref });
}

export function clipMediaTitle(title: string, max = 48) {
	return title.length > max ? `${title.slice(0, max - 1)}…` : title;
}

export function durableMediaUrl(url: string | null | undefined) {
	return url && /^https?:\/\//i.test(url) ? url : undefined;
}

export type MediaAskTarget = {
	draft: string;
	readonly sending: boolean;
	readonly hasMarks: boolean;
	send(): Promise<boolean>;
	view(ref: MediaRef | null): void;
	marks(ref: MediaRef): readonly ViewportMediaMark[];
	addMark(ref: MediaRef, rect: MediaMarkRect, floor?: number): number;
	removeMark(ref: MediaRef, n: number): void;
};

let target = $state.raw<MediaAskTarget | null>(null);

export const mediaAsk = {
	get target() {
		return target;
	},
	register(next: MediaAskTarget) {
		target = next;
		return () => {
			if (target === next) target = null;
		};
	},
};
