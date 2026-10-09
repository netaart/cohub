import assert from "node:assert/strict";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelsConfig } from "@cohub/infra/config-runtime/models";
import { applyRequestProfile, type ProfiledModel } from "@cohub/model-runtime/request-profile";
import { CohubModelRegistry } from "../runtime/model-registry.js";

const config: ModelsConfig = {
  providers: {
    test: {
      api: "openai-responses",
      baseUrl: "https://example.test/v1",
      headers: { Originator: "provider", "User-Agent": "provider-agent", "X-Shared": "provider" },
      models: [
        {
          id: "gpt-test",
          requestProfile: "codex",
          compat: { sessionAffinityFormat: "openai-nosession" },
          headers: { originator: "codex_cli_rs", "user-agent": "codex_cli_rs/test", "x-shared": "model" },
        },
      ],
    },
  },
};

const registry = new CohubModelRegistry({ configs: [config] });
const model = registry.find("test", "gpt-test");
assert.ok(model);
assert.equal(model.requestProfile, "codex");
assert.equal(registry.getHeaders("test", "gpt-test"), model.headers);
assert.deepEqual(model.headers, {
  originator: "codex_cli_rs",
  "user-agent": "codex_cli_rs/test",
  "x-shared": "model",
});

const sessionId = "x".repeat(67);
const options = applyRequestProfile(model, {
  sessionId,
  threadId: "thread-branch",
  headers: { "Session-Id": "override", "X-Request": "request" },
});
assert.deepEqual(options.headers, {
  "thread-id": "thread-branch",
  "Session-Id": "override",
  "X-Request": "request",
});
// The profile hint is consumed, not forwarded to the provider.
assert.equal("threadId" in options, false);

const alternateCompatModel = {
  ...model,
  compat: { sessionAffinityFormat: "openai" },
} as ProfiledModel;
assert.deepEqual(applyRequestProfile(alternateCompatModel, { sessionId: "session" }).headers, {
  "session-id": "session",
  "thread-id": "session",
});

const alternateApiModel = {
  ...model,
  api: "anthropic-messages",
} as Model<"anthropic-messages"> & { requestProfile: "codex" };
assert.deepEqual(applyRequestProfile(alternateApiModel, { sessionId: "session" }).headers, {
  "session-id": "session",
  "thread-id": "session",
});
