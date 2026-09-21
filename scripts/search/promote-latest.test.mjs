import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./promote-latest.mjs", import.meta.url));

function fixture(t, current) {
  const root = mkdtempSync(join(tmpdir(), "cohub-search-release-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pointer = join(root, "latest.json");
  const requests = join(root, "requests.jsonl");
  if (current !== undefined) writeFileSync(pointer, current);
  writeFileSync(
    join(root, "aws"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const root = process.env.MOCK_OSS_STATE;
const pointer = path.join(root, "latest.json");
fs.appendFileSync(path.join(root, "requests.jsonl"), JSON.stringify(args) + "\\n");
if (args[0] === "s3api" && args[1] === "get-object") {
  if (process.env.MOCK_GET_ERROR || !fs.existsSync(pointer)) {
    console.error(process.env.MOCK_GET_ERROR || "An error occurred (NoSuchKey) when calling the GetObject operation");
    process.exit(1);
  }
  fs.copyFileSync(pointer, args.at(-1));
} else if (args[0] === "s3" && args[1] === "cp") {
  if (process.env.MOCK_PUT_ERROR) {
    console.error(process.env.MOCK_PUT_ERROR);
    process.exit(1);
  }
  fs.copyFileSync(args[2], pointer);
} else {
  throw new Error("Unexpected AWS command: " + JSON.stringify(args));
}
`,
    { mode: 0o700 },
  );
  return {
    run(version, overrides = {}) {
      return spawnSync(process.execPath, [script], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${root}${delimiter}${process.env.PATH}`,
          VERSION: version,
          OSS_BUCKET: "test-releases",
          OSS_ENDPOINT: "https://oss.example.test",
          MOCK_OSS_STATE: root,
          ...overrides,
        },
      });
    },
    readPointer: () => readFileSync(pointer, "utf8"),
    requests: () => existsSync(requests)
      ? readFileSync(requests, "utf8").trim().split("\n").map((line) => JSON.parse(line))
      : [],
  };
}

for (const version of ["v2.53.1", "v2.53.2"]) {
  test(`rerunning ${version} leaves the latest pointer unchanged`, (t) => {
    const current = '{"version":"v2.53.2"}\n';
    const store = fixture(t, current);
    const result = store.run(version);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(store.readPointer(), current);
    assert.equal(store.requests().length, 1);
    assert.deepEqual(store.requests()[0].slice(0, 2), ["s3api", "get-object"]);
  });
}

test("creates the first pointer only when OSS reports NoSuchKey", (t) => {
  const store = fixture(t);
  const result = store.run("v2.53.2");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(store.readPointer(), '{"version":"v2.53.2"}\n');
  const [read, write] = store.requests();
  assert.deepEqual(read.slice(0, -1), [
    "s3api", "get-object", "--bucket", "test-releases", "--key", "search/latest.json",
    "--endpoint-url", "https://oss.example.test",
  ]);
  assert.deepEqual(write.slice(3), [
    "s3://test-releases/search/latest.json",
    "--endpoint-url", "https://oss.example.test",
    "--content-type", "application/json",
    "--cache-control", "no-cache, max-age=0",
  ]);
});

for (const [current, version] of [
  ["v2.9.9", "v2.10.0"],
  ["v2.53.9", "v2.53.10"],
  ["v2.99.99", "v3.0.0"],
]) {
  test(`promotes ${current} to ${version} using numeric version ordering`, (t) => {
    const store = fixture(t, JSON.stringify({ version: current }));
    const result = store.run(version);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(store.readPointer()).version, version);
    assert.equal(store.requests().length, 2);
  });
}

for (const error of [
  "An error occurred (AccessDenied) when calling the GetObject operation",
  "An error occurred (NoSuchBucket) when calling the GetObject operation",
  "Could not connect to the endpoint URL",
]) {
  test(`does not overwrite the pointer after a read failure: ${error}`, (t) => {
    const current = '{"version":"v2.53.2"}\n';
    const store = fixture(t, current);
    const result = store.run("v2.54.0", { MOCK_GET_ERROR: error });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Read latest release failed/);
    assert.equal(store.readPointer(), current);
    assert.equal(store.requests().length, 1);
  });
}

for (const current of ["not JSON", "null", '{}', '{"version":"v2.53.2-rc.1"}']) {
  test(`refuses to overwrite an invalid pointer: ${current}`, (t) => {
    const store = fixture(t, current);
    const result = store.run("v2.54.0");
    assert.notEqual(result.status, 0);
    assert.equal(store.readPointer(), current);
    assert.equal(store.requests().length, 1);
  });
}

for (const version of ["v2.54.0-rc.1", "../latest"]) {
  test(`rejects an unsupported release version before contacting OSS: ${version}`, (t) => {
    const store = fixture(t);
    const result = store.run(version);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid search release version/);
    assert.deepEqual(store.requests(), []);
  });
}

for (const name of ["VERSION", "OSS_BUCKET", "OSS_ENDPOINT"]) {
  test(`requires ${name} before contacting OSS`, (t) => {
    const store = fixture(t);
    const result = store.run("v2.54.0", { [name]: "" });
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(`Missing ${name}`));
    assert.deepEqual(store.requests(), []);
  });
}

test("reports upload failure without claiming a successful promotion", (t) => {
  const current = '{"version":"v2.53.2"}\n';
  const store = fixture(t, current);
  const result = store.run("v2.54.0", { MOCK_PUT_ERROR: "AccessDenied" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AccessDenied/);
  assert.doesNotMatch(result.stdout, /Promoted search/);
  assert.equal(store.readPointer(), current);
});
