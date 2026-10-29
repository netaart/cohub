import {
	type ComposerAttachment,
	type ComposerFileAttachment,
	type ComposerImageAttachment,
	createComposerAttachmentId,
	isComposerImageFile,
	isSupportedComposerAttachmentFile,
	isSupportedComposerImageFile,
	MAX_COMPOSER_ATTACHMENTS,
	MAX_COMPOSER_TEXT_ATTACHMENT_BYTES,
	readComposerTextAttachment,
} from "$lib/composer-attachments";
import type { Locale } from "$lib/i18n/locale";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { cancelChatAttachmentUpload, prepareChatImageAttachment } from "$lib/public-asset-images";
import { entriesFromFiles, type LocalUploadEntry } from "$lib/upload-entries";
import {
	exceedsUploadFileLimit,
	uploadFileLimitLabel,
} from "$lib/upload-errors";

export function revokeComposerAttachmentPreview(
	attachment: ComposerAttachment,
) {
	if (attachment.kind === "image") URL.revokeObjectURL(attachment.previewUrl);
}

function rejectionNotices(
	tooLarge: LocalUploadEntry[],
	empty: LocalUploadEntry[],
	locale: Locale,
) {
	const limit = uploadFileLimitLabel();
	const notices: string[] = [];
	if (tooLarge.length === 1)
		notices.push(
			m.attach_rejected_too_large_one(
				{ name: tooLarge[0].file.name, limit },
				{ locale },
			),
		);
	else if (tooLarge.length > 1)
		notices.push(
			m.attach_rejected_too_large_many(
				{ count: tooLarge.length, limit },
				{ locale },
			),
		);
	if (empty.length === 1)
		notices.push(
			m.attach_rejected_empty_one({ name: empty[0].file.name }, { locale }),
		);
	else if (empty.length > 1)
		notices.push(
			m.attach_rejected_empty_many({ count: empty.length }, { locale }),
		);
	return notices;
}

