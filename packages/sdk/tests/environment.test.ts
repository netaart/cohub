import assert from "node:assert/strict";
import { test } from "node:test";
// Import built package so node:test can run without a TS loader.
import {
	COHUB_ENVIRONMENTS,
	getCohubContext,
	createHttpClient,
	resolveApiBaseUrl,
	resolveVoiceInputWebsocketUrl,
	resolveWebBaseUrl,
	resolveWebsocketUrl,
} from "../dist/index.js";

test("execution context combines sandbox env and token claims", () => {
	const keys = [
		"COHUB_EXECUTION_TOKEN",
		"COHUB_USER_UUID",
		"COHUB_SPACE_ID",
		"COHUB_SESSION_ID",
		"COHUB_TURN_ID",
		"COHUB_TOOL_CALL_ID",
		"COHUB_SOURCE_CLIENT_ID",
		"COHUB_MODEL_PROVIDER",
		"COHUB_MODEL_ID",
	] as const;
	const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	for (const key of keys) delete process.env[key];
	const payload = Buffer.from(JSON.stringify({
		viewerUserId: "viewer-1",
		appId: "app-1",
		action: "generate",
		taskRunId: "task-1",
		scopes: ["space.view", "not-a-permission"],
	})).toString("base64url");
	process.env.COHUB_EXECUTION_TOKEN = `header.${payload}.signature`;
	process.env.COHUB_USER_UUID = "actor-1";
	process.env.COHUB_SPACE_ID = "space-1";
	try {
		assert.deepEqual(getCohubContext(), {
			runtime: { kind: "sandbox" },
			execution: {
				source: null,
				actorUserId: "actor-1",
				viewerUserId: "viewer-1",
				spaceId: "space-1",
				sessionId: null,
				turnId: null,
				toolCallId: null,
				sourceClientId: null,
				taskRunId: "task-1",
				appId: "app-1",
				appVersionId: null,
				action: "generate",
				scopes: ["space.view"],
				modelProvider: null,
				modelId: null,
			},
		});
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test("a Space target does not change a local runtime", () => {
	const previousToken = process.env.COHUB_EXECUTION_TOKEN;
	const previousSpace = process.env.COHUB_SPACE_ID;
	delete process.env.COHUB_EXECUTION_TOKEN;
	process.env.COHUB_SPACE_ID = "space-1";
	try {
		assert.deepEqual(getCohubContext(), {
			runtime: { kind: "local" },
			execution: null,
		});
	} finally {
		if (previousToken === undefined) delete process.env.COHUB_EXECUTION_TOKEN;
		else process.env.COHUB_EXECUTION_TOKEN = previousToken;
		if (previousSpace === undefined) delete process.env.COHUB_SPACE_ID;
		else process.env.COHUB_SPACE_ID = previousSpace;
	}
});

test("production uses cohub.live endpoints by default", () => {
	assert.deepEqual(COHUB_ENVIRONMENTS.prod, {
		apiBaseUrl: "https://api.cohub.live",
		webBaseUrl: "https://cohub.live",
		websocketUrl: "wss://gateway.cohub.live/ws",
		voiceInputWebsocketUrl: "wss://gateway.cohub.live/asr/ws",
	});
	assert.equal(resolveApiBaseUrl({ env: "prod" }), "https://api.cohub.live");
	assert.equal(resolveWebBaseUrl({ env: "prod" }), "https://cohub.live");
	assert.equal(resolveWebsocketUrl({ env: "prod" }), "wss://gateway.cohub.live/ws");
	assert.equal(
		resolveVoiceInputWebsocketUrl({ env: "prod" }),
		"wss://gateway.cohub.live/asr/ws",
	);
});

test("development uses cohub.live endpoints", () => {
	assert.deepEqual(COHUB_ENVIRONMENTS.dev, {
		apiBaseUrl: "https://api-dev.cohub.live",
		webBaseUrl: "https://dev.cohub.live",
		websocketUrl: "wss://gateway-dev.cohub.live/ws",
		voiceInputWebsocketUrl: "wss://gateway-dev.cohub.live/asr/ws",
	});
	assert.equal(resolveApiBaseUrl({ env: "dev" }), "https://api-dev.cohub.live");
	assert.equal(resolveWebBaseUrl({ env: "dev" }), "https://dev.cohub.live");
	assert.equal(resolveWebsocketUrl({ env: "dev" }), "wss://gateway-dev.cohub.live/ws");
	assert.equal(
		resolveVoiceInputWebsocketUrl({ env: "dev" }),
		"wss://gateway-dev.cohub.live/asr/ws",
	);
});

test("custom API endpoints preserve proxy paths and explicit overrides", async () => {
  const previous = process.env.COHUB_BASE_URL;
  process.env.COHUB_BASE_URL = " https://custom.example.test/proxy/ ";
  try {
    const calls: string[] = [];
    const fetch = async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return Response.json({ uuid: "user-1" });
    };
    await createHttpClient({ fetch, getAccessToken: () => "token" }).user.getMe();
    await createHttpClient({ baseUrl: "https://explicit.example.test/", fetch, getAccessToken: () => "token" }).user.getMe();
    assert.deepEqual(calls, ["https://custom.example.test/proxy/api/me", "https://explicit.example.test/api/me"]);
  } finally {
    if (previous === undefined) delete process.env.COHUB_BASE_URL;
    else process.env.COHUB_BASE_URL = previous;
  }
});
