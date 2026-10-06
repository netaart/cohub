import assert from "node:assert/strict";
import { test } from "node:test";
import { sameCommandItemSequence } from "../lib/command-palette/merge-results";

type KeySource = Parameters<typeof sameCommandItemSequence>[0][number];

const space = (id: string): KeySource => ({ type: "space", id });
const chat = (id: string): KeySource => ({ type: "chat", id });

test("identical ordered keys are the same sequence", () => {
	const left = [space("a"), chat("s1"), chat("s2")];
	const right = [space("a"), chat("s1"), chat("s2")];
	assert.equal(sameCommandItemSequence(left, right), true);
});

test("a different order is not the same sequence", () => {
	const left = [space("a"), space("b")];
	const right = [space("b"), space("a")];
	assert.equal(sameCommandItemSequence(left, right), false);
});

test("a different length is not the same sequence", () => {
	assert.equal(sameCommandItemSequence([space("a")], []), false);
});

test("same id but a different resource type is not the same sequence", () => {
	const left = [space("a")];
	const right: KeySource[] = [{ type: "command", id: "a" }];
	assert.equal(sameCommandItemSequence(left, right), false);
});
