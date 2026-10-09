import assert from "node:assert/strict";
import { test } from "node:test";
// Import built package so node:test can run without a TS loader.
import {
	HttpError,
	joinApiUrl,
	sanitizeAccessToken,
	createCohubClient,
	readRequestSourceFromEnv,
	requestSourceToHeaders,
	COHUB_SOURCE_HEADER,
} from "../dist/index.js";

test("sanitizeAccessToken strips CR/LF/TAB and empty results", () => {
	assert.equal(sanitizeAccessToken("  abc.def  "), "abc.def");
	assert.equal(sanitizeAccessToken("abc\r\ndef"), "abcdef");
	assert.equal(sanitizeAccessToken("tok\ten"), "token");
	assert.equal(sanitizeAccessToken("\n\r\t"), null);
	assert.equal(sanitizeAccessToken(""), null);
	assert.equal(sanitizeAccessToken(null), null);
	assert.equal(sanitizeAccessToken(undefined), null);
});

test("joinApiUrl joins absolute base and path without double slash", () => {
	assert.equal(
		joinApiUrl("https://api.cohub.run", "/api/spaces/x/prompt"),
		"https://api.cohub.run/api/spaces/x/prompt",
	);
	assert.equal(
		joinApiUrl("https://api.cohub.run/", "/api/spaces/x/prompt"),
		"https://api.cohub.run/api/spaces/x/prompt",
	);
	assert.equal(
		joinApiUrl("https://api.cohub.run", "api/spaces/x/prompt"),
		"https://api.cohub.run/api/spaces/x/prompt",
	);
	assert.equal(joinApiUrl("", "/api/spaces"), "/api/spaces");
	assert.equal(joinApiUrl("  ", "/api/spaces"), "/api/spaces");
});

test("HttpTransport Authorization header uses sanitized tokens", async () => {
	const calls = [];
	const client = createCohubClient({
		baseUrl: "https://api.example.com",
		getAccessToken: async () => "good.token\r\n",
		fetch: async (input, init) => {
			const headers = new Headers(init?.headers);
			calls.push({
				url: String(input),
				auth: headers.get("Authorization"),
			});
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		},
	});
	await client.spaces.list();
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.auth, "Bearer good.token");
	assert.equal(calls[0]?.url, "https://api.example.com/api/spaces?filter=recent");
	assert.ok(HttpError);
});

test("HttpTransport can skip onUnauthorized for bootstrap 401s", async () => {
	let unauthorizedCalls = 0;
	const client = createCohubClient({
		baseUrl: "https://api.example.com",
		getAccessToken: async () => "token",
		onUnauthorized: () => {
			unauthorizedCalls += 1;
		},
		fetch: async () =>
			new Response(JSON.stringify({ message: "unauthorized" }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			}),
	});

	await assert.rejects(
		() => client.user.getMe({ skipUnauthorizedHandler: true }),
		(error: unknown) => error instanceof HttpError && error.status === 401,
	);
	assert.equal(unauthorizedCalls, 0);

	await assert.rejects(
		() => client.user.getMe(),
		(error: unknown) => error instanceof HttpError && error.status === 401,
	);
	assert.equal(unauthorizedCalls, 1);
});

test("HttpTransport attaches X-Cohub-Source-* from requestSource", async () => {
	const calls = [];
	const client = createCohubClient({
		baseUrl: "https://api.example.com",
		getAccessToken: async () => "token",
		requestSource: {
			spaceId: "11111111-1111-1111-1111-111111111111",
			sessionId: "22222222-2222-2222-2222-222222222222",
			turnId: "33333333-3333-3333-3333-333333333333",
			toolCallId: "44444444-4444-4444-4444-444444444444",
			sandboxVersion: "cohub-sandbox:sha-abc123",
			via: "cli",
		},
		fetch: async (_input, init) => {
			const headers = new Headers(init?.headers);
			calls.push({
				space: headers.get(COHUB_SOURCE_HEADER.space),
				session: headers.get(COHUB_SOURCE_HEADER.session),
				turn: headers.get(COHUB_SOURCE_HEADER.turn),
				toolCall: headers.get(COHUB_SOURCE_HEADER.toolCall),
				sandboxVersion: headers.get(COHUB_SOURCE_HEADER.sandboxVersion),
				via: headers.get(COHUB_SOURCE_HEADER.via),
			});
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		},
	});
	await client.spaces.list();
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0], {
		space: "11111111-1111-1111-1111-111111111111",
		session: "22222222-2222-2222-2222-222222222222",
		turn: "33333333-3333-3333-3333-333333333333",
		toolCall: "44444444-4444-4444-4444-444444444444",
		sandboxVersion: "cohub-sandbox:sha-abc123",
		via: "cli",
	});
});

test("readRequestSourceFromEnv defaults via for sandbox env", () => {
	const source = readRequestSourceFromEnv(
		{
			COHUB_SPACE_ID: "11111111-1111-1111-1111-111111111111",
			COHUB_SESSION_ID: "22222222-2222-2222-2222-222222222222",
			COHUB_SANDBOX_VERSION: "cohub-sandbox:sha-abc123",
		},
		{ via: "cli" },
	);
	assert.deepEqual(source, {
		spaceId: "11111111-1111-1111-1111-111111111111",
		sessionId: "22222222-2222-2222-2222-222222222222",
		sandboxVersion: "cohub-sandbox:sha-abc123",
		via: "cli",
	});
	assert.deepEqual(
		requestSourceToHeaders(source),
		{
			[COHUB_SOURCE_HEADER.space]: "11111111-1111-1111-1111-111111111111",
			[COHUB_SOURCE_HEADER.session]: "22222222-2222-2222-2222-222222222222",
			[COHUB_SOURCE_HEADER.sandboxVersion]: "cohub-sandbox:sha-abc123",
			[COHUB_SOURCE_HEADER.via]: "cli",
		},
	);
});

test("readRequestSourceFromEnv supports legacy Sandbox version env", () => {
	assert.deepEqual(
		readRequestSourceFromEnv({ IMAGE_VERSION: "cohub-sandbox:legacy" }),
		{ sandboxVersion: "cohub-sandbox:legacy" },
	);
});

test("readRequestSourceFromEnv drops invalid UUIDs; via-only is valid", () => {
	// Invalid space id is dropped; via alone remains a valid channel source.
	assert.deepEqual(
		readRequestSourceFromEnv({ COHUB_SPACE_ID: "not-a-uuid", COHUB_SOURCE_VIA: "cli" }),
		{ via: "cli" },
	);
	assert.deepEqual(readRequestSourceFromEnv({ COHUB_SOURCE_VIA: "cli" }), { via: "cli" });
	assert.deepEqual(readRequestSourceFromEnv({}, { via: "cli" }), { via: "cli" });
	assert.equal(readRequestSourceFromEnv({ COHUB_SPACE_ID: "not-a-uuid" }), null);
});
