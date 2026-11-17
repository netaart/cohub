import assert from "node:assert/strict";
import test from "node:test";
import { CSV_PREVIEW_MAX_ROWS, parseCsv } from "#lib/csv-parse.ts";

test("parses a plain comma-separated table with a header", () => {
	const result = parseCsv("name,age,city\nAlice,30,NYC\nBob,25,LA\n");
	assert.deepEqual(result.headers, ["name", "age", "city"]);
	assert.deepEqual(result.rows, [
		["Alice", "30", "NYC"],
		["Bob", "25", "LA"],
	]);
	assert.equal(result.totalRows, 2);
	assert.equal(result.truncated, false);
	assert.equal(result.delimiter, ",");
});

test("keeps commas inside quoted fields", () => {
	const result = parseCsv('a,b\n"x,y",z\n');
	assert.deepEqual(result.rows, [["x,y", "z"]]);
});

test("unquotes escaped double quotes", () => {
	const result = parseCsv('a\n"he said ""hi"""\n');
	assert.deepEqual(result.rows, [['he said "hi"']]);
});

test("handles CRLF and lone CR line endings", () => {
	const crlf = parseCsv("a,b\r\n1,2\r\n3,4\r\n");
	assert.equal(crlf.rows.length, 2);
	const cr = parseCsv("a,b\r1,2\r3,4\r");
	assert.equal(cr.rows.length, 2);
});

test("does not emit a trailing blank record", () => {
	const result = parseCsv("a,b\n1,2\n");
	assert.equal(result.rows.length, 1);
});

test("skips physically blank lines", () => {
	const result = parseCsv("a,b\n1,2\n\n\n3,4\n");
	assert.deepEqual(result.rows, [
		["1", "2"],
		["3", "4"],
	]);
});

test("keeps rows that are shorter or longer than the header", () => {
	const result = parseCsv("a,b,c\n1,2\n3,4,5,6\n");
	assert.deepEqual(result.rows, [
		["1", "2"],
		["3", "4", "5", "6"],
	]);
});

test("returns an empty result for an empty file", () => {
	const result = parseCsv("");
	assert.deepEqual(result.headers, []);
	assert.deepEqual(result.rows, []);
	assert.equal(result.totalRows, 0);
});

test("returns headers only for a header-only file", () => {
	const result = parseCsv("a,b,c\n");
	assert.deepEqual(result.headers, ["a", "b", "c"]);
	assert.deepEqual(result.rows, []);
	assert.equal(result.totalRows, 0);
});

test("supports multi-line quoted fields", () => {
	const result = parseCsv('a,b\n"line1\nline2",x\n');
	assert.deepEqual(result.rows, [["line1\nline2", "x"]]);
});

test("auto-detects tab as the delimiter for TSV content", () => {
	const result = parseCsv("name\tage\nAlice\t30\n");
	assert.equal(result.delimiter, "\t");
	assert.deepEqual(result.headers, ["name", "age"]);
	assert.deepEqual(result.rows, [["Alice", "30"]]);
});

test("keeps the comma default for single-column content", () => {
	const result = parseCsv("one\ntwo\n");
	assert.equal(result.delimiter, ",");
	assert.deepEqual(result.headers, ["one"]);
	assert.deepEqual(result.rows, [["two"]]);
});

test("honours an explicit delimiter override", () => {
	const result = parseCsv("a;b\n1;2\n", { delimiter: ";" });
	assert.deepEqual(result.headers, ["a", "b"]);
	assert.deepEqual(result.rows, [["1", "2"]]);
});

test("truncates rows beyond maxRows and reports an approximate total", () => {
	const source = Array.from(
		{ length: CSV_PREVIEW_MAX_ROWS + 50 },
		(_, index) => `row,${index}`,
	).join("\n");
	const result = parseCsv(source, { maxRows: 10 });
	// maxRows counts data rows only, so a cap of 10 yields exactly 10 rows.
	assert.equal(result.rows.length, 10);
	assert.equal(result.truncated, true);
	assert.ok(result.totalRows > result.rows.length);
});

test("estimates the total accurately when the file has no trailing newline", () => {
	const source = Array.from({ length: 550 }, (_, index) => `row,${index}`).join(
		"\n",
	);
	const result = parseCsv(source, { maxRows: 500 });
	assert.equal(result.rows.length, 500);
	assert.equal(result.truncated, true);
	assert.equal(result.totalRows, 549);
});

test("does not flag a file that ends exactly at the cap as truncated", () => {
	const source = Array.from({ length: 101 }, (_, index) => `row,${index}`).join(
		"\n",
	);
	const result = parseCsv(source, { maxRows: 100 });
	assert.equal(result.rows.length, 100);
	assert.equal(result.truncated, false);
	assert.equal(result.totalRows, 100);
});

test("normalises invalid maxRows and delimiter inputs", () => {
	const source = Array.from({ length: 30 }, (_, index) => `r,${index}`).join(
		"\n",
	);
	// Non-positive / NaN / fractional maxRows fall back or floor.
	assert.equal(parseCsv(source, { maxRows: 0 }).rows.length, 29);
	assert.equal(parseCsv(source, { maxRows: -5 }).rows.length, 29);
	assert.equal(parseCsv(source, { maxRows: Number.NaN }).rows.length, 29);
	assert.equal(parseCsv(source, { maxRows: 4.9 }).rows.length, 4);
	// Empty or multi-character delimiters fall back to auto-detection.
	assert.equal(parseCsv(source, { delimiter: "" }).delimiter, ",");
	assert.equal(parseCsv(source, { delimiter: "||" }).delimiter, ",");
});

test("an explicit maxRows of 1 keeps the header and one data row", () => {
	const result = parseCsv("a,b\n1,2\n3,4\n", { maxRows: 1 });
	assert.deepEqual(result.headers, ["a", "b"]);
	assert.deepEqual(result.rows, [["1", "2"]]);
	assert.equal(result.truncated, true);
});
