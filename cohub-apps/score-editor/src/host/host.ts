import type { DraftStore, ScoreFileSource, SongProject } from "@neta-art/score-editor";
import { createDraftStore } from "./drafts.ts";
import { isConflict, statusOf } from "./errors.ts";
import { fileNameOf } from "./path.ts";
import { saveGeneratedScore, type SaveAsOutcome } from "./save-as.ts";
import { nameOfTask, projectFromTask, type TaskRunSnapshot } from "./task.ts";
import { parseFileVersion, versionString, type FileVersion } from "./version.ts";

export { statusOf } from "./errors.ts";
export { fileNameOf } from "./path.ts";
export { parseFileVersion, versionString, type FileVersion } from "./version.ts";

export type ReadFileResult = { readonly text: string; readonly version: FileVersion };

export type FileEntry = {
  readonly name: string;
  readonly path: string;
  readonly type: "file" | "dir" | "symlink";
  readonly size: number;
  readonly mtimeMs: number;
};

/** The Space a grant is for; `name` is null when the host did not send one. */
export type AuthorizeSpace = { readonly id: string; readonly name: string | null };

/** What `auth.authorize` came to, narrowed to the fields this App acts on. */
export type AuthorizeResult =
  | { readonly status: "granted"; readonly space: AuthorizeSpace; readonly scopes: readonly string[] }
  | { readonly status: "cancelled" }
  | { readonly status: "denied"; readonly code?: string };

/** The cohub calls the App needs, behind one seam so tests can stand in for the host. */
export type CohubFileClient = {
  authorize(input: {
    readonly spaceId: string;
    readonly scopes: readonly string[];
    readonly reason: string;
    readonly fallback?: "allow" | "none";
  }): Promise<AuthorizeResult>;
  read(input: { readonly spaceId: string; readonly path: string }): Promise<ReadFileResult>;
  /** One directory's entries; a missing folder rejects with 404. */
  list(input: { readonly spaceId: string; readonly path: string }): Promise<readonly FileEntry[]>;
  /** `expected: null` writes without a version, replacing a file that is already there. */
  write(input: {
    readonly spaceId: string;
    readonly path: string;
    readonly text: string;
    readonly expected: FileVersion | null;
  }): Promise<FileVersion>;
  delete(input: { readonly spaceId: string; readonly path: string }): Promise<void>;
  /** The Task Run record, for a generated score. */
  getTask(taskRunId: string): Promise<TaskRunSnapshot>;
};

/** The composer chip the host draws; the protocol limits each field (label 120 chars, content 32 KB). */
export type ComposerChip = {
  readonly key: string;
  readonly label: string;
  readonly content: string;
};

/** The other cohub calls the App needs: one chip while its window is active, replaced by key. */
export type ComposerChipApi = {
  setComposerChip(chip: ComposerChip): void;
  clearComposerChip(key: string): void;
};

export type TaskListPage = {
  readonly runs: readonly TaskRunSnapshot[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
};

export type PickSpaceResult = AuthorizeResult;

export type NavigationResult = {
  readonly handled: boolean;
  readonly reason?: string;
};

/** The home and handoff calls beyond files: task pages, a picked Space, and one navigation. */
export type HomeApi = {
  listTasks(input: {
    readonly spaceId: string;
    readonly limit: number;
    readonly cursor?: string | null;
    readonly taskType?: "generation";
    readonly status?: "completed";
  }): Promise<TaskListPage>;
  pickSpace(input: {
    readonly scopes: readonly string[];
    readonly reason: string;
  }): Promise<PickSpaceResult>;
  navigate(input: { readonly spaceId: string; readonly path: string }): Promise<NavigationResult>;
};

/** The whole seam: files, task pages, a picked Space, navigation and the composer chip. */
export type CohubAppClient = CohubFileClient & ComposerChipApi & HomeApi;

export type HostState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly editable: boolean; readonly name: string; readonly path: string }
  | { readonly status: "no-permission"; readonly reason: "missing" | "revoked" }
  | { readonly status: "file-gone" }
  | { readonly status: "task-gone" }
  | { readonly status: "failed" };

