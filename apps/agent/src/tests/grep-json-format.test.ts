import assert from "node:assert/strict";
import test from "node:test";
import { createRgJsonGrepCollector } from "../runtime/tools/grep-json-format.js";

type RgEvent = { type: string; data?: Record<string, unknown> };

function rgFileEvents(path: string, matches: Array<{ line: number; text: string; kind?: "match" | "context" }>): RgEvent[] {
  return [
    { type: "begin", data: { path: { text: path } } },
    ...matches.map(({ line, text, kind = "match" }) => ({
      type: kind,
      data: { path: { text: path }, lines: { text: `${text}\n` }, line_number: line },
    })),
    { type: "end", data: { path: { text: path } } },
  ];
}

function streamInChunks(events: RgEvent[], chunkSize: number) {
  const stdout = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  const chunks: string[] = [];
  for (let offset = 0; offset < stdout.length; offset += chunkSize) chunks.push(stdout.slice(offset, offset + chunkSize));
  return chunks;
}

function collect(events: RgEvent[], limit: number, chunkSize = 7) {
  const collector = createRgJsonGrepCollector({ searchPath: ".", limit });
  for (const chunk of streamInChunks(events, chunkSize)) collector.push(chunk);
  collector.end();
  const result = collector.format();
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  return { result, text, matchLines: text.split("\n").filter((line) => /:\d+: /.test(line)) };
}

test("the grep limit counts matches, not rg begin/end events", () => {
  const events = Array.from({ length: 60 }, (_, index) => rgFileEvents(`./f${index}.txt`, [{ line: 1, text: `hit ${index}` }])).flat();
  events.push({ type: "summary" });

  const { result, text, matchLines } = collect(events, 100);

  assert.equal(matchLines.length, 60);
  assert.doesNotMatch(text, /limit reached/);
  assert.equal(result.details, undefined);
});

test("the grep limit truncates at the requested match count and says so", () => {
  const events = Array.from({ length: 150 }, (_, index) => rgFileEvents(`./f${index}.txt`, [{ line: 3, text: `hit ${index}` }])).flat();

  const { result, text, matchLines } = collect(events, 100);

  assert.equal(matchLines.length, 100);
  assert.match(text, /100 matches limit reached/);
  assert.equal(result.details?.matchLimitReached, 100);
});

test("context lines do not consume the match limit", () => {
  const events = [
    ...rgFileEvents("./a.txt", [
      { line: 1, text: "before", kind: "context" },
      { line: 2, text: "first hit" },
      { line: 3, text: "after", kind: "context" },
    ]),
    ...rgFileEvents("./b.txt", [
      { line: 9, text: "before", kind: "context" },
      { line: 10, text: "second hit" },
    ]),
  ];

  const { text, matchLines } = collect(events, 2);

  assert.deepEqual(matchLines, ["a.txt:2: first hit", "b.txt:10: second hit"]);
  assert.match(text, /a\.txt-1- before/);
  assert.match(text, /b\.txt-9- before/);
});

test("a final line without a trailing newline is kept", () => {
  const collector = createRgJsonGrepCollector({ searchPath: ".", limit: 10 });
  const match = JSON.stringify({ type: "match", data: { path: { text: "./a.txt" }, lines: { text: "hit\n" }, line_number: 4 } });

  assert.equal(collector.push(match), false);
  assert.equal(collector.end(), true);
  assert.equal(collector.lines.length, 1);
  const result = collector.format();
  assert.equal(result.content[0]?.type === "text" ? result.content[0].text : "", "a.txt:4: hit");
});
