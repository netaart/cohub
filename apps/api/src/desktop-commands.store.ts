/**
 * Mailbox Redis access, free of the client import so it can be tested with a fake.
 * Both writes are atomic Lua because reports genuinely race; `GET` then `SET`
 * would let the loser overwrite the winner.
 */

import {
  type DesktopCommandRecord,
  DESKTOP_COMMAND_PENDING_TTL_SECONDS,
  DESKTOP_COMMAND_TERMINAL_TTL_SECONDS,
  DESKTOP_UNREACHABLE_ERROR,
  isDesktopCommandAcceptOverdue,
} from "@cohub/protocol/desktop-command";

export type DesktopCommandStoreClient = {
  eval(script: string, keyCount: number, ...args: string[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
};

const DESKTOP_COMMAND_PREFIX = "cohub:ui:command";

export const getDesktopCommandKey = (commandId: string) => `${DESKTOP_COMMAND_PREFIX}:${commandId}`;

const CLAIM_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if existing then
  return {0, existing}
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return {1, ARGV[1]}
`;

/**
 * `actorUserId` is the security boundary; it comes from the session. The
 * `targetClientId` match only orders the user's own tabs, since `clientId` is a
 * client-supplied header.
 *
 * Returns `{ code, record }`: 1 settled, 0 already settled, -1 missing, -2 forbidden.
 */
const SETTLE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then
  return {-1, ''}
end
local record = cjson.decode(raw)
if record['actorUserId'] ~= ARGV[1] then
  return {-2, ''}
end
local target = record['targetClientId']
if target and target ~= '' and target ~= ARGV[2] then
  return {-2, ''}
end
if record['settledAt'] and record['settledAt'] ~= cjson.null then
  return {0, raw}
end
redis.call('SET', KEYS[1], ARGV[3], 'EX', ARGV[4])
return {1, ARGV[3]}
`;

/**
 * Accept and expiry race; the script lets exactly one leave the unaccepted state.
 * Returns `{ code, record }`: 1 written, 0 already settled, 2 already accepted, -1 missing.
 */
const TRANSITION_UNACCEPTED_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then
  return {-1, ''}
end
local record = cjson.decode(raw)
if record['settledAt'] and record['settledAt'] ~= cjson.null then
  return {0, raw}
end
if record['acceptedAt'] and record['acceptedAt'] ~= cjson.null then
  return {2, raw}
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return {1, ARGV[1]}
`;

export type DesktopCommandSettleReason = "not_found" | "forbidden" | "already_settled";

export type DesktopCommandSettleOutcome =
  | { ok: true; record: DesktopCommandRecord }
  | { ok: false; reason: DesktopCommandSettleReason; record?: DesktopCommandRecord };

const parseRecord = (raw: string | null): DesktopCommandRecord | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DesktopCommandRecord;
  } catch {
    return null;
  }
};

export class DesktopCommandStoreError extends Error {
  constructor(detail: string) {
    super(`desktop command store returned an unusable value: ${detail}`);
    this.name = "DesktopCommandStoreError";
  }
}

/** Throws rather than guessing: dispatching an unpersisted command guarantees a timeout. */
const readScriptResult = (value: unknown): { code: number; record: DesktopCommandRecord | null } => {
  const pair = Array.isArray(value) ? value : [];
  const code = Number(pair[0]);
  if (!Number.isFinite(code)) throw new DesktopCommandStoreError(`code ${String(pair[0])}`);
  const raw = typeof pair[1] === "string" && pair[1] ? pair[1] : null;
  const record = parseRecord(raw);
  if (raw && !record) throw new DesktopCommandStoreError("record is not valid JSON");
  return { code, record };
};

export async function readDesktopCommand(
  client: DesktopCommandStoreClient,
  commandId: string,
): Promise<DesktopCommandRecord | null> {
  return parseRecord(await client.get(getDesktopCommandKey(commandId)));
}

export async function claimDesktopCommand(
  client: DesktopCommandStoreClient,
  record: DesktopCommandRecord,
): Promise<{ claimed: boolean; record: DesktopCommandRecord }> {
  const result = readScriptResult(
    await client.eval(
      CLAIM_SCRIPT,
      1,
      getDesktopCommandKey(record.commandId),
      JSON.stringify(record),
      String(record.settledAt ? DESKTOP_COMMAND_TERMINAL_TTL_SECONDS : DESKTOP_COMMAND_PENDING_TTL_SECONDS),
    ),
  );
  if (result.code === 1) return { claimed: true, record: result.record ?? record };
  if (!result.record) throw new DesktopCommandStoreError("claim lost without a stored record");
  return { claimed: false, record: result.record };
}

export async function settleDesktopCommandRecord(
  client: DesktopCommandStoreClient,
  input: {
    commandId: string;
    actorUserId: string;
    reportingClientId: string | null;
    next: (current: DesktopCommandRecord) => DesktopCommandRecord;
  },
): Promise<DesktopCommandSettleOutcome> {
  const current = await readDesktopCommand(client, input.commandId);
  if (!current) return { ok: false, reason: "not_found" };

  const result = readScriptResult(
    await client.eval(
      SETTLE_SCRIPT,
      1,
      getDesktopCommandKey(input.commandId),
      input.actorUserId,
      input.reportingClientId ?? "",
      JSON.stringify(input.next(current)),
      String(DESKTOP_COMMAND_TERMINAL_TTL_SECONDS),
    ),
  );

  if (result.code === 1 && result.record) return { ok: true, record: result.record };
  if (result.code === 0) {
    return {
      ok: false,
      reason: "already_settled",
      ...(result.record ? { record: result.record } : {}),
    };
  }
  if (result.code === -2) return { ok: false, reason: "forbidden" };
  return { ok: false, reason: "not_found" };
}

/** Write `next` only while the command is still pending and unaccepted; returns the stored record. */
async function transitionUnaccepted(
  client: DesktopCommandStoreClient,
  next: DesktopCommandRecord,
): Promise<DesktopCommandRecord | null> {
  const result = readScriptResult(
    await client.eval(
      TRANSITION_UNACCEPTED_SCRIPT,
      1,
      getDesktopCommandKey(next.commandId),
      JSON.stringify(next),
      String(next.settledAt ? DESKTOP_COMMAND_TERMINAL_TTL_SECONDS : DESKTOP_COMMAND_PENDING_TTL_SECONDS),
    ),
  );
  return result.record;
}

/** Expiry is a function of the clock, so it is applied lazily on read. */
async function expireIfUnreachable(
  client: DesktopCommandStoreClient,
  record: DesktopCommandRecord,
  now: number,
): Promise<DesktopCommandRecord> {
  if (!isDesktopCommandAcceptOverdue(record, now)) return record;
  const expired = await transitionUnaccepted(client, {
    ...record,
    status: "no_active_client",
    error: DESKTOP_UNREACHABLE_ERROR,
    settledAt: new Date(now).toISOString(),
  });
  return expired ?? record;
}

export async function readCurrentDesktopCommand(
  client: DesktopCommandStoreClient,
  commandId: string,
  now = Date.now(),
): Promise<DesktopCommandRecord | null> {
  const record = await readDesktopCommand(client, commandId);
  return record ? expireIfUnreachable(client, record, now) : null;
}

export type DesktopCommandAcceptOutcome =
  | { ok: true; accepted: boolean; record: DesktopCommandRecord }
  | { ok: false; reason: "not_found" | "forbidden" };

/** Idempotent; a command that already expired is refused, so a late tab opens nothing. */
export async function acceptDesktopCommandRecord(
  client: DesktopCommandStoreClient,
  input: { commandId: string; actorUserId: string; clientId: string | null },
  now = Date.now(),
): Promise<DesktopCommandAcceptOutcome> {
  const current = await readDesktopCommand(client, input.commandId);
  if (!current) return { ok: false, reason: "not_found" };
  if (current.actorUserId !== input.actorUserId || current.targetClientId !== input.clientId) {
    return { ok: false, reason: "forbidden" };
  }
  const record = await expireIfUnreachable(client, current, now);
  const stored = record.settledAt || record.acceptedAt
    ? record
    : await transitionUnaccepted(client, { ...record, acceptedAt: new Date(now).toISOString() });
  if (!stored) return { ok: false, reason: "not_found" };
  return { ok: true, accepted: !stored.settledAt, record: stored };
}
