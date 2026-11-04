import {
	type BoardImageSource,
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
): Promise<BoardImageSource> {
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
