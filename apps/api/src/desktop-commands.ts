import { randomUUID } from "node:crypto";
import {
  DESKTOP_COMMAND_VERSION,
  type DesktopCommand,
  type DesktopCommandError,
  type DesktopCommandRecord,
  type DesktopCommandStatus,
} from "@cohub/protocol/desktop-command";
import type { RequestSource } from "@cohub/protocol/provenance";
import { getRealtimeUserRoom } from "@cohub/protocol/realtime";
import { dispatchRealtimeEvent } from "./channels.js";
import { redisCommandClient } from "./redis.js";
import {
  acceptDesktopCommandRecord,
  claimDesktopCommand,
  readCurrentDesktopCommand,
  settleDesktopCommandRecord,
  type DesktopCommandAcceptOutcome,
  type DesktopCommandSettleOutcome,
  type DesktopCommandStoreClient,
} from "./desktop-commands.store.js";

const store = () => redisCommandClient as unknown as DesktopCommandStoreClient;

async function dispatch(record: DesktopCommandRecord): Promise<void> {
  await dispatchRealtimeEvent({
    id: randomUUID(),
    timestamp: Date.now(),
    domain: "desktop",
    type: "desktop.command.dispatched",
    spaceId: record.source?.spaceId ?? null,
    sessionId: record.source?.sessionId ?? null,
    rooms: [getRealtimeUserRoom(record.actorUserId)],
    payload: {
      commandId: record.commandId,
      targetClientId: record.targetClientId,
      command: record.command,
      source: record.source,
    },
  });
}

export async function getDesktopCommand(commandId: string): Promise<DesktopCommandRecord | null> {
  return readCurrentDesktopCommand(store(), commandId);
}

export function acceptDesktopCommand(input: {
  commandId: string;
  actorUserId: string;
  clientId: string | null;
}): Promise<DesktopCommandAcceptOutcome> {
  return acceptDesktopCommandRecord(store(), input);
}

export class DesktopCommandOwnershipError extends Error {
  constructor() {
    super("desktop command belongs to another user");
    this.name = "DesktopCommandOwnershipError";
  }
}

export async function createDesktopCommand(input: {
  commandId?: string | null;
  actorUserId: string;
  command: DesktopCommand;
  targetClientId: string | null;
  source: RequestSource | null;
}): Promise<{ record: DesktopCommandRecord; reused: boolean }> {
  const commandId = input.commandId?.trim() || randomUUID();
  const now = new Date().toISOString();
  const settledWithoutTarget = !input.targetClientId;
  const record: DesktopCommandRecord = {
    version: DESKTOP_COMMAND_VERSION,
    commandId,
    status: settledWithoutTarget ? "no_active_client" : "pending",
    command: input.command,
    actorUserId: input.actorUserId,
    targetClientId: input.targetClientId ?? "",
    source: input.source,
    error: settledWithoutTarget
      ? {
          code: "no_active_client",
          message:
            "No Cohub desktop is bound to this request. Run from a chat started in the Cohub app, or pass an explicit client id.",
        }
      : null,
    createdAt: now,
    acceptedAt: null,
    settledAt: settledWithoutTarget ? now : null,
  };

  const claim = await claimDesktopCommand(store(), record);
  if (!claim.claimed) {
    const existing = claim.record;
    if (existing.actorUserId !== input.actorUserId) throw new DesktopCommandOwnershipError();
    // Delivery is best-effort, so a retry publishes again; the frontend dedupes.
    if (!existing.settledAt && existing.targetClientId) {
      await dispatch(existing);
    }
    return { record: existing, reused: true };
  }

  if (!settledWithoutTarget) await dispatch(record);
  return { record: claim.record, reused: false };
}

export async function settleDesktopCommand(input: {
  commandId: string;
  actorUserId: string;
  reportingClientId: string | null;
  status: DesktopCommandStatus;
  result?: unknown;
  error?: DesktopCommandError | null;
}): Promise<DesktopCommandSettleOutcome> {
  return settleDesktopCommandRecord(store(), {
    commandId: input.commandId,
    actorUserId: input.actorUserId,
    reportingClientId: input.reportingClientId,
    next: (current) => ({
      ...current,
      status: input.status,
      ...(input.result === undefined ? {} : { result: input.result }),
      error: input.error ?? null,
      settledAt: new Date().toISOString(),
    }),
  });
}
