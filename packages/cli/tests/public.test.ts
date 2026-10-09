import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { CohubHttpClient, PublicFileCreateUploadInput } from "@neta-art/cohub";
import { Command } from "commander";
import { collectPublicUpload, registerPublic } from "../src/commands/public.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "cohub-public-"));
  tempDirs.push(root);
  const dist = join(root, "dist");
  await mkdir(join(dist, "assets"), { recursive: true });
  await writeFile(join(dist, "index.html"), "<!doctype html>");
  await writeFile(join(dist, "assets", "demo.mp4"), "video");
  return dist;
}

function publicUrl(path: string) {
  return `https://cdn.example/p/7c9e6679-7425-40de-944b-e07fc1f90ae7/${path.split("/").map(encodeURIComponent).join("/")}`;
}

function createUploadClient() {
  return {
    space: () => ({
      publicFiles: {
        createUpload: async (input: PublicFileCreateUploadInput) => ({
          entries: input.entries.map((entry) => ({
            id: entry.id,
            path: entry.relativePath,
            uploadUrl: `https://upload.example/${entry.id}`,
            publicUrl: publicUrl(entry.relativePath),
            headers: { "content-type": entry.mimeType ?? "application/octet-stream" },
          })),
        }),
      },
    }),
  } as unknown as CohubHttpClient;
}

test("public commands do not expose removal", () => {
  const program = new Command("cohub");
  const publicCommand = registerPublic(program);

  assert.deepEqual(publicCommand.commands.map((command) => command.name()), ["upload", "ls", "url"]);
});

test("public upload maps a directory to one concise destination", async () => {
  const dist = await createFixture();
  const upload = await collectPublicUpload(dist, "demo");

  assert.equal(upload.destination, "demo/");
  assert.equal(upload.entryPath, "demo/index.html");
  assert.deepEqual(
    upload.files.map((file) => [file.publicPath, file.mimeType]),
    [
      ["demo/assets/demo.mp4", "video/mp4"],
      ["demo/index.html", "text/html; charset=utf-8"],
    ],
  );
});

test("public upload declares explicit overwrites and prints only the entry URL", async () => {
  const dist = await createFixture();
  let received: PublicFileCreateUploadInput | null = null;
  const uploadedPaths: string[] = [];
  const client = {
    space: () => ({
      publicFiles: {
        createUpload: async (input: PublicFileCreateUploadInput) => {
          received = input;
          return {
            entries: input.entries.map((entry) => ({
              id: entry.id,
              path: entry.relativePath,
              uploadUrl: `https://upload.example/${entry.id}`,
              publicUrl: `https://public.example/p/7c9e6679-7425-40de-944b-e07fc1f90ae7/${entry.relativePath}`,
              headers: { "content-type": entry.mimeType ?? "application/octet-stream" },
            })),
          };
        },
      },
    }),
  } as unknown as CohubHttpClient;
  const program = new Command("cohub").option("-s, --space <id>");
  registerPublic(program, {
    createClient: () => client,
    fetch: async (input) => {
      const entry = received?.entries.find((candidate) => String(input).endsWith(candidate.id));
      if (entry) uploadedPaths.push(entry.relativePath);
      return new Response(null, { status: 200 });
    },
  });

  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalWrite = process.stderr.write;
  console.log = (...values: unknown[]) => logs.push(values.join(" "));
  process.stderr.write = ((chunk: string | Uint8Array) => {
    errors.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await program.parseAsync(["node", "cohub", "-s", "7c9e6679-7425-40de-944b-e07fc1f90ae7", "public", "upload", dist, "demo", "--overwrite"]);
  } finally {
    console.log = originalLog;
    process.stderr.write = originalWrite;
  }

  assert.equal(received?.overwrite, true);
  assert.equal(uploadedPaths.at(-1), "demo/index.html");
  assert.deepEqual(logs, ["https://public.example/p/7c9e6679-7425-40de-944b-e07fc1f90ae7/demo/index.html"]);
  assert.equal(errors.join(""), "Overwrite enabled for demo/\n");
});

test("public upload prints the CDN prefix for a directory without an entry file", async () => {
  const dist = await createFixture();
  await rm(join(dist, "index.html"));
  const program = new Command("cohub").option("-s, --space <id>");
  registerPublic(program, {
    createClient: createUploadClient,
    fetch: async () => new Response(null, { status: 200 }),
  });

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => logs.push(values.join(" "));
  try {
    await program.parseAsync(["node", "cohub", "-s", "7c9e6679-7425-40de-944b-e07fc1f90ae7", "public", "upload", dist, "demo files"]);
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(logs, [
    "Uploaded 1 file to demo files/",
    "URL prefix: https://cdn.example/p/7c9e6679-7425-40de-944b-e07fc1f90ae7/demo%20files/",
  ]);
});

test("public upload JSON combines one URL prefix with the complete file manifest", async () => {
  const dist = await createFixture();
  const program = new Command("cohub").option("-s, --space <id>");
  registerPublic(program, {
    createClient: createUploadClient,
    fetch: async () => new Response(null, { status: 200 }),
  });

  const logs: string[] = [];
  const originalArgv = process.argv;
  const originalLog = console.log;
  process.argv = [...process.argv, "--json"];
  console.log = (...values: unknown[]) => logs.push(values.join(" "));
  try {
    await program.parseAsync(["node", "cohub", "-s", "7c9e6679-7425-40de-944b-e07fc1f90ae7", "public", "upload", dist, "demo"]);
  } finally {
    process.argv = originalArgv;
    console.log = originalLog;
  }

  assert.equal(logs.length, 1);
  assert.deepEqual(JSON.parse(logs[0] as string), {
    destination: "demo/",
    urlPrefix: "https://cdn.example/p/7c9e6679-7425-40de-944b-e07fc1f90ae7/",
    files: [
      {
        path: "demo/assets/demo.mp4",
        size: 5,
        mimeType: "video/mp4",
      },
      {
        path: "demo/index.html",
        size: 15,
        mimeType: "text/html; charset=utf-8",
      },
    ],
  });
});

test("public ls follows pagination without exposing cursors", async () => {
  const cursors: Array<string | undefined> = [];
  const client = {
    space: () => ({
      publicFiles: {
        list: async (_path: string, options: { cursor?: string }) => {
          cursors.push(options.cursor);
          return options.cursor
            ? {
                path: "demo",
                entries: [{ path: "demo/index.html", name: "index.html", kind: "file", size: 1, updatedAt: null, publicUrl: "url" }],
                nextCursor: null,
              }
            : {
                path: "demo",
                entries: [{ path: "demo/assets", name: "assets", kind: "directory", size: null, updatedAt: null, publicUrl: null }],
                nextCursor: "page-2",
              };
        },
      },
    }),
  } as unknown as CohubHttpClient;
  const program = new Command("cohub").option("-s, --space <id>");
  registerPublic(program, { createClient: () => client });

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => logs.push(values.join(" "));
  try {
    await program.parseAsync(["node", "cohub", "-s", "7c9e6679-7425-40de-944b-e07fc1f90ae7", "public", "ls", "demo"]);
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(cursors, [undefined, "page-2"]);
  assert.deepEqual(logs, ["assets/", "index.html"]);
});
