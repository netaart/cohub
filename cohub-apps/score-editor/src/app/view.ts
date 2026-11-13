import { frameCopy, type FrameCopy, type Language } from "./copy.ts";
import { folderLine, type ScoreKind, type StateContent } from "./policy.ts";

export type FrameAction = {
  readonly label: string;
  readonly ariaLabel?: string;
  readonly kind?: "primary" | "text" | "danger";
  readonly disabled?: boolean;
  readonly run: () => void;
};

export type FrameView = {
  readonly editorElement: HTMLElement;
  setHidden(hidden: boolean): void;
  setBack(action?: FrameAction): void;
  setSpaceName(name: string | null): void;
  setFile(name: string | null, path: string | null, editable: boolean, kind?: ScoreKind): void;
  setLanguage(language: Language): void;
  showLoading(title: string): void;
  showState(content: StateContent & { readonly action?: FrameAction }): void;
  showEditor(): void;
  showNotice(input: { readonly text: string; readonly action?: FrameAction }): void;
  clearNotice(): void;
  /** The line under the bar that says a handoff is ready, or why it did not go. */
  showHandoff(input: { readonly text: string; readonly tone: "ready" | "info" | "problem" }): void;
  clearHandoff(): void;
  /** The save/discard/keep bar shown when leaving a dirty score file for the home. */
  showGuard(input: {
    readonly title: string;
    readonly body: string;
    readonly actions: readonly FrameAction[];
  }): void;
  clearGuard(): void;
  destroy(): void;
};

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  parent?: HTMLElement,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  parent?.append(node);
  return node;
}

function setAction(button: HTMLButtonElement, action: FrameAction | undefined) {
  button.hidden = action === undefined;
  if (!action) {
    button.onclick = null;
    return;
  }
  button.textContent = action.label;
  button.onclick = () => action.run();
}

