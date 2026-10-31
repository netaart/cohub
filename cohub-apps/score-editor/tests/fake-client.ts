import {
  APP_COMPOSER_CHIP_CONTENT_MAX_BYTES,
  APP_COMPOSER_CHIP_KEY_MAX_LENGTH,
  APP_COMPOSER_CHIP_LABEL_MAX_LENGTH,
} from "@neta-art/cohub";
import type {
  AuthorizeResult,
  CohubAppClient,
  ComposerChip,
  FileEntry,
  FileVersion,
  NavigationResult,
  PickSpaceResult,
  ReadFileResult,
  TaskListPage,
} from "../src/host/host.ts";
import type { TaskRunSnapshot } from "../src/host/task.ts";

export class FakeRequestError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null = null) {
    super(code ?? `HTTP ${status}`);
    this.name = "FakeRequestError";
    this.status = status;
    this.code = code;
  }
}

type FakeFile = { text: string; version: FileVersion };

export type FakeCall =
  | {
      kind: "authorize";
      spaceId: string;
      scopes: readonly string[];
      reason: string | null;
      fallback?: "allow" | "none";
    }
  | { kind: "read"; spaceId: string; path: string }
  | { kind: "write"; spaceId: string; path: string; text: string; expected: FileVersion | null }
  | { kind: "list"; spaceId: string; path: string }
  | { kind: "delete"; spaceId: string; path: string }
  | { kind: "task"; taskRunId: string }
  | { kind: "task-list"; spaceId: string; limit: number; cursor: string | null; taskType?: string; status?: string }
  | { kind: "pick-space"; scopes: readonly string[]; reason: string }
  | { kind: "navigate"; spaceId: string; path: string }
  | { kind: "chip-set"; chip: ComposerChip }
  | { kind: "chip-clear"; key: string };

export type FakeClient = CohubAppClient & {
  readonly calls: FakeCall[];
  readonly writes: Array<{ spaceId: string; path: string; text: string; expected: FileVersion | null }>;
  /** Every chip the App put on the composer, in order; the host shows the last one. */
  readonly chips: ComposerChip[];
  readonly clearedChips: string[];
  fileAt(path: string): { text: string; version: FileVersion } | null;
  setFile(path: string, text: string, version?: FileVersion): void;
  deleteFile(path: string): void;
  setTask(task: TaskRunSnapshot): void;
  taskAt(taskRunId: string): TaskRunSnapshot | null;
  /** What the viewer holds on the Space; a grant is limited to it. */
  grant(scopes: readonly string[]): void;
  cancelAuthorize(): void;
  /** The viewer revokes the App's grant; the next `authorize` asks again. */
  revoke(): void;
  failNextWrite(error: Error): void;
  failNextRead(error: Error): void;
  failNextList(error: Error): void;
  reads(): number;
  writesTo(path: string): number;
};

/**
 * A cohub consent model, not a canned answer list: the viewer holds scopes on the Space, a granted
 * answer gives the requested scopes the viewer holds, later calls inside that grant answer granted
 * without a dialog, and a revoke drops the grant.
 */
