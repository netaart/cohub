
import type {
	BoardDocument,
	BoardSceneItem,
	BoardShapeColors,
} from "@neta-art/cohub/board";
import {
	type BoardExportRegion,
	buildBoardScene,
	planBoardExport,
	selectBoardExportAssets,
} from "@neta-art/cohub/board";
import {
	type BoardExportOptions,
	type BoardExportWarning,
	describeBoardExportWarning,
	renderBoardExport,
} from "@neta-art/cohub/board/export";
import type { BoardRenderPalette } from "@neta-art/cohub/board/render";
import { type Renderer, Texture } from "pixi.js";

export type BoardImageFormat = "png" | "jpeg" | "webp";

const MAX_BACKGROUND_BYTES = 32 * 1024 * 1024;
const BACKGROUND_MIME_TYPES = new Set([
	"image/avif",
	"image/gif",
	"image/jpeg",
	"image/png",
	"image/webp",
]);

type ExportBackgroundTexture = {
	texture: Texture;
	dispose: () => void;
};

async function rejectResponse(
	response: Response,
	message: string,
): Promise<never> {
	if (response.body) await response.body.cancel().catch(() => undefined);
	throw new Error(message);
}

export async function readBoundedImageBlob(
	response: Response,
	mimeType: string,
	maxBytes = MAX_BACKGROUND_BYTES,
): Promise<Blob> {
	const declaredLength = Number(response.headers.get("content-length") ?? 0);
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		return rejectResponse(
			response,
			`Remote background exceeds the ${maxBytes} byte download limit`,
		);
	}
	if (!response.body) return new Blob([], { type: mimeType });

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				throw new Error(
					`Remote background exceeds the ${maxBytes} byte download limit`,
				);
			}
			chunks.push(value);
		}
	} catch (error) {
		await reader.cancel().catch(() => undefined);
		throw error;
	} finally {
		reader.releaseLock();
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new Blob([bytes], { type: mimeType });
}

async function loadExportBackgroundTexture(
	url: string,
): Promise<ExportBackgroundTexture> {
	const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
	if (!response.ok) return rejectResponse(response, `HTTP ${response.status}`);
	const mimeType = response.headers
		.get("content-type")
		?.split(";", 1)[0]
		?.trim()
		.toLowerCase();
	if (!mimeType || !BACKGROUND_MIME_TYPES.has(mimeType)) {
		return rejectResponse(
			response,
			"Remote background must be a supported raster image",
		);
	}
	const blob = await readBoundedImageBlob(response, mimeType);
	const bitmap = await createImageBitmap(blob);
	const texture = Texture.from(bitmap);
	return {
		texture,
		dispose: () => {
			texture.destroy(true);
			bitmap.close();
		},
	};
}

const MIME: Record<BoardImageFormat, string> = {
	png: "image/png",
	jpeg: "image/jpeg",
	webp: "image/webp",
};

const EXTENSION: Record<BoardImageFormat, string> = {
	png: "png",
	jpeg: "jpg",
	webp: "webp",
};

export type BoardStageExportBridge = {
	renderer: () => Renderer | null;
	assetKey: (item: BoardSceneItem) => string | null;
	theme: () => {
		palette: BoardRenderPalette;
		colors: BoardShapeColors;
		colorScheme: "dark" | "light";
	};
	withTextures: <T>(
		items: BoardSceneItem[],
		use: (textures: Map<string, Texture>) => T | Promise<T>,
	) => Promise<T>;
};

export type BoardImageExportResult = {
	blob: Blob;
	width: number;
	height: number;
	scale: number;
	format: BoardImageFormat;
	warnings: string[];
};

function canvasToBlob(
	canvas: HTMLCanvasElement | OffscreenCanvas,
	mimeType: string,
	quality?: number,
): Promise<Blob | null> {
	if ("convertToBlob" in canvas) {
		return canvas.convertToBlob({ type: mimeType, quality }).catch(() => null);
	}
	return new Promise((resolve) => canvas.toBlob(resolve, mimeType, quality));
}

function describe(warnings: BoardExportWarning[]): string[] {
	return warnings.map(describeBoardExportWarning);
}

