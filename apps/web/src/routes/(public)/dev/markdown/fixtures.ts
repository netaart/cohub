import cjk from "./fixtures/cjk.md?raw";
import code from "./fixtures/code.md?raw";
import reply from "./fixtures/reply.md?raw";

const long = Array.from(
	{ length: 4 },
	(_, round) => `# Part ${round + 1}\n\n${reply}\n\n${code}\n\n${cjk}`,
).join("\n\n");

export const MARKDOWN_FIXTURES = { reply, code, cjk, long } as const;

export type MarkdownFixture = keyof typeof MARKDOWN_FIXTURES;

export function uniquify(source: string, tag: string) {
	return source
		.replaceAll(" the ", ` the(${tag}) `)
		.replaceAll("的", `的${tag}`)
		.replace(/^(```\w+)\n/gm, `$1\n${tag}\n`);
}

export function historyMessages(count: number, nonce: string) {
	const sources = [reply, code, cjk];
	return Array.from({ length: count }, (_, index) =>
		uniquify(sources[index % sources.length], `${nonce}-${index}`),
	);
}
