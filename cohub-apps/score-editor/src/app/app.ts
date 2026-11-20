import { createDialectRegistry, mount, type HandoffPayload, type MountedEditor } from "@neta-art/score-editor";
import { song2Dialect } from "@neta-art/score-dialect-song2";
import {
  createScoreHost,
  fileNameOf,
  type CohubAppClient,
  type HostFailure,
  type HostState,
  type OpenedScore,
} from "../host/host.ts";
import { scoreThemeVars, type HostAppearance } from "../host/theme.ts";
import { fillCopy, frameCopy, languageFor, type Language } from "./copy.ts";
import { createHandoff, handoffScorePath, withOriginalLyrics, type HandoffOutcome } from "./handoff.ts";
import { createHomeController, type HomeController, type HomeOpenTarget } from "./home-controller.ts";
import { editorOptionsFor } from "./options.ts";
import {
  canRetry,
  editorNotice,
  leaveNeedsGuard,
  failurePresentation,
  handoffNoticeFor,
  handoffNoticeText,
  launchChoice,
  stateCopy,
  type FailureAction,
  type HandoffNotice,
} from "./policy.ts";
import { createFrameView, type FrameAction, type FrameView } from "./view.ts";

/** The host side of the App: the SDK in a published App, a fake one in the harness. */
export type AppHost = {
  readonly client: CohubAppClient;
  readonly initial: {
    readonly locale: string | null;
    readonly appearance: HostAppearance;
    /** The Space the App was opened in. */
    readonly spaceId: string | null;
    /** The file the host opened, from the invocation context; a launch can replace it later. */
    readonly file: { readonly spaceId: string; readonly path: string } | null;
    /** `?taskRun=` from the launch URL: the generation this open is about. */
    readonly taskRunId: string | null;
    /** Whether the embedder has a composer; only Cohub's own origins do. */
    readonly composer: boolean;
  };
  onLaunch(listener: (file: { readonly spaceId: string; readonly path: string }) => void): () => void;
  onContext(
    listener: (context: { readonly locale: string | null; readonly appearance: HostAppearance }) => void,
  ): () => void;
  setTitle(title: string): void;
  setDirty(dirty: boolean): void;
  onBeforeClose(handler: () => boolean): void;
  close(): void;
};

const DIALECTS = createDialectRegistry([song2Dialect]);

type Mode = "loading" | "failure" | "editor" | "no-file" | "home";

