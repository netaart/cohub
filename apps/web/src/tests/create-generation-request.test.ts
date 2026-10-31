import assert from "node:assert/strict";
import { test } from "node:test";
import type { PublicGenerationDeclaration } from "@cohub/protocol/generation";
import { buildCreateGenerationRequest } from "../lib/features/session-chat/create-generation-request";
import { song2Declaration } from "./fixtures/song2-declaration";

const song2 = {
	schema: "neta.generation.model.v1",
	model: "song2",
	title: "Song 2",
	content: {
		input: [
			{ type: "text", roles: ["prompt", "lyrics", "abc"], min: 1, max: 3 },
			{ type: "image", sources: ["url"] },
		],
	},
	parameters: {
		seed: { type: "integer", optional: true },
		return_abc: { type: "boolean", optional: true },
	},
} satisfies PublicGenerationDeclaration;

const imagePro = {
	schema: "neta.generation.model.v1",
	model: "image-pro",
	title: "Pro Image",
	content: {
		input: [{ type: "text" }, { type: "image", sources: ["url"] }],
	},
} satisfies PublicGenerationDeclaration;

test("builds a text-only create request", () => {
	assert.deepEqual(
		buildCreateGenerationRequest({
			declaration: song2,
			text: "upbeat synthwave",
			clientMessageId: "client-text",
		}),
		{
			mode: "create",
			generation: {
				model: "song2",
				content: [{ type: "text", text: "upbeat synthwave" }],
			},
			clientMessageId: "client-text",
			accessMode: "full_access",
			intent: "followup",
			schedule: { mode: "immediate" },
		},
	);
});

test("builds a create request with an uploaded image and an existing session", () => {
	assert.deepEqual(
		buildCreateGenerationRequest({
			declaration: imagePro,
			text: "a lighthouse at dusk",
			imageUrls: ["https://cdn.example.test/lighthouse.png"],
			sessionId: "session-existing",
			clientMessageId: "client-image",
		}),
		{
			mode: "create",
			sessionId: "session-existing",
			generation: {
				model: "image-pro",
				content: [
					{ type: "text", text: "a lighthouse at dusk" },
					{
						type: "image",
						source: {
							type: "url",
							url: "https://cdn.example.test/lighthouse.png",
						},
					},
				],
			},
			clientMessageId: "client-image",
			accessMode: "full_access",
			intent: "followup",
			schedule: { mode: "immediate" },
		},
	);
});

test("keeps text attachments before uploaded images", () => {
	assert.deepEqual(
		buildCreateGenerationRequest({
			declaration: song2,
			text: "summarize this",
			textAttachments: [{ text: "line one\nline two" }],
			imageUrls: ["https://cdn.example.test/lighthouse.png"],
			clientMessageId: "client-text-and-image",
		}),
		{
			mode: "create",
			generation: {
				model: "song2",
				content: [
					{ type: "text", text: "summarize this" },
					{ type: "text", text: "line one\nline two" },
					{
						type: "image",
						source: {
							type: "url",
							url: "https://cdn.example.test/lighthouse.png",
						},
					},
				],
			},
			clientMessageId: "client-text-and-image",
			accessMode: "full_access",
			intent: "followup",
			schedule: { mode: "immediate" },
		},
	);
});

test("forwards parameters under generation", () => {
	assert.deepEqual(
		buildCreateGenerationRequest({
			declaration: song2,
			text: "upbeat synthwave",
			parameters: { seed: 42, return_abc: true },
			clientMessageId: "client-params",
		}),
		{
			mode: "create",
			generation: {
				model: "song2",
				content: [{ type: "text", text: "upbeat synthwave" }],
				parameters: { seed: 42, return_abc: true },
			},
			clientMessageId: "client-params",
			accessMode: "full_access",
			intent: "followup",
			schedule: { mode: "immediate" },
		},
	);
});

