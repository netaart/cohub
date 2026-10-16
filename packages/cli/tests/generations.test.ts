import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { CohubHttpClient, CreateGenerationTaskRequest } from "@neta-art/cohub";
import { Command } from "commander";
import { registerGenerations } from "../src/commands/generations.js";

const SPACE_ID = "11111111-1111-4111-8111-111111111111";

type Upload = { mimeType: string; filename: string };

async function generate(argv: string[], uploads: Upload[] = []): Promise<CreateGenerationTaskRequest> {
  let request: CreateGenerationTaskRequest | undefined;
  const program = new Command("cohub").option("-s, --space <id>");
  registerGenerations(program, {
    createClient: () => ({
      publicAssets: {
        uploadGenerationInput: async (input: Upload) => {
          uploads.push({ mimeType: input.mimeType, filename: input.filename });
          return { publicUrl: `https://assets.example.com/${input.filename}` };
        },
      },
      generations: {
        create: async (input: CreateGenerationTaskRequest) => {
          request = input;
          return { taskRunId: "task-1", taskType: "generation", status: "pending" };
        },
      },
    }) as unknown as CohubHttpClient,
  });
  const originalLog = console.log;
  const originalError = process.stderr.write;
  console.log = () => undefined;
  process.stderr.write = () => true;
  try {
    await program.parseAsync(["node", "cohub", "-s", SPACE_ID, "generate", ...argv, "--async", "--json"]);
  } finally {
    console.log = originalLog;
    process.stderr.write = originalError;
  }
  assert.ok(request);
  return request;
}

test("local 3D models upload by extension before the task is created", async () => {
  const dir = await mkdtemp(join(import.meta.dirname, ".generate-"));
  try {
    await writeFile(join(dir, "chest.glb"), "glTF");
    await writeFile(join(dir, "pose.fbx"), "Kaydara");
    const uploads: Upload[] = [];
    const request = await generate(
      ["-m", "meshy", "--3d", join(dir, "chest.glb"), "--3d", join(dir, "pose.fbx"), "--param", "operation=remesh"],
      uploads,
    );
    assert.deepEqual(uploads, [
      { mimeType: "model/gltf-binary", filename: "chest.glb" },
      { mimeType: "application/octet-stream", filename: "pose.fbx" },
    ]);
    assert.deepEqual(request.content, [
      { type: "3d", source: { type: "url", url: "https://assets.example.com/chest.glb" } },
      { type: "3d", source: { type: "url", url: "https://assets.example.com/pose.fbx" } },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("3D inputs take a role prefix the model declares and no prompt", async () => {
  const request = await generate([
    "-m", "meshy",
    "--3d", "https://cdn.example.com/rigged.glb",
    "--3d", "motion=https://cdn.example.com/clip.fbx",
    "--param", "operation=animation",
    "--param", "action_ids=[10,25]",
  ]);
  assert.deepEqual(request.content, [
    { type: "3d", source: { type: "url", url: "https://cdn.example.com/rigged.glb" } },
    { type: "3d", source: { type: "url", url: "https://cdn.example.com/clip.fbx" }, meta: { role: "motion" } },
  ]);
  assert.deepEqual(request.parameters, { operation: "animation", action_ids: [10, 25] });
});

test("an output block passes back unchanged with its meta", async () => {
  const block = {
    type: "3d",
    source: { type: "url", url: "https://cdn.example.com/preview.glb" },
    meta: { task_id: "task_preview", task_type: "text-to-3d-preview", field: "model_urls.glb" },
  };
  const request = await generate([
    "weathered oak",
    "-m", "meshy",
    "--param", "operation=text-to-3d-refine",
    "--block", JSON.stringify(block),
  ]);
  assert.deepEqual(request.content, [{ type: "text", text: "weathered oak" }, block]);
});

test("image roles beyond frames and references reach the model unchanged", async () => {
  const request = await generate([
    "-m", "meshy",
    "--image", "https://cdn.example.com/front.png",
    "--image", "texture=https://cdn.example.com/style.png",
    "--param", "operation=image-to-3d",
  ]);
  assert.deepEqual(request.content.map((block) => block.meta?.role ?? null), [null, "texture"]);
});
