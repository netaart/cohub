import assert from "node:assert/strict";
import { test } from "node:test";
import { CohubHttpClient } from "../src/http.js";
import type { Fetch } from "../src/transport.js";

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

test("spaces.create serializes checkpoint bootstrap input and request headers", async () => {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const fetch: Fetch = async (input, init) => {
		requests.push({ url: String(input), init });
		return jsonResponse({ space: {}, taskRunId: "task-1" });
	};
	const client = new CohubHttpClient({
		baseUrl: "https://api.example.test",
		fetch,
	});

	await client.spaces.create(
		{
			name: "Forked space",
			bootstrapSource: {
				type: "checkpoint",
				checkpointId: "checkpoint-1",
			},
		},
		{ "X-Request-Test": "spaces-create" },
	);

	assert.equal(requests[0]?.url, "https://api.example.test/api/spaces");
	assert.equal(requests[0]?.init?.method, "POST");
	const headers = new Headers(requests[0]?.init?.headers);
	assert.equal(headers.get("X-Request-Test"), "spaces-create");
	assert.equal(headers.get("Content-Type"), "application/json");
	assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
		name: "Forked space",
		bootstrapSource: {
			type: "checkpoint",
			checkpointId: "checkpoint-1",
		},
	});
});

test("space prompts retain each explicit Codex approval mode over HTTP", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const client = new CohubHttpClient({ baseUrl: "https://api.example.test", fetch: async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body))); return jsonResponse({ turnId: "turn", userMessageId: "message" });
  } });
  for (const codexApprovalMode of [undefined, "inherit", "read_only", "auto", "full_access"] as const) {
    await client.space("space").prompt({ sessionId: "session", content: [{ type: "text", text: "hello" }], harness: "codex", codexApprovalMode });
    const body = bodies.at(-1);
    assert.ok(body);
    assert.equal(body.codexApprovalMode, codexApprovalMode);
    assert.equal(Object.hasOwn(body, "codexApprovalMode"), codexApprovalMode !== undefined);
  }
});