export type HostFailure = Extract<
  HostState,
  { status: "no-permission" | "file-gone" | "task-gone" | "failed" }
>;

type OpenedBase = {
  readonly ok: true;
  readonly project: SongProject;
  readonly editable: boolean;
  readonly name: string;
  /** The file the window is about: the opened score file, or the generation's Save as place. */
  readonly path: string | null;
};

/** What the App opens: a score file with a save source, or a generation kept in drafts. */
export type OpenedScore = OpenedBase &
  (
    | { readonly kind: "scoreFile"; readonly source: ScoreFileSource }
    | {
        readonly kind: "generated";
        /** Absent when read-only, so nothing is read or written. */
        readonly drafts?: DraftStore;
        /** Absent when read-only. */
        readonly saveAs?: (text: string) => Promise<SaveAsOutcome>;
      }
  );

export type OpenResult = OpenedScore | { readonly ok: false; readonly state: HostFailure };

const MODEL_ID = "song2";

function projectFor(spaceId: string, path: string, text: string): SongProject {
  return {
    style: "",
    lyrics: "",
    score: text,
    scoreMode: "full",
    seed: null,
    modelId: MODEL_ID,
    sourceKey: `score-file:${spaceId}:${path}`,
  };
}

type FileCurrent = {
  kind: "scoreFile";
  spaceId: string;
  path: string;
  name: string;
  version: FileVersion;
  editable: boolean;
};

type GeneratedCurrent = {
  kind: "generated";
  spaceId: string;
  taskRunId: string;
  file: string | null;
  name: string;
  project: SongProject;
  editable: boolean;
};

type Current = FileCurrent | GeneratedCurrent;

const FILE_SCOPES = ["file.view", "file.edit"] as const;
const FILE_READ_SCOPES = ["file.view"] as const;
const GENERATED_SCOPES = ["file.view", "file.edit", "taskrun.view"] as const;
const GENERATED_READ_SCOPES = ["file.view", "taskrun.view"] as const;

export type OpenGrant = { readonly scopes: readonly string[] };

export type ScoreHost = {
  /** A host launch asks for access; a home row passes the grant the home already holds. */
  openFile(
    input: { readonly spaceId: string; readonly path: string },
    options?: { readonly grant?: OpenGrant },
  ): Promise<OpenResult>;
  openGenerated(
    input: {
      readonly spaceId: string;
      readonly taskRunId: string;
      readonly file: { readonly spaceId: string; readonly path: string } | null;
    },
    options?: { readonly grant?: OpenGrant },
  ): Promise<OpenResult>;
  /** Follows a launch: the same file again, a rename/move, or another space. */
  relaunch(input: { readonly spaceId: string; readonly path: string }): "same" | "moved" | "other";
  state(): HostState;
  subscribe(listener: (state: HostState) => void): () => void;
  setLanguage(language: "zh" | "en"): void;
  /** Asks for the access the current state is missing, then reports what the viewer chose. */
  requestAccess(): Promise<"granted" | "cancelled" | "denied">;
  /** True once after a save recreated a deleted file, so the frame can say it is back. */
  takeRecreated(): boolean;
  /** The window may close without a prompt unless there are unsaved changes. */
  allowClose(unsaved: boolean): boolean;
  name(): string | null;
  path(): string | null;
  editable(): boolean;
  kind(): "scoreFile" | "generated" | null;
  /** The Space the current score lives in, once it is open. */
  spaceId(): string | null;
  /** Writes a generated score as a new file and answers where it went. */
  saveAs(text: string): Promise<SaveAsOutcome>;
};

const REASONS = {
  open: {
    en: "Open and save score files in this Space.",
    zh: "打开并保存这个 Space 里的乐谱文件。",
  },
  generated: {
    en: "Open this generated score in this Space.",
    zh: "打开这个 Space 里这次生成的乐谱。",
  },
  edit: {
    en: "Edit score files in this Space.",
    zh: "修改这个 Space 里的乐谱文件。",
  },
} as const;

