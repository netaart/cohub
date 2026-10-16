import assert from "node:assert/strict";
import { test } from "node:test";
import type { PublicGenerationDeclaration } from "@cohub/protocol/generation";
import type { TaskRunRecord } from "@neta-art/cohub";
import {
	buildBoardGenerationContent,
	generationAspectRatio,
	generationOutputMeta,
	modelAcceptsGenerationReferences,
	operationAcceptsGenerationReferences,
	parseBoardGenerationReferences,
	regenerationRequestFromTaskRun,
	validateBoardGeneration,
} from "$lib/board/board-generation";
import { generationModelKind } from "$lib/generation-model-catalog";
import {
	declaredGenerationParameters,
	editableGenerationParameters,
	generationParametersError,
	parseListParameter,
	storedGenerationParameters,
} from "$lib/generation-parameters";
import { mediaFilename } from "$lib/media-download";
import { generationModelOutputs, remoteModelSource } from "$lib/model3d/remote";
import { isValidCachedGenerationModel } from "$lib/stores/generation-models-validation";

const meshy = {
	schema: "neta.generation.model.v1",
	model: "meshy",
	title: "Meshy",
	category: "3d",
	content: { input: [] },
	parameters: {
		operation: {
			type: "string",
			enum: [
				"text-to-3d",
				"text-to-3d-refine",
				"remesh",
				"text-to-motion",
				"animation",
			],
		},
		max_wait: {
			type: "integer",
			optional: true,
			default: 3600,
			min: 60,
			max: 7200,
		},
	},
	operations: {
		"text-to-3d": {
			title: "Text To 3D",
			content: { input: [{ type: "text", required: true, min: 1, max: 16 }] },
			parameters: {
				target_formats: {
					type: "array",
					optional: true,
					items: { type: "string", enum: ["glb", "obj", "fbx"] },
					min: 1,
					unique: true,
				},
			},
		},
		"text-to-3d-refine": {
			content: {
				input: [
					{ type: "3d", required: true, min: 1, max: 1, sources: ["url"] },
					{ type: "text", required: false, max: 16 },
				],
			},
		},
		remesh: {
			content: {
				input: [
					{ type: "3d", required: true, min: 1, max: 1, sources: ["url"] },
				],
			},
		},
		"text-to-motion": {
			content: { input: [{ type: "text", required: true, min: 1, max: 16 }] },
			parameters: {
				duration: { type: "number", min: 2, max: 10, multipleOf: 0.5 },
			},
		},
		animation: {
			content: {
				input: [
					{
						type: "3d",
						required: true,
						min: 1,
						max: 2,
						sources: ["url"],
						roles: ["motion"],
					},
				],
			},
			parameters: {
				action_ids: {
					type: "array",
					optional: true,
					items: { type: "integer", min: 0 },
					min: 1,
					max: 10,
					unique: true,
				},
			},
		},
	},
} as unknown as PublicGenerationDeclaration;

const imageModel = {
	schema: "neta.generation.model.v1",
	model: "image-pro",
	content: {
		input: [
			{ type: "text", required: true },
			{ type: "image", max: 4 },
		],
	},
	parameters: {
		aspect_ratio: { type: "string", enum: ["1:1", "16:9"], default: "16:9" },
	},
} as unknown as PublicGenerationDeclaration;

const glb = "https://router-files.neta.art/files/a/model.glb";
const fbx = "https://router-files.neta.art/files/a/model.fbx";
const preview = "https://router-files.neta.art/files/a/preview.png";
const texture = "https://router-files.neta.art/files/a/texture.png";
const outputMeta = {
	field: "model_urls.glb",
	format: "glb",
	task_id: "task_1",
	task_type: "text-to-3d",
};
const meshyOutput = [
	{ type: "3d", source: { type: "url", url: glb }, meta: outputMeta },
	{
		type: "3d",
		source: { type: "url", url: fbx },
		meta: { ...outputMeta, field: "model_urls.fbx", format: "fbx" },
	},
	{
		type: "image",
		source: { type: "url", url: preview },
		meta: { field: "thumbnail_url", task_id: "task_1" },
	},
	{
		type: "image",
		source: { type: "url", url: texture },
		meta: { field: "texture_urls.0.base_color" },
	},
];
const modelReference = {
	id: "item-1",
	type: "3d" as const,
	url: glb,
	label: "Robot",
	meta: outputMeta,
};

test("cached declarations keep operations and array parameters", () => {
	assert.equal(isValidCachedGenerationModel(meshy), true);
	const withParameters = (parameters: unknown) => ({
		...meshy,
		operations: { remesh: { parameters } },
	});
	assert.equal(
		isValidCachedGenerationModel(
			withParameters({ formats: { type: "array" } }),
		),
		false,
	);
	assert.equal(
		isValidCachedGenerationModel(
			withParameters({ ids: { type: "array", items: { type: "number" } } }),
		),
		false,
	);
	assert.equal(
		isValidCachedGenerationModel({ ...meshy, operations: { remesh: "glb" } }),
		false,
	);
});

test("a request sends the parameters the selected operation declares", () => {
	const saved = {
		operation: "text-to-3d",
		target_formats: ["glb"],
		action_ids: [1],
		max_wait: 120,
	};
	assert.deepEqual(declaredGenerationParameters(meshy, saved), {
		operation: "text-to-3d",
		target_formats: ["glb"],
		max_wait: 120,
	});
	assert.deepEqual(
		editableGenerationParameters(meshy, saved).map(([name]) => name),
		["max_wait", "target_formats"],
	);
	assert.deepEqual(
		editableGenerationParameters(imageModel, {}).map(([name]) => name),
		["aspect_ratio"],
	);
});

