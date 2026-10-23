import type { ContentBlock } from "@cohub/protocol/core";

function cloneContentBlock(block: ContentBlock): ContentBlock {
	if (block.type === "text") return { ...block };
	if (block.type === "thinking") return { ...block };
	if (block.type === "image") {
		return {
			...block,
			source: { ...block.source },
		};
	}
	if (block.type === "shell_command") return { ...block };
	if (block.type === "tool_use") {
		return {
			...block,
			input: { ...block.input },
		};
	}
	if (block.type === "tool_result") {
		return {
			...block,
			content: Array.isArray(block.content)
				? block.content.flatMap((item: unknown): ContentBlock[] =>
						typeof item === "object" && item !== null && "type" in item
							? [cloneContentBlock(item as ContentBlock)]
							: [],
					)
				: block.content,
		};
	}
	return { ...block };
}

function getStreamIndex(block: ContentBlock): number | null {
	const value = block._meta?.streamIndex;
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function findMergeTargetIndex(
	result: ContentBlock[],
	block: ContentBlock,
): number {
	const streamIndex = getStreamIndex(block);
	if (streamIndex != null) {
		return result.findIndex(
			(existing) =>
				existing.type === block.type &&
				getStreamIndex(existing) === streamIndex,
		);
	}

	if (block.type === "tool_use") {
		return result.findIndex(
			(existing) => existing.type === "tool_use" && existing.id === block.id,
		);
	}

	if (block.type === "tool_result") {
		return result.findIndex(
			(existing) =>
				existing.type === "tool_result" &&
				existing.tool_use_id === block.tool_use_id,
		);
	}

	return -1;
}

export function mergeStreamingDeltaBlocks(
	existing: ContentBlock[],
	delta: ContentBlock[],
): ContentBlock[] {
	if (delta.length === 0) return existing;

	const result = existing.map((block) => cloneContentBlock(block));

	for (const block of delta) {
		const targetIndex = findMergeTargetIndex(result, block);
		if (targetIndex === -1) {
			result.push(cloneContentBlock(block));
			continue;
		}

		const target = result[targetIndex];
		if (block.type === "text" && target?.type === "text") {
			target.text += block.text;
			continue;
		}
		if (block.type === "thinking" && target?.type === "thinking") {
			target.thinking += block.thinking;
			if (block.signature) target.signature = block.signature;
			if (block._meta)
				target._meta = { ...(target._meta ?? {}), ...block._meta };
			continue;
		}

		result[targetIndex] = Object.assign(target, cloneContentBlock(block));
	}

	return result;
}
