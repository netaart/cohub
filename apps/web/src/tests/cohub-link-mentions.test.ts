import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildAppMentionMarkdown,
	parseCohubAppUrls,
	replaceCohubAppUrls,
} from "$lib/mentions/app";
import {
	buildSpaceMentionMarkdown,
	getCohubSpaceLinkKey,
	parseCohubSpaceUrls,
	replaceCohubSpaceUrls,
	tokenizeSpaceMentionText,
	unresolvedCohubSpaceAddresses,
} from "$lib/mentions/space";
import {
	clearSpaceAddresses,
	rememberSpaceAddress,
} from "$lib/stores/space-address";

const SPACE_ID = "f7000115-55d8-4d97-a0e4-d2a55b6ffa41";
const SESSION_ID = "3b1e6a2c-9d4f-4a7b-8c5d-2e1f0a9b8c7d";

function spaceUrl(origin: string, withSession = false) {
	return `${origin}/spaces/${SPACE_ID}${withSession ? `/sessions/${SESSION_ID}` : ""}`;
}

test("parses space links on the primary cohub.live domain", () => {
	for (const origin of [
		"https://cohub.live",
		"https://www.cohub.live",
		"https://dev.cohub.live",
		"http://cohub.live",
	]) {
		const matches = parseCohubSpaceUrls(`看看 ${spaceUrl(origin)} 这个空间`);
		assert.equal(matches.length, 1, origin);
		assert.equal(matches[0]?.raw, spaceUrl(origin));
		assert.equal(matches[0]?.spaceId, SPACE_ID);
		assert.equal(matches[0]?.sessionId, undefined);
	}
});

test("keeps legacy cohub.run and localhost space links convertible", () => {
	for (const origin of [
		"https://cohub.run",
		"https://dev.cohub.run",
		"http://localhost:5173",
	]) {
		const [match] = parseCohubSpaceUrls(spaceUrl(origin));
		assert.equal(match?.spaceId, SPACE_ID);
	}
});

test("parses session-scoped space links with query and hash", () => {
	const [match] = parseCohubSpaceUrls(
		`${spaceUrl("https://cohub.live", true)}?x=1#frag`,
	);
	assert.equal(match?.spaceId, SPACE_ID);
	assert.equal(match?.sessionId, SESSION_ID);
});

test("parses root-relative space links after a boundary", () => {
	const matches = parseCohubSpaceUrls(`参考 /spaces/${SPACE_ID} 里的内容`);
	assert.equal(matches.length, 1);
	assert.equal(matches[0]?.spaceId, SPACE_ID);
	assert.equal(matches[0]?.raw, `/spaces/${SPACE_ID}`);
});

test("rejects lookalike hosts for space links", () => {
	for (const text of [
		`https://cohub.live.evil.example/spaces/${SPACE_ID}`,
		`https://notcohub.live/spaces/${SPACE_ID}`,
		`https://example.com/spaces/${SPACE_ID}`,
	]) {
		assert.deepEqual(parseCohubSpaceUrls(text), [], text);
	}
});

test("replaces cohub.live space links with space mentions", () => {
	const replaced = replaceCohubSpaceUrls(
		`合并 ${spaceUrl("https://cohub.live")} 的进展`,
		() => "Design Studio",
	);
	assert.equal(
		replaced,
		`合并 ${buildSpaceMentionMarkdown({ spaceId: SPACE_ID, label: "Design Studio" })} 的进展`,
	);
	const tokens = tokenizeSpaceMentionText(replaced);
	const mention = tokens.find((token) => token.type === "spaceMention");
	assert.equal(mention?.label, "Design Studio");
	assert.equal(mention?.spaceId, SPACE_ID);
});