export function createSessionComposerController() {
	let input = $state("");
	let attachments = $state<ComposerAttachment[]>([]);
	let sending = $state(false);
	let aborting = $state(false);
	let error = $state("");
	let errorCode = $state<string | null>(null);

	function clearError() {
		error = "";
		errorCode = null;
	}

	function setError(message: string, code: string | null = null) {
		error = message;
		errorCode = code;
	}

	function setAttachments(next: ComposerAttachment[]) {
		attachments = next;
	}

	function setUploading(kind: "file" | "image") {
		attachments = attachments.map((attachment) =>
			attachment.kind === kind
				? { ...attachment, status: "uploading" as const, progress: 0 }
				: attachment,
		);
	}

	function setAttachmentUploadProgress(id: string, progress: number) {
		const normalizedProgress = Math.round(Math.max(0, Math.min(100, progress)));
		const current = attachments.find(
			(
				attachment,
			): attachment is ComposerFileAttachment | ComposerImageAttachment =>
				(attachment.kind === "file" || attachment.kind === "image") &&
				attachment.id === id,
		);
		if (
			!current ||
			(current.status === "uploading" &&
				current.progress === normalizedProgress)
		)
			return;
		attachments = attachments.map((attachment) =>
			attachment === current
				? {
						...attachment,
						status: "uploading" as const,
						progress: normalizedProgress,
					}
				: attachment,
		);
	}

	function setAttachmentFinalizing(id: string) {
		attachments = attachments.map((attachment) =>
			(attachment.kind === "file" || attachment.kind === "image") &&
			attachment.id === id
				? { ...attachment, status: "finalizing" as const, progress: 100 }
				: attachment,
		);
	}

	function setUploadedImageUrls(imageUrls: Map<string, string>) {
		attachments = attachments.map((attachment) =>
			attachment.kind === "image" && imageUrls.has(attachment.id)
				? {
						...attachment,
						status: "finalizing" as const,
						progress: 100,
						uploadedUrl: imageUrls.get(attachment.id) ?? attachment.uploadedUrl,
					}
				: attachment,
		);
	}

	function clearDraft() {
		input = "";
		attachments = [];
	}

	function restoreDraft(
		nextInput: string,
		nextAttachments: ComposerAttachment[],
	) {
		input = nextInput;
		attachments = nextAttachments;
	}

	function markAttachmentUploadsFailed() {
		attachments = attachments.map((attachment) =>
			attachment.kind === "file" || attachment.kind === "image"
				? { ...attachment, status: "failed" as const, progress: undefined }
				: attachment,
		);
	}

	async function handlePickAttachments(
		files: FileList | File[] | LocalUploadEntry[] | null,
	) {
		if (!files) return;
		const locale = getLocale();
		let pickedEntries: LocalUploadEntry[];
		try {
			pickedEntries =
				Array.isArray(files) &&
				files.every((item) => "file" in item && "relativePath" in item)
					? (files as LocalUploadEntry[])
					: entriesFromFiles(Array.from(files as FileList | File[]));
		} catch {
			setError(m.attach_invalid_path({}, { locale }));
			return;
		}
		if (pickedEntries.length === 0) return;

		// Reject files that can never upload before they take an attachment slot.
		const tooLarge = pickedEntries.filter((entry) =>
			exceedsUploadFileLimit(entry.file),
		);
		const empty = pickedEntries.filter((entry) => entry.file.size === 0);
		const attachable = pickedEntries.filter(
			(entry) => entry.file.size > 0 && !exceedsUploadFileLimit(entry.file),
		);
		const notices = rejectionNotices(tooLarge, empty, locale);

		const remainingSlots = MAX_COMPOSER_ATTACHMENTS - attachments.length;
		if (attachable.length > 0 && remainingSlots <= 0) {
			notices.unshift(
				m.attach_limit_reached({ max: MAX_COMPOSER_ATTACHMENTS }, { locale }),
			);
		} else if (attachable.length > remainingSlots) {
			notices.unshift(
				remainingSlots === 1
					? m.attach_partial_one({ max: MAX_COMPOSER_ATTACHMENTS }, { locale })
					: m.attach_partial_many(
							{ max: MAX_COMPOSER_ATTACHMENTS, count: remainingSlots },
							{ locale },
						),
			);
		}
		if (notices.length > 0) setError(notices.join(" "));
		else clearError();

		const acceptedEntries = attachable.slice(0, Math.max(0, remainingSlots));
		if (acceptedEntries.length === 0) return;

		try {
			const nextAttachments = await Promise.all(
				acceptedEntries.map(async (entry): Promise<ComposerAttachment> => {
					const { file, relativePath } = entry;
					const fallbackFileAttachment = (): ComposerFileAttachment => ({
						kind: "file",
						id: createComposerAttachmentId(file),
						name: file.name,
						relativePath,
						mediaType: file.type || null,
						file,
						size: file.size,
						status: "ready",
					});
					if (!isSupportedComposerAttachmentFile(file))
						return fallbackFileAttachment();
					if (!isComposerImageFile(file)) {
						return file.size > MAX_COMPOSER_TEXT_ATTACHMENT_BYTES
							? fallbackFileAttachment()
							: await readComposerTextAttachment(file);
					}
					if (!isSupportedComposerImageFile(file))
						return fallbackFileAttachment();
					try {
						const compressed = await prepareChatImageAttachment(file);
						return {
							kind: "image",
							id: createComposerAttachmentId(file),
							name: compressed.name,
							mediaType: compressed.mediaType,
							file: compressed.file,
							previewUrl: compressed.previewUrl,
							size: compressed.size,
							width: compressed.width,
							height: compressed.height,
							status: "ready",
						} satisfies ComposerImageAttachment;
					} catch (error) {
						console.warn("[composer] image preprocessing failed", {
							name: file.name,
							type: file.type,
							size: file.size,
							error,
						});
						return fallbackFileAttachment();
					}
				}),
			);
			attachments = [...attachments, ...nextAttachments];
		} catch (error) {
			console.warn("[composer] failed to read attachment", error);
			setError(m.attach_read_failed({}, { locale }));
		}
	}

	function handleRemoveAttachment(id: string) {
		const removed = attachments.find((attachment) => attachment.id === id);
		if (removed) revokeComposerAttachmentPreview(removed);
		if (removed?.kind === "file" || removed?.kind === "image")
			void cancelChatAttachmentUpload(removed.file);
		attachments = attachments.filter((attachment) => attachment.id !== id);
	}

	function dispose() {
		for (const attachment of attachments) {
			revokeComposerAttachmentPreview(attachment);
			if (attachment.kind === "file" || attachment.kind === "image")
				void cancelChatAttachmentUpload(attachment.file);
		}
	}

	return {
		get input() {
			return input;
		},
		set input(value: string) {
			input = value;
		},
		get attachments() {
			return attachments;
		},
		set attachments(value: ComposerAttachment[]) {
			attachments = value;
		},
		get sending() {
			return sending;
		},
		set sending(value: boolean) {
			sending = value;
		},
		get aborting() {
			return aborting;
		},
		set aborting(value: boolean) {
			aborting = value;
		},
		get error() {
			return error;
		},
		get errorCode() {
			return errorCode;
		},
		clearError,
		setError,
		setAttachments,
		setUploading,
		setAttachmentUploadProgress,
		setAttachmentFinalizing,
		setUploadedImageUrls,
		clearDraft,
		restoreDraft,
		markAttachmentUploadsFailed,
		handlePickAttachments,
		handleRemoveAttachment,
		dispose,
	};
}