export function createFakeClient(options: {
  files?: Record<string, string>;
  scopes?: readonly string[];
  authorize?: "granted" | "cancelled" | "denied";
  /** The viewer's answer when the dialog is shown; one per dialog, then `authorize`. */
  authorizeSteps?: Array<"granted" | "cancelled" | "denied">;
  clock?: number;
  /** Runs once, after the first read answers, to stage a later writer or a failure. */
  afterRead?: () => void;
  /** Runs once, after a write fails, to stage a file that came back meanwhile. */
  afterWriteError?: () => void;
  /** Runs once, after a read finds no file, to stage the file coming back between reads. */
  afterReadError?: () => void;
  /** A read that never settles, for the loading state. */
  neverResolveRead?: boolean;
  /** Task Runs by id, for a generated score and the home. */
  tasks?: Record<string, TaskRunSnapshot>;
  /** The Space the viewer picks; defaults to a second Space with the requested scopes. */
  pickedSpace?: { id: string; name: string | null } | null;
  pickSpaceAnswer?: "granted" | "cancelled" | "denied";
  /** What the host answers to navigation.open; defaults to handled. */
  navigationHandled?: boolean;
  /** A list that never settles, for the home's loading state. */
  neverResolveList?: boolean;
  /** The next task-list read fails, for the home's songs error state. */
  failNextTaskList?: Error;
  /** A write that never settles, for the home's copy-in-progress state. */
  neverResolveWrite?: boolean;
  /** The scopes the picked Space grants; defaults to the requested set. */
  pickedScopes?: readonly string[];
  /** Another Space the host grants instead; a `fallback: "none"` ask is refused. */
  fallbackSpace?: { id: string; name: string | null } | null;
  /** Answer the fallback Space even when the request says `fallback: "none"` (a host that ignores it). */
  ignoreFallback?: boolean;
  /** Spaces a `fallback: "none"` ask cannot use. */
  inaccessibleSpaces?: readonly string[];
  /** Names for Spaces the fake grants, by id. */
  spaceNames?: Record<string, string | null>;
} = {}): FakeClient {
  const files = new Map<string, FakeFile>();
  const tasks = new Map<string, TaskRunSnapshot>(Object.entries(options.tasks ?? {}));
  let clock = options.clock ?? Date.UTC(2026, 9, 28, 9, 30);
  let viewerScopes = [...(options.scopes ?? ["file.view", "file.edit", "taskrun.view"])];
  const grants = new Map<string, Set<string>>();
  const spaceNames = new Map<string, string | null>([
    ["space-2", "My Space"],
    ...Object.entries(options.spaceNames ?? {}),
  ]);
  const fallbackSpace = options.fallbackSpace ?? null;
  const ignoreFallback = options.ignoreFallback === true;
  const inaccessibleSpaces = new Set(options.inaccessibleSpaces ?? []);
  let authorizeMode = options.authorize ?? "granted";
  const authorizeSteps = [...(options.authorizeSteps ?? [])];
  let nextWriteError: Error | null = null;
  let nextReadError: Error | null = null;
  let nextListError: Error | null = null;
  let nextTaskListError = options.failNextTaskList ?? null;
  const neverResolveList = options.neverResolveList === true;
  const neverResolveWrite = options.neverResolveWrite === true;
  const pickedScopes = options.pickedScopes;
  let pickedSpace = options.pickedSpace ?? { id: "space-2", name: "My Space" };
  const pickSpaceAnswer = options.pickSpaceAnswer ?? "granted";
  const navigationHandled = options.navigationHandled ?? true;
  let afterRead = options.afterRead ?? null;
  let afterWriteError = options.afterWriteError ?? null;
  let afterReadError = options.afterReadError ?? null;
  let neverResolveRead = options.neverResolveRead === true;
  const calls: FakeCall[] = [];
  const chips: ComposerChip[] = [];
  const clearedChips: string[] = [];

  const put = (path: string, text: string, version?: FileVersion) => {
    clock += 1_000;
    files.set(path, {
      text,
      version: version ?? { mtimeMs: clock, size: new TextEncoder().encode(text).length },
    });
  };
  for (const [path, text] of Object.entries(options.files ?? {})) put(path, text);

  const requirePermission = (
    scope: "file.view" | "file.edit" | "taskrun.view",
    spaceId?: string,
  ) => {
    if (spaceId === undefined) {
      const held = [...grants.values()].some((scopes) => scopes.has(scope));
      if (!held) throw new FakeRequestError(403);
      return;
    }
    if (!grants.get(spaceId)?.has(scope)) throw new FakeRequestError(403);
  };

  const spaceFor = (id: string, name: string | null = spaceNames.get(id) ?? null) => ({ id, name });

  const grantFor = (spaceId: string, scopes: readonly string[]): string[] => {
    const merged = [...new Set([...(grants.get(spaceId) ?? []), ...scopes])];
    grants.set(spaceId, new Set(merged));
    return merged;
  };

  const client: FakeClient = {
    calls,
    chips,
    clearedChips,
    get writes() {
      return calls.filter((call): call is Extract<FakeCall, { kind: "write" }> => call.kind === "write");
    },
    async authorize(input): Promise<AuthorizeResult> {
      calls.push({
        kind: "authorize",
        spaceId: input.spaceId,
        scopes: input.scopes,
        reason: input.reason,
        ...(input.fallback === undefined ? {} : { fallback: input.fallback }),
      });
      const requested = [...input.scopes];
      const current = grants.get(input.spaceId);
      if (current && requested.every((scope) => current.has(scope))) {
        return {
          status: "granted",
          space: spaceFor(input.spaceId),
          scopes: [...current],
        };
      }
      const answer = authorizeSteps.shift() ?? authorizeMode;
      if (answer === "cancelled") return { status: "cancelled" };
      if (answer === "denied") return { status: "denied" };
      if (fallbackSpace !== null && input.spaceId !== fallbackSpace.id) {
        if (input.fallback !== "none" || ignoreFallback) {
          return {
            status: "granted",
            space: { id: fallbackSpace.id, name: fallbackSpace.name },
            scopes: grantFor(fallbackSpace.id, requested),
          };
        }
        return { status: "denied", code: "space_inaccessible" };
      }
      if (input.fallback === "none" && inaccessibleSpaces.has(input.spaceId)) {
        return { status: "denied", code: "space_inaccessible" };
      }
      if (!requested.every((scope) => viewerScopes.includes(scope))) {
        return { status: "denied", code: "scope_not_held" };
      }
      return {
        status: "granted",
        space: spaceFor(input.spaceId),
        scopes: grantFor(input.spaceId, requested),
      };
    },
    async getTask(taskRunId: string): Promise<TaskRunSnapshot> {
      calls.push({ kind: "task", taskRunId });
      requirePermission("taskrun.view");
      const task = tasks.get(taskRunId);
      if (!task) throw new FakeRequestError(404);
      return task;
    },
    async listTasks(input): Promise<TaskListPage> {
      calls.push({
        kind: "task-list",
        spaceId: input.spaceId,
        limit: input.limit,
        cursor: input.cursor ?? null,
        ...(input.taskType === undefined ? {} : { taskType: input.taskType }),
        ...(input.status === undefined ? {} : { status: input.status }),
      });
      requirePermission("taskrun.view", input.spaceId);
      if (neverResolveList) return new Promise<TaskListPage>(() => {});
      if (nextTaskListError) {
        const error = nextTaskListError;
        nextTaskListError = null;
        throw error;
      }
      const runs = [...tasks.values()]
        .filter((run) => run.spaceId === input.spaceId)
        .filter((run) => (run.status ?? "completed") === "completed")
        .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || b.id.localeCompare(a.id));
      const offset = Number(input.cursor ?? 0) || 0;
      const page = runs.slice(offset, offset + input.limit);
      const next = offset + page.length;
      return {
        runs: page,
        hasMore: next < runs.length,
        nextCursor: next < runs.length ? String(next) : null,
      };
    },
    async pickSpace(input): Promise<PickSpaceResult> {
      calls.push({ kind: "pick-space", scopes: input.scopes, reason: input.reason });
      if (pickSpaceAnswer === "cancelled") return { status: "cancelled" };
      if (pickSpaceAnswer === "denied") return { status: "denied", code: "cancelled" };
      if (!pickedSpace) return { status: "cancelled" };
      const scopes = pickedScopes ?? input.scopes;
      return {
        status: "granted",
        space: pickedSpace,
        scopes: grantFor(pickedSpace.id, scopes),
      };
    },
    async navigate(input): Promise<NavigationResult> {
      calls.push({ kind: "navigate", spaceId: input.spaceId, path: input.path });
      return navigationHandled
        ? { handled: true }
        : { handled: false, reason: "inaccessible" };
    },
    async list(input): Promise<readonly FileEntry[]> {
      calls.push({ kind: "list", spaceId: input.spaceId, path: input.path });
      requirePermission("file.view", input.spaceId);
      if (neverResolveList) return new Promise<readonly FileEntry[]>(() => {});
      if (nextListError) {
        const error = nextListError;
        nextListError = null;
        throw error;
      }
      const prefix = input.path ? `${input.path.replace(/\/+$/, "")}/` : "";
      const entries = new Map<string, FileEntry>();
      for (const [filePath, file] of files) {
        if (!filePath.startsWith(prefix)) continue;
        const rest = filePath.slice(prefix.length);
        const first = rest.split("/")[0];
        if (!first) continue;
        const entryPath = `${prefix}${first}`;
        if (rest.includes("/")) {
          const current = entries.get(entryPath);
          entries.set(entryPath, {
            name: first,
            path: entryPath,
            type: "dir",
            size: 0,
            mtimeMs: Math.max(current?.mtimeMs ?? 0, file.version.mtimeMs),
          });
        } else {
          entries.set(entryPath, {
            name: first,
            path: entryPath,
            type: "file",
            size: file.version.size,
            mtimeMs: file.version.mtimeMs,
          });
        }
      }
      if (entries.size === 0) throw new FakeRequestError(404);
      return [...entries.values()].sort((a, b) =>
        a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1,
      );
    },
    async delete(input): Promise<void> {
      calls.push({ kind: "delete", spaceId: input.spaceId, path: input.path });
      requirePermission("file.edit", input.spaceId);
      if (!files.has(input.path)) throw new FakeRequestError(404);
      files.delete(input.path);
    },
    async read(input): Promise<ReadFileResult> {
      calls.push({ kind: "read", spaceId: input.spaceId, path: input.path });
      requirePermission("file.view", input.spaceId);
      if (nextReadError) {
        const error = nextReadError;
        nextReadError = null;
        throw error;
      }
      const file = files.get(input.path);
      if (!file) {
        if (afterReadError) {
          const run = afterReadError;
          afterReadError = null;
          run();
        }
        throw new FakeRequestError(404, "path_not_found");
      }
      const answer = { text: file.text, version: { ...file.version } };
      if (afterRead) {
        const run = afterRead;
        afterRead = null;
        run();
      }
      if (neverResolveRead) return new Promise<ReadFileResult>(() => {});
      return answer;
    },
    async write(input): Promise<FileVersion> {
      calls.push({
        kind: "write",
        spaceId: input.spaceId,
        path: input.path,
        text: input.text,
        expected: input.expected ? { ...input.expected } : null,
      });
      try {
        requirePermission("file.edit", input.spaceId);
        if (neverResolveWrite) return new Promise<FileVersion>(() => {});
        if (nextWriteError) {
          const error = nextWriteError;
          nextWriteError = null;
          throw error;
        }
        // cohub's versioned write checks the file first, and a missing file is a conflict, not a 404:
        // apps/api/src/space-fs.ts `writeSpaceFile` throws SpaceFsError(409, "file_conflict") when the
        // stat fails, and apps/api/src/space-fs-remote.ts `writeSpaceFile` does the same through fs.stat.
        // A read of a missing path is the 404 `path_not_found` those files throw.
        const file = files.get(input.path);
        if (input.expected === null) {
          clock += 1_000;
          const version = { mtimeMs: clock, size: new TextEncoder().encode(input.text).length };
          files.set(input.path, { text: input.text, version });
          return { ...version };
        }
        if (!file) throw new FakeRequestError(409, "file_conflict");
        const sameVersion =
          file.version.mtimeMs === input.expected.mtimeMs && file.version.size === input.expected.size;
        if (!sameVersion) throw new FakeRequestError(409, "file_conflict");
        clock += 1_000;
        const version = { mtimeMs: clock, size: new TextEncoder().encode(input.text).length };
        files.set(input.path, { text: input.text, version });
        return { ...version };
      } catch (error) {
        if (afterWriteError) {
          const run = afterWriteError;
          afterWriteError = null;
          run();
        }
        throw error;
      }
    },
    fileAt(path) {
      const file = files.get(path);
      return file ? { text: file.text, version: { ...file.version } } : null;
    },
    setComposerChip(chip) {
      // The protocol's parser, as `AppSurfaceApi.setComposerChip` runs it (packages/protocol/src/app-surface.ts:108).
      const key = chip.key.trim();
      const label = chip.label.trim();
      if (!key || key.length > APP_COMPOSER_CHIP_KEY_MAX_LENGTH) throw new Error("Invalid App composer chip");
      if (!label || label.length > APP_COMPOSER_CHIP_LABEL_MAX_LENGTH) throw new Error("Invalid App composer chip");
      if (
        !chip.content.trim() ||
        new TextEncoder().encode(chip.content).length > APP_COMPOSER_CHIP_CONTENT_MAX_BYTES
      ) {
        throw new Error("Invalid App composer chip");
      }
      const next = { key, label, content: chip.content };
      calls.push({ kind: "chip-set", chip: next });
      chips.push(next);
    },
    clearComposerChip(key) {
      calls.push({ kind: "chip-clear", key });
      clearedChips.push(key);
    },
    setFile(path, text, version) {
      put(path, text, version);
    },
    deleteFile(path) {
      files.delete(path);
    },
    setTask(task) {
      tasks.set(task.id, task);
    },
    taskAt(taskRunId) {
      return tasks.get(taskRunId) ?? null;
    },
    grant(next) {
      viewerScopes = [...next];
    },
    cancelAuthorize() {
      authorizeMode = "cancelled";
    },
    revoke() {
      grants.clear();
    },
    failNextWrite(error) {
      nextWriteError = error;
    },
    failNextRead(error) {
      nextReadError = error;
    },
    failNextList(error) {
      nextListError = error;
    },
    reads() {
      return calls.filter((call) => call.kind === "read").length;
    },
    writesTo(path) {
      return calls.filter((call) => call.kind === "write" && call.path === path).length;
    },
  };
  return client;
}
