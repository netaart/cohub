import {
	blockFormat,
	blockPreviewUrl,
	blockUrl,
	generationCovers,
} from "@cohub/protocol";
import { type ModelFormat, modelFormatForPath } from "@cohub/protocol/fs";
import {
	createModelSource,
	fetchModelBytes,
	type ModelSource,
	remoteReferences,
} from "$lib/model3d/source";

export type GenerationModelOutput = {
	url: string;
	/** File format, such as `glb` or `fbx`. */
	format: string | null;
	/** Still of the model, from the image the generation paired with it. */
	previewUrl: string | null;
	name: string;
};

function fileName(url: string) {
	return new URL(url).pathname.split("/").pop() ?? "";
}

/** The 3D outputs of a generation, the blocks they come from, and the images that only depict them. */
export function generationModelOutputs(
	blocks: readonly Record<string, unknown>[],
) {
	const covers = generationCovers(blocks);
	const coverIndexes = new Set<number>();
	const modelIndexes: number[] = [];
	const models = blocks.flatMap((block, index): GenerationModelOutput[] => {
		const url = block.type === "3d" ? blockUrl(block) : undefined;
		if (!url) return [];
		modelIndexes.push(index);
		const cover = covers.get(index);
		if (cover !== undefined) coverIndexes.add(cover);
		const format = blockFormat(block) ?? null;
		return [
			{
				url,
				format,
				previewUrl:
					blockPreviewUrl(block) ??
					(cover === undefined ? undefined : blockUrl(blocks[cover] ?? {})) ??
					null,
				name:
					fileName(url) || `model-${index + 1}${format ? `.${format}` : ""}`,
			},
		];
	});
	return { models, modelIndexes, coverIndexes };
}

/** The format the 3D viewer reads a model as, or null when it cannot preview it. */
export function previewableModelFormat(
	format: string | null | undefined,
): ModelFormat | null {
	return format ? modelFormatForPath(`model.${format}`) : null;
}

/** A viewer source for a model at a public URL, or null when its format has no preview. */
export function remoteModelSource(model: {
	url: string;
	name: string;
	format: string | null | undefined;
}): ModelSource | null {
	const format = previewableModelFormat(model.format);
	if (!format) return null;
	return createModelSource({
		key: model.url,
		name: model.name,
		format,
		size: null,
		read: (options) => fetchModelBytes(model.url, options),
		references: () => remoteReferences(model.url),
	});
}
