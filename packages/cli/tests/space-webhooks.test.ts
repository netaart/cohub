import assert from "node:assert/strict";
import { test } from "node:test";
import { Command } from "commander";
import { parseBody, registerSpaceWebhooks } from "../src/commands/space-webhooks.js";

type Sent = { path: string; init?: RequestInit };

function createProgram() {
	return new Command("cohub")
		.option("-s, --space <id>", "Target space ID")
		.helpOption("-h, --help", "Show help");
}

test("spaces webhooks registers ls, url and trigger", () => {
	const program = createProgram();
	const spaces = program.command("spaces");
	registerSpaceWebhooks(spaces, { createClient: (() => ({})) as never });
	const webhooks = spaces.commands.at(-1);
	assert.equal(webhooks?.name(), "webhooks");
	assert.deepEqual(
		webhooks?.commands.map((command) => command.name()),
		["ls", "url", "trigger"],
	);
});

test("spaces webhooks url prints the trigger URL for the selected space", async () => {
	const program = createProgram();
	const spaces = program.command("spaces");
	registerSpaceWebhooks(spaces, {
		createClient: (() => ({
			space: (spaceId: string) => ({
				webhooks: {
					path: (name: string) => `/api/spaces/${spaceId}/webhooks/${name}`,
				},
			}),
		})) as never,
	});

	const chunks: string[] = [];
	const originalWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((chunk: string) => {
		chunks.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	try {
		await program.parseAsync(["node", "cohub", "-s", "7c9e6679-7425-40de-944b-e07fc1f90ae7", "spaces", "webhooks", "url", "mail"]);
	} finally {
		process.stdout.write = originalWrite;
	}

	assert.match(chunks.join(""), /\/api\/spaces\/7c9e6679-7425-40de-944b-e07fc1f90ae7\/webhooks\/mail\n$/);
});

test("spaces webhooks trigger forwards the JSON body and secret", async () => {
	const sent: Sent[] = [];
	const program = createProgram();
	const spaces = program.command("spaces");
	registerSpaceWebhooks(spaces, {
		createClient: (() => ({
			space: (spaceId: string) => ({
				webhooks: {
					trigger: async (name: string, body: unknown, options: { secret?: string }) => {
						sent.push({
							path: `/api/spaces/${spaceId}/webhooks/${name}`,
							init: { body: JSON.stringify(body), headers: { secret: options.secret ?? "" } },
						});
						return { taskRunId: "task-1", hook: ".cohub/hooks/mail.yml", eventId: "event-1" };
					},
				},
			}),
		})) as never,
	});

	await program.parseAsync([
		"node", "cohub", "-s", "7c9e6679-7425-40de-944b-e07fc1f90ae7", "spaces", "webhooks", "trigger", "mail",
		"--body", '{"from":"a@b.c"}', "--secret", "wh_1",
	]);

	assert.equal(sent[0]?.path, "/api/spaces/7c9e6679-7425-40de-944b-e07fc1f90ae7/webhooks/mail");
	assert.equal(sent[0]?.init?.body, '{"from":"a@b.c"}');
	assert.deepEqual(sent[0]?.init?.headers, { secret: "wh_1" });
});

test("spaces webhooks trigger defaults the body to null", () => {
	assert.equal(parseBody(undefined), null);
	assert.deepEqual(parseBody('{"a":1}'), { a: 1 });
});