test("leaves unresolved or lookalike space links untouched", () => {
	const text = spaceUrl("https://cohub.live");
	assert.equal(
		replaceCohubSpaceUrls(text, () => null),
		text,
	);
	const foreign = `https://example.com/spaces/${SPACE_ID}`;
	assert.equal(
		replaceCohubSpaceUrls(foreign, () => "X"),
		foreign,
	);
});

test("parses work links on the primary cohub.live domain", () => {
	for (const origin of [
		"https://cohub.live",
		"https://www.cohub.live",
		"https://dev.cohub.live",
	]) {
		const matches = parseCohubAppUrls(`${origin}/alice/studio/w/pulsewall`);
		assert.equal(matches.length, 1, origin);
		assert.deepEqual(
			{
				username: matches[0]?.username,
				spaceSlug: matches[0]?.spaceSlug,
				appSlug: matches[0]?.appSlug,
				launchSuffix: matches[0]?.launchSuffix,
			},
			{
				username: "alice",
				spaceSlug: "studio",
				appSlug: "pulsewall",
				launchSuffix: "",
			},
		);
	}
});

test("keeps legacy cohub.run and root-relative work links convertible", () => {
	const [absolute] = parseCohubAppUrls(
		"https://cohub.run/alice/studio/w/pulsewall?view=board#today",
	);
	assert.equal(absolute?.launchSuffix, "?view=board#today");

	const [relative] = parseCohubAppUrls("看下 /alice/studio/w/pulsewall 吧");
	assert.equal(relative?.appSlug, "pulsewall");
	assert.equal(relative?.raw, "/alice/studio/w/pulsewall");
});

test("replaces cohub.live work links with work mentions", () => {
	const text = "打开 https://cohub.live/alice/studio/w/pulsewall 试试";
	const replaced = replaceCohubAppUrls(text, () => "Pulse Wall");
	assert.equal(
		replaced,
		`打开 ${buildAppMentionMarkdown({
			username: "alice",
			spaceSlug: "studio",
			appSlug: "pulsewall",
			label: "Pulse Wall",
		})} 试试`,
	);
});

test("rejects lookalike hosts for work links", () => {
	for (const text of [
		"https://cohub.live.evil.example/alice/studio/w/pulsewall",
		"https://notcohub.live/alice/studio/w/pulsewall",
		"https://example.com/alice/studio/w/pulsewall",
	]) {
		assert.deepEqual(parseCohubAppUrls(text), [], text);
	}
});

test("space link keys stay stable across domains", () => {
	const [live] = parseCohubSpaceUrls(spaceUrl("https://cohub.live", true));
	const [legacy] = parseCohubSpaceUrls(spaceUrl("https://cohub.run", true));
	assert.ok(live);
	assert.ok(legacy);
	assert.equal(getCohubSpaceLinkKey(live), getCohubSpaceLinkKey(legacy));
});

test("friendly Space links become mentions once their address is confirmed", () => {
	const url = `https://cohub.live/alice/notes/sessions/${SESSION_ID}`;
	clearSpaceAddresses();
	assert.deepEqual(parseCohubSpaceUrls(url), []);
	assert.deepEqual(unresolvedCohubSpaceAddresses(url), [
		{ username: "alice", slug: "notes" },
	]);
	rememberSpaceAddress({
		id: SPACE_ID,
		slug: "notes",
		ownerProfile: {
			userUuid: "u",
			username: "alice",
			displayName: "A",
			avatarUrl: null,
		},
	});
	assert.deepEqual(parseCohubSpaceUrls(url), [
		{ raw: url, spaceId: SPACE_ID, sessionId: SESSION_ID },
	]);
	assert.equal(
		replaceCohubSpaceUrls(`see ${url}`, () => "Notes"),
		`see ${buildSpaceMentionMarkdown({ spaceId: SPACE_ID, sessionId: SESSION_ID, label: "Notes" })}`,
	);
	assert.deepEqual(
		unresolvedCohubSpaceAddresses("https://cohub.live/docs/cli"),
		[],
	);
	clearSpaceAddresses();
});
