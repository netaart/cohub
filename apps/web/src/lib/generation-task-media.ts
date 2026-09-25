type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function readString(record: RecordValue, keys: readonly string[]) {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && /\S/.test(value)) return value.trim();
	}
	return null;
}

function textFromBlock(block: RecordValue): string | null {
	if (block.type !== "text") return null;
	return readString(block, ["text", "content", "value"]);
}

export function extractGenerationPromptPreview(
	payload: unknown,
): string | null {
	const root = isRecord(payload) ? payload : null;
	const data = root && isRecord(root.data) ? root.data : root;
	const content = data?.content;
	if (!Array.isArray(content)) return null;
	const text = content
		.filter(isRecord)
		.map(textFromBlock)
		.filter(Boolean)
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
	return text || null;
}