export function createApp(options: {
  root: HTMLElement;
  host: AppHost;
  /** The package's mount, injectable for the App-level seam tests. */
  mount?: typeof mount;
}): { destroy(): void } {
  const { root, host, mount: mountScoreEditor = mount } = options;
  let language: Language = languageFor(host.initial.locale);
  let appearance: HostAppearance = host.initial.appearance;
  const view: FrameView = createFrameView(root, language);
  const scoreHost = createScoreHost({ client: host.client, language });
  const composer = host.initial.composer;
  const handoff = createHandoff({ client: host.client, dialects: DIALECTS, composer });
  let home: HomeController | null = null;
  let homeStarted = false;
  let handoffNotice: HandoffNotice | null = null;
  const stops: Array<() => void> = [];
  let editor: MountedEditor | null = null;
  let opened: OpenedScore | null = null;
  let lastFile: { spaceId: string; path: string } | null = host.initial.file;
  let taskRunId: string | null = host.initial.taskRunId;
  const appSpaceId = host.initial.spaceId ?? host.initial.file?.spaceId ?? null;
  let openSpaceId = appSpaceId;
  let openRequest = 0;
  const launchKind = () => (taskRunId !== null ? "generated" : "scoreFile");
  let mode: Mode = taskRunId !== null || lastFile ? "loading" : "home";
  let failure: HostFailure | null = null;
  /** A message that overrides the state copy, e.g. "Access was not given." */
  let message: string | null = null;
  let declined = false;
  /** A one-line confirmation (access back, file back) that the next edit or save clears. */
  let flash: string | null = null;
  /** A one-time message from the editor (a draft save that failed, a refused command). */
  let packageNotice: string | null = null;

  let appliedVars: string[] = [];
  const applyTheme = () => {
    const { vars, colorScheme } = scoreThemeVars(appearance);
    for (const property of appliedVars) root.style.removeProperty(property);
    appliedVars = Object.keys(vars);
    for (const [property, value] of Object.entries(vars)) root.style.setProperty(property, value);
    root.style.colorScheme = colorScheme;
  };

  const applyLanguage = () => {
    document.documentElement.lang = language;
  };

  const actionFor = (action: FailureAction): FrameAction | undefined => {
    const copy = frameCopy(language);
    if (action === "access") return { label: copy.askAccess, run: () => void askAccess() };
    if (action === "retry") return { label: copy.retry, run: () => retry() };
    if (action === "close") return { label: copy.close, run: () => host.close() };
    return undefined;
  };

  const paint = () => {
    if (mode === "home") return;
    const copy = frameCopy(language);
    if (mode === "loading") {
      view.showLoading(
        stateCopy(
          "loading",
          scoreHost.name() ?? (lastFile ? fileNameOf(lastFile.path) : null),
          language,
          launchKind(),
        ).title,
      );
      return;
    }
    if (mode === "no-file") {
      view.showState(stateCopy("no-file", null, language));
      return;
    }
    if (mode === "failure" && failure) {
      const shown = failurePresentation(failure, {
        unsaved: editor?.hasUnsavedChanges() ?? false,
        name: scoreHost.name() ?? (lastFile ? fileNameOf(lastFile.path) : copy.scoreFileTag),
        language,
        kind: scoreHost.kind() ?? launchKind(),
      });
      if (shown.keepEditor && editor) {
        mode = "editor";
        view.showEditor();
        const body = declined ? `${message ?? shown.body} ${copy.accessNotGiven}` : message ?? shown.body;
        view.showNotice({ text: body, action: actionFor(shown.action) });
        host.setDirty(true);
        return;
      }
      editor?.destroy();
      editor = null;
      opened = null;
      host.setDirty(false);
      const body = declined ? `${message ?? shown.body} ${copy.accessNotGiven}` : message ?? shown.body;
      view.showState({ title: shown.title, body, action: actionFor(shown.action) });
      return;
    }
    if (mode !== "editor") return;
    view.showEditor();
    if (scoreHost.state().status === "file-gone") {
      view.showNotice({ text: fillCopy(copy.deletedEditsBody, { name: scoreHost.name() ?? "" }) });
      host.setDirty(true);
      return;
    }
    if (packageNotice) {
      // The package says what happened to the save; the revoked frame keeps the way back to access.
      const revoked = scoreHost.state().status === "no-permission";
      view.showNotice({
        text: declined ? `${packageNotice} ${copy.accessNotGiven}` : packageNotice,
        ...(revoked ? { action: { label: copy.askAccess, run: () => void askAccess() } } : {}),
      });
      return;
    }
    const notice = editorNotice({
      unsaved: editor?.hasUnsavedChanges() ?? false,
      editable: scoreHost.editable(),
      message,
      name: scoreHost.name() ?? "",
      language,
      kind: scoreHost.kind() ?? launchKind(),
    });
    if (flash) {
      view.showNotice({ text: flash });
      return;
    }
    if (notice) {
      view.showNotice({
        text: declined ? `${notice.text} ${copy.accessNotGiven}` : notice.text,
        action: { label: copy.askEdit, run: () => void askAccess() },
      });
    } else {
      view.clearNotice();
    }
  };

  const paintHandoff = () => {
    if (handoffNotice === null) {
      view.clearHandoff();
      return;
    }
    view.showHandoff({
      text: handoffNoticeText(handoffNotice, language),
      tone:
        handoffNotice.kind === "ready" || handoffNotice.kind === "saved"
          ? "ready"
          : handoffNotice.kind === "elsewhere" || handoffNotice.kind === "saved-elsewhere"
            ? "info"
            : "problem",
    });
  };

  const handOff = async (payload: HandoffPayload) => {
    const kind = scoreHost.kind() ?? launchKind();
    const title = scoreHost.name() ?? "";
    // The mount's `handoffScorePath` reads this same function, so the instruction and the chip name one path.
    const path = handoffScorePath({ kind, taskRunId, filePath: scoreHost.path() });
    const spaceId = scoreHost.spaceId() ?? openSpaceId ?? lastFile?.spaceId ?? null;
    if (spaceId === null || path === null) return;
    const working = home?.workingSpace() ?? null;
    const navigate =
      working !== null && working.id !== appSpaceId && spaceId === working.id
        ? { spaceName: working.name ?? frameCopy(language).otherSpace }
        : null;
    const handedPayload =
      opened?.kind === "generated" ? withOriginalLyrics(payload, opened.project.lyrics, language) : payload;
    const result: HandoffOutcome =
      kind === "generated" && taskRunId !== null
        ? await handoff.run({
            spaceId,
            target: { kind: "generated", taskRunId },
            title,
            language,
            payload: handedPayload,
            navigation: navigate,
          })
        : await handoff.run({
            spaceId,
            target: { kind: "scoreFile", path },
            title: title || fileNameOf(path),
            language,
            payload: handedPayload,
            navigation: navigate,
          });
    // A refused handoff takes the previous chip back: it names a version that is no longer in this window.
    if (!result.ok) handoff.clear();
    handoffNotice = handoffNoticeFor(result, navigate ?? undefined, { composer });
    paintHandoff();
  };

  const showFailure = (state: HostState) => {
    if (state.status === "ready" || state.status === "loading") return;
    // The window no longer holds what the chip describes.
    handoff.clear();
    handoffNotice = null;
    view.clearHandoff();
    failure = state;
    message = null;
    declined = false;
    flash = null;
    mode = "failure";
    paint();
  };

  const mountEditor = (file: OpenedScore) => {
    editor?.destroy();
    view.showEditor();
    const base = editorOptionsFor(file, language);
    const generated =
      file.kind === "generated"
        ? {
            source: { kind: "generated" } as const,
            requiredInputs:
              file.project.lyrics.trim() === ""
                ? (["style", "lyrics"] as const)
                : (["style"] as const),
            title: file.name,
            ...(file.drafts ? { drafts: file.drafts } : {}),
            ...(file.saveAs ? { onSaveAs: (text: string) => void saveAs(text) } : {}),
          }
        : {};
    editor = mountScoreEditor(view.editorElement, {
      ...base,
      ...generated,
      project: file.project,
      dialects: DIALECTS,
      handoffScorePath: () =>
        handoffScorePath({
          kind: scoreHost.kind() ?? file.kind,
          taskRunId,
          filePath: scoreHost.path(),
        }),
      notify: (notice) => {
        packageNotice = notice.message;
        if (mode === "editor") paint();
      },
      onHandoff: (payload) => void handOff(payload),
      onUnsavedChange: (unsaved) => {
        host.setDirty(unsaved);
        if (unsaved) flash = null;
        if (!unsaved && scoreHost.takeRecreated()) {
          const name = scoreHost.name();
          flash = name ? fillCopy(frameCopy(language).backWithChanges, { name }) : null;
        }
        if (mode === "editor") paint();
      },
    });
    view.editorElement.focus();
  };

  function spaceLabelFor(spaceId: string | null): string | null {
    if (spaceId === null || spaceId === appSpaceId) return null;
    const working = home?.workingSpace();
    if (working?.id !== spaceId) return null;
    return working.name ?? frameCopy(language).otherSpace;
  }

  const openScoreFile = async (
    file: { spaceId: string; path: string },
    grant?: readonly string[],
  ) => {
    lastFile = file;
    openSpaceId = file.spaceId;
    home?.hide();
    view.setHidden(false);
    view.setBack({
      label: frameCopy(language).homeTitle,
      ariaLabel: frameCopy(language).backToScores,
      run: () => requestHome(),
    });
    const request = ++openRequest;
    handoff.clear();
    handoffNotice = null;
    paintHandoff();
    opened = null;
    failure = null;
    message = null;
    declined = false;
    flash = null;
    packageNotice = null;
    editor?.destroy();
    editor = null;
    host.setDirty(false);
    // Name the file before the read so loading and every failure show which file the window is about.
    view.setFile(fileNameOf(file.path), file.path, false, "scoreFile");
    view.setSpaceName(spaceLabelFor(file.spaceId));
    host.setTitle(fileNameOf(file.path));
    mode = "loading";
    paint();
    const result =
      grant === undefined
        ? await scoreHost.openFile(file)
        : await scoreHost.openFile(file, { grant: { scopes: grant } });
    if (request !== openRequest) return;
    if (!result.ok) {
      failure = result.state;
      mode = "failure";
      paint();
      return;
    }
    opened = result;
    mode = "editor";
    view.setFile(result.name, result.path, result.editable, result.kind);
    view.setSpaceName(spaceLabelFor(file.spaceId));
    host.setTitle(result.name);
    mountEditor(result);
    paint();
  };

  const openGenerated = async (grant?: readonly string[]) => {
    if (taskRunId === null || openSpaceId === null) {
      failure = { status: "no-permission", reason: "missing" };
      mode = "failure";
      paint();
      return;
    }
    const request = ++openRequest;
    opened = null;
    failure = null;
    message = null;
    packageNotice = null;
    editor?.destroy();
    editor = null;
    host.setDirty(false);
    home?.hide();
    view.setHidden(false);
    view.setBack({
      label: frameCopy(language).homeTitle,
      ariaLabel: frameCopy(language).backToScores,
      run: () => requestHome(),
    });
    view.setFile(null, lastFile?.path ?? null, false, "generated");
    view.setSpaceName(spaceLabelFor(openSpaceId));
    mode = "loading";
    paint();
    const result =
      grant === undefined
        ? await scoreHost.openGenerated({
            spaceId: openSpaceId,
            taskRunId,
            file: lastFile,
          })
        : await scoreHost.openGenerated(
            { spaceId: openSpaceId, taskRunId, file: lastFile },
            { grant: { scopes: grant } },
          );
    if (request !== openRequest) return;
    if (!result.ok) {
      failure = result.state;
      mode = "failure";
      paint();
      return;
    }
    opened = result;
    mode = "editor";
    view.setFile(result.name, result.path, result.editable, result.kind);
    view.setSpaceName(spaceLabelFor(openSpaceId));
    host.setTitle(result.name);
    mountEditor(result);
    paint();
  };

  const openCurrent = () => {
    if (taskRunId !== null) return openGenerated();
    if (lastFile) return openScoreFile(lastFile);
    mode = "no-file";
    paint();
    return Promise.resolve();
  };

  const retry = () => {
    // Reloading would throw the unsaved edits away, so a retry waits until the file is clean.
    if (canRetry(editor?.hasUnsavedChanges() ?? false)) void openCurrent();
  };

  const askAccess = async () => {
    const outcome = await scoreHost.requestAccess();
    if (outcome !== "granted") {
      declined = true;
      paint();
      return;
    }
    message = null;
    declined = false;
    packageNotice = null;
    if (editor?.hasUnsavedChanges()) {
      // The edits stay; a granted write permission lets the next save retry.
      failure = null;
      mode = "editor";
      flash = scoreHost.editable() ? frameCopy(language).accessBack : null;
      paint();
      return;
    }
    void openCurrent();
  };

  const saveAs = async (text: string) => {
    const result = await scoreHost.saveAs(text);
    if (!result.ok) {
      packageNotice = frameCopy(language).saveAsFailed;
      paint();
      return;
    }
    // The new score file is what this window holds from now on; open it in the same editor.
    taskRunId = null;
    await openScoreFile({ spaceId: scoreHost.spaceId() ?? appSpaceId ?? "", path: result.path });
  };

  function goHome(): void {
    view.clearGuard();
    view.setBack(undefined);
    view.setSpaceName(null);
    handoff.clear();
    handoffNotice = null;
    view.clearHandoff();
    editor?.destroy();
    editor = null;
    opened = null;
    failure = null;
    message = null;
    packageNotice = null;
    flash = null;
    host.setDirty(false);
    taskRunId = null;
    lastFile = null;
    openSpaceId = appSpaceId;
    view.setHidden(true);
    mode = "home";
    if (home && appSpaceId !== null) {
      home.show();
      if (homeStarted) {
        void home.refresh();
      } else {
        homeStarted = true;
        void home.start(appSpaceId);
      }
    } else {
      view.setHidden(false);
      mode = "no-file";
      paint();
    }
  }

  function requestHome(): void {
    if (mode === "loading") {
      openRequest += 1;
      goHome();
      return;
    }
    if (mode === "failure" || mode === "no-file") {
      goHome();
      return;
    }
    if (mode !== "editor" || editor === null) return;
    if (!leaveNeedsGuard(scoreHost.kind(), editor.hasUnsavedChanges())) {
      goHome();
      return;
    }
    const copy = frameCopy(language);
    const name = scoreHost.name() ?? "";
    view.showGuard({
      title: fillCopy(copy.guardTitle, { name }),
      body: copy.guardBody,
      actions: [
        { label: copy.saveAndHome, kind: "primary", run: () => void saveAndHome() },
        { label: copy.discardAndHome, kind: "danger", run: goHome },
        { label: copy.keepEditing, kind: "text", run: () => view.clearGuard() },
      ],
    });
  }

  async function saveAndHome(): Promise<void> {
    const copy = frameCopy(language);
    const name = scoreHost.name() ?? "";
    if (!editor) {
      goHome();
      return;
    }
    view.showGuard({
      title: fillCopy(copy.guardTitle, { name }),
      body: copy.guardBody,
      actions: [{ label: copy.saving, kind: "primary", disabled: true, run: () => {} }],
    });
    let result: string;
    try {
      result = await editor.save();
    } catch {
      result = "failed";
    }
    if (result === "saved" || result === "unchanged") {
      goHome();
      return;
    }
    if (result === "conflict") {
      view.clearGuard();
      paint();
      return;
    }
    view.showGuard({
      title: fillCopy(copy.guardTitle, { name }),
      body: fillCopy(copy.guardSaveFailed, { name }),
      actions: [
        { label: copy.saveAndHome, kind: "primary", run: () => void saveAndHome() },
        { label: copy.discardAndHome, kind: "danger", run: goHome },
        { label: copy.keepEditing, kind: "text", run: () => view.clearGuard() },
      ],
    });
  }

  const openFromHome = async (target: HomeOpenTarget): Promise<void> => {
    home?.hide();
    openSpaceId = target.spaceId;
    if (target.kind === "generated") {
      taskRunId = target.taskRunId ?? null;
      lastFile = target.file ?? null;
      await openGenerated(target.scopes);
      return;
    }
    taskRunId = null;
    lastFile = null;
    await openScoreFile({ spaceId: target.spaceId, path: target.path ?? "" }, target.scopes);
  };

  home = createHomeController({
    root,
    client: host.client,
    language,
    onOpen: (target) => void openFromHome(target),
    onTitle: (title) => host.setTitle(title),
  });

  applyTheme();
  applyLanguage();
  view.setFile(
    lastFile ? fileNameOf(lastFile.path) : null,
    lastFile?.path ?? null,
    false,
    launchKind(),
  );
  if (taskRunId !== null || lastFile) {
    mode = "loading";
    paint();
    void openCurrent();
  } else if (appSpaceId !== null) {
    mode = "home";
    host.setTitle(frameCopy(language).homeTitle);
    view.setHidden(true);
    homeStarted = true;
    void home?.start(appSpaceId);
  } else {
    mode = "no-file";
    view.setHidden(false);
    paint();
  }

  stops.push(
    scoreHost.subscribe((state) => {
      if (opened === null) return;
      if (state.status === "ready") {
        // A file that came back takes the gone line down; the package's conflict banner is then the
        // only message.
        if (mode === "editor") paint();
        return;
      }
      showFailure(state);
    }),
  );
  stops.push(
    host.onLaunch((file) => {
      if (mode === "home" || mode === "no-file") {
        taskRunId = null;
        lastFile = null;
        void openScoreFile(file);
        return;
      }
      if (taskRunId !== null) {
        // A generated score's window follows the file only as its Save as place.
        lastFile = file;
        scoreHost.relaunch(file);
        view.setFile(scoreHost.name(), scoreHost.path(), scoreHost.editable(), "generated");
        return;
      }
      // The invocation context already opened this file; a repeat launch only brings the window forward.
      if (lastFile?.spaceId === file.spaceId && lastFile.path === file.path) return;
      const relaunch = launchChoice(scoreHost.relaunch(file), editor?.hasUnsavedChanges() ?? false);
      if (relaunch === "same") {
        view.setFile(scoreHost.name(), scoreHost.path(), scoreHost.editable(), "scoreFile");
        return;
      }
      if (relaunch === "moved") {
        lastFile = { spaceId: file.spaceId, path: file.path };
        handoff.clear();
        handoffNotice = null;
        view.clearHandoff();
        const nextName = scoreHost.name();
        view.setFile(nextName, scoreHost.path(), scoreHost.editable(), "scoreFile");
        if (nextName) host.setTitle(nextName);
        return;
      }
      if (relaunch === "hold") return;
      void openScoreFile(file);
    }),
  );
  stops.push(
    host.onContext((next) => {
      appearance = next.appearance;
      applyTheme();
      const nextLanguage = languageFor(next.locale);
      if (nextLanguage === language) return;
      language = nextLanguage;
      scoreHost.setLanguage(language);
      applyLanguage();
      view.setLanguage(language);
      home?.setLanguage(language);
      paintHandoff();
      editor?.update({ language });
      paint();
    }),
  );
  host.onBeforeClose(() => {
    const keptOnDeleted = scoreHost.state().status === "file-gone" && editor !== null;
    return scoreHost.allowClose((editor?.hasUnsavedChanges() ?? false) || keptOnDeleted);
  });

  return {
    destroy() {
      openRequest += 1;
      handoff.clear();
      home?.destroy();
      home = null;
      editor?.destroy();
      editor = null;
      for (const stop of stops) stop();
      view.destroy();
    },
  };
}
