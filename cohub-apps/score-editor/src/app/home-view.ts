import type { HomeFile, HomeSong } from "./home.ts";
import { formatHomeFullTime, formatHomeTime, timeIso } from "./home.ts";
import { fillCopy, frameCopy, type FrameCopy, type Language } from "./copy.ts";
import { element, type FrameAction } from "./view.ts";

export type HomeSectionState = "loading" | "ready" | "error" | "denied";

export type HomeModel = {
  readonly language: Language;
  readonly songs: readonly HomeSong[];
  readonly files: readonly HomeFile[];
  readonly songsState: HomeSectionState;
  readonly filesState: HomeSectionState;
  readonly refreshing: boolean;
  readonly refreshFailed: boolean;
  readonly songsHasMore: boolean;
  readonly loadingSongs: boolean;
  readonly canWrite: boolean;
  readonly readOnly: boolean;
  readonly workingName: string | null;
  readonly listedIsContext: boolean;
  /** The context Space holds a grant this window can return to. */
  readonly contextHasGrant: boolean;
  readonly fileLimit: number;
  readonly checking: string | null;
  readonly copying: string | null;
  readonly busy: "new" | "pick" | "copy" | null;
  readonly accessRequired: boolean;
  readonly slowSongs: boolean;
  readonly slowFiles: boolean;
  readonly allFailed: boolean;
  readonly rowError: { readonly key: string; readonly text: string; readonly retry: () => void } | null;
  readonly notice: { readonly text: string; readonly tone: "info" | "problem"; readonly action?: FrameAction } | null;
};

export type HomeActions = {
  readonly newScore: () => void;
  readonly pickSpace: () => void;
  readonly backToContext: () => void;
  readonly backToWorking: () => void;
  readonly openSong: (id: string) => void;
  readonly openFile: (path: string) => void;
  readonly copySong: (id: string) => void;
  readonly copyFile: (path: string) => void;
  readonly loadMoreSongs: () => void;
  readonly showMoreFiles: () => void;
  readonly retrySongs: () => void;
  readonly retryFiles: () => void;
  readonly retryAll: () => void;
  readonly askSongs: () => void;
  readonly askFiles: () => void;
  readonly askAll: () => void;
  readonly askEdit: () => void;
  readonly cancelCheck: () => void;
  readonly retryRefresh: () => void;
};

export type HomeView = {
  readonly element: HTMLElement;
  render(model: HomeModel): void;
  scrollTop(): number;
  scrollTo(top: number): void;
  destroy(): void;
};

function actionButton(
  parent: HTMLElement,
  className: string,
  label: string,
  run: () => void,
  focusKey?: string,
): HTMLButtonElement {
  const button = element("button", className, parent);
  button.type = "button";
  button.textContent = label;
  button.onclick = () => run();
  if (focusKey) {
    button.dataset.focusKey = focusKey;
    button.dataset.homeAction = focusKey;
  }
  return button;
}

function isFocusableKey(key: string | undefined): key is string {
  return typeof key === "string" && key.length > 0;
}

