import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveRuntimeModelsConfig, type ModelsConfig } from "@cohub/infra/config-runtime/models";
import { CohubModelRegistry } from "../runtime/model-registry.js";

const platform: ModelsConfig = {
  providers: {
    cohub: {
      api: "openai-responses", baseUrl: "https://platform.example.test/v1",
      apiKey: "R02_AGENT_SECRET", headers: { "X-Key": "synthetic-platform-header" },
      models: [{ id: "platform" }],
    },
  },
};

test("agent registry resolves platform references at the loader boundary, never user literals", (t) => {
  const previous = process.env.R02_AGENT_SECRET;
  process.env.R02_AGENT_SECRET = "synthetic-agent-secret";
  t.after(() => {
    if (previous === undefined) delete process.env.R02_AGENT_SECRET;
    else process.env.R02_AGENT_SECRET = previous;
  });
  const user: ModelsConfig = {
    providers: {
      custom: {
        api: "openai-completions", baseUrl: "https://user.example.test/v1",
        apiKey: "R02_AGENT_SECRET", models: [{ id: "custom" }],
      },
    },
  };
  const registry = new CohubModelRegistry({ configs: [resolveRuntimeModelsConfig({ platform, user })] });
  assert.equal(registry.getApiKey("cohub"), "synthetic-agent-secret");
  assert.equal(registry.getApiKey("custom"), "R02_AGENT_SECRET");
  registry.refresh();
  assert.equal(registry.getApiKey("custom"), "R02_AGENT_SECRET");
});

test("agent registry does not retain platform headers or models for a replaced provider", () => {
  const user: ModelsConfig = {
    providers: {
      cohub: {
        api: "openai-completions", baseUrl: "https://user.example.test/v1",
        apiKey: "user-key", models: [{ id: "custom" }],
      },
    },
  };
  const registry = new CohubModelRegistry({ configs: [resolveRuntimeModelsConfig({ platform, user })] });
  assert.equal(registry.getApiKey("cohub"), "user-key");
  assert.equal(registry.getHeaders("cohub", "custom"), undefined);
  assert.equal(registry.find("cohub", "platform"), undefined);
  assert.equal(registry.find("cohub", "custom")?.baseUrl, "https://user.example.test/v1");
});
