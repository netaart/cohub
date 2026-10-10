import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContentBlock } from "@cohub/protocol/core";
import { mergeStreamingDeltaBlocks } from "../lib/session-streaming";
import {
	buildStreamingPreviewBlocks,
	buildTurnTimelineItems,
} from "../lib/session-turn-render";

test("mergeStreamingDeltaBlocks appends text deltas by stream index", () => {
	const existing: ContentBlock[] = [
		{ type: "text", text: "before", _meta: { streamIndex: 0 } },
		{
			type: "tool_use",
			id: "t1",
			name: "bash",
			input: { command: "pwd" },
			_meta: { streamIndex: 1, toolStatus: "done" },
		},
		{
			type: "tool_result",
			tool_use_id: "t1",
			content: "/workspace",
			_meta: { streamIndex: 1, toolStatus: "done" },
		},
		{ type: "text", text: "af", _meta: { streamIndex: 2 } },
	];

	const delta: ContentBlock[] = [
		{ type: "text", text: "ter", _meta: { streamIndex: 2 } },
	];

	const merged = mergeStreamingDeltaBlocks(existing, delta);
	const textBlocks = merged.filter(
		(block): block is Extract<ContentBlock, { type: "text" }> =>
			block.type === "text",
	);

	assert.equal(textBlocks[0]?.text, "before");
	assert.equal(textBlocks[1]?.text, "after");

	const delta2: ContentBlock[] = [
		{ type: "text", text: "!", _meta: { streamIndex: 0 } },
	];
	const merged2 = mergeStreamingDeltaBlocks(merged, delta2);
	const textBlocks2 = merged2.filter(
		(block): block is Extract<ContentBlock, { type: "text" }> =>
			block.type === "text",
	);
	assert.equal(textBlocks2[0]?.text, "before!");
	assert.equal(textBlocks2[1]?.text, "after");
});

test("buildStreamingPreviewBlocks preserves stream block order", () => {
	const blocks = buildStreamingPreviewBlocks([
		{ type: "text", text: "answer", _meta: { streamIndex: 2 } },
		{ type: "thinking", thinking: "reasoning", _meta: { streamIndex: 3 } },
	]);

	assert.deepEqual(
		blocks.map((block) => block.type),
		["text", "thinking"],
	);
	assert.equal(
		(blocks[0] as Extract<ContentBlock, { type: "text" }>)._meta?.streamIndex,
		2,
	);
	assert.equal(
		(blocks[1] as Extract<ContentBlock, { type: "thinking" }>)._meta
			?.streamIndex,
		3,
	);
});

