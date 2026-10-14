export type CodexQuestionReply = { question: string; answer: string };

const openingTag = "<send_user_message_question_reply>";
const closingTag = "</send_user_message_question_reply>";

/** Presentation only: an unrecognized payload must remain visible verbatim. */
export function parseCodexQuestionReply(
	text: string,
): CodexQuestionReply[] | null {
	const value = text.trim();
	if (!value.startsWith(openingTag) || !value.endsWith(closingTag)) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(value.slice(openingTag.length, -closingTag.length));
	} catch {
		return null;
	}
	if (!Array.isArray(parsed) || parsed.length === 0) return null;
	const replies: CodexQuestionReply[] = [];
	for (const item of parsed) {
		if (
			!item ||
			typeof item !== "object" ||
			typeof item.question !== "string" ||
			!item.question.trim() ||
			typeof item.answer !== "string"
		)
			return null;
		replies.push({ question: item.question, answer: item.answer });
	}
	return replies;
}

export function questionReplyCopyText(text: string): string {
	const replies = parseCodexQuestionReply(text);
	return replies
		? replies
				.map(({ question, answer }) => `${question}\n${answer}`)
				.join("\n\n")
		: text;
}
