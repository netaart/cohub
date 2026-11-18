import assert from "node:assert/strict";
import { test } from "node:test";
import { createGenerationClient, getBuiltinGenerationModel } from "@neta-art/generation";
import { createGenerationTaskFetch } from "../src/generation-task-fetch.js";

function captureFetch() {
  const requests: Request[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    requests.push(new Request(input, init));
    return Response.json({ data: [{ url: "https://media.example/result.png" }] });
  };
  return { requests, fetchFn };
}

test("generation SDK sends the task header without changing authorization or payload", async () => {
  const { requests, fetchFn } = captureFetch();
  const model = getBuiltinGenerationModel("gpt-image-2");
  assert.ok(model);
  const client = createGenerationClient({
    models: [model],
    includeBuiltinModels: false,
    apiKey: "test-key",
    fetch: createGenerationTaskFetch("task-1", { fetchFn }),
  });
  await client.generateResult({ model: model.model, content: [{ type: "text", text: "A tree" }] });

  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.equal(request.url, "https://router.neta.art/v1/images/generations");
  assert.equal(request.headers.get("x-cohub-task-id"), "task-1");
  assert.equal(request.headers.get("authorization"), "Bearer test-key");
  assert.equal(request.headers.get("content-type"), "application/json");
  assert.equal((await request.json()).prompt, "A tree");
  assert.equal(request.redirect, "error");
});
