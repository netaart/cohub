import {
	type BoardItem,
	type BoardItemEntry,
	type BoardMediaSnapshot,
	createMediaBoardItem,
	normalizeBoardRemoteUrl,
} from "@neta-art/cohub/board";
import {
	isComposerImageFile,
	isSupportedComposerImageFile,
} from "$lib/composer-attachments";
import {
	prepareChatImageAttachment,
	uploadChatAttachmentFile,
	uploadChatImageDurable,
} from "$lib/public-asset-images";

export type BoardUploadedImage = { url: string; snapshot: BoardMediaSnapshot };

type ViewRect = { x: number; y: number; width: number; height: number };

const IMAGE_GAP = 24;
/** Largest share of the view a pasted row of images may cover. */
const VIEW_FILL = 0.8;

/** Places uploaded images as one centered row that fits inside the view. */
export function layoutBoardImages(
	images: readonly BoardUploadedImage[],
	view: ViewRect,
): BoardItemEntry[] {
	const center = {
		x: view.x + view.width / 2,
		y: view.y + view.height / 2,
	};
	const entries = images.map((image) =>
		createMediaBoardItem(image.url, 0, 0, image.snapshot, undefined, "image"),
	);
	const sizes = entries.map(({ item }) =>
		"size" in item ? item.size : { width: 0, height: 0 },
	);
	if (!entries.length) return entries;
	const gaps = IMAGE_GAP * (entries.length - 1);
	const width = sizes.reduce((sum, size) => sum + size.width, 0);
	const height = Math.max(...sizes.map((size) => size.height));
	const room = view.width * VIEW_FILL - gaps;
	const scale =
		room > 0 && view.height > 0
			? Math.min(1, room / width, (view.height * VIEW_FILL) / height)
			: 1;
	let x = center.x - (width * scale + gaps) / 2;
	return entries.map(({ id, item }, index) => {
		const natural = sizes[index] as { width: number; height: number };
		const size = {
			width: natural.width * scale,
			height: natural.height * scale,
		};
		const position = { x, y: center.y - size.height / 2 };
		x += size.width + IMAGE_GAP;
		return { id, item: { ...item, position, size } as BoardItem };
	});
}

function boardImageUrl(publicUrl: string): string {
	const url = normalizeBoardRemoteUrl(publicUrl);
	if (!url) throw new Error("Uploaded image has no public URL");
	return url;
}

export function clipboardImageFiles(
	data: Pick<DataTransfer, "items"> | null | undefined,
): File[] {
	return Array.from(data?.items ?? []).flatMap((item) => {
		if (item.kind !== "file") return [];
		const file = item.getAsFile();
		return file && file.size > 0 && isComposerImageFile(file) ? [file] : [];
	});
}

/** Uploads a pasted image the way the chat composer does: compress, then durable upload. */
export async function uploadBoardImage(
	file: File,
	options: { spaceId?: string; signal?: AbortSignal } = {},
): Promise<BoardUploadedImage> {
	const prepared = isSupportedComposerImageFile(file)
		? await prepareChatImageAttachment(file).catch((error) => {
				console.warn("[board] image preprocessing failed", {
					name: file.name,
					type: file.type,
					error,
				});
				return null;
			})
		: null;
	if (prepared) {
		URL.revokeObjectURL(prepared.previewUrl);
		const { publicUrl } = await uploadChatImageDurable({
			spaceId: options.spaceId,
			file: prepared.file,
			mediaType: prepared.mediaType,
			filename: prepared.name,
			signal: options.signal,
		});
		return {
			url: boardImageUrl(publicUrl),
			snapshot: {
				title: prepared.name,
				mimeType: prepared.mediaType,
				size: prepared.size,
				naturalWidth: prepared.width,
				naturalHeight: prepared.height,
			},
		};
	}
	const asset = await uploadChatAttachmentFile({
		spaceId: options.spaceId,
		file,
		signal: options.signal,
	});
	return {
		url: boardImageUrl(asset.publicUrl),
		snapshot: {
			title: file.name,
			mimeType: file.type || undefined,
			size: file.size,
		},
	};
}
