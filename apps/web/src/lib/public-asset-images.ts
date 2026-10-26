import type {
	PublicAssetMimeType,
	PublicAssetUploadProgress,
	UploadPublicAssetInput,
} from "@neta-art/cohub";
import { normalizeAvatarImage } from "$lib/avatar-image";
import { sdk } from "$lib/sdk";
import { authStore } from "$lib/stores/auth.svelte";

export type PreparedChatImageAttachment = {
	file: File;
	mediaType: PublicAssetMimeType;
	name: string;
	previewUrl: string;
	size: number;
	width: number;
	height: number;
};

const CHAT_IMAGE_MAX_EDGE = 1984;
const CHAT_IMAGE_OUTPUT_FORMATS: Array<{
	mimeType: PublicAssetMimeType;
	extension: "webp" | "jpg";
	quality: number;
}> = [
	{ mimeType: "image/webp", extension: "webp", quality: 0.86 },
	{ mimeType: "image/jpeg", extension: "jpg", quality: 0.88 },
];

function getCompressedImageName(name: string, extension: string) {
	const baseName = name.replace(/\.[^.]+$/, "") || name;
	return `${baseName}.${extension}`;
}

function loadImageElement(file: File): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const objectUrl = URL.createObjectURL(file);
		const image = new Image();
		image.onload = () => {
			URL.revokeObjectURL(objectUrl);
			resolve(image);
		};
		image.onerror = () => {
			URL.revokeObjectURL(objectUrl);
			reject(new Error("Failed to decode image"));
		};
		image.src = objectUrl;
	});
}

function canvasToImageBlob(
	canvas: HTMLCanvasElement,
	mediaType: PublicAssetMimeType,
	quality: number,
): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(blob) => {
				if (blob) resolve(blob);
				else reject(new Error("Failed to encode image"));
			},
			mediaType,
			quality,
		);
	});
}

async function encodeChatImageCanvas(canvas: HTMLCanvasElement) {
	for (const format of CHAT_IMAGE_OUTPUT_FORMATS) {
		const blob = await canvasToImageBlob(
			canvas,
			format.mimeType,
			format.quality,
		).catch(() => null);
		if (blob?.type === format.mimeType) return { ...format, blob };
	}
	throw new Error("Failed to encode image");
}

export async function prepareChatImageAttachment(
	file: File,
): Promise<PreparedChatImageAttachment> {
	try {
		const image = await loadImageElement(file);
		const longestEdge = Math.max(image.naturalWidth, image.naturalHeight);
		const scale =
			longestEdge > CHAT_IMAGE_MAX_EDGE ? CHAT_IMAGE_MAX_EDGE / longestEdge : 1;
		const width = Math.max(1, Math.round(image.naturalWidth * scale));
		const height = Math.max(1, Math.round(image.naturalHeight * scale));
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const context = canvas.getContext("2d");
		if (!context) throw new Error("Canvas is not supported");
		context.drawImage(image, 0, 0, width, height);
		const encoded = await encodeChatImageCanvas(canvas);
		const name = getCompressedImageName(file.name, encoded.extension);
		const compressedFile = new File([encoded.blob], name, {
			type: encoded.mimeType,
			lastModified: Date.now(),
		});
		return {
			file: compressedFile,
			mediaType: encoded.mimeType,
			name,
			previewUrl: URL.createObjectURL(compressedFile),
			size: compressedFile.size,
			width,
			height,
		};
	} catch {
		throw new Error(
			`Could not process image "${file.name}". Use JPG, PNG, GIF, or WebP.`,
		);
	}
}

type PublicAssetUploadOptions = {
	onProgress?: (progress: PublicAssetUploadProgress) => void;
	signal?: AbortSignal;
};

const attachmentUploads = new WeakMap<File, Map<string, ReturnType<typeof sdk.publicAssets.createUploadTask>>>();

export async function cancelChatAttachmentUpload(file: File) {
	const tasks = attachmentUploads.get(file);
	attachmentUploads.delete(file);
	if (tasks) await Promise.allSettled([...tasks.values()].map((task) => task.cancel()));
}

function uploadChatAttachment(input: UploadPublicAssetInput & { file: File }) {
	const account = authStore.userUuid ?? authStore.claims?.sub ?? authStore.hostSubjectKey;
	if (!account) return sdk.publicAssets.upload(input);
	const key = JSON.stringify([account, input.spaceId, input.sessionId, input.mimeType, input.filename]);
	let tasks = attachmentUploads.get(input.file);
	if (!tasks) {
		tasks = new Map();
		attachmentUploads.set(input.file, tasks);
	}
	let task = tasks.get(key);
	if (!task) {
		task = sdk.publicAssets.createUploadTask({ ...input, signal: undefined, onProgress: undefined });
		tasks.set(key, task);
	}
	return task.run({ signal: input.signal, onProgress: input.onProgress });
}

export async function uploadUserAvatarImage(
	file: File,
	options: PublicAssetUploadOptions = {},
) {
	const avatar = await normalizeAvatarImage(file);
	return sdk.publicAssets.upload({
		purpose: "user_avatar",
		file: avatar.file,
		mimeType: avatar.mimeType,
		filename: `avatar.${avatar.extension}`,
		onProgress: options.onProgress,
		signal: options.signal,
	});
}

export async function uploadSpaceAvatarImage(input: {
	spaceId: string;
	file: File;
	onProgress?: (progress: PublicAssetUploadProgress) => void;
	signal?: AbortSignal;
}) {
	const avatar = await normalizeAvatarImage(input.file);
	return sdk.publicAssets.upload({
		purpose: "space_avatar",
		spaceId: input.spaceId,
		file: avatar.file,
		mimeType: avatar.mimeType,
		filename: `avatar.${avatar.extension}`,
		onProgress: input.onProgress,
		signal: input.signal,
	});
}

export function uploadChatAttachmentImage(input: {
	spaceId?: string;
	sessionId?: string;
	file: File;
	mediaType: PublicAssetMimeType;
	filename: string;
	onProgress?: (progress: PublicAssetUploadProgress) => void;
	signal?: AbortSignal;
}) {
	return uploadChatAttachment({
		purpose: "chat_attachment",
		spaceId: input.spaceId,
		sessionId: input.sessionId,
		file: input.file,
		mimeType: input.mediaType,
		filename: input.filename,
		onProgress: input.onProgress,
		signal: input.signal,
	});
}

/** Durable public upload for any chat file (no space required). */
export function uploadChatAttachmentFile(input: {
	spaceId?: string;
	sessionId?: string;
	file: File;
	filename?: string;
	onProgress?: (progress: PublicAssetUploadProgress) => void;
	signal?: AbortSignal;
}) {
	return uploadChatAttachment({
		purpose: "chat_attachment",
		spaceId: input.spaceId,
		sessionId: input.sessionId,
		file: input.file,
		mimeType: input.file.type || "application/octet-stream",
		filename: input.filename ?? input.file.name,
		onProgress: input.onProgress,
		signal: input.signal,
	});
}