export function createHomeView(
  root: HTMLElement,
  language: Language,
  actions: HomeActions,
): HomeView {
  let copy: FrameCopy = frameCopy(language);
  let currentLanguage = language;
  let hintId = 0;
  const app = element("section", "frame home", root);
  const bar = element("header", "frame-bar home-bar", app);
  const progress = element("div", "home-progress", app);
  progress.hidden = true;
  progress.setAttribute("aria-hidden", "true");
  const heading = element("div", "frame-heading", bar);
  const title = element("h1", "frame-name home-title", heading);
  const barActions = element("div", "home-bar-actions", bar);
  const newScore = actionButton(barActions, "frame-action home-new", copy.newScore, actions.newScore, "new-score");

  const banner = element("div", "home-banner", app);
  const bannerText = element("p", "home-banner-text", banner);
  const viewOnlyNote = element("p", "home-banner-note", banner);
  viewOnlyNote.hidden = true;
  const bannerActions = element("div", "home-banner-actions", banner);

  const scroll = element("div", "home-scroll", app);
  const body = element("div", "home-body", scroll);
  const notice = element("div", "home-notice", body);
  const noticeText = element("p", "home-notice-text", notice);
  const noticeAction = element("button", "home-text-action", notice);
  noticeAction.type = "button";
  notice.hidden = true;

  const copyingLine = element("p", "home-loading-line", body);
  copyingLine.hidden = true;

  const refreshLine = element("div", "home-refresh", body);
  const refreshText = element("p", "home-section-note", refreshLine);
  const refreshAction = actionButton(
    refreshLine,
    "home-text-action",
    copy.retry,
    actions.retryRefresh,
    "retry-refresh",
  );
  refreshLine.hidden = true;

  const access = element("section", "home-access", body);
  const accessTitle = element("h2", "frame-state-title", access);
  const accessBody = element("p", "frame-state-body", access);
  const accessActions = element("div", "home-access-actions", access);
  actionButton(accessActions, "frame-action", copy.askAccess, actions.askAll, "ask-all");
  const accessPick = actionButton(accessActions, "home-text-action", copy.workInYourSpace, actions.pickSpace, "pick-access");
  access.hidden = true;

  const allFailed = element("section", "home-access", body);
  const allFailedTitle = element("h2", "frame-state-title", allFailed);
  const allFailedBody = element("p", "frame-state-body", allFailed);
  actionButton(allFailed, "frame-action", copy.retry, actions.retryAll, "retry-all");
  allFailed.hidden = true;

  const songsSection = element("section", "home-section", body);
  const songsTitle = element("h2", "home-section-title", songsSection);
  const songsLoading = element("p", "home-loading-line", songsSection);
  const songsList = element("div", "home-list", songsSection);
  const songsFoot = element("div", "home-section-foot", songsSection);

  const filesSection = element("section", "home-section", body);
  const filesTitle = element("h2", "home-section-title", filesSection);
  const filesLoading = element("p", "home-loading-line", filesSection);
  const filesNote = element("p", "home-section-note", filesSection);
  const filesList = element("div", "home-list", filesSection);
  const filesFoot = element("div", "home-section-foot", filesSection);
  const orphanError = element("div", "home-row-error home-row-error-wide", body);
  orphanError.hidden = true;

  const empty = element("section", "home-empty", body);
  const emptyTitle = element("h2", "frame-state-title", empty);
  const emptyBody = element("p", "frame-state-body", empty);
  const emptyActions = element("div", "home-empty-actions", empty);

  const live = element("p", "frame-live", app);
  live.setAttribute("role", "status");
  live.setAttribute("aria-live", "polite");

  const setText = (node: HTMLElement, value: string) => {
    if (node.textContent !== value) node.textContent = value;
  };

  const headingFor = (model: HomeModel): string | null => {
    if (model.workingName !== null && !model.listedIsContext) {
      return fillCopy(copy.workingIn, { space: model.workingName });
    }
    if (model.workingName !== null && model.listedIsContext) {
      return `${fillCopy(copy.workingIn, { space: model.workingName })} · ${copy.viewingContext}`;
    }
    if (model.readOnly && model.listedIsContext) return copy.readOnlySpace;
    return null;
  };

  const renderBanner = (model: HomeModel) => {
    const text = headingFor(model);
    banner.hidden = text === null || model.accessRequired || model.allFailed;
    bannerActions.replaceChildren();
    if (text === null) return;
    bannerText.textContent = text;
    if (model.workingName !== null && !model.listedIsContext && model.contextHasGrant) {
      actionButton(bannerActions, "home-text-action", copy.backToContext, actions.backToContext, "back-context");
    }
    if (model.workingName !== null && model.listedIsContext) {
      actionButton(
        bannerActions,
        "home-text-action",
        fillCopy(copy.backToWorking, { space: model.workingName }),
        actions.backToWorking,
        "back-working",
      );
    }
    viewOnlyNote.hidden = !(model.workingName !== null && !model.canWrite);
    viewOnlyNote.textContent = copy.viewOnly;
    if (model.workingName === null && model.readOnly) {
      actionButton(bannerActions, "frame-action home-primary", copy.workInYourSpace, actions.pickSpace, "pick-space");
    } else {
      actionButton(bannerActions, "home-text-action", copy.pickSpace, actions.pickSpace, "pick-space");
    }
    if (!model.canWrite && model.workingName !== null) {
      actionButton(bannerActions, "home-text-action", copy.askEdit, actions.askEdit, "ask-edit");
    }
  };

  const renderNotice = (model: HomeModel) => {
    notice.hidden = model.notice === null || model.accessRequired || model.allFailed;
    noticeAction.hidden = true;
    noticeAction.onclick = null;
    if (model.notice === null) return;
    notice.dataset.tone = model.notice.tone;
    noticeText.textContent = model.notice.text;
    if (model.notice.action) {
      noticeAction.hidden = false;
      noticeAction.textContent = model.notice.action.label;
      noticeAction.onclick = () => model.notice?.action?.run();
    }
  };

  const renderRow = (
    list: HTMLElement,
    input: {
      readonly key: string;
      readonly title: string;
      readonly meta: string;
      readonly time: string;
      readonly fullTime: string;
      readonly machineTime: string;
      readonly tag?: string;
      readonly hint?: string;
      readonly tooltip?: string;
      readonly checking: boolean;
      readonly copying: boolean;
      readonly disabled?: boolean;
      readonly copyLabel: string | null;
      readonly error: { readonly text: string; readonly retry: () => void } | null;
      readonly onOpen: () => void;
      readonly onCopy: (() => void) | null;
    },
  ) => {
    const row = element("div", input.copyLabel ? "home-row has-copy" : "home-row", list);
    const main = element("button", "home-row-main", row);
    main.type = "button";
    main.disabled = input.checking || (input.disabled ?? false);
    main.dataset.focusKey = `row:${input.key}`;
    if (input.checking) main.dataset.checking = "true";
    if (input.hint) {
      const id = `home-hint-${++hintId}`;
      main.setAttribute("aria-describedby", id);
      main.title = input.hint;
      const hint = element("span", "home-row-hint", row);
      hint.id = id;
      hint.textContent = input.hint;
    }
    if (input.tooltip) main.title = input.tooltip;
    const titleLine = element("span", "home-row-title", main);
    const titleText = element("span", "home-row-title-text", titleLine);
    titleText.textContent = input.title;
    if (input.tag) {
      const tag = element("span", "home-tag", titleLine);
      tag.textContent = input.tag;
    }
    const meta = element("span", "home-row-meta", main);
    if (input.checking) {
      meta.textContent = copy.copyCheck;
      meta.hidden = false;
    } else if (input.copying) {
      meta.textContent = copy.copying;
      meta.hidden = false;
    } else if (input.meta) {
      meta.textContent = input.meta;
    } else {
      meta.hidden = true;
    }
    const time = element("time", "home-row-time", main);
    time.dateTime = input.machineTime;
    time.title = input.fullTime;
    time.textContent = input.time;
    time.hidden = input.machineTime === "";
    if (input.checking) {
      const cancel = actionButton(row, "home-text-action", copy.cancel, actions.cancelCheck, `cancel:${input.key}`);
      cancel.dataset.action = "cancel-check";
    } else {
      main.onclick = input.onOpen;
      if (input.copyLabel && input.onCopy) {
        const copyButton = actionButton(
          row,
          "home-text-action home-row-copy",
          input.copying ? copy.copying : input.copyLabel,
          input.onCopy,
          `copy:${input.key}`,
        );
        copyButton.dataset.action = "copy-row";
        copyButton.disabled = input.copying || (input.disabled ?? false);
        copyButton.setAttribute("aria-label", `${input.copyLabel} (${input.title})`);
      }
    }
    if (input.error) {
      const error = element("div", "home-row-error", row);
      error.textContent = input.error.text;
      actionButton(error, "home-text-action", copy.retry, input.error.retry, `retry:${input.key}`);
    }
  };

  const skeleton = (list: HTMLElement, count: number) => {
    for (let index = 0; index < count; index += 1) {
      const row = element("div", "home-row home-row-skeleton", list);
      row.setAttribute("aria-hidden", "true");
      element("span", "home-skeleton-title", row);
      element("span", "home-skeleton-meta", row);
    }
  };

  const renderSection = (
    headingNode: HTMLElement,
    list: HTMLElement,
    foot: HTMLElement,
    state: HomeSectionState,
    rows: number,
    options: {
      readonly kind: "songs" | "files";
      readonly label: string;
      readonly loading: boolean;
      readonly retry: () => void;
      readonly ask: () => void;
      readonly more: (() => void) | null;
      readonly moreLabel?: string;
      readonly moreDisabled?: boolean;
    },
  ) => {
    headingNode.textContent = options.label;
    list.replaceChildren();
    foot.replaceChildren();
    if (state === "loading" && rows === 0) {
      skeleton(list, 4);
      return;
    }
    if (state === "error") {
      const error = element("div", "home-section-message", list);
      error.textContent = options.kind === "songs" ? copy.songsFailed : copy.filesFailed;
      actionButton(error, "home-text-action", copy.retry, options.retry, `retry:${options.kind}`);
      return;
    }
    if (state === "denied") {
      const denied = element("div", "home-section-message", list);
      denied.textContent = options.kind === "songs" ? copy.songsNeedAccess : copy.filesNeedAccess;
      actionButton(denied, "home-text-action", copy.askAccess, options.ask, `ask:${options.kind}`);
      return;
    }
    if (options.loading && rows > 0) skeleton(list, 1);
    if (state === "ready" && options.more) {
      actionButton(
        foot,
        "home-text-action",
        options.moreDisabled ? copy.loading : copy.showMore,
        options.moreDisabled ? () => {} : options.more,
        `more:${options.kind}`,
      ).disabled = options.moreDisabled === true;
    }
  };

  const render = (model: HomeModel) => {
    const activeKey =
      typeof document.activeElement === "object" && document.activeElement !== null
        ? (document.activeElement as HTMLElement).dataset?.focusKey
        : undefined;
    if (model.language !== currentLanguage) {
      currentLanguage = model.language;
      copy = frameCopy(model.language);
    }
    setText(title, copy.homeTitle);
    newScore.hidden = !model.canWrite || model.allFailed;
    newScore.disabled = model.busy !== null || model.checking !== null;
    setText(newScore, model.busy === "new" ? copy.creating : copy.newScore);
    renderBanner(model);
    renderNotice(model);
    copyingLine.hidden = model.copying === null;
    copyingLine.textContent = copy.copying;
    progress.hidden = !model.refreshing;
    refreshLine.hidden = !model.refreshFailed || model.accessRequired || model.allFailed;
    refreshText.textContent = copy.refreshFailed;
    refreshAction.textContent = copy.retry;

    access.hidden = !model.accessRequired;
    allFailed.hidden = !model.allFailed;
    if (model.accessRequired) {
      banner.hidden = true;
      notice.hidden = true;
      songsSection.hidden = true;
      filesSection.hidden = true;
      empty.hidden = true;
      accessTitle.textContent = copy.homeAccessTitle;
      accessBody.textContent = model.notice?.text ?? copy.homeAccessBody;
      accessPick.hidden = !(model.readOnly && model.workingName === null);
    }
    if (model.allFailed) {
      banner.hidden = true;
      notice.hidden = true;
      songsSection.hidden = true;
      filesSection.hidden = true;
      empty.hidden = true;
      access.hidden = true;
      allFailedTitle.textContent = copy.homeFailed;
      allFailedBody.textContent = copy.unchanged;
    }

    const showEmpty = !model.accessRequired && !model.allFailed &&
      model.songsState === "ready" &&
      model.filesState === "ready" &&
      model.songs.length === 0 &&
      model.files.length === 0;
    empty.hidden = !showEmpty;
    emptyTitle.textContent = copy.homeEmptyTitle;
    emptyBody.textContent = model.canWrite ? copy.homeEmptyBody : copy.homeEmptyReadOnly;
    emptyActions.replaceChildren();
    if (showEmpty) {
      if (model.canWrite) {
        actionButton(emptyActions, "frame-action", copy.newScore, actions.newScore, "empty-new");
      } else if (model.readOnly) {
        actionButton(emptyActions, "frame-action", copy.workInYourSpace, actions.pickSpace, "empty-pick");
      }
    }

    if (!model.accessRequired && !model.allFailed) {
      renderSections(model);
      const error = model.rowError;
      const present =
        error === null
          ? true
          : model.songs.some((song) => song.id === error.key) ||
            model.files.some((file) => file.path === error.key);
      orphanError.hidden = error === null || present;
      if (error && !present) {
        orphanError.replaceChildren();
        orphanError.textContent = error.text;
        actionButton(orphanError, "home-text-action", copy.retry, error.retry, "retry-orphan");
      }
    }
    if (isFocusableKey(activeKey)) {
      const next = app.querySelector<HTMLElement>(`[data-focus-key="${activeKey.replaceAll('"', '\\"')}"]`);
      if (next) next.focus();
    }
    const sectionError = [
      model.songsState === "error" ? copy.songsFailed : "",
      model.filesState === "error" ? copy.filesFailed : "",
    ]
      .filter(Boolean)
      .join(" ");
    const stateText = model.accessRequired
      ? `${copy.homeAccessTitle} ${copy.homeAccessBody}`
      : model.allFailed
        ? `${copy.homeFailed} ${copy.unchanged}`
        : showEmpty
          ? `${copy.homeEmptyTitle} ${model.canWrite ? copy.homeEmptyBody : copy.homeEmptyReadOnly}`
          : sectionError;
    live.textContent = [model.notice?.text, stateText].filter(Boolean).join(" ");
  };

  const renderSections = (model: HomeModel) => {
    const copyLabel =
      model.listedIsContext && model.readOnly
        ? model.workingName === null
          ? copy.copyToYourSpace
          : fillCopy(copy.copyToWorking, { space: model.workingName })
        : null;
    const canCopy = copyLabel !== null && (model.workingName !== null ? model.canWrite : true);
    const locked = model.checking !== null || model.busy !== null;
    const files = model.files.slice(0, model.fileLimit);

    songsSection.hidden = model.songsState === "ready" && model.songs.length === 0;
    filesSection.hidden = model.filesState === "ready" && files.length === 0;

    songsLoading.hidden = !(model.slowSongs && model.songsState === "loading" && model.songs.length === 0);
    songsLoading.textContent = copy.lookingForSongs;
    filesLoading.hidden = !(model.slowFiles && model.filesState === "loading");
    filesLoading.textContent = copy.lookingForFiles;
    filesNote.hidden = model.songsState === "ready";
    filesNote.textContent =
      model.songsState === "denied"
        ? copy.copyUnchecked
        : model.songsState === "loading"
          ? copy.copyLoading
          : copy.copyUnknown;

    renderSection(songsTitle, songsList, songsFoot, model.songsState, model.songs.length, {
      kind: "songs",
      label: copy.songs,
      loading: model.loadingSongs,
      retry: actions.retrySongs,
      ask: actions.askSongs,
      more: model.songsHasMore ? actions.loadMoreSongs : null,
      moreDisabled: model.loadingSongs,
    });
    for (const song of model.songs) {
      renderRow(songsList, {
        key: song.id,
        title: song.title || copy.untitledSong,
        tooltip: song.title ? undefined : song.id,
        meta: song.style,
        time: formatHomeTime(song.createdAt, currentLanguage),
        fullTime: formatHomeFullTime(song.createdAt, currentLanguage),
        machineTime: timeIso(song.createdAt),
        checking: false,
        copying: model.copying === song.id,
        disabled: locked,
        copyLabel: canCopy ? copyLabel : null,
        error: model.rowError?.key === song.id ? model.rowError : null,
        onOpen: () => actions.openSong(song.id),
        onCopy: canCopy ? () => actions.copySong(song.id) : null,
      });
    }

    renderSection(filesTitle, filesList, filesFoot, model.filesState, files.length, {
      kind: "files",
      label: copy.scoreFiles,
      loading: model.filesState === "loading",
      retry: actions.retryFiles,
      ask: actions.askFiles,
      more: model.files.length > files.length ? actions.showMoreFiles : null,
    });
    for (const file of files) {
      renderRow(filesList, {
        key: file.path,
        title: file.name,
        meta: file.folder || copy.spaceRoot,
        time: formatHomeTime(file.mtimeMs, currentLanguage),
        fullTime: formatHomeFullTime(file.mtimeMs, currentLanguage),
        machineTime: timeIso(file.mtimeMs),
        tag: file.copyTaskId ? copy.generatedCopyTag : undefined,
        hint: file.copyTaskId ? copy.generatedCopyHint : undefined,
        checking: model.checking === file.path,
        copying: model.copying === file.path,
        disabled: locked && model.checking !== file.path,
        copyLabel: canCopy ? copyLabel : null,
        error: model.rowError?.key === file.path ? model.rowError : null,
        onOpen: () => actions.openFile(file.path),
        onCopy: canCopy ? () => actions.copyFile(file.path) : null,
      });
    }
  };

  return {
    element: app,
    render,
    scrollTop: () => scroll.scrollTop,
    scrollTo(top) {
      scroll.scrollTop = Math.max(0, top);
    },
    destroy() {
      app.remove();
    },
  };
}
