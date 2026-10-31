import type { PublicGenerationDeclaration } from "@cohub/protocol/generation";

/** The public `song2` declaration as the API serves it: the SDK declaration without `adapter`. */
export const song2Declaration = {
	schema: "neta.generation.model.v1",
	model: "song2",
	title: "Song 2",
	category: "audio",
	description:
		"Full-song generation with vocals from a style description and lyrics, optionally following an ABC score. Produces one MP3 per request.",
	content: {
		input: [
			{
				type: "text",
				required: true,
				min: 2,
				max: 3,
				roles: ["prompt", "lyrics", "abc"],
				roleRequired: true,
				description:
					"Text blocks by meta.role: prompt is the style description and lyrics the words to sing, up to 2000 characters each; optional abc is a score in the model's own ABC dialect, such as one returned with return_abc, up to 64000 characters.",
			},
		],
	},
	parameters: {
		abc_mode: {
			type: "string",
			optional: true,
			enum: ["full", "melody"],
			description:
				"How a score is used: full follows its melody and chords; melody follows only the melody and rejects chord marks. Omitted: inferred from the score, else full.",
		},
		seed: {
			type: "integer",
			optional: true,
			min: 0,
			max: 9007199254740991,
			description: "Random seed for reproducibility.",
		},
		return_abc: {
			type: "boolean",
			optional: true,
			description:
				"Also return the score the song used, as a text block with meta.role abc.",
		},
	},
	examples: [
		{
			title: "Song from style and lyrics",
			request: {
				model: "song2",
				content: [
					{
						type: "text",
						text: "bright J-pop, female vocal, piano",
						meta: {
							role: "prompt",
						},
					},
					{
						type: "text",
						text: "[verse]\nla la la",
						meta: {
							role: "lyrics",
						},
					},
				],
			},
		},
		{
			title: "Song that returns its score",
			request: {
				model: "song2",
				content: [
					{
						type: "text",
						text: "bright J-pop, female vocal, piano",
						meta: {
							role: "prompt",
						},
					},
					{
						type: "text",
						text: "[verse]\nla la la",
						meta: {
							role: "lyrics",
						},
					},
				],
				parameters: {
					seed: 7,
					return_abc: true,
				},
			},
		},
	],
} satisfies PublicGenerationDeclaration;
