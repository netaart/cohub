import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { buildSpaceSessionRoute } from "$lib/space-routes";
import {
	canonicalSpaceLocation,
	clearSpaceAddresses,
	markAddressPending,
	parseSpaceAddressPath,
	rememberResolvedAddress,
	rememberSpaceAddress,
	spaceIdAt,
	toSpaceIdPath,
} from "$lib/stores/space-address";

const owner = (username: string) => ({
	userUuid: `${username}-uuid`,
	username,
	displayName: username,
	avatarUrl: null,
});
const url = (href: string) => new URL(href, "https://cohub.test");

beforeEach(clearSpaceAddresses);

test("friendly paths parse only outside platform and public routes", () => {
	assert.deepEqual(parseSpaceAddressPath("/alice/notes/sessions/1"), {
		address: { username: "alice", slug: "notes" },
		rest: "/sessions/1",
	});
	assert.equal(parseSpaceAddressPath("/spaces/abc"), null);
	assert.equal(parseSpaceAddressPath("/dev/board"), null);
	assert.equal(parseSpaceAddressPath("/alice/notes/w/app"), null);
	assert.equal(parseSpaceAddressPath("/alice"), null);
});

test("links and the address bar use confirmed addresses only", () => {
	rememberSpaceAddress(
		{ id: "x", slug: "notes", ownerProfile: owner("alice") },
		{ confirmed: false },
	);
	assert.equal(buildSpaceSessionRoute("x", "s1"), "/spaces/x/sessions/s1");
	assert.equal(spaceIdAt({ username: "alice", slug: "notes" })?.spaceId, "x");
	assert.equal(canonicalSpaceLocation(url("/spaces/x"), "x"), null);

	rememberSpaceAddress({
		id: "x",
		slug: "notes",
		ownerProfile: owner("alice"),
	});
	assert.equal(buildSpaceSessionRoute("x", "s1"), "/alice/notes/sessions/s1");
	assert.equal(
		toSpaceIdPath("/alice/notes/sessions/s1"),
		"/spaces/x/sessions/s1",
	);
	assert.deepEqual(
		canonicalSpaceLocation(url("/spaces/x/sessions/s1?turn=2"), "x"),
		{
			replace: "/alice/notes/sessions/s1?turn=2",
		},
	);
});

test("reserved names held from before they were reserved keep id links", () => {
	rememberSpaceAddress({ id: "x", slug: "notes", ownerProfile: owner("dev") });
	rememberSpaceAddress({ id: "y", slug: "join", ownerProfile: owner("alice") });
	assert.equal(buildSpaceSessionRoute("x", "s1"), "/spaces/x/sessions/s1");
	assert.equal(buildSpaceSessionRoute("y", "s1"), "/spaces/y/sessions/s1");
});

test("one address belongs to one Space, and cache seeds never displace server data", () => {
	rememberSpaceAddress({
		id: "x",
		slug: "notes",
		ownerProfile: owner("alice"),
	});
	rememberSpaceAddress(
		{ id: "y", slug: "notes", ownerProfile: owner("alice") },
		{ confirmed: false },
	);
	assert.equal(spaceIdAt({ username: "alice", slug: "notes" })?.spaceId, "x");

	rememberSpaceAddress({
		id: "y",
		slug: "notes",
		ownerProfile: owner("alice"),
	});
	assert.equal(spaceIdAt({ username: "alice", slug: "notes" })?.spaceId, "y");
	assert.equal(toSpaceIdPath("/spaces/x"), "/spaces/x");
	// x lost its address: its page stays on the id URL.
	assert.equal(canonicalSpaceLocation(url("/spaces/x"), "x"), null);
});

test("an address now held by another Space moves the page there", () => {
	rememberSpaceAddress({
		id: "x",
		slug: "journal",
		ownerProfile: owner("alice"),
	});
	rememberSpaceAddress({
		id: "y",
		slug: "notes",
		ownerProfile: owner("alice"),
	});
	assert.deepEqual(
		canonicalSpaceLocation(url("/alice/notes/sessions/s1"), "x"),
		{
			navigate: "/spaces/y/sessions/s1",
		},
	);
});

test("old addresses resolved by the server alias to the current one", () => {
	markAddressPending({ username: "alice", slug: "notes" });
	assert.equal(canonicalSpaceLocation(url("/alice/notes"), "x"), null);

	rememberResolvedAddress({ username: "alice", slug: "notes" }, "x", {
		username: "alice3",
		slug: "journal",
	});
	assert.equal(toSpaceIdPath("/alice/notes/settings"), "/spaces/x/settings");
	assert.deepEqual(canonicalSpaceLocation(url("/alice/notes/settings"), "x"), {
		replace: "/alice3/journal/settings",
	});
});
