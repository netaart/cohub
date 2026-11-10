import assert from "node:assert/strict";
import { test } from "node:test";
import { createStderrClassifier } from "../src/system/jobs/workspace-usage/pdu.js";

test("only vanished and unreadable entries are non-fatal", () => {
  const classifier = createStderrClassifier();
  classifier.push([
    '[error] read_dir "/w/tmp": No such file or directory (os error 2)',
    '[error] read_dir "/w/locked": Permission denied (os error 13)',
    '[error] read_dir "/w/a": Input/output error (os error 5)',
    "",
  ].join("\n"));
  assert.equal(classifier.end(), '[error] read_dir "/w/a": Input/output error (os error 5)');
});
