/** The two languages this App draws. The host's locale picks one; nothing else is supported. */
export type Language = "zh" | "en";

/**
 * Every string the App itself writes, on screen or into the agent instruction, in both languages.
 * `{name}` is the score file's name. One word throughout: "score file" / 乐谱文件.
 */
export const FRAME_COPY = {
  opening: { zh: "正在打开 {name}…", en: "Opening {name}…" },
  scoreFileTag: { zh: "乐谱文件", en: "Score file" },
  generatedScoreTag: { zh: "生成的乐谱", en: "Generated score" },
  noPermissionTitle: { zh: "需要权限才能打开 {name}", en: "Access needed to open {name}" },
  noPermissionBody: {
    zh: "申请这个 Space 的权限。需要查看和编辑权限，才能打开并保存。",
    en: "Ask for view and edit access to this Space to open this score file and save it.",
  },
  revokedTitle: { zh: "{name} 的权限已被收回", en: "Access to {name} was removed" },
  revokedBody: {
    zh: "{name} 的权限已被收回。没有改动任何内容。申请权限后再打开。",
    en: "Access to {name} was removed. Nothing was changed. Ask for access to open it again.",
  },
  goneTitle: { zh: "{name} 不在了", en: "{name} is gone" },
  goneBody: {
    zh: "{name} 不在了。没有改动任何内容。如果它被移到了别处，从 Space 里重新打开。",
    en: "{name} is gone. Nothing was changed. If it was moved, open it again from the Space.",
  },
  failedTitle: { zh: "没能读取 {name}", en: "Couldn’t read {name}" },
  taskGoneTitle: { zh: "找不到这次生成。", en: "This generation isn’t available." },
  taskGoneBody: {
    zh: "没有改动任何内容。",
    en: "Nothing was changed.",
  },
  failedBody: { zh: "没有改动任何内容。再试一次。", en: "Nothing was changed. Try again." },
  deletedEditsBody: {
    zh: "{name} 不在了。你的修改还在。重新保存会把它放回原来的位置。",
    en: "{name} is gone. Your changes are still here. Save again to put it back where it was.",
  },
  checkFailedBody: {
    zh: "刚才没能检查 {name}。你的修改还在。等一下再保存一次。",
    en: "Couldn’t check {name} just now. Your changes are still here. Save again when you can.",
  },
  revokedEditsBody: {
    zh: "{name} 的权限已被收回。你的修改还在。先申请权限，再重新保存。",
    en: "Access to {name} was removed. Your changes are still here. Ask for access, then save again.",
  },
  needsAccessEditsBody: {
    zh: "需要 {name} 的权限。你的修改还在。先申请权限，再重新保存。",
    en: "Access to {name} is needed. Your changes are still here. Ask for access, then save again.",
  },
  accessBack: {
    zh: "权限已恢复。再保存一次，保住你的修改。",
    en: "Access is back. Save again to keep your changes.",
  },
  viewOnlyEdits: {
    zh: "你能查看 {name}，但不能修改。你的修改还在。请向 Space 的所有者申请编辑权限。",
    en: "You can view {name} but not change it. Your changes are still here. Ask the Space’s owner for edit access.",
  },
  backWithChanges: {
    zh: "{name} 已经放回去了，修改都在。",
    en: "{name} is back, with your changes.",
  },
  spaceRoot: { zh: "Space 根目录", en: "Space root" },
  readOnlyBody: {
    zh: "你可以查看 {name}。申请编辑权限后才能修改。",
    en: "You can view {name}. Ask for edit access to change it.",
  },
  readOnlyGeneratedBody: {
    zh: "你可以查看这次生成的乐谱。申请编辑权限后才能修改。",
    en: "You can view this generated score. Ask for edit access to change it.",
  },
  generatedNoPermissionBody: {
    zh: "申请这个 Space 的查看和编辑权限，才能打开这次生成的乐谱，并把改动留在它的草稿里。",
    en: "Ask for view and edit access to this Space to open this generated score and keep your edits in its draft.",
  },
  accessNotGiven: {
    zh: "没有获得权限。没有改动任何内容。准备好后再申请一次。",
    en: "Access was not given. Nothing was changed. Ask again when you are ready.",
  },
  askAccess: { zh: "申请权限", en: "Ask for access" },
  askEdit: { zh: "申请编辑权限", en: "Ask for edit access" },
  retry: { zh: "再试一次", en: "Try again" },
  close: { zh: "关闭", en: "Close" },
  saveAsFailed: {
    zh: "没能另存为乐谱文件。没有改动任何内容。再试一次。",
    en: "Couldn’t save a copy as a score file. Nothing was changed. Try again.",
  },
  noFileTitle: { zh: "打开乐谱文件", en: "Open a score file" },
  noFileBody: {
    zh: "在 Space 里打开一个 .abc 乐谱文件，它就会出现在这里。",
    en: "Open a .abc score file in a Space and it opens here.",
  },
  startupFailedTitle: { zh: "没有连接到 Cohub", en: "Couldn’t connect to Cohub" },
  startupFailedBody: { zh: "没有改动任何内容。再试一次。", en: "Nothing was changed. Try again." },
  noHostTitle: { zh: "在 Space 里打开这个 App", en: "Open this App from a Space" },
  noHostBody: {
    zh: "在 Space 里用这个 App 打开一份乐谱文件。",
    en: "Open a score file in a Space with this App.",
  },
  homeTitle: { zh: "乐谱", en: "Scores" },
  newScore: { zh: "新建乐谱", en: "New score" },
  creating: { zh: "正在新建…", en: "Creating…" },
  songs: { zh: "歌曲", en: "Songs" },
  scoreFiles: { zh: "乐谱文件", en: "Score files" },
  untitledSong: { zh: "未命名的歌曲", en: "Untitled song" },
  generatedCopyTag: { zh: "生成的副本", en: "Generated copy" },
  generatedCopyHint: {
    zh: "打开它来自的那首歌。保存时这份文件保持原样。",
    en: "Opens the song it came from. Saving leaves this file as it is.",
  },
  showMore: { zh: "显示更多", en: "Show more" },
  loading: { zh: "正在加载…", en: "Loading…" },
  lookingForSongs: { zh: "正在查找歌曲…", en: "Looking for songs…" },
  lookingForFiles: {
    zh: "正在查找这个 Space 里的乐谱文件…",
    en: "Looking through this Space’s files…",
  },
  songsFailed: { zh: "没能加载歌曲。", en: "Couldn’t load songs." },
  filesFailed: { zh: "没能加载乐谱文件。", en: "Couldn’t load score files." },
  homeFailed: { zh: "没能加载这个 Space 的乐谱。", en: "Couldn’t load this Space’s scores." },
  refreshFailed: {
    zh: "没能刷新。显示的是上次的内容。",
    en: "Couldn’t refresh. Showing what was here before.",
  },
  homeEmptyTitle: { zh: "还没有乐谱", en: "No scores yet" },
  homeEmptyBody: {
    zh: "这个 Space 里生成的歌曲和 .abc 乐谱文件会出现在这里。新建一份乐谱，自己写一首。",
    en: "Songs generated in this Space and .abc score files appear here. Start a new score to write one.",
  },
  homeEmptyReadOnly: {
    zh: "这个 Space 里生成的歌曲和 .abc 乐谱文件会出现在这里。在自己的 Space 里工作才能新建乐谱。",
    en: "Songs generated in this Space and .abc score files appear here. Work in one of your Spaces to start a score.",
  },
  unchanged: { zh: "没有改动任何内容。", en: "Nothing was changed." },
  songsNeedAccess: {
    zh: "查看这个 Space 的歌曲需要权限。",
    en: "Songs need access to this Space’s songs.",
  },
  filesNeedAccess: {
    zh: "查看这个 Space 的乐谱文件需要权限。",
    en: "Score files need access to this Space.",
  },
  homeAccessTitle: {
    zh: "需要权限才能浏览这个 Space",
    en: "Access needed to browse this Space",
  },
  homeAccessBody: {
    zh: "申请查看权限，才能看到这里的歌曲和乐谱文件。",
    en: "Ask for view access to see its songs and score files.",
  },
  viewOnly: {
    zh: "你可以浏览和打开乐谱。申请编辑权限后才能新建或保存。",
    en: "You can browse and open scores. Ask for edit access to start or save one.",
  },
  copyCheck: {
    zh: "正在核对这个文件是不是这里某首歌的生成稿…",
    en: "Checking this file against this Space’s songs…",
  },
  copying: { zh: "正在保存副本…", en: "Saving a copy…" },
  copyLoading: {
    zh: "歌曲还在加载，副本状态待定。",
    en: "Copy status pending while the songs load.",
  },
  copyUnknown: {
    zh: "歌曲没能加载，副本状态未知。",
    en: "Copy status unknown because the songs couldn’t load.",
  },
  copyCheckFailed: {
    zh: "没能核对这个文件。没有改动任何内容。再试一次。",
    en: "Couldn’t check this file. Nothing was changed. Try again.",
  },
  cancel: { zh: "取消", en: "Cancel" },
  copyUnchecked: {
    zh: "没有查看这个 Space 歌曲的权限，就认不出生成的副本。",
    en: "Generated copies can’t be recognized without access to this Space’s songs.",
  },
  newScoreFailed: {
    zh: "没能新建乐谱。没有改动任何内容。再试一次。",
    en: "Couldn’t create a new score. Nothing was changed. Try again.",
  },
  guardTitle: { zh: "保存 {name} 的修改吗？", en: "Save changes to {name}?" },
  guardBody: { zh: "你的修改还没有保存。", en: "Your changes aren’t saved yet." },
  saveAndHome: { zh: "保存并返回", en: "Save and go back" },
  discardAndHome: { zh: "放弃修改", en: "Discard changes" },
  keepEditing: { zh: "继续编辑", en: "Keep editing" },
  saving: { zh: "正在保存…", en: "Saving…" },
  guardSaveFailed: {
    zh: "没能保存 {name}。你的修改还在。再试一次。",
    en: "Couldn’t save {name}. Your changes are still here. Try again.",
  },
  backToScores: { zh: "返回乐谱", en: "Back to scores" },
  workInYourSpace: { zh: "在自己的 Space 里工作", en: "Work in one of your Spaces" },
  pickSpace: { zh: "选择其他 Space", en: "Pick another Space" },
  backToContext: { zh: "返回打开这个 App 的 Space", en: "Back to the Space you opened" },
  backToWorking: { zh: "返回 {space}", en: "Back to {space}" },
  viewingContext: { zh: "正在查看这个 Space", en: "Viewing this Space" },
  workingIn: { zh: "正在 {space} 里工作", en: "Working in {space}" },
  copyToWorking: { zh: "把副本另存到 {space}", en: "Save a copy to {space}" },
  copyToYourSpace: {
    zh: "把副本另存到自己选择的 Space",
    en: "Save a copy to one of your Spaces",
  },
  copyFailed: {
    zh: "没能另存副本。没有改动任何内容。再试一次。",
    en: "Couldn’t save a copy. Nothing was changed. Try again.",
  },
  pickDenied: {
    zh: "没有选择 Space。没有改动任何内容。",
    en: "No Space was picked. Nothing was changed.",
  },
  pickFailed: {
    zh: "没能选择 Space。没有改动任何内容。再试一次。",
    en: "Couldn’t pick a Space. Nothing was changed. Try again.",
  },
  askFailed: {
    zh: "没能申请权限。没有改动任何内容。再试一次。",
    en: "Couldn’t ask for access. Nothing was changed. Try again.",
  },
  otherSpace: { zh: "你的另一个 Space", en: "your other Space" },
  readOnlySpace: {
    zh: "这个 Space 只能查看。",
    en: "This Space is read-only.",
  },
  homeAuthReason: {
    zh: "浏览和编辑这个 Space 里的乐谱。",
    en: "Browse and edit scores in this Space.",
  },
  pickSpaceReason: {
    zh: "选择你自己的一个 Space，在里面编辑乐谱。",
    en: "Pick one of your Spaces to edit scores in it.",
  },
  handoffElsewhere: {
    zh: "已存到 {space} 的 {path}。输入框上的内容还留在这个窗口；打开 {space}，把乐谱交给那个 Space 的 agent。",
    en: "Saved in {space} at {path}. Your chip is still in this window; open {space} to hand it to that Space’s agent.",
  },
  handoffElsewhereFailed: {
    zh: "没能带你到 {space}。乐谱已存到 {path}，输入框上的内容还留在这个窗口；打开 {space} 再交接。",
    en: "Couldn’t take you to {space}. The score is saved at {path} and the chip is still in this window; open {space} to hand it off.",
  },
  /** A host without a composer: the handoff file the agent should read, in this Space. */
  handoffSaved: {
    zh: "已为 agent 存好：{path}。在聊天里让 agent 读这个文件，按里面的谱重新生成，想改的别的地方一起说。",
    en: "Saved for the agent at {path}. In the chat, ask the agent to read that file and sing the score it names. Add anything else you want changed.",
  },
  /** The same file in the working Space, which this window cannot hand to directly. */
  handoffSavedElsewhere: {
    zh: "已为 agent 存到 {space}：{path}。打开 {space}，在它的聊天里让 agent 读这个文件，按里面的谱重新生成。",
    en: "Saved for the agent in {space} at {path}. Open {space}, and in its chat ask the agent to read that file and sing the score it names.",
  },
  /** The first line of the composer chip: the `.abc` the agent should read. */
  chipPath: { zh: "Space 里的乐谱文件：`{path}`", en: "Score file in this Space: `{path}`" },
  chipPathInSpace: { zh: "{space} 里的乐谱文件：`{path}`", en: "Score file in {space}: `{path}`" },
  handoffReady: {
    zh: "已放到聊天输入框。留在乐谱编辑器窗口里写一句要求，然后发送。切到别的窗口，输入框上的内容就不在了。",
    en: "It’s in the chat box. Stay in the score editor window, write what you want the agent to do, then send. The chip is gone if you switch windows.",
  },
  handoffBlocked: { zh: "没有交接：{reason}", en: "Not sent: {reason}" },
  handoffLyrics: { zh: "歌词", en: "Lyrics" },
  handoffLine: { zh: "第 {line} 行读不出来。", en: "The score cannot be read at line {line}." },
  handoffUnreadable: {
    zh: "没有交接：这份乐谱读不出来。先在文本视图里改好，再试一次。",
    en: "Not sent: this score can’t be read. Fix it in the text view, then try again.",
  },
  handoffTooLong: {
    zh: "没有交接：这份乐谱太长，不能作为文字交给 agent。把乐谱改短一些，再试一次。",
    en: "Not sent: this score is too long to hand off as text. Shorten it, then try again.",
  },
  handoffFailed: {
    zh: "没有交接：这次交接没有完成。没有改动任何内容。再试一次。",
    en: "Not sent: the handoff didn’t go through. Nothing was changed. Try again.",
  },
} as const;

export type FrameCopy = { readonly [K in keyof typeof FRAME_COPY]: string };

/** `zh*` is Chinese, everything else English — the host's locale is a language tag, not a list. */
export function languageFor(locale: string | null | undefined): Language {
  return typeof locale === "string" && locale.trim().toLowerCase().startsWith("zh") ? "zh" : "en";
}

/** One language at a time, flattened for the renderer. */
export function frameCopy(language: Language): FrameCopy {
  const copy = {} as Record<keyof typeof FRAME_COPY, string>;
  for (const key of Object.keys(FRAME_COPY) as Array<keyof typeof FRAME_COPY>) {
    copy[key] = FRAME_COPY[key][language];
  }
  return copy as FrameCopy;
}

export function fillCopy(template: string, values: Readonly<Record<string, string>>): string {
  let text = template;
  for (const [key, value] of Object.entries(values)) text = text.replaceAll(`{${key}}`, () => value);
  return text;
}