export function createScoreHost(options: {
  client: CohubFileClient;
  language?: "zh" | "en";
}): ScoreHost {
  let language = options.language ?? "en";
  let current: Current | null = null;
  let lastSpaceId: string | null = null;
  let lastKind: "scoreFile" | "generated" = "scoreFile";
  let createOnNextSave = false;
  let recreated = false;
  let state: HostState = { status: "loading" };
  const listeners = new Set<(state: HostState) => void>();

  const setState = (next: HostState) => {
    state = next;
    for (const listener of listeners) listener(next);
  };

  const readyState = (value: Current): HostState => ({
    status: "ready",
    editable: value.editable,
    name: value.name,
    path: value.kind === "scoreFile" ? value.path : (value.file ?? ""),
  });

  /** Reads the path now and says why there is no entry: a 404 is missing, any other failure is failed. */
  const readNow = async (): Promise<
    { readonly ok: true; readonly text: string; readonly version: FileVersion } | { readonly ok: false; readonly reason: "missing" | "failed" }
  > => {
    if (current?.kind !== "scoreFile") return { ok: false, reason: "failed" };
    const file = current;
    try {
      const entry = await options.client.read({ spaceId: file.spaceId, path: file.path });
      // The file is back: a create armed for a deleted file must not run any more.
      createOnNextSave = false;
      if (state.status === "file-gone") setState(readyState(file));
      return { ok: true, ...entry };
    } catch (error) {
      if (statusOf(error) === 403) {
        setState({ status: "no-permission", reason: "revoked" });
        return { ok: false, reason: "failed" };
      }
      if (statusOf(error) === 404) {
        setState({ status: "file-gone" });
        // The next save of this file puts it back at the same path.
        createOnNextSave = true;
        return { ok: false, reason: "missing" };
      }
      return { ok: false, reason: "failed" };
    }
  };

  const save = async (
    text: string,
    expected: string,
  ): Promise<{ ok: true; version: string } | { ok: false; reason: "conflict" | "failed" | "no-access" }> => {
    if (current?.kind !== "scoreFile") return { ok: false, reason: "failed" };
    const file = current;
    const recreate = createOnNextSave && expected === versionString(file.version);
    createOnNextSave = false;
    if (recreate) {
      // Recreating a deleted file: read first, so a file that came back is a conflict, not an overwrite.
      let exists = true;
      try {
        await options.client.read({ spaceId: file.spaceId, path: file.path });
      } catch (error) {
        if (statusOf(error) === 404) {
          exists = false;
        } else {
          if (statusOf(error) === 403) {
            setState({ status: "no-permission", reason: "revoked" });
            return { ok: false, reason: "no-access" };
          }
          return { ok: false, reason: "failed" };
        }
      }
      if (exists) {
        createOnNextSave = false;
        setState(readyState(file));
        return { ok: false, reason: "conflict" };
      }
      try {
        const written = await options.client.write({
          spaceId: file.spaceId,
          path: file.path,
          text,
          expected: null,
        });
        file.version = written;
        createOnNextSave = false;
        recreated = true;
        setState(readyState(file));
        return { ok: true, version: versionString(written) };
      } catch (error) {
        if (statusOf(error) === 403) {
          setState({ status: "no-permission", reason: "revoked" });
          return { ok: false, reason: "no-access" };
        }
        return { ok: false, reason: "failed" };
      }
    }
    const version = parseFileVersion(expected) ?? file.version;
    try {
      const written = await options.client.write({
        spaceId: file.spaceId,
        path: file.path,
        text,
        expected: version,
      });
      file.version = written;
      if (state.status !== "ready") setState(readyState(file));
      return { ok: true, version: versionString(written) };
    } catch (error) {
      if (isConflict(error)) {
        // A versioned write to a missing file is a conflict in cohub; the read tells the two apart.
        const entry = await readNow();
        return entry.ok ? { ok: false, reason: "conflict" } : { ok: false, reason: "failed" };
      }
      if (statusOf(error) === 403) {
        setState({ status: "no-permission", reason: "revoked" });
        return { ok: false, reason: "no-access" };
      }
      if (statusOf(error) === 404) {
        setState({ status: "file-gone" });
      }
      return { ok: false, reason: "failed" };
    }
  };

  const sourceFor = (file: FileCurrent): ScoreFileSource => ({
    kind: "scoreFile",
    name: file.name,
    version: versionString(file.version),
    save,
    read: async () => {
      const entry = await readNow();
      if (!entry.ok) return entry;
      return { text: entry.text, version: versionString(entry.version) };
    },
  });

  const authorize = async (
    spaceId: string,
    scopes: readonly string[],
    reason: string,
  ): Promise<AuthorizeResult | null> => {
    try {
      const answer = await options.client.authorize({ spaceId, scopes, reason, fallback: "none" });
      // A grant for another Space cannot read or write this file; a host that ignores `fallback`
      // must not turn that answer into access here.
      if (answer.status === "granted" && answer.space.id !== spaceId) {
        return { status: "denied", code: "space_inaccessible" };
      }
      return answer;
    } catch {
      setState({ status: "failed" });
      return null;
    }
  };

  /** A viewer without edit access gets the read scopes alone, so the file opens read-only. */
  const authorizeOpen = async (
    spaceId: string,
    scopes: readonly string[],
    readScopes: readonly string[],
    reason: string,
  ): Promise<AuthorizeResult | null> => {
    const granted = await authorize(spaceId, scopes, reason);
    if (granted?.status === "denied" && granted.code === "scope_not_held") {
      return authorize(spaceId, readScopes, reason);
    }
    return granted;
  };

  /** The one Save as path: it reads the file the window is on now, including after a relaunch. */
  const saveGenerated = async (text: string): Promise<SaveAsOutcome> => {
    if (current?.kind !== "generated" || !current.editable) return { ok: false, reason: "failed" };
    const generated = current;
    return saveGeneratedScore({
      client: options.client,
      spaceId: generated.spaceId,
      sourceFile: generated.file,
      taskRunId: generated.taskRunId,
      name: generated.name,
      text,
    });
  };

  return {
    async openFile(input, callOptions) {
      lastSpaceId = input.spaceId;
      lastKind = "scoreFile";
      current = null;
      setState({ status: "loading" });
      const granted = callOptions?.grant
        ? { status: "granted" as const, scopes: callOptions.grant.scopes }
        : await authorizeOpen(
            input.spaceId,
            FILE_SCOPES,
            FILE_READ_SCOPES,
            REASONS.open[language],
          );
      if (granted === null) return { ok: false, state: { status: "failed" } };
      if (granted.status !== "granted") {
        const failed: HostFailure = { status: "no-permission", reason: "missing" };
        setState(failed);
        return { ok: false, state: failed };
      }
      const editable = granted.scopes.includes("file.edit");

      let read: ReadFileResult;
      try {
        read = await options.client.read({ spaceId: input.spaceId, path: input.path });
      } catch (error) {
        if (statusOf(error) === 403) {
          const failed: HostFailure = { status: "no-permission", reason: "revoked" };
          setState(failed);
          return { ok: false, state: failed };
        }
        if (statusOf(error) === 404) {
          const failed: HostFailure = { status: "file-gone" };
          setState(failed);
          return { ok: false, state: failed };
        }
        const failed: HostFailure = { status: "failed" };
        setState(failed);
        return { ok: false, state: failed };
      }

      const file: FileCurrent = {
        kind: "scoreFile",
        spaceId: input.spaceId,
        path: input.path,
        name: fileNameOf(input.path),
        version: read.version,
        editable,
      };
      current = file;
      setState(readyState(file));
      return {
        ok: true,
        kind: "scoreFile",
        project: projectFor(file.spaceId, file.path, read.text),
        source: sourceFor(file),
        editable,
        name: file.name,
        path: file.path,
      };
    },

    async openGenerated(input, callOptions) {
      lastSpaceId = input.spaceId;
      lastKind = "generated";
      current = null;
      setState({ status: "loading" });
      const granted = callOptions?.grant
        ? { status: "granted" as const, scopes: callOptions.grant.scopes }
        : await authorizeOpen(
            input.spaceId,
            GENERATED_SCOPES,
            GENERATED_READ_SCOPES,
            REASONS.generated[language],
          );
      if (granted === null) return { ok: false, state: { status: "failed" } };
      if (granted.status !== "granted") {
        const failed: HostFailure = { status: "no-permission", reason: "missing" };
        setState(failed);
        return { ok: false, state: failed };
      }
      if (!granted.scopes.includes("taskrun.view")) {
        const failed: HostFailure = { status: "no-permission", reason: "missing" };
        setState(failed);
        return { ok: false, state: failed };
      }
      const editable = granted.scopes.includes("file.edit");

      let task: TaskRunSnapshot;
      try {
        task = await options.client.getTask(input.taskRunId);
      } catch (error) {
        if (statusOf(error) === 403) {
          const failed: HostFailure = { status: "no-permission", reason: "revoked" };
          setState(failed);
          return { ok: false, state: failed };
        }
        if (statusOf(error) === 404) {
          const failed: HostFailure = { status: "task-gone" };
          setState(failed);
          return { ok: false, state: failed };
        }
        const failed: HostFailure = { status: "failed" };
        setState(failed);
        return { ok: false, state: failed };
      }

      const project = projectFromTask(task);
      const generated: GeneratedCurrent = {
        kind: "generated",
        spaceId: task.spaceId ?? input.spaceId,
        taskRunId: input.taskRunId,
        file: input.file?.path ?? null,
        name: nameOfTask(task, project),
        project,
        editable,
      };
      current = generated;
      setState(readyState(generated));

      const opened: OpenedScore = {
        ok: true,
        kind: "generated",
        project,
        editable,
        name: generated.name,
        path: generated.file,
      };
      if (!editable) return opened;
      return {
        ...opened,
        drafts: createDraftStore({ client: options.client, spaceId: generated.spaceId }),
        saveAs: saveGenerated,
      };
    },

    async requestAccess() {
      const spaceId = current?.spaceId ?? lastSpaceId;
      if (spaceId === null) return "denied";
      const kind = current?.kind ?? lastKind;
      const required = kind === "generated" ? GENERATED_SCOPES : FILE_SCOPES;
      const missing = current?.editable === false ? ["file.edit"] : [...required];
      const reason =
        missing.length === 1 && missing[0] === "file.edit"
          ? REASONS.edit[language]
          : kind === "generated"
            ? REASONS.generated[language]
            : REASONS.open[language];
      const granted = await authorize(spaceId, missing, reason);
      if (granted === null) return "denied";
      if (granted.status !== "granted") return granted.status;
      if (current !== null) {
        current = { ...current, editable: granted.scopes.includes("file.edit") };
        setState(readyState(current));
      }
      return "granted";
    },

    relaunch(input) {
      if (!current) return "other";
      if (current.spaceId !== input.spaceId) return "other";
      if (current.kind === "generated") {
        current = { ...current, file: input.path };
        return "same";
      }
      if (current.path === input.path) return "same";
      current = { ...current, path: input.path, name: fileNameOf(input.path) };
      setState(readyState(current));
      return "moved";
    },

    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setLanguage(next) {
      language = next;
    },
    takeRecreated() {
      const answer = recreated;
      recreated = false;
      return answer;
    },
    allowClose(unsaved) {
      return !unsaved;
    },
    name: () => current?.name ?? null,
    path: () => {
      if (!current) return null;
      return current.kind === "scoreFile" ? current.path : current.file;
    },
    editable: () => current?.editable ?? false,
    kind: () => current?.kind ?? null,
    spaceId: () => current?.spaceId ?? lastSpaceId,
    async saveAs(text) {
      return saveGenerated(text);
    },
  };
}
