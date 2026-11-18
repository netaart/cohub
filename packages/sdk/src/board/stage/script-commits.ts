import type { BoardDocument, BoardPatch } from "@cohub/protocol";
import { diffMergePatch } from "@cohub/protocol/board-patch";
import { validateBoardScriptCommit } from "../model/script-scene.js";

export const BOARD_SCRIPT_USER_COMMIT_MS = 100;
const BUSY_RETRY_MS = 50;
export const BOARD_SCRIPT_AUTO_COMMIT_MS = 1_000;

export type BoardScriptCommitTarget = {
  readonly document: BoardDocument;
  readonly readonly: boolean;
  readonly busy: boolean;
  commitPatch(patch: BoardPatch, options: { record: boolean; source: "script" }): Promise<void> | undefined;
};

type Waiter = { owner: string; patch: BoardPatch; resolve(value: boolean): void; reject(error: Error): void };
type Batch = {
  waiters: Waiter[];
  document?: BoardDocument;
  cancel?: () => void;
};

export type BoardScriptTimer = (run: () => void, ms: number) => () => void;

const toError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

export function createBoardScriptCommits(options: {
  target: BoardScriptCommitTarget;
  leader: (owner: string) => boolean;
  now: () => number;
  setTimer?: BoardScriptTimer;
}) {
  const setTimer: BoardScriptTimer = options.setTimer ?? ((run, ms) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  });
  const batches: Record<"user" | "auto", Batch> = { user: { waiters: [] }, auto: { waiters: [] } };
  const lastFlush = { user: -Infinity, auto: -Infinity };

  function flush(kind: "user" | "auto", force = false) {
    const batch = batches[kind];
    batch.cancel?.();
    if (!force && options.target.busy && batch.waiters.length) {
      batch.cancel = setTimer(() => flush(kind), BUSY_RETRY_MS);
      return;
    }
    batches[kind] = { waiters: [] };
    if (!batch.waiters.length) return;
    lastFlush[kind] = options.now();
    const waiters: Waiter[] = [];
    for (const waiter of batch.waiters)
      if (kind === "user" || options.leader(waiter.owner)) waiters.push(waiter);
      else waiter.resolve(false);
    if (!waiters.length) return;
    const base = options.target.document;
    const failed = new Map<string, Error>();
    const failures = new Map<Waiter, Error>();
    let document = base;
    const touched = new Set<string>();
    for (const waiter of waiters) {
      const earlier = failed.get(waiter.owner);
      if (earlier) {
        failures.set(waiter, earlier);
        continue;
      }
      try {
        document = validateBoardScriptCommit(document, waiter.owner, waiter.patch);
        for (const id of Object.keys(waiter.patch.items ?? {})) touched.add(id);
      } catch (error) {
        failed.set(waiter.owner, toError(error));
        failures.set(waiter, toError(error));
      }
    }
    const items: Record<string, unknown> = {};
    for (const id of touched) {
      const change = diffMergePatch(base.items[id], document.items[id]);
      if (change !== undefined) items[id] = change;
    }
    const settle = (error?: Error) => {
      for (const waiter of waiters) {
        const failure = failures.get(waiter) ?? error;
        if (failure) waiter.reject(failure);
        else waiter.resolve(true);
      }
    };
    if (!Object.keys(items).length) return settle();
    try {
      const sent = options.target.commitPatch({ items } as BoardPatch, { record: kind === "user", source: "script" });
      if (sent) void sent.then(() => settle(), (error: unknown) => settle(toError(error)));
      else settle();
    } catch (error) {
      settle(toError(error));
    }
  }

  return {
    commit(owner: string, patch: BoardPatch, user: boolean): Promise<boolean> {
      if (options.target.readonly) return Promise.reject(new Error("This viewer cannot edit the Board."));
      const kind = user ? "user" : "auto";
      if (kind === "auto" && !options.leader(owner)) return Promise.resolve(false);
      const batch = batches[kind];
      try {
        batch.document = validateBoardScriptCommit(batch.document ?? options.target.document, owner, patch);
      } catch (error) {
        return Promise.reject(error);
      }
      const promise = new Promise<boolean>((resolve, reject) => batch.waiters.push({ owner, patch, resolve, reject }));
      if (!batch.cancel) {
        const interval = kind === "user" ? BOARD_SCRIPT_USER_COMMIT_MS : BOARD_SCRIPT_AUTO_COMMIT_MS;
        batch.cancel = setTimer(() => flush(kind), Math.max(0, lastFlush[kind] + interval - options.now()));
      }
      return promise;
    },
    flush(force = false) {
      flush("user", force);
      flush("auto", force);
    },
    clear() {
      for (const kind of ["user", "auto"] as const) {
        const batch = batches[kind];
        batch.cancel?.();
        for (const waiter of batch.waiters) waiter.reject(new Error("Scripts stopped before the commit was saved."));
        batches[kind] = { waiters: [] };
      }
    },
  };
}
