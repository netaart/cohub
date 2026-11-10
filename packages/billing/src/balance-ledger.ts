import type { BillingBalanceActivity, BillingBalanceActivityKind } from "./interfaces.js";

export type LedgerRow = {
  key: string;
  type: BillingBalanceActivityKind | "consume" | "settlement" | "overage";
  tokenType: string;
  amountUsd: number;
  usageType: string | null;
  sourceType: string | null;
  sourceId: string | null;
  operationId: string | null;
  reason: string | null;
  createdAt: string;
};

export type LedgerSource = (query: { to: string | undefined; page: number; limit: number }) => Promise<{
  items: LedgerRow[];
  hasMore: boolean;
}>;

type Cursor = { before: number; seen: [key: string, at: number][] };

// Upstream stores sub-millisecond times; re-read 1ms and skip rows already shown.
const BOUNDARY_MS = 1;
const MAX_SEEN = 5_000;
const MAX_TIME = 8.64e15;

export function encodeLedgerCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.before, cursor.seen])).toString("base64url");
}

export function decodeLedgerCursor(value: string): Cursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [before, seen] = parsed;
    if (!Number.isSafeInteger(before) || before < 0 || before >= MAX_TIME) return null;
    if (!Array.isArray(seen) || seen.length > MAX_SEEN) return null;
    if (!seen.every((entry) => Array.isArray(entry) && typeof entry[0] === "string" && entry[0].length <= 128 && Number.isSafeInteger(entry[1]))) return null;
    return { before, seen };
  } catch {
    return null;
  }
}

class Stream {
  #buffer: LedgerRow[] = [];
  #page = 1;
  #done = false;

  constructor(
    private readonly source: LedgerSource,
    private readonly to: string | undefined,
    private readonly batch: number,
  ) {}

  get buffered(): readonly LedgerRow[] {
    return this.#buffer;
  }

  async peek(): Promise<LedgerRow | undefined> {
    while (!this.#buffer.length && !this.#done) {
      const page = await this.source({ to: this.to, page: this.#page++, limit: this.batch });
      this.#buffer = page.items;
      this.#done = !page.hasMore;
    }
    return this.#buffer[0];
  }

  shift() {
    this.#buffer.shift();
  }
}

const time = (row: LedgerRow) => Date.parse(row.createdAt) || 0;
const round = (value: number) => Number(value.toFixed(8));
const isUsageRow = (row: LedgerRow) => row.type === "consume" || row.type === "overage";

function groupKey(row: LedgerRow) {
  if (!isUsageRow(row)) return row.key;
  return row.operationId ? `usage:operation:${row.operationId}` : `usage:${row.key}`;
}

type UsageDraft = { first: LedgerRow; covered: number; overage: number };
type Group = { kind: "usage"; draft: UsageDraft } | { kind: "single"; activity: BillingBalanceActivity };

const TITLES: Partial<Record<LedgerRow["type"], string>> = {
  grant: "Credits added",
  reversal: "Usage refund",
  refund: "Refund",
  expire: "Credits expired",
  revoke: "Credits revoked",
  adjust: "Balance adjusted",
};

function usageTitle(usageType: string | null) {
  if (!usageType) return "Usage";
  return usageType.split(/[._-]/g).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function singleActivity(row: LedgerRow): BillingBalanceActivity | null {
  if (row.type === "settlement" || row.type === "consume" || row.type === "overage" || row.amountUsd === 0) return null;
  const negative = row.type === "expire" || row.type === "revoke";
  return {
    id: row.key,
    kind: row.type,
    tokenType: row.tokenType,
    title: TITLES[row.type] ?? "Balance activity",
    description: row.reason ?? row.sourceType,
    usageType: row.usageType,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    operationId: row.operationId,
    amountUsd: negative ? -row.amountUsd : row.amountUsd,
    status: null,
    createdAt: row.createdAt,
  };
}

function usageActivity(id: string, { first, covered, overage }: UsageDraft): BillingBalanceActivity {
  return {
    id,
    kind: "usage",
    tokenType: first.tokenType,
    title: usageTitle(first.usageType),
    description: first.reason ?? first.sourceType,
    usageType: first.usageType,
    sourceType: first.sourceType,
    sourceId: first.sourceId,
    operationId: first.operationId,
    amountUsd: -round(covered + overage),
    status: covered > 0 && overage > 0 ? "partial" : overage > 0 ? "overage" : "covered",
    createdAt: first.createdAt,
  };
}

function absorb(draft: UsageDraft, row: LedgerRow) {
  if (row.type === "overage") draft.overage = round(draft.overage + row.amountUsd);
  else draft.covered = round(draft.covered + row.amountUsd);
  for (const field of ["usageType", "sourceType", "sourceId", "reason"] as const) {
    if (draft.first[field] === null && row[field] !== null) draft.first = { ...draft.first, [field]: row[field] };
  }
}

export async function readLedger(input: {
  sources: LedgerSource[];
  cursor: string | null;
  limit: number;
  offset?: number;
}): Promise<{ items: BillingBalanceActivity[]; nextCursor: string | null }> {
  const cursor = input.cursor ? decodeLedgerCursor(input.cursor) : null;
  const to = cursor ? new Date(cursor.before + BOUNDARY_MS).toISOString() : undefined;
  const skip = new Set(cursor?.seen.map(([key]) => key));
  const want = (input.offset ?? 0) + input.limit;
  const batch = Math.min(100, Math.max(20, input.limit * 2));
  const streams = input.sources.map((source) => new Stream(source, to, batch));
  const groups = new Map<string, Group>();
  const consumed: LedgerRow[] = [];
  let boundary: LedgerRow | null = null;
  await Promise.all(streams.map((stream) => stream.peek()));

  for (;;) {
    let next: { stream: Stream; row: LedgerRow } | null = null;
    for (const stream of streams) {
      const row = await stream.peek();
      if (row && (!next || time(row) > time(next.row))) next = { stream, row };
    }
    if (!next) break;
    const { stream, row } = next;
    if (skip.has(row.key)) {
      stream.shift();
      continue;
    }
    const key = groupKey(row);
    const group = groups.get(key);
    const activity = singleActivity(row);
    if (!group && !activity && !isUsageRow(row)) {
      stream.shift();
      continue;
    }
    if (!group && groups.size === want) {
      boundary = row;
      break;
    }
    if (group?.kind === "usage") absorb(group.draft, row);
    else if (activity) groups.set(key, { kind: "single", activity });
    else {
      const draft = { first: row, covered: 0, overage: 0 };
      absorb(draft, row);
      groups.set(key, { kind: "usage", draft });
    }
    consumed.push(row);
    stream.shift();
  }

  let nextCursor: string | null = null;
  if (boundary) {
    for (const stream of streams) {
      for (const row of stream.buffered) {
        const group = groups.get(groupKey(row));
        if (group?.kind === "usage" && !skip.has(row.key)) {
          absorb(group.draft, row);
          consumed.push(row);
        }
      }
    }
    const before = time(boundary);
    const seen = new Map(cursor?.seen);
    for (const row of consumed) seen.set(row.key, time(row));
    const kept = [...seen].filter(([, at]) => at <= before + BOUNDARY_MS);
    nextCursor = encodeLedgerCursor({ before, seen: kept });
  }

  const items = [...groups].map(([id, group]) => group.kind === "usage" ? usageActivity(id, group.draft) : group.activity);
  return { items: items.slice(input.offset ?? 0).filter((item) => item.amountUsd !== 0), nextCursor };
}
