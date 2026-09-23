import process from "node:process";
import { extractBillingPayload } from "@neta-art/cohub";

// -- Table rendering ---------------------------------------------------------

export type Row = Record<string, unknown>;

/**
 * A table column. `format` maps a raw cell value to its display string, so
 * machine-oriented fields (epoch timestamps, byte counts) stay unmodified in
 * `--json` output while the human-facing table shows something readable.
 */
export type Column = {
  key: string;
  label: string;
  format?: (value: unknown, row: Row) => string;
};

/**
 * Timestamp → local ISO-style date and time with the system's UTC offset.
 *
 * CLI tables are for people and follow the machine's local timezone. Structured
 * output remains untouched so scripts continue to receive the server value.
 */
export function formatLocalDateTime(value: unknown): string {
  const date = value instanceof Date
    ? value
    : typeof value === "number"
      ? new Date(value)
      : typeof value === "string" && value.trim() !== ""
        ? new Date(value)
        : null;
  if (!date || Number.isNaN(date.getTime())) return "";

  const pad = (part: number) => String(part).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const offset = `${offsetSign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`;

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${offset}`;
}

/**
 * Epoch milliseconds → local date and time.
 *
 * Absent values render empty rather than falling through `Number()` coercion:
 * `null` and `""` both become 0 there, which would print a confident-looking
 * Unix epoch for a timestamp the server never sent.
 */
export function formatEpochMs(value: unknown): string {
  const ms =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(ms)) return "";
  return formatLocalDateTime(ms);
}

function cellText(column: Column, row: Row): string {
  const raw = row[column.key];
  if (column.format) return column.format(raw, row);
  if (/(?:At|Timestamp)$/.test(column.key)) return formatLocalDateTime(raw);
  const v = raw ?? "";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

function colWidth(rows: Row[], column: Column): number {
  const maxVal = rows.reduce((m, r) => Math.max(m, cellText(column, r).length), 0);
  return Math.max(column.label.length, maxVal) + 2;
}

export function table(rows: Row[], columns: Column[]): void {
  if (rows.length === 0) {
    console.log("  (empty)");
    return;
  }

  const widths = columns.map((c) => colWidth(rows, c));

  const header = columns
    .map((c, i) => c.label.padEnd(widths[i] ?? 0))
    .join(" │ ")
    .trimEnd();

  console.log(header);
  console.log("─".repeat(header.length));

  for (const row of rows) {
    const line = columns
      .map((c, i) => cellText(c, row).padEnd(widths[i] ?? 0))
      .join(" │ ")
      .trimEnd();
    console.log(line);
  }
}

// -- Output helpers ----------------------------------------------------------

export function json(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export function jsonRequested(opts?: { json?: boolean }): boolean {
  return Boolean(opts?.json || process.argv.includes("--json"));
}

export function ok(msg: string): void {
  console.log(`\n  ✓ ${msg}\n`);
}

export function error(msg: string, detail?: string): never {
  process.stderr.write(`\n  ✗ ${msg}\n`);
  if (detail) process.stderr.write(`    ${detail}\n`);
  process.stderr.write("\n");
  process.exit(1);
}

// -- HTTP error handler ------------------------------------------------------

function errorMessageFromBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const errorBody = body as { message?: unknown };
  if (typeof errorBody.message === "string" && errorBody.message.trim()) return errorBody.message;
  return null;
}

function diagnosticDetailFromBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const diagnostics = (body as { diagnostics?: unknown }).diagnostics;
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) return null;
  const lines = diagnostics.slice(0, 8).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const diagnostic = item as { path?: unknown; message?: unknown };
    if (typeof diagnostic.message !== "string" || !diagnostic.message.trim()) return [];
    const path = typeof diagnostic.path === "string" ? diagnostic.path : "";
    const message = diagnostic.message.replace(path ? `${path}: ` : "", "");
    return [`${path ? `${path}: ` : ""}${message}`];
  });
  if (lines.length === 0) return null;
  const suffix = diagnostics.length > lines.length ? ` (+${diagnostics.length - lines.length} more)` : "";
  return `${lines.join("; ")}${suffix}`;
}

function debugErrorMetaFromBody(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const errorBody = body as {
    code?: unknown;
    requestId?: unknown;
    traceId?: unknown;
  };
  const items: string[] = [];
  const code = typeof errorBody.code === "string" ? errorBody.code : null;
  if (code) items.push(code);
  if (typeof errorBody.requestId === "string") items.push(`requestId: ${errorBody.requestId}`);
  if (typeof errorBody.traceId === "string") items.push(`traceId: ${errorBody.traceId}`);
  return items;
}

function fetchFailureDetail(e: unknown): string | null {
  if (!(e instanceof Error) || e.message !== "fetch failed") return null;
  const cause = e.cause as { code?: unknown; hostname?: unknown; message?: unknown } | undefined;
  const code = typeof cause?.code === "string" ? cause.code : null;
  const hostname = typeof cause?.hostname === "string" ? cause.hostname : null;
  const message = typeof cause?.message === "string" ? cause.message : null;
  const parts = [code, hostname && `host: ${hostname}`, message].filter(Boolean);
  return parts.length > 0
    ? `Network request failed (${parts.join(" · ")}). Check DNS/proxy/firewall settings and try again.`
    : "Network request failed. Check DNS/proxy/firewall settings and try again.";
}

function errorPresentationFromHttpError(e: unknown): { message?: string; detail?: string } | null {
  const httpError = e as { code?: unknown };
  if (httpError.code === "space_commerce_not_initialized") {
    return {
      message: "space commerce is not initialized",
      detail: "run `cohub -s <space-id> spaces commerce setup` first",
    };
  }
  return null;
}

export function handleHttp(e: unknown): never {
  const status = (e as { status?: number }).status;
  const body = (e as { body?: unknown }).body;

  if (jsonRequested()) {
    const payload = body && typeof body === "object"
      ? body
      : {
          code: (e as { code?: unknown }).code ?? "CLI_ERROR",
          message: e instanceof Error ? e.message : String(e),
          ...(status ? { status } : {}),
        };
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exit(1);
  }

  if (e instanceof Error && e.name === "AuthRequiredError") {
    return error("not authenticated", "run `cohub auth login`");
  }

  if (status === 402) {
    const conversion = extractBillingPayload(body)?.conversion as
      | { title?: string; message?: string }
      | undefined;
    if (conversion) {
      return error(
        conversion.title || "Upgrade required",
        [conversion.message, "Manage billing at your Cohub account settings."]
          .filter(Boolean)
          .join(" · "),
      );
    }
  }

  const presentation = errorPresentationFromHttpError(e);
  const message = presentation?.message ?? errorMessageFromBody(body) ?? (e instanceof Error ? e.message : String(e));
  const fetchDetail = fetchFailureDetail(e);
  const diagnosticDetail = diagnosticDetailFromBody(body);

  const detailParts: string[] = [];
  if (diagnosticDetail) detailParts.push(diagnosticDetail);
  if (presentation?.detail) detailParts.push(presentation.detail);
  if (process.env.COHUB_DEBUG_ERRORS) {
    if (status) detailParts.push(`HTTP ${status}`);
    detailParts.push(...debugErrorMetaFromBody(body));
  }

  error(message, detailParts.length > 0 ? detailParts.join(" · ") : fetchDetail ?? undefined);
}

// -- Spinner -----------------------------------------------------------------

export function spinner(): { start(msg: string): void; update(msg: string): void; stop(msg: string): void } {
  let interval: ReturnType<typeof setInterval> | null = null;
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  let currentMsg = "";

  return {
    start(msg: string) {
      currentMsg = msg;
      if (process.env.CI || !process.stderr.isTTY) {
        process.stderr.write(`  ${currentMsg}...\n`);
        return;
      }
      process.stderr.write(`  ${currentMsg}  `);
      interval = setInterval(() => {
        process.stderr.clearLine?.(0);
        process.stderr.cursorTo?.(0);
        process.stderr.write(`  ${frames[i++ % frames.length] ?? ""} ${currentMsg}  `);
      }, 80);
    },
    update(msg: string) {
      currentMsg = msg;
    },
    stop(msg: string) {
      if (interval) clearInterval(interval);
      if (process.env.CI || !process.stderr.isTTY) {
        process.stderr.write(`  ${msg}\n`);
        return;
      }
      process.stderr.clearLine?.(0);
      process.stderr.cursorTo?.(0);
      process.stderr.write(`  ✓ ${msg}\n`);
    },
  };
}
