import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildCodexApprovalRequest,
	resolveCodexApprovalModeFromTurns,
} from "../lib/codex-approval-mode.ts";

const modes = ["inherit", "read_only", "auto", "full_access"] as const;

test("explicit approval choice is sent on every Codex turn and omitted for other harnesses", () => {
	for (const mode of modes) {
		assert.deepEqual(buildCodexApprovalRequest("codex", mode, modes), {
			codexApprovalMode: mode,
		});
		assert.deepEqual(buildCodexApprovalRequest("pi", mode, modes), {});
		assert.deepEqual(buildCodexApprovalRequest("cohub", mode, modes), {});
	}
	assert.deepEqual(
		buildCodexApprovalRequest("codex", undefined, undefined),
		{},
	);
});

test("unsupported approval choices fail explicitly instead of dispatching without protection", () => {
	assert.throws(
		() => buildCodexApprovalRequest("codex", "read_only", undefined),
		/does not support/,
	);
	assert.throws(
		() => buildCodexApprovalRequest("codex", "full_access", ["read_only"]),
		/does not support/,
	);
});

test("restores the most recent explicit Codex choice across cloud turns and native followups", () => {
	assert.equal(
		resolveCodexApprovalModeFromTurns([
			{ meta: { harness: "codex", codexApprovalMode: "full_access" } },
			{ meta: { harness: "codex", codexApprovalMode: "read_only" } },
			{ meta: { harness: "cohub", codexApprovalMode: "full_access" } },
			{ meta: { harness: "codex" } },
		]),
		"read_only",
	);
	assert.equal(resolveCodexApprovalModeFromTurns([]), undefined);
	assert.equal(
		resolveCodexApprovalModeFromTurns([
			{ meta: { harness: "pi", codexApprovalMode: "full_access" } },
		]),
		undefined,
	);
});

test("invalid stored approval data is exposed rather than interpreted as inherited access", () => {
	assert.throws(
		() =>
			resolveCodexApprovalModeFromTurns([
				{ meta: { harness: "codex", codexApprovalMode: "corrupt" } },
			]),
		/Invalid Codex approval mode/,
	);
});

test("switching back to local settings remains an explicit request after refresh", () => {
	const restored = resolveCodexApprovalModeFromTurns([
		{ meta: { harness: "codex", codexApprovalMode: "full_access" } },
		{ meta: { harness: "codex", codexApprovalMode: "inherit" } },
	]);
	assert.equal(restored, "inherit");
	assert.deepEqual(buildCodexApprovalRequest("codex", restored, modes), {
		codexApprovalMode: "inherit",
	});
});

test("the approval picker offers all four explicit choices including returning to local settings", async () => {
	const { CODEX_APPROVAL_CHOICES } = await import(
		"../lib/codex-approval-mode.ts"
	);
	assert.deepEqual(CODEX_APPROVAL_CHOICES, [
		"inherit",
		"auto",
		"full_access",
		"read_only",
	]);
});

test("accepted choices do not mask a newer permission change from another device", async () => {
	const { finishCodexApprovalChoice } = await import(
		"../lib/codex-approval-mode.ts"
	);
	for (const key of ["space:draft", "space:existing"]) {
		const sent = { mode: "full_access" as const, revision: 1 };
		const local = finishCodexApprovalChoice({ [key]: sent }, key, sent);
		for (const remoteMode of ["read_only", "inherit"] as const) {
			const serverTurns = [
				{ meta: { harness: "codex", codexApprovalMode: "full_access" } },
				{ meta: { harness: "codex", codexApprovalMode: remoteMode } },
			];
			assert.equal(
				local[key]?.mode ?? resolveCodexApprovalModeFromTurns(serverTurns),
				remoteMode,
			);
		}
		assert.deepEqual(local, {});
	}
});

test("acceptance only clears the sent revision, preserving newer choices and other chats", async () => {
	const { finishCodexApprovalChoice } = await import(
		"../lib/codex-approval-mode.ts"
	);
	const sent = { mode: "full_access" as const, revision: 1 };
	for (const mode of ["read_only", "full_access"] as const) {
		const newer = { mode, revision: 2 };
		const choices = { "space:draft": newer, "other:session": sent };
		assert.deepEqual(
			finishCodexApprovalChoice(choices, "space:draft", sent),
			choices,
		);
		assert.deepEqual(
			finishCodexApprovalChoice(choices, "space:draft", undefined),
			choices,
		);
	}
	const choices = {
		"space:session": sent,
		"other:session": { mode: "read_only" as const, revision: 2 },
	};
	assert.deepEqual(finishCodexApprovalChoice(choices, "space:session", sent), {
		"other:session": choices["other:session"],
	});
	assert.equal(choices["space:session"].mode, "full_access");
});