test("sends one role-tagged text block per filled role with the parameters", () => {
	assert.deepEqual(
		buildCreateGenerationRequest({
			declaration: song2Declaration,
			text: "",
			roleTexts: {
				prompt: "bright J-pop, female vocal, piano",
				lyrics: "[verse]\nla la la",
				abc: "",
			},
			parameters: { seed: 7, return_abc: true },
			clientMessageId: "client-roles",
		}),
		{
			mode: "create",
			generation: {
				model: "song2",
				content: [
					{
						type: "text",
						text: "bright J-pop, female vocal, piano",
						meta: { role: "prompt" },
					},
					{
						type: "text",
						text: "[verse]\nla la la",
						meta: { role: "lyrics" },
					},
				],
				parameters: { seed: 7, return_abc: true },
			},
			clientMessageId: "client-roles",
			accessMode: "full_access",
			intent: "followup",
			schedule: { mode: "immediate" },
		},
	);
});

test("sends role text exactly as typed, drops whitespace-only boxes and follows the declared role order", () => {
	const request = buildCreateGenerationRequest({
		declaration: song2Declaration,
		text: "",
		roleTexts: {
			abc: " X:1\nK:C \n",
			lyrics: " \n ",
			prompt: "  slow ballad ",
		},
		clientMessageId: "client-order",
	});
	assert.deepEqual(request.generation?.content, [
		{ type: "text", text: "  slow ballad ", meta: { role: "prompt" } },
		{ type: "text", text: " X:1\nK:C \n", meta: { role: "abc" } },
	]);
});

// Expected strings were recorded from the builder before role support existed.
const imageWithRatio = {
	schema: "neta.generation.model.v1",
	model: "image-pro",
	title: "Pro Image",
	content: { input: [{ type: "text" }, { type: "image", sources: ["url"] }] },
	parameters: {
		aspect_ratio: { type: "string", optional: true, enum: ["1:1", "16:9"] },
	},
} satisfies PublicGenerationDeclaration;

test("a model without text roles gets the same request bytes as before role support", () => {
	const roleTexts = { prompt: "ignored", lyrics: "ignored" };
	const cases = [
		{
			input: {
				text: "a lighthouse at dusk",
				imageUrls: ["https://cdn.example.test/lighthouse.png"],
				sessionId: "session-existing",
				clientMessageId: "client-image",
			},
			recorded:
				'{"mode":"create","sessionId":"session-existing","generation":{"model":"image-pro","content":[{"type":"text","text":"a lighthouse at dusk"},{"type":"image","source":{"type":"url","url":"https://cdn.example.test/lighthouse.png"}}]},"clientMessageId":"client-image","accessMode":"full_access","intent":"followup","schedule":{"mode":"immediate"}}',
		},
		{
			input: {
				text: "a lighthouse at dusk",
				parameters: { aspect_ratio: "16:9" },
				clientMessageId: "client-params",
			},
			recorded:
				'{"mode":"create","generation":{"model":"image-pro","content":[{"type":"text","text":"a lighthouse at dusk"}],"parameters":{"aspect_ratio":"16:9"}},"clientMessageId":"client-params","accessMode":"full_access","intent":"followup","schedule":{"mode":"immediate"}}',
		},
		{
			input: {
				text: "summarize this",
				textAttachments: [{ text: "line one\nline two" }],
				clientMessageId: "client-file",
			},
			recorded:
				'{"mode":"create","generation":{"model":"image-pro","content":[{"type":"text","text":"summarize this"},{"type":"text","text":"line one\\nline two"}]},"clientMessageId":"client-file","accessMode":"full_access","intent":"followup","schedule":{"mode":"immediate"}}',
		},
	];
	for (const { input, recorded } of cases) {
		const request = { declaration: imageWithRatio, ...input };
		assert.equal(
			JSON.stringify(buildCreateGenerationRequest(request)),
			recorded,
		);
		assert.equal(
			JSON.stringify(buildCreateGenerationRequest({ ...request, roleTexts })),
			recorded,
		);
	}
});
