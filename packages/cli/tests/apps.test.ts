import assert from "node:assert/strict";
import { test } from "node:test";
import type { CohubHttpClient, AppViewStatsResponse } from "@neta-art/cohub";
import { Command } from "commander";
import { registerApps, getAppStatsByRef } from "../src/commands/apps.js";

const stats: AppViewStatsResponse = {
  summary: { totalViews: 42, views24h: 8, views7d: 21, views30d: 42 },
  daily: [],
  sources: [
    { source: "web", views: 30 },
    { source: "cli", views: 8 },
    { source: "api", views: 4 },
  ],
};

test("incremental authorization is opt-in", () => {
  const program = new Command("cohub");
  registerApps(program);
  const authorize = program.commands.find((command) => command.name() === "apps")?.commands.find((command) => command.name() === "authorize");
  assert.ok(authorize);
  assert.equal(authorize.opts().extend, undefined);
  authorize.parseOptions(["--scope", "file.view", "--extend"]);
  assert.equal(authorize.opts().extend, true);
});

test("apps command registers stats", () => {
  const program = new Command("cohub");
  registerApps(program);
  const apps = program.commands.find((command) => command.name() === "apps");
  assert.match(apps?.helpInformation() ?? "", /stats \[options\] <app>/);
});

test("getAppStatsByRef resolves public references before requesting stats", async () => {
  const calls: string[] = [];
  const client = {
    apps: {
      getBySlug: async (username: string, spaceSlug: string, appSlug: string) => {
        calls.push(`resolve:${username}/${spaceSlug}/${appSlug}`);
        return { app: { id: "app-1" } };
      },
      getStats: async (appId: string) => {
        calls.push(`stats:${appId}`);
        return stats;
      },
    },
  } as unknown as CohubHttpClient;

  assert.equal(await getAppStatsByRef(client, "alice/studio/launch"), stats);
  assert.deepEqual(calls, ["resolve:alice/studio/launch", "stats:app-1"]);
});

test("getAppStatsByRef requests stats directly for work ids", async () => {
  const calls: string[] = [];
  const client = {
    apps: {
      get: async () => {
        throw new Error("work details should not be requested");
      },
      getStats: async (appId: string) => {
        calls.push(`stats:${appId}`);
        return stats;
      },
    },
  } as unknown as CohubHttpClient;
  const appId = "123e4567-e89b-42d3-a456-426614174000";

  assert.equal(await getAppStatsByRef(client, appId), stats);
  assert.deepEqual(calls, [`stats:${appId}`]);
});
