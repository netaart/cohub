export type MediaType = "image" | "video" | "audio";

export interface MediaItem {
	type: MediaType;
	/** Direct source. Omit it and provide `resolve` to load on demand. */
	src?: string;
	resolve?: () => Promise<string | null>;
	alt?: string;
	/** Video poster or audio cover. */
	poster?: string;
	/** Caption, e.g. the generation prompt. */
	title?: string;
	/** Secondary caption, e.g. the model. */
	subtitle?: string;
	filename?: string;
	mimeType?: string;
	/** Natural size, when known, reserves the frame before media loads. */
	width?: number;
	height?: number;
	/** Opens the source record; the lightbox closes first. */
	onDetails?: () => void;
}

export type MediaSource =
	| { status: "ready"; src: string }
	| { status: "loading" }
	| { status: "error" };

let open = $state(false);
let items = $state.raw<MediaItem[]>([]);
let index = $state(0);
/** Resolved sources by index; `null` marks a failed resolve. */
let resolved = $state.raw<ReadonlyMap<number, string | null>>(new Map());
let pending = new Set<number>();
/** Bumped per `show`, so a late resolve can't leak into another gallery. */
let session = 0;

function reset(next: MediaItem[], start: number) {
	session += 1;
	pending = new Set();
	resolved = new Map();
	items = next;
	index = Math.min(Math.max(0, start), Math.max(0, next.length - 1));
}

export const mediaLightbox = {
	get open() {
		return open;
	},
	get items() {
		return items;
	},
	get index() {
		return index;
	},
	get current(): MediaItem | undefined {
		return items[index];
	},
	get hasPrev() {
		return index > 0;
	},
	get hasNext() {
		return index < items.length - 1;
	},
	show(item: MediaItem | MediaItem[], startIdx = 0) {
		const next = Array.isArray(item) ? item : [item];
		reset(next, startIdx);
		open = next.length > 0;
	},
	close() {
		open = false;
		reset([], 0);
	},
	go(target: number) {
		if (target >= 0 && target < items.length) index = target;
	},
	source(at: number): MediaSource {
		const item = items[at];
		if (item?.src) return { status: "ready", src: item.src };
		const src = resolved.get(at);
		if (src) return { status: "ready", src };
		return item?.resolve && src === undefined
			? { status: "loading" }
			: { status: "error" };
	},
	/** Resolve an on-demand source once per gallery. */
	load(at: number) {
		const item = items[at];
		if (!item?.resolve || item.src || resolved.has(at) || pending.has(at))
			return;
		const owner = session;
		pending.add(at);
		const settle = (src: string | null) => {
			if (owner !== session) return;
			pending.delete(at);
			resolved = new Map(resolved).set(at, src);
		};
		item.resolve().then(settle, () => settle(null));
	},
};
