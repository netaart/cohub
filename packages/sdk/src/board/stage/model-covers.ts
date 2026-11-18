import type { BoardItem } from "@cohub/protocol/board-model";
import type { BoardEditor, BoardModelLearned } from "../editor/index.js";
import { type BoardAssetSource, type BoardSceneItem, boardModelCover, boardModelCoverDisplay, boardModelCoverVariant, boardModelFormat, fileStem } from "../model/index.js";
import { boardModelSource, loadModelEngine, type ModelStill } from "../render/model3d/index.js";

export type BoardModelCoverUpload = (cover: { key: string; image: Blob; signal: AbortSignal }) => Promise<string>;

export type BoardModelCovers = {
	drawn(items: Iterable<BoardSceneItem>, still: ModelStill): void;
	held(id: string): void;
	sync(): void;
	destroy(): void;
};

type Look = { key: string; variant: string };

const RENDER_TIMEOUT_MS = 60_000;

async function encodeWebp(image: ImageBitmap): Promise<Blob | null> {
	if (typeof OffscreenCanvas === "undefined") return null;
	const canvas = new OffscreenCanvas(image.width, image.height);
	const context = canvas.getContext("2d");
	if (!context) return null;
	context.drawImage(image, 0, 0);
	const blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.9 });
	return blob.type === "image/webp" ? blob : null;
}

export function createBoardModelCovers(options: {
	editor: BoardEditor;
	source: BoardAssetSource;
	upload: BoardModelCoverUpload;
	maxBytes: number;
	drawsStill: (id: string) => boolean;
	adopt: (learned: BoardModelLearned[]) => void;
}): BoardModelCovers {
	const controller = new AbortController();
	const held = new Set<string>();
	const tried = new Set<string>();
	let queue = Promise.resolve();
	let checked: unknown = null;

	const fileOf = (id: string) => {
		const item = options.editor.document.items[id];
		return item?.type === "file" ? item : null;
	};
	function lookOf(item: BoardItem): Look | null {
		const variant = boardModelCoverVariant(item);
		return variant && item.type === "file" ? { key: `${item.props.snapshot?.mtimeMs ?? ""}:${variant}`, variant } : null;
	}
	function claim(item: BoardItem): Look | null {
		const look = boardModelCover(item) === null ? lookOf(item) : null;
		if (!look || tried.has(look.key)) return null;
		tried.add(look.key);
		return look;
	}

	async function store(look: Look, sha256: string, image: Promise<Blob | null>) {
		try {
			const blob = await image;
			if (!blob || controller.signal.aborted) return;
			const url = await options.upload({ key: `${sha256}-${look.variant}`, image: blob, signal: controller.signal });
			if (controller.signal.aborted) return;
			const learned: BoardModelLearned[] = [];
			for (const [id, item] of Object.entries(options.editor.document.items)) {
				if (lookOf(item)?.key === look.key && boardModelCover(item) === null) learned.push({ id, coverUrl: url });
			}
			if (learned.length) options.adopt(learned);
		} catch {
		}
	}

	function render(id: string) {
		const item = fileOf(id);
		if (!item) return;
		const lighting = boardModelCoverDisplay(item);
		if (lighting === "card" && options.drawsStill(id)) return;
		const look = claim(item);
		if (!look) return;
		const { src, snapshot, model } = item.props;
		const format = boardModelFormat(src, snapshot?.mimeType);
		const source = format && boardModelSource({ key: `${src}:${snapshot?.mtimeMs ?? ""}`, src, format, size: snapshot?.size, name: fileStem(src) }, options.source);
		if (!source) return;
		queue = queue.then(async () => {
			const engine = await loadModelEngine();
			const still = await engine.renderModelStill(source, {
				signal: AbortSignal.any([controller.signal, AbortSignal.timeout(RENDER_TIMEOUT_MS)]),
				maxBytes: options.maxBytes,
				view: model?.view,
				clip: model?.animation,
				lighting,
			});
			if (!still.sha256) return still.image.close();
			await store(look, still.sha256, encodeWebp(still.image).finally(() => still.image.close()));
		}).catch(() => {});
	}

	return {
		drawn(items, still) {
			if (!still.sha256) return;
			for (const shown of items) {
				const item = fileOf(shown.id);
				if (!item || boardModelCoverDisplay(item) !== "card" || lookOf(item)?.key !== lookOf(shown)?.key) continue;
				const look = claim(item);
				if (look) return void store(look, still.sha256, encodeWebp(still.image));
			}
		},
		held(id) {
			held.add(id);
			render(id);
		},
		sync() {
			const document = options.editor.document;
			if (document === checked) return;
			checked = document;
			for (const id of held) {
				if (fileOf(id)) render(id);
				else held.delete(id);
			}
		},
		destroy() {
			controller.abort();
			held.clear();
		},
	};
}
