export function createBoardEntityId(): string {
	const cryptoRef = globalThis.crypto;
	if (cryptoRef && typeof cryptoRef.randomUUID === "function") return cryptoRef.randomUUID();
	return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createBoardItemId(): string {
	return `item_${createBoardEntityId()}`;
}