export function createFrameView(root: HTMLElement, language: Language): FrameView {
  let currentLanguage = language;
  let copy: FrameCopy = frameCopy(language);
  let hasFile = false;
  let currentPath: string | null = null;
  let spaceName: string | null = null;
  let kind: ScoreKind = "scoreFile";
  const tagFor = () => (kind === "generated" ? copy.generatedScoreTag : copy.scoreFileTag);

  const app = element("div", "frame", root);
  const bar = element("header", "frame-bar", app);
  const back = element("button", "frame-back", bar);
  back.type = "button";
  back.hidden = true;
  const heading = element("div", "frame-heading", bar);
  const name = element("h1", "frame-name", heading);
  const tag = element("span", "frame-tag", heading);
  const path = element("span", "frame-path", bar);

  const renderPath = () => {
    const folder = currentPath === null ? null : folderLine(currentPath, currentLanguage);
    const text = folder === null ? spaceName : spaceName === null ? folder : `${spaceName} · ${folder}`;
    path.textContent = text ?? "";
    path.hidden = text === null;
    path.title = currentPath ?? "";
  };

  const guard = element("div", "frame-guard", app);
  guard.hidden = true;
  const guardCopy = element("div", "frame-guard-copy", guard);
  const guardTitle = element("p", "frame-guard-title", guardCopy);
  guardTitle.tabIndex = -1;
  const guardBody = element("p", "frame-guard-body", guardCopy);
  const guardActions = element("div", "frame-guard-actions", guard);

  const handoff = element("div", "frame-handoff", app);
  const handoffText = element("p", "frame-handoff-text", handoff);
  handoff.hidden = true;

  const notice = element("div", "frame-notice", app);
  const noticeText = element("p", "frame-notice-text", notice);
  const noticeAction = element("button", "frame-action", notice);
  noticeAction.type = "button";

  const stage = element("main", "frame-stage", app);
  const progress = element("div", "frame-progress", stage);
  progress.setAttribute("aria-hidden", "true");

  const panel = element("section", "frame-state", stage);
  const panelCopy = element("div", "frame-state-copy", panel);
  const title = element("h2", "frame-state-title", panelCopy);
  title.tabIndex = -1;
  const body = element("p", "frame-state-body", panelCopy);
  const action = element("button", "frame-action", panel);
  action.type = "button";

  const editor = element("div", "frame-editor", stage);
  editor.tabIndex = -1;
  const live = element("p", "frame-live", app);
  live.setAttribute("role", "status");
  live.setAttribute("aria-live", "polite");

  name.textContent = "";
  tag.textContent = tagFor();
  path.textContent = "";
  notice.hidden = true;
  panel.hidden = true;
  body.hidden = true;
  action.hidden = true;
  noticeAction.hidden = true;

  const announce = (content: StateContent) => {
    live.textContent = content.body ? `${content.title} ${content.body}` : content.title;
  };

  return {
    editorElement: editor,
    setHidden(hidden) {
      app.hidden = hidden;
    },
    setBack(action) {
      back.hidden = action === undefined;
      back.textContent = action?.label ?? "";
      back.setAttribute("aria-label", action?.ariaLabel ?? action?.label ?? "");
      back.onclick = action ? () => action.run() : null;
    },
    setSpaceName(name) {
      spaceName = name;
      renderPath();
    },
    setFile(nextName, nextPath, editable, nextKind = "scoreFile") {
      kind = nextKind;
      name.textContent = nextName ?? "";
      heading.title = nextName ?? "";
      currentPath = nextPath;
      renderPath();
      hasFile = nextName !== null;
      tag.textContent = tagFor();
      tag.hidden = !hasFile;
      app.dataset.editable = String(editable);
    },
    setLanguage(next) {
      currentLanguage = next;
      copy = frameCopy(next);
      renderPath();
      tag.textContent = tagFor();
    },
    showLoading(titleText) {
      guard.hidden = true;
      const wasVisible = !panel.hidden;
      notice.hidden = true;
      panel.hidden = false;
      editor.hidden = true;
      progress.hidden = false;
      stage.setAttribute("aria-busy", "true");
      title.textContent = titleText;
      body.hidden = true;
      action.hidden = true;
      tag.textContent = tagFor();
      tag.hidden = !hasFile;
      if (wasVisible) title.focus();
    },
    showState(content) {
      guard.hidden = true;
      notice.hidden = true;
      panel.hidden = false;
      editor.hidden = true;
      progress.hidden = true;
      stage.setAttribute("aria-busy", "false");
      title.textContent = content.title;
      body.textContent = content.body;
      body.hidden = content.body === "";
      setAction(action, content.action);
      tag.textContent = tagFor();
      tag.hidden = !hasFile;
      announce(content);
      title.focus();
    },
    showEditor() {
      guard.hidden = true;
      panel.hidden = true;
      editor.hidden = false;
      // The package's own source label names the kind, read-only included; the frame's tag would repeat it.
      tag.hidden = true;
      notice.hidden = true;
      progress.hidden = true;
      stage.setAttribute("aria-busy", "false");
      live.textContent = "";
    },
    showNotice(input) {
      notice.hidden = false;
      noticeText.textContent = input.text;
      setAction(noticeAction, input.action);
      live.textContent = input.text;
    },
    clearNotice() {
      notice.hidden = true;
      noticeText.textContent = "";
      setAction(noticeAction, undefined);
      live.textContent = "";
    },
    showHandoff(input) {
      handoff.hidden = false;
      handoff.dataset.tone = input.tone;
      handoffText.textContent = input.text;
      live.textContent = input.text;
    },
    clearHandoff() {
      handoff.hidden = true;
      handoffText.textContent = "";
    },
    showGuard(input) {
      guard.hidden = false;
      guardTitle.textContent = input.title;
      guardBody.textContent = input.body;
      guardActions.replaceChildren(
        ...input.actions.map((item) => {
          const className =
            item.kind === "text" || item.kind === "danger"
              ? `frame-guard-text${item.kind === "danger" ? " frame-guard-danger" : ""}`
              : "frame-action";
          const button = element("button", className, guardActions);
          button.type = "button";
          button.textContent = item.label;
          button.disabled = item.disabled === true;
          button.onclick = () => item.run();
          return button;
        }),
      );
      live.textContent = `${input.title} ${input.body}`;
      guardTitle.focus();
    },
    clearGuard() {
      guard.hidden = true;
      guardTitle.textContent = "";
      guardBody.textContent = "";
      guardActions.replaceChildren();
    },
    destroy() {
      app.remove();
    },
  };
}
