import assert from "node:assert/strict";
import { test } from "node:test";
import type { PublicGenerationDeclaration } from "@cohub/protocol/generation";
import {
	type BoardGenerationReference,
	buildBoardGenerationContent,
	validateBoardGeneration,
} from "../lib/board/board-generation";
import { song2Declaration } from "./fixtures/song2-declaration";

const reference = (id: string, role?: string): BoardGenerationReference => ({
	id,
	type: "image",
	url: `https://cdn.example.test/${id}.png`,
	label: id,
	...(role ? { role } : {}),
});

test("builds one role-tagged text block per filled role", () => {
	assert.deepEqual(
		buildBoardGenerationContent("", [], {
			model: song2Declaration,
			texts: {
				prompt: "bright J-pop, female vocal, piano",
				lyrics: "[verse]\nla la la",
				abc: "",
			},
		}),
		[
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
	);
});

test("role text is built exactly as typed and a whitespace-only box counts as empty", () => {
	assert.deepEqual(
		buildBoardGenerationContent("", [], {
			model: song2Declaration,
			texts: {
				prompt: "  slow ballad ",
				lyrics: " \n ",
				abc: " X:1\nK:C \n",
			},
		}),
		[
			{ type: "text", text: "  slow ballad ", meta: { role: "prompt" } },
			{ type: "text", text: " X:1\nK:C \n", meta: { role: "abc" } },
		],
	);
	assert.match(
		validateBoardGeneration({
			model: song2Declaration,
			prompt: "",
			references: [],
			roleTexts: { prompt: "slow ballad", lyrics: " \n " },
		}) ?? "",
		/lyrics/,
	);
});

test("song2 is allowed once its required roles are filled", () => {
	assert.equal(
		validateBoardGeneration({
			model: song2Declaration,
			prompt: "",
			references: [],
			roleTexts: { prompt: "bright J-pop", lyrics: "[verse]\nla la la" },
		}),
		null,
	);
});

test("a required role left empty blocks song2 and is named", () => {
	const blocked = (roleTexts: Record<string, string>) =>
		validateBoardGeneration({
			model: song2Declaration,
			prompt: "",
			references: [],
			roleTexts,
		});
	assert.match(blocked({ prompt: "bright J-pop" }) ?? "", /lyrics/);
	assert.match(blocked({ prompt: "bright J-pop", abc: "X:1" }) ?? "", /lyrics/);
	assert.match(blocked({ lyrics: "la la la", abc: "X:1" }) ?? "", /prompt/);
	assert.match(
		blocked({ prompt: "bright J-pop", lyrics: "  \n " }) ?? "",
		/lyrics/,
	);
	assert.equal(
		blocked({ prompt: "bright J-pop", lyrics: "la la la", abc: "X:1" }),
		null,
	);
});

// Expected values below were recorded from the Board code before role support existed.
const imagePro = {
	schema: "neta.generation.model.v1",
	model: "image-pro",
	title: "Pro Image",
	content: {
		input: [
			{ type: "text", required: true },
			{ type: "image", sources: ["url"], max: 2 },
		],
	},
} satisfies PublicGenerationDeclaration;

const videoWithRoles = {
	schema: "neta.generation.model.v1",
	model: "video-ref",
	title: "Video",
	content: {
		input: [
			{ type: "text", required: true, min: 1, max: 4 },
			{
				type: "image",
				sources: ["url"],
				roles: ["first_frame", "last_frame"],
				roleRequired: true,
				max: 2,
			},
		],
	},
} satisfies PublicGenerationDeclaration;

test("a model without text roles builds the same content bytes as before role support", () => {
	const roles = { model: imagePro, texts: { prompt: "ignored" } };
	for (const withRoles of [undefined, roles]) {
		assert.equal(
			JSON.stringify(
				buildBoardGenerationContent("  a lighthouse at dusk  ", [], withRoles),
			),
			'[{"type":"text","text":"a lighthouse at dusk"}]',
		);
		assert.equal(
			JSON.stringify(
				buildBoardGenerationContent(
					"a cat",
					[reference("a"), reference("b", "first_frame")],
					withRoles,
				),
			),
			'[{"type":"text","text":"a cat"},{"type":"image","source":{"type":"url","url":"https://cdn.example.test/a.png"}},{"type":"image","source":{"type":"url","url":"https://cdn.example.test/b.png"},"meta":{"role":"first_frame"}}]',
		);
		assert.equal(
			JSON.stringify(
				buildBoardGenerationContent("   ", [reference("a")], withRoles),
			),
			'[{"type":"image","source":{"type":"url","url":"https://cdn.example.test/a.png"}}]',
		);
	}
});

test("a model without text roles validates as before role support", () => {
	const variants: (Record<string, string> | undefined)[] = [
		undefined,
		{},
		{ prompt: "ignored" },
	];
	for (const roleTexts of variants) {
		const check = (
			model: PublicGenerationDeclaration,
			prompt: string,
			references: BoardGenerationReference[],
		) => validateBoardGeneration({ model, prompt, references, roleTexts });
		assert.equal(check(imagePro, "x", []), null);
		assert.equal(check(imagePro, " ", []), "Add text input.");
		assert.equal(
			check(videoWithRoles, "x", [reference("a")]),
			"Choose a role for each image reference.",
		);
		assert.equal(
			check(videoWithRoles, "x", [reference("a", "first_frame")]),
			null,
		);
	}
});

test("callers that pass no role texts keep the old text count for song2", () => {
	const check = (prompt: string) =>
		validateBoardGeneration({
			model: song2Declaration,
			prompt,
			references: [],
		});
	assert.equal(check("style"), "Add at least 2 text inputs.");
	assert.equal(check(""), "Add text input.");
});