test("buildTurnTimelineItems renders streaming intermediate messages separately from active preview", () => {
	const items = buildTurnTimelineItems({
		sessionId: "s1",
		turns: [
			{
				id: "t1",
				sessionId: "s1",
				userUuid: null,
				sequence: 1,
				status: "running",
				intent: "steer",
				userContent: [{ type: "text", text: "hi" }],
				userText: "hi",
				assistantContent: null,
				assistantText: null,
				provider: null,
				model: null,
				stopReason: null,
				errorMessage: null,
				finalUsage: null,
				totalUsage: null,
				summary: null,
				intermediateIndex: null,
				intermediateSummary: null,
				meta: null,
				startedAt: null,
				durationMs: null,
				completedAt: null,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		],
		streaming: {
			sessionId: "s1",
			turnId: "t1",
			contentBlocks: [
				{
					type: "thinking",
					thinking: "still thinking",
					_meta: { streamIndex: 0 },
				},
			],
			intermediateMessages: [
				{
					id: "m1",
					sessionId: "s1",
					role: "assistant",
					content: [
						{
							type: "text",
							text: "previous answer",
							_meta: { streamIndex: 1 },
						},
					],
					text: "previous answer",
					provider: null,
					model: null,
					stopReason: null,
					errorMessage: null,
					usage: null,
					durationMs: null,
					toolCallsObjectKey: null,
					meta: null,
					createdAt: "2026-01-01T00:00:00.000Z",
				},
			],
			status: "streaming",
		},
	});

	const preview = items.find(
		(item) =>
			item.kind === "message" &&
			item.message.meta?.messageKind === "assistant_streaming_preview",
	);
	assert.equal(preview?.kind, "message");
	assert.deepEqual(
		preview?.kind === "message"
			? preview.message.content.map((block) => block.type)
			: [],
		["thinking"],
	);
});

test("buildTurnTimelineItems keeps streaming preview visible when a same-turn partial assistant patch exists", () => {
	const items = buildTurnTimelineItems({
		sessionId: "s1",
		turns: [
			{
				id: "t1",
				sessionId: "s1",
				userUuid: null,
				sequence: 1,
				status: "running",
				intent: "steer",
				userContent: [{ type: "text", text: "hi" }],
				userText: "hi",
				assistantContent: [{ type: "text", text: "partial final patch" }],
				assistantText: "partial final patch",
				provider: null,
				model: null,
				stopReason: null,
				errorMessage: null,
				finalUsage: null,
				totalUsage: null,
				summary: null,
				intermediateIndex: null,
				intermediateSummary: null,
				meta: null,
				startedAt: null,
				durationMs: null,
				completedAt: null,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:01.000Z",
			},
		],
		streaming: {
			sessionId: "s1",
			turnId: "t1",
			contentBlocks: [
				{ type: "thinking", thinking: "thinking", _meta: { streamIndex: 0 } },
				{ type: "text", text: "answer", _meta: { streamIndex: 1 } },
			],
			status: "streaming",
		},
	});

	const assistantMessages = items.filter(
		(item) => item.kind === "message" && item.message.role === "assistant",
	);
	assert.equal(assistantMessages.length, 1);
	assert.deepEqual(
		assistantMessages[0]?.kind === "message"
			? assistantMessages[0].message.content.map((block) => block.type)
			: [],
		["thinking", "text"],
	);
	assert.equal(
		assistantMessages[0]?.kind === "message"
			? assistantMessages[0].message.meta?.messageKind
			: null,
		"assistant_streaming_preview",
	);
});

test("buildTurnTimelineItems keeps streaming intermediate messages after final turn patch", () => {
	const items = buildTurnTimelineItems({
		sessionId: "s1",
		turns: [
			{
				id: "t1",
				sessionId: "s1",
				userUuid: null,
				sequence: 1,
				status: "completed",
				intent: "steer",
				userContent: [{ type: "text", text: "hi" }],
				userText: "hi",
				assistantContent: [{ type: "text", text: "final" }],
				assistantText: "final",
				provider: null,
				model: null,
				stopReason: "end_turn",
				errorMessage: null,
				finalUsage: null,
				totalUsage: null,
				summary: null,
				intermediateIndex: null,
				intermediateSummary: null,
				meta: null,
				startedAt: null,
				durationMs: null,
				completedAt: "2026-01-01T00:00:01.000Z",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:01.000Z",
			},
		],
		streaming: {
			sessionId: "s1",
			turnId: "t1",
			contentBlocks: [{ type: "text", text: "final" }],
			intermediateMessages: [
				{
					id: "m1",
					sessionId: "s1",
					role: "assistant",
					content: [{ type: "text", text: "previous answer" }],
					text: "previous answer",
					provider: null,
					model: null,
					stopReason: null,
					errorMessage: null,
					usage: null,
					durationMs: null,
					toolCallsObjectKey: null,
					meta: null,
					createdAt: "2026-01-01T00:00:00.000Z",
				},
			],
			status: "streaming",
		},
	});

	const process = items.find(
		(item) => item.kind === "process" && item.streaming,
	);
	assert.equal(process?.kind, "process");
	assert.equal(
		process?.kind === "process" ? process.summary?.messageCount : 0,
		1,
	);
	assert.equal(
		process?.kind === "process" ? process.intermediateMessages?.[0]?.text : "",
		"previous answer",
	);
});

test("buildTurnTimelineItems keeps active running process streaming when live details are empty", () => {
	const items = buildTurnTimelineItems({
		sessionId: "s1",
		turns: [
			{
				id: "t1",
				sessionId: "s1",
				userUuid: null,
				sequence: 1,
				status: "running",
				intent: "steer",
				userContent: [{ type: "text", text: "hi" }],
				userText: "hi",
				assistantContent: null,
				assistantText: null,
				provider: null,
				model: null,
				stopReason: null,
				errorMessage: null,
				finalUsage: null,
				totalUsage: null,
				summary: null,
				intermediateIndex: null,
				intermediateSummary: {
					messageCount: 2,
					toolCallCount: 1,
				},
				meta: null,
				startedAt: null,
				durationMs: null,
				completedAt: null,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		],
		streaming: {
			sessionId: "s1",
			turnId: "t1",
			contentBlocks: [{ type: "text", text: "current" }],
			intermediateMessages: [],
			status: "streaming",
		},
	});

	const process = items.find((item) => item.kind === "process");
	assert.equal(process?.kind, "process");
	assert.equal(process?.kind === "process" ? process.streaming : false, true);
	assert.equal(
		process?.kind === "process" ? process.summary?.messageCount : 0,
		2,
	);
	assert.equal(
		process?.kind === "process" ? process.intermediateMessages : null,
		undefined,
	);
});

test("buildTurnTimelineItems keeps completed handoff process details while persisted index catches up", () => {
	const items = buildTurnTimelineItems({
		sessionId: "s1",
		turns: [
			{
				id: "t1",
				sessionId: "s1",
				userUuid: null,
				sequence: 1,
				status: "completed",
				intent: "steer",
				userContent: [{ type: "text", text: "hi" }],
				userText: "hi",
				assistantContent: [{ type: "text", text: "final" }],
				assistantText: "final",
				provider: null,
				model: null,
				stopReason: "end_turn",
				errorMessage: null,
				finalUsage: null,
				totalUsage: null,
				summary: null,
				intermediateIndex: null,
				intermediateSummary: {
					messageCount: 1,
					toolCallCount: 0,
				},
				meta: null,
				startedAt: null,
				durationMs: null,
				completedAt: "2026-01-01T00:00:01.000Z",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:01.000Z",
			},
		],
		streaming: {
			sessionId: "s1",
			turnId: "t1",
			contentBlocks: [],
			intermediateMessages: [
				{
					id: "m1",
					sessionId: "s1",
					role: "assistant",
					content: [{ type: "text", text: "previous answer" }],
					text: "previous answer",
					provider: null,
					model: null,
					stopReason: null,
					errorMessage: null,
					usage: null,
					durationMs: null,
					toolCallsObjectKey: null,
					meta: null,
					createdAt: "2026-01-01T00:00:00.000Z",
				},
			],
			status: "completed",
		},
	});

	const process = items.find(
		(item) => item.kind === "process" && item.streaming,
	);
	assert.equal(process?.kind, "process");
	assert.equal(
		process?.kind === "process"
			? process.intermediateMessages?.[0]?.text
			: null,
		"previous answer",
	);
});

test("buildTurnTimelineItems places waiting status in turn footer at the end", () => {
	const items = buildTurnTimelineItems({
		sessionId: "s1",
		turns: [
			{
				id: "t1",
				sessionId: "s1",
				userUuid: null,
				sequence: 1,
				status: "running",
				intent: "steer",
				userContent: [{ type: "text", text: "hi" }],
				userText: "hi",
				assistantContent: null,
				assistantText: null,
				provider: null,
				model: null,
				stopReason: null,
				errorMessage: null,
				finalUsage: null,
				totalUsage: null,
				summary: null,
				intermediateIndex: null,
				intermediateSummary: null,
				meta: null,
				startedAt: null,
				durationMs: null,
				completedAt: null,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		],
		streaming: {
			sessionId: "s1",
			turnId: "t1",
			contentBlocks: [],
			intermediateMessages: [
				{
					id: "m1",
					sessionId: "s1",
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "tool-1",
							name: "bash",
							input: { command: "pwd" },
						},
					],
					text: "",
					provider: null,
					model: null,
					stopReason: null,
					errorMessage: null,
					usage: null,
					durationMs: null,
					toolCallsObjectKey: null,
					meta: null,
					createdAt: "2026-01-01T00:00:00.000Z",
				},
			],
			status: "streaming",
			runtimePhase: "llm_call_started",
			runtimeProvider: "openai",
			runtimeModel: "gpt-5",
		},
	});

	// Waiting status must not live on the process card.
	const processItem = items.find((item) => item.kind === "process");
	assert.equal(processItem?.kind, "process");
	assert.equal(
		processItem && "runtimePhase" in processItem
			? processItem.runtimePhase
			: undefined,
		undefined,
	);
	const processIndex = items.findIndex((item) => item.kind === "process");
	const footerIndex = items.findIndex((item) => item.kind === "turn_footer");
	assert.ok(processIndex >= 0);
	assert.ok(footerIndex >= 0);
	assert.ok(footerIndex > processIndex);
	assert.equal(footerIndex, items.length - 1);
	assert.equal(
		items[footerIndex]?.kind === "turn_footer"
			? items[footerIndex].phase
			: null,
		"waiting_model",
	);
	assert.equal(
		items[footerIndex]?.kind === "turn_footer"
			? items[footerIndex].runtimeModel
			: null,
		"gpt-5",
	);
});

test("buildTurnTimelineItems labels direct generation startup separately", () => {
	const items = buildTurnTimelineItems({
		sessionId: "s1",
		turns: [
			{
				id: "t1",
				sessionId: "s1",
				userUuid: null,
				sequence: 1,
				status: "running",
				intent: "steer",
				userContent: [{ type: "text", text: "hi" }],
				userText: "hi",
				assistantContent: null,
				assistantText: null,
				provider: null,
				model: null,
				stopReason: null,
				errorMessage: null,
				finalUsage: null,
				totalUsage: null,
				summary: null,
				intermediateIndex: null,
				intermediateSummary: null,
				meta: null,
				startedAt: null,
				durationMs: null,
				completedAt: null,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		],
		streaming: {
			sessionId: "s1",
			turnId: "t1",
			executionKind: "direct_generation",
			contentBlocks: [],
			status: "pending",
		},
	});

	assert.equal(
		items.some((item) => item.kind === "process"),
		false,
	);
	const footer = items.find((item) => item.kind === "turn_footer");
	assert.equal(footer?.kind, "turn_footer");
	assert.equal(
		footer?.kind === "turn_footer" ? footer.phase : null,
		"starting_generation",
	);
	assert.equal(items.at(-1)?.kind, "turn_footer");
});

test("buildTurnTimelineItems hides turn footer once assistant content is streaming", () => {
	const items = buildTurnTimelineItems({
		sessionId: "s1",
		turns: [
			{
				id: "t1",
				sessionId: "s1",
				userUuid: null,
				sequence: 1,
				status: "running",
				intent: "steer",
				userContent: [{ type: "text", text: "hi" }],
				userText: "hi",
				assistantContent: null,
				assistantText: null,
				provider: null,
				model: null,
				stopReason: null,
				errorMessage: null,
				finalUsage: null,
				totalUsage: null,
				summary: null,
				intermediateIndex: null,
				intermediateSummary: null,
				meta: null,
				startedAt: null,
				durationMs: null,
				completedAt: null,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		],
		streaming: {
			sessionId: "s1",
			turnId: "t1",
			contentBlocks: [{ type: "text", text: "hello" }],
			status: "streaming",
			runtimePhase: null,
		},
	});

	assert.equal(
		items.some((item) => item.kind === "turn_footer"),
		false,
	);
	assert.equal(
		items.some(
			(item) =>
				item.kind === "message" &&
				item.message.meta?.messageKind === "assistant_streaming_preview",
		),
		true,
	);
});

test("buildTurnTimelineItems hides waiting footer when live content already exists", () => {
	const items = buildTurnTimelineItems({
		sessionId: "s1",
		turns: [
			{
				id: "t1",
				sessionId: "s1",
				userUuid: null,
				sequence: 1,
				status: "running",
				intent: "steer",
				userContent: [{ type: "text", text: "hi" }],
				userText: "hi",
				assistantContent: null,
				assistantText: null,
				provider: null,
				model: null,
				stopReason: null,
				errorMessage: null,
				finalUsage: null,
				totalUsage: null,
				summary: null,
				intermediateIndex: null,
				intermediateSummary: null,
				meta: null,
				startedAt: null,
				durationMs: null,
				completedAt: null,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		],
		streaming: {
			sessionId: "s1",
			turnId: "t1",
			contentBlocks: [{ type: "thinking", thinking: "still thinking" }],
			status: "streaming",
			runtimePhase: "llm_call_started",
			runtimeModel: "gpt-5",
		},
	});

	assert.equal(
		items.some((item) => item.kind === "turn_footer"),
		false,
	);
});

test("buildTurnTimelineItems shows waiting footer between intermediate rounds", () => {
	const items = buildTurnTimelineItems({
		sessionId: "s1",
		turns: [
			{
				id: "t1",
				sessionId: "s1",
				userUuid: null,
				sequence: 1,
				status: "running",
				intent: "steer",
				userContent: [{ type: "text", text: "hi" }],
				userText: "hi",
				assistantContent: null,
				assistantText: null,
				provider: null,
				model: null,
				stopReason: null,
				errorMessage: null,
				finalUsage: null,
				totalUsage: null,
				summary: null,
				intermediateIndex: null,
				intermediateSummary: null,
				meta: null,
				startedAt: null,
				durationMs: null,
				completedAt: null,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		],
		streaming: {
			sessionId: "s1",
			turnId: "t1",
			contentBlocks: [],
			intermediateMessages: [
				{
					id: "m1",
					sessionId: "s1",
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "tool-1",
							name: "bash",
							input: { command: "pwd" },
						},
					],
					text: "",
					provider: null,
					model: null,
					stopReason: null,
					errorMessage: null,
					usage: null,
					durationMs: null,
					toolCallsObjectKey: null,
					meta: null,
					createdAt: "2026-01-01T00:00:00.000Z",
				},
			],
			status: "streaming",
			runtimePhase: null,
		},
	});

	const processIndex = items.findIndex((item) => item.kind === "process");
	const footerIndex = items.findIndex((item) => item.kind === "turn_footer");
	assert.ok(processIndex >= 0);
	assert.ok(footerIndex > processIndex);
	assert.equal(
		items[footerIndex]?.kind === "turn_footer"
			? items[footerIndex].phase
			: null,
		"waiting_model",
	);
});

test("buildTurnTimelineItems keeps waiting footer when only residual tool blocks remain", () => {
	const items = buildTurnTimelineItems({
		sessionId: "s1",
		turns: [
			{
				id: "t1",
				sessionId: "s1",
				userUuid: null,
				sequence: 1,
				status: "running",
				intent: "steer",
				userContent: [{ type: "text", text: "hi" }],
				userText: "hi",
				assistantContent: null,
				assistantText: null,
				provider: null,
				model: null,
				stopReason: null,
				errorMessage: null,
				finalUsage: null,
				totalUsage: null,
				summary: null,
				intermediateIndex: null,
				intermediateSummary: null,
				meta: null,
				startedAt: null,
				durationMs: null,
				completedAt: null,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		],
		streaming: {
			sessionId: "s1",
			turnId: "t1",
			contentBlocks: [
				{
					type: "tool_use",
					id: "tool-1",
					name: "bash",
					input: { command: "pwd" },
				},
			],
			status: "streaming",
			runtimePhase: "llm_call_started",
			runtimeModel: "gpt-5",
		},
	});

	const footer = items.find((item) => item.kind === "turn_footer");
	assert.equal(footer?.kind, "turn_footer");
	assert.equal(
		footer?.kind === "turn_footer" ? footer.phase : null,
		"waiting_model",
	);
});

test("buildTurnTimelineItems exposes persisted assistant duration metadata", () => {
	const items = buildTurnTimelineItems({
		sessionId: "s1",
		turns: [
			{
				id: "t1",
				sessionId: "s1",
				userUuid: null,
				sequence: 1,
				status: "completed",
				intent: "steer",
				userContent: [{ type: "text", text: "hi" }],
				userText: "hi",
				assistantContent: [{ type: "text", text: "final" }],
				assistantText: "final",
				provider: null,
				model: null,
				stopReason: "end_turn",
				errorMessage: null,
				finalUsage: null,
				totalUsage: null,
				summary: null,
				intermediateIndex: null,
				intermediateSummary: null,
				meta: { finalMessageDurationMs: 1523 },
				startedAt: "2026-01-01T00:00:00.000Z",
				completedAt: "2026-01-01T00:00:03.000Z",
				durationMs: 3000,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:03.000Z",
			},
		],
	});

	const assistant = items.find(
		(item) => item.kind === "message" && item.message.role === "assistant",
	);
	assert.equal(assistant?.kind, "message");
	assert.equal(
		assistant?.kind === "message" ? assistant.message.meta?.durationMs : null,
		1523,
	);
});

test("buildTurnTimelineItems uses total duration and cost for direct generation", () => {
	const items = buildTurnTimelineItems({
		sessionId: "s1",
		turns: [
			{
				id: "t-create",
				sessionId: "s1",
				userUuid: null,
				sequence: 1,
				executionKind: "direct_generation",
				status: "completed",
				intent: "followup",
				userContent: [{ type: "text", text: "create" }],
				userText: "create",
				assistantContent: [{ type: "text", text: "created" }],
				assistantText: "created",
				provider: "generation",
				model: "image-model",
				stopReason: null,
				errorMessage: null,
				finalUsage: { cost: { total: 0.012 } },
				totalUsage: { cost: { total: 0.012 } },
				summary: null,
				intermediateIndex: null,
				intermediateSummary: null,
				meta: null,
				startedAt: "2026-01-01T00:00:00.000Z",
				completedAt: "2026-01-01T00:00:08.000Z",
				durationMs: 8000,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:08.000Z",
			},
		],
	});

	const assistant = items.find(
		(item) => item.kind === "message" && item.message.role === "assistant",
	);
	assert.equal(assistant?.kind, "message");
	assert.equal(
		assistant?.kind === "message" ? assistant.message.meta?.durationMs : null,
		8000,
	);
	assert.deepEqual(
		assistant?.kind === "message" ? assistant.message.meta?.usage : null,
		{ cost: { total: 0.012 } },
	);
});

test("buildTurnTimelineItems never renders a queued follow-up as the streaming turn", () => {
	const items = buildTurnTimelineItems({
		sessionId: "s1",
		// The live turn record is not loaded yet; only a queued follow-up is.
		turns: [
			{
				id: "turn-queued",
				sessionId: "s1",
				userUuid: null,
				sequence: 2,
				status: "queued",
				intent: "followup",
				userContent: [{ type: "text", text: "queued follow-up" }],
				userText: "queued follow-up",
				assistantContent: null,
				assistantText: null,
				provider: null,
				model: null,
				stopReason: null,
				errorMessage: null,
				finalUsage: null,
				totalUsage: null,
				summary: null,
				intermediateIndex: null,
				intermediateSummary: null,
				meta: null,
				startedAt: null,
				durationMs: null,
				completedAt: null,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		],
		streaming: {
			sessionId: "s1",
			turnId: "turn-running",
			contentBlocks: [],
			intermediateMessages: [
				{
					id: "m1",
					sessionId: "s1",
					role: "assistant",
					content: [{ type: "text", text: "working" }],
					text: "working",
					provider: null,
					model: null,
					stopReason: null,
					errorMessage: null,
					usage: null,
					durationMs: null,
					toolCallsObjectKey: null,
					meta: null,
					createdAt: "2026-01-01T00:00:00.000Z",
				},
			],
			status: "streaming",
		},
	});

	// The queued follow-up is owned by the queue UI, not the timeline.
	assert.equal(
		items.some((item) => "turn" in item && item.turn.id === "turn-queued"),
		false,
	);
	// The live process still renders, anchored to the real streaming turn.
	const process = items.find((item) => item.kind === "process");
	assert.equal(process?.kind, "process");
	assert.equal(
		process?.kind === "process" ? process.turn.id : null,
		"turn-running",
	);
});

test("restoring a running Turn never invents a starting footer or thinking block", () => {
	const streaming = {
		sessionId: "s",
		turnId: "t",
		status: "pending",
		contentBlocks: [],
	};
	for (const contentBlocks of [
		[],
		[{ type: "thinking" as const, thinking: "" }],
	]) {
		const resumed = buildTurnTimelineItems({
			sessionId: "s",
			turns: [],
			streaming: { ...streaming, resumed: true, contentBlocks },
		});
		assert.equal(
			resumed.some(
				(item) => item.kind === "turn_footer" || item.kind === "message",
			),
			false,
		);
	}
	const fresh = buildTurnTimelineItems({
		sessionId: "s",
		turns: [],
		streaming,
	});
	assert.equal(
		fresh.some(
			(item) => item.kind === "turn_footer" && item.phase === "starting",
		),
		true,
	);
	const waiting = buildTurnTimelineItems({
		sessionId: "s",
		turns: [],
		streaming: {
			...streaming,
			resumed: true,
			runtimePhase: "llm_call_started",
		},
	});
	assert.equal(
		waiting.some(
			(item) => item.kind === "turn_footer" && item.phase === "waiting_model",
		),
		true,
	);
});