test("parameter errors cover operations, lists, and steps", () => {
	const error = (parameters: Record<string, unknown>) =>
		generationParametersError(meshy, parameters, "en");
	assert.equal(error({}), "Choose an operation.");
	assert.equal(error({ operation: "text-to-3d" }), null);
	assert.equal(
		error({ operation: "text-to-3d", target_formats: ["glb", "usdz"] }),
		"Choose a valid target formats.",
	);
	assert.equal(
		error({ operation: "text-to-3d", target_formats: [] }),
		"Choose at least 1 for target formats.",
	);
	assert.equal(
		error({ operation: "text-to-3d", target_formats: ["glb", "glb"] }),
		"target formats must not repeat items.",
	);
	assert.equal(
		error({ operation: "animation", action_ids: [1, -1] }),
		"action ids must be at least 0.",
	);
	assert.equal(
		error({ operation: "animation", action_ids: [1, Number.NaN] }),
		"action ids must use whole numbers.",
	);
	assert.equal(error({ operation: "text-to-motion" }), "Set duration.");
	assert.equal(
		error({ operation: "text-to-motion", duration: 2.25 }),
		"duration must be a multiple of 0.5.",
	);
	assert.equal(error({ operation: "text-to-motion", duration: 2.5 }), null);
	assert.equal(generationParametersError(meshy, {}, "zh-CN"), "请选择功能。");
});

test("list parameters parse from text and restore from drafts", () => {
	assert.deepEqual(
		parseListParameter(" 3, 7 ,, x", { type: "integer", min: 0 }),
		[3, 7, Number.NaN],
	);
	assert.deepEqual(parseListParameter("glb, obj", { type: "string" }), [
		"glb",
		"obj",
	]);
	assert.deepEqual(
		storedGenerationParameters({
			operation: "remesh",
			target_formats: ["glb"],
			nested: { a: 1 },
			mixed: [1, {}],
		}),
		{ operation: "remesh", target_formats: ["glb"] },
	);
	assert.deepEqual(storedGenerationParameters(["glb"]), {});
});

test("3D references pick the operations that accept them", () => {
	assert.equal(modelAcceptsGenerationReferences(meshy, [modelReference]), true);
	assert.equal(
		modelAcceptsGenerationReferences(imageModel, [modelReference]),
		false,
	);
	const accepts = (name: string) =>
		operationAcceptsGenerationReferences(meshy, { name }, [modelReference]);
	assert.equal(accepts("text-to-3d"), false);
	assert.equal(accepts("text-to-3d-refine"), true);
	assert.equal(accepts("remesh"), true);
});

test("board generation validates the selected operation", () => {
	const validate = (parameters: Record<string, unknown>, prompt = "") =>
		validateBoardGeneration({
			model: meshy,
			prompt,
			references: [modelReference],
			parameters,
			locale: "en",
		});
	assert.equal(validate({}), "Choose an operation.");
	assert.equal(
		validate({ operation: "text-to-3d" }, "a robot"),
		"The selected model does not support these references.",
	);
	assert.equal(
		validate({ operation: "text-to-3d-refine" }, "rusty metal"),
		null,
	);
	assert.equal(
		validateBoardGeneration({
			model: meshy,
			prompt: "",
			references: [],
			parameters: { operation: "remesh" },
			locale: "en",
		}),
		"Add 3D model input.",
	);
});

test("3D references carry their output meta into the request", () => {
	assert.deepEqual(
		buildBoardGenerationContent("rusty metal", [
			{ ...modelReference, role: "motion" },
		]),
		[
			{ type: "text", text: "rusty metal" },
			{
				type: "3d",
				source: { type: "url", url: glb },
				meta: { ...outputMeta, role: "motion" },
			},
		],
	);
	const run = { result: { output: meshyOutput } } as unknown as TaskRunRecord;
	assert.deepEqual(generationOutputMeta(run, glb), outputMeta);
	assert.equal(
		generationOutputMeta(run, "https://example.com/other.glb"),
		undefined,
	);
	assert.deepEqual(
		parseBoardGenerationReferences([
			modelReference,
			{ ...modelReference, type: "mesh" },
		]),
		[modelReference],
	);
});

test("3D generations regenerate and lay out as squares", () => {
	const content = [
		{ type: "3d", source: { type: "url", url: glb }, meta: outputMeta },
	];
	const run = {
		taskType: "generation",
		spaceId: "space-1",
		payload: {
			data: { model: "meshy", content, parameters: { operation: "remesh" } },
		},
	} as unknown as TaskRunRecord;
	assert.deepEqual(regenerationRequestFromTaskRun(run, "space-1"), {
		spaceId: "space-1",
		model: "meshy",
		content,
		parameters: { operation: "remesh" },
	});
	assert.equal(generationAspectRatio(meshy, {}), 1);
	assert.equal(generationAspectRatio(imageModel, {}), 16 / 9);
});

test("model kinds follow the declared category", () => {
	assert.equal(generationModelKind(meshy, "en"), "3D");
	assert.equal(generationModelKind(imageModel, "en"), "Image");
});

test("3D outputs list every format with the still that depicts them", () => {
	const { models, modelIndexes, coverIndexes } =
		generationModelOutputs(meshyOutput);
	assert.deepEqual(models, [
		{ url: glb, format: "glb", previewUrl: preview, name: "model.glb" },
		{ url: fbx, format: "fbx", previewUrl: preview, name: "model.fbx" },
	]);
	assert.deepEqual(modelIndexes, [0, 1]);
	assert.deepEqual([...coverIndexes], [2]);
	assert.equal(remoteModelSource(models[0])?.format, "glb");
	assert.equal(remoteModelSource(models[1]), null);
	assert.equal(
		mediaFilename({ src: "https://cdn.example.com/files/7f3a", type: "3d" }),
		"7f3a.glb",
	);
});