export async function exportBoardImage(
	bridge: BoardStageExportBridge,
	document: BoardDocument,
	options: Omit<BoardExportOptions, "textures"> & {
		format?: BoardImageFormat;
		quality?: number;
	} = {},
): Promise<BoardImageExportResult | null> {
	const renderer = bridge.renderer();
	if (!renderer) throw new Error("The board is not ready to export yet.");
	const { format = "png", quality = 0.92, ...exportOptions } = options;

	const region: BoardExportRegion = exportOptions.region ?? { kind: "all" };
	const plan = planBoardExport({ ...exportOptions, scene: buildBoardScene(document), region });
	if (!plan) return null;

	const theme = bridge.theme();
	const assets = selectBoardExportAssets(plan.items, bridge.assetKey);
	const omittedKeys = new Set(assets.omittedKeys);
	const cappedAssetKey = (item: BoardSceneItem) => {
		const key = bridge.assetKey(item);
		return key && omittedKeys.has(key) ? null : key;
	};
	const declaredBackground = document.board.background;
	const backgroundUrl =
		exportOptions.background !== "transparent" &&
		declaredBackground.kind === "image"
			? declaredBackground.imageUrl
			: undefined;
	let backgroundTexture: ExportBackgroundTexture | null = null;
	let backgroundWarning: string | null = null;
	if (backgroundUrl) {
		try {
			backgroundTexture = await loadExportBackgroundTexture(backgroundUrl);
		} catch {
			backgroundWarning =
				"The board background image could not be loaded; the fallback color was exported.";
		}
	}

	try {
		return await bridge.withTextures(assets.items, async (textures) => {
			const result = renderBoardExport(renderer, document, {
				palette: theme.palette,
				colors: theme.colors,
				colorScheme: theme.colorScheme,
				...exportOptions,
				region,
				textures,
				assetKey: cappedAssetKey,
				backgroundImage: backgroundTexture
					? {
							texture: backgroundTexture.texture,
							fit: declaredBackground.fit ?? "cover",
							position: "center",
							opacity: declaredBackground.opacity ?? 1,
						}
					: undefined,
			});
			if (!result) return null;

			const canvas = result.canvas as unknown as HTMLCanvasElement;
			const blob = await canvasToBlob(
				canvas,
				MIME[format],
				format === "png" ? undefined : quality,
			);
			if (!blob) throw new Error("This browser could not encode the export.");
			const warnings = describe(result.warnings);
			if (backgroundWarning) warnings.push(backgroundWarning);
			if (assets.omittedKeys.length > 0) {
				warnings.push(
					`${assets.omittedKeys.length} previews were drawn as placeholders to stay within the export texture limit.`,
				);
			}
			return {
				blob,
				width: result.plan.width,
				height: result.plan.height,
				scale: result.plan.scale,
				format,
				warnings,
			};
		});
	} finally {
		backgroundTexture?.dispose();
	}
}

export function boardExportFilename(
	title: string | null | undefined,
	format: BoardImageFormat,
	suffix?: string,
): string {
	const base = (title || "board")
		.replace(/\.board$/i, "")
		.replace(/[^\w\u4e00-\u9fff-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
	const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
	return `${base || "board"}${suffix ? `-${suffix}` : ""}-${stamp}.${EXTENSION[format]}`;
}

export function downloadBlob(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	anchor.rel = "noopener";
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function copyImageToClipboard(blob: Blob): Promise<void> {
	if (!("clipboard" in navigator) || !("write" in navigator.clipboard)) {
		throw new Error("This browser cannot copy images to the clipboard.");
	}
	const ClipboardItemCtor = globalThis.ClipboardItem;
	if (!ClipboardItemCtor) {
		throw new Error("This browser cannot copy images to the clipboard.");
	}
	try {
		await navigator.clipboard.write([
			new ClipboardItemCtor({ [blob.type]: blob }),
		]);
	} catch {
		await navigator.clipboard.write([
			new ClipboardItemCtor({ [blob.type]: Promise.resolve(blob) }),
		]);
	}
}
