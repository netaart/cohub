/**
 * Pure stream-identity helpers shared by generation store paths and tests.
 * Keep this module free of store/auth/sdk imports so node:test can use it.
 */

export type StreamMessageIdentity = {
	messageOrdinal?: number | null;
	messageId?: string | null;
	streamMessageId?: string | null;
	id?: string | null;
};

export type ArchivedStreamMessage = {
	messageOrdinal?: number | null;
	messageId?: string | null;
	id?: string | null;
};

/** Whether a live store identity and an incoming event refer to the same assistant message. */
export function isSameLiveMessage(
	current: StreamMessageIdentity,
	event: StreamMessageIdentity,
): boolean {
	const eventOrdinal = event.messageOrdinal ?? null;
	const currentOrdinal = current.messageOrdinal ?? null;
	if (
		eventOrdinal != null &&
		currentOrdinal != null &&
		eventOrdinal === currentOrdinal
	) {
		return true;
	}

	const eventId = event.messageId ?? event.streamMessageId ?? null;
	const currentId = current.streamMessageId ?? current.messageId ?? null;
	if (eventId && currentId && eventId === currentId) {
		return true;
	}

	// Both sides still anonymous — treat as the same live stream identity.
	return (
		eventOrdinal == null && !eventId && currentOrdinal == null && !currentId
	);
}

/** Whether an incoming identity already belongs to an archived intermediate round. */
export function isArchivedMessageIdentity(
	intermediates: readonly ArchivedStreamMessage[],
	event: StreamMessageIdentity,
): boolean {
	const eventOrdinal = event.messageOrdinal ?? null;
	const eventId = event.messageId ?? event.streamMessageId ?? null;
	if (eventOrdinal == null && !eventId) return false;

	return intermediates.some((message) => {
		if (
			eventOrdinal != null &&
			message.messageOrdinal != null &&
			eventOrdinal === message.messageOrdinal
		) {
			return true;
		}
		if (!eventId) return false;
		if (message.messageId && eventId === message.messageId) return true;
		if (message.id && eventId === message.id) return true;
		return false;
	});
}

/**
 * Next assistant round already owns live identity — archive should only fold
 * history, never clear the newer identity/patchSeq/preview.
 */
export function shouldPreserveLivePreviewOnArchive(
	current: StreamMessageIdentity,
	archived: ArchivedStreamMessage | null | undefined,
): boolean {
	if (!archived) return false;

	// Persisted messages may use a DB id instead of the stream id.
	// When both ordinals exist, they are the authoritative round identity.
	if (archived.messageOrdinal != null && current.messageOrdinal != null) {
		return current.messageOrdinal !== archived.messageOrdinal;
	}
	const currentId = current.streamMessageId ?? current.messageId ?? null;
	const archivedId = archived.messageId ?? archived.id ?? null;
	return Boolean(archivedId && currentId && currentId !== archivedId);
}
