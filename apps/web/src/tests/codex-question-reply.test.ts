import assert from "node:assert/strict";
import { test } from "node:test";
import {
	parseCodexQuestionReply,
	questionReplyCopyText,
} from "../lib/messages/codex-question-reply.ts";

const wrap = (value: unknown) =>
	`<send_user_message_question_reply>\n${JSON.stringify(value)}\n</send_user_message_question_reply>`;
const reply = {
	questionItemId: '["request_user_input_async","call_test",0]',
	question: "Does the window now open?",
	answer: "It opens, but the width is still wrong",
};

test("presents the question and answer without transport metadata", () => {
	assert.deepEqual(parseCodexQuestionReply(wrap([reply])), [
		{ question: reply.question, answer: reply.answer },
	]);
});

test("preserves multiple answers, order, whitespace and empty replies", () => {
	assert.deepEqual(
		parseCodexQuestionReply(
			` \n${wrap([
				reply,
				{ question: "Choose a path", answer: " A\nB " },
				{ question: "Anything else?", answer: "" },
			])}\n `,
		),
		[
			{ question: reply.question, answer: reply.answer },
			{ question: "Choose a path", answer: " A\nB " },
			{ question: "Anything else?", answer: "" },
		],
	);
});

test("retains raw text for malformed, partial or unsupported reply payloads", () => {
	for (const raw of [
		"An ordinary user message",
		"<send_user_message_question_reply>{broken}</send_user_message_question_reply>",
		"<send_user_message_question_reply>[",
		wrap([]),
		wrap(reply),
		wrap([null]),
		wrap([{ question: "Question", answer: ["Choice"] }]),
		wrap([{ question: "Question" }]),
		wrap([{ question: 4, answer: "Choice" }]),
		wrap([{ question: "  ", answer: "Choice" }]),
		wrap([reply, { question: "Missing answer" }]),
		`Before ${wrap([reply])}`,
		`${wrap([reply])} after`,
		`\`\`\`\n${wrap([reply])}\n\`\`\``,
	]) {
		assert.equal(parseCodexQuestionReply(raw), null, raw);
		assert.equal(questionReplyCopyText(raw), raw, raw);
	}
});

test("copy includes full questions and answers in order without JSON escapes", () => {
	const question = "A long question?\nWith more context.";
	const answer = 'Use "Option A"\nand keep going.';
	assert.equal(
		questionReplyCopyText(wrap([{ question, answer }, reply])),
		`${question}\n${answer}\n\n${reply.question}\n${reply.answer}`,
	);
});

test("keeps HTML and tag-like answer text as text without interpreting it", () => {
	const answer =
		'<img src=x onerror="alert(1)"> & </send_user_message_question_reply>';
	const raw = wrap([{ question: "<script>question</script>", answer }]);
	assert.deepEqual(parseCodexQuestionReply(raw), [
		{ question: "<script>question</script>", answer },
	]);
	assert.equal(
		questionReplyCopyText(raw),
		`<script>question</script>\n${answer}`,
	);
});
