import assert from "node:assert/strict";
import { test } from "node:test";
import { avatarInitials, isSingleGlyph } from "$lib/avatar-initials";

test("avatarInitials takes two letters for Latin names", () => {
	assert.equal(avatarInitials("Pixel Editor", "A"), "PE");
	assert.equal(avatarInitials("cohub", "A"), "CO");
	assert.equal(avatarInitials("todo-board", "A"), "TB");
	assert.equal(avatarInitials("[beta] tool", "A"), "BT");
	assert.equal(avatarInitials("3D studio", "A"), "3S");
	assert.equal(avatarInitials("x", "A"), "X");
});

test("avatarInitials keeps a single wide glyph", () => {
	assert.equal(avatarInitials("我的待办看板", "A"), "我");
	assert.equal(avatarInitials("天気予報", "A"), "天");
	assert.equal(avatarInitials("한국어 앱", "A"), "한");
	assert.equal(avatarInitials("我的 App", "A"), "我");
});

test("avatarInitials never pairs a Latin letter with a wide glyph", () => {
	assert.equal(avatarInitials("AI 助手", "A"), "AI");
	assert.equal(avatarInitials("A 助手", "A"), "A");
	assert.equal(avatarInitials("A助手", "A"), "A");
});

test("avatarInitials keeps emoji graphemes intact", () => {
	assert.equal(avatarInitials("🎨 调色板", "A"), "🎨");
	assert.equal(avatarInitials("👩‍💻 Dev", "A"), "👩‍💻");
});

test("avatarInitials falls back when nothing is usable", () => {
	assert.equal(avatarInitials("", "SP"), "SP");
	assert.equal(avatarInitials("  --  ", "SP"), "SP");
	assert.equal(avatarInitials(null, "SP"), "SP");
});

test("isSingleGlyph detects lone marks", () => {
	assert.equal(isSingleGlyph("我"), true);
	assert.equal(isSingleGlyph("👩‍💻"), true);
	assert.equal(isSingleGlyph("X"), true);
	assert.equal(isSingleGlyph("PE"), false);
});
