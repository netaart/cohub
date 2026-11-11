import assert from "node:assert/strict";
import { test } from "node:test";
import { readLedger, type LedgerRow, type LedgerSource } from "../src/balance-ledger.js";

const base = Date.parse("2026-11-10T00:00:00.000Z");

function row(id: string, at: number, type: LedgerRow["type"], amountUsd: number, operationId: string | null = null): LedgerRow {
  return {
    key: `${type === "overage" ? "overage" : "transaction"}:${id}`,
    type, tokenType: "usd_micro_cent", amountUsd, usageType: "generation.llm",
    sourceType: "usage", sourceId: null, operationId, reason: null,
    createdAt: new Date(base + at).toISOString(),
  };
}

function source(rows: LedgerRow[]): LedgerSource {
  const sorted = [...rows].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return async ({ to, page, limit }) => {
    const visible = sorted.filter((item) => !to || Date.parse(item.createdAt) <= Date.parse(to));
    const items = visible.slice((page - 1) * limit, page * limit);
    return { items, hasMore: visible.length > page * limit };
  };
}

async function readAll(sources: LedgerSource[], limit: number) {
  const pages = [];
  let cursor: string | null = null;
  do {
    const page = await readLedger({ sources, cursor, limit });
    pages.push(page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return pages;
}

test("readLedger keeps an operation interleaved with the page boundary on one page", async () => {
  const pages = await readAll([source([
    row("x1", 10, "consume", 1, "op-x"),
    row("y", 9, "consume", 1, "op-y"),
    row("x2", 8, "consume", 1, "op-x"),
    row("z", 7, "consume", 1, "op-z"),
  ])], 1);
  assert.deepEqual(pages.map((items) => items.map((item) => [item.id, item.amountUsd])), [
    [["usage:operation:op-x", -2]],
    [["usage:operation:op-y", -1]],
    [["usage:operation:op-z", -1]],
  ]);
});
