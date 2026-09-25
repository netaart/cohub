import type {
	SpaceFsEntry,
	SpaceFsFileResponse,
	SpacePendingDiffFileResponse,
} from "@neta-art/cohub";
import { HttpError } from "@neta-art/cohub";

import { ensureBoardExtension } from "$lib/board/board-file";
import {
	deleteFilePendingDraft,
	readFilePendingDraft,
	writeFilePendingDraft,
} from "$lib/cache/repositories/file-pending-draft-repo";
import {
	defaultFileViewMode,
	type FileViewMode,
} from "$lib/components/file-diff-view";
import { filePreviewModel } from "$lib/file-preview-model";
import { sdk } from "$lib/sdk";
import {
	isTextFileResponse,
	tryResolveTextFileResponse,
} from "$lib/space-file-text";
import type { SpaceFsNode } from "$lib/space-fs";

import {
	clearCachedSpaceFsSubtree,
	fetchSpaceFsDirWithCache,
	getCachedSpaceFsDir,
	patchCachedSpaceFsDir,
} from "$lib/stores/space-fs-cache";
import type { WorkspaceFilePosition } from "$lib/workspace-file-links";
import { type ActiveFsSource, createActiveFsClient } from "./active-fs-client";
import { createFileAutosaveCoordinator } from "./file-autosave-coordinator";
import {
	buildFsEntry,
	classifySaveConflict,
	getParentDirPath,
	hasSameFileVersion,
	makeFsNodes,
	replaceNodeChildren,
	resolveFsMoveDestination,
	rewriteFsPathPrefix,
	updateNodeState,
} from "./file-workspace-utils";
import type { WindowSyncStatus } from "./window-sync-status";
import { workspaceFilePreviewKind } from "./windows";

export type { ActiveFsSource, FileViewMode };

type FileDiffState = {
	path: string | null;
	patch: SpacePendingDiffFileResponse | null;
	loading: boolean;
	error: string | null;
	requestToken: number;
};

export type FileWorkspaceInlineFile = {
	response: SpaceFsFileResponse | null;
	draft: string;
	path: string;
	position: WorkspaceFilePosition | null;
	loading: boolean;
	saving: boolean;
	syncStatus: WindowSyncStatus;
	saveError: string | null;
	error: string | null;
	tooLarge: boolean;
	viewMode: FileViewMode;
	zoom: number;
	panX: number;
	panY: number;
	dragging: boolean;
	copied: boolean;
	backStack: string[];
	requestToken: number;
};

type FileWorkspaceControllerOptions = {
	getSpaceId: () => string;
	getActiveFsSource: () => ActiveFsSource;
	getActiveFsSourceKey: () => string;
	getCanEditFiles: () => boolean;
	getActiveFsReadonly: () => boolean;
	getSpaceHasMinimalAccess: () => boolean;
	onOpenInlineFile: (path: string) => Promise<void>;
	onOpenInlineBoard: (path: string) => Promise<void>;
	onCloseInlineBoard: () => void;
	onRenameInlineBoard?: (fromPath: string, toPath: string) => void;
	onOpenInlinePort: (
		port: string,
		url: string,
		options?: { autoOpened?: boolean },
	) => void;
	onCloseInlinePort: () => void;
	onActivateFilePreview?: () => void;
	/** A tab actually went away (deferred autosave close, external delete). */
	onInlineFileClosed?: (path: string) => void;
	onClosePreviewFocusMode: () => void;
	onEnsurePreviewPanelFits: () => void;
};

export function createFileWorkspaceController(
	options: FileWorkspaceControllerOptions,
) {
	let fileTree = $state<SpaceFsNode[]>([]);
	let fileTreeBySource = $state<Record<string, SpaceFsNode[]>>({});
	let fileTreeSourceKey = $state("live");
	let fileTreeLoading = $state(false);
	let fileTreeError = $state<string | null>(null);
	let fileTreeRequestToken = $state(0);
	let directoryLoadTokenByPath = $state<Record<string, number>>({});
	let inlineFileTabs = $state<FileWorkspaceInlineFile[]>([]);
	let activeInlineFilePath = $state<string | null>(null);
	let inlineFileRequestToken = $state(0);
	let inlineFileDiff = $state<FileDiffState>({
		path: null,
		patch: null,
		loading: false,
		error: null,
		requestToken: 0,
	});
	let inlineFileCopiedTimer: ReturnType<typeof setTimeout> | null = null;
	let uploadPaneVisible = $state(false);
	let uploadPaneTargetDir = $state("");
	let pendingUploadFiles = $state<File[]>([]);
	let pendingUploadEntries = $state<{ file: File; relativePath: string }[]>([]);
	let pendingFileSavePaths = $state<Set<string>>(new Set());
	const pendingSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
	// Reuse the same mutationId across autosave retries of one logical save so
	// the backend can dedupe on the job id instead of re-issuing the mutation.
	const pendingSaveMutationIds = new Map<string, string>();
	const ownFileMutationIds = new Set<string>();
	const fileSaveRetryAttempts = new Map<string, number>();
	const inlineFileRefreshTokens = new Map<string, number>();
	const inlineFileRefreshTimers = new Map<
		string,
		ReturnType<typeof setTimeout>
	>();
	const pendingDraftPersistTimers = new Map<
		string,
		ReturnType<typeof setTimeout>
	>();
	const pendingDraftTails = new Map<string, Promise<void>>();
	const forcedOverwritePaths = new Set<string>();
	const deletingPaths = new Set<string>();
	let workspaceSpaceId = options.getSpaceId();
	let workspaceGeneration = 0;
	type WorkspaceContext = { spaceId: string; generation: number };
	const getWorkspaceContext = (): WorkspaceContext => ({
		spaceId: workspaceSpaceId,
		generation: workspaceGeneration,
	});
	const isCurrentWorkspaceContext = (context: WorkspaceContext) =>
		context.spaceId === workspaceSpaceId &&
		context.generation === workspaceGeneration;
	const fileAutosave = createFileAutosaveCoordinator({
		save: (path) => saveInlineFilePath(path),
	});

	const getActiveInlineFile = () =>
		inlineFileTabs.find((tab) => tab.path === activeInlineFilePath) ?? null;

	function setInlineFileTab(
		path: string,
		updater: (tab: FileWorkspaceInlineFile) => FileWorkspaceInlineFile,
	) {
		inlineFileTabs = inlineFileTabs.map((tab) =>
			tab.path === path ? updater(tab) : tab,
		);
	}

	function makeInlineFileTab(
		path: string,
		position: WorkspaceFilePosition | null,
		requestToken: number,
		backStack: string[] = [],
	): FileWorkspaceInlineFile {
		return {
			response: null,
			draft: "",
			path,
			position,
			loading: true,
			saving: false,
			syncStatus: "idle",
			saveError: null,
			error: null,
			tooLarge: false,
			viewMode: "source",
			zoom: 1,
			panX: 0,
			panY: 0,
			dragging: false,
			copied: false,
			backStack,
			requestToken,
		};
	}

	function isLocalUploadEntries(
		value: File[] | { file: File; relativePath: string }[],
	): value is { file: File; relativePath: string }[] {
		return value.length > 0 && "file" in value[0] && "relativePath" in value[0];
	}

	function isOwnPendingFileSave(
		path: string | undefined,
		source?: string,
		kind?: string,
		mutationId?: string,
	) {
		if (mutationId) return ownFileMutationIds.has(mutationId);
		if (!path || !pendingFileSavePaths.has(path)) return false;
		// While a file is being saved, its change echo must not be treated as an
		// external edit: direct PVC writes arrive as api-fs, sandbox mutations
		// arrive as sandbox-watch (no mutationId) from the sandbox watcher.
		if (source === "api-fs") return kind === "modify";
		if (source === "sandbox-watch")
			return kind === "modify" || kind === "create";
		return false;
	}

	function markFileSavePending(path: string) {
		// A new save for the same path extends the window: cancel any pending
		// cleanup so an earlier save's timer cannot clear a newer save's marker.
		const existing = pendingSaveTimers.get(path);
		if (existing) clearTimeout(existing);
		pendingSaveTimers.delete(path);
		pendingFileSavePaths = new Set(pendingFileSavePaths).add(path);
	}

	function clearFileSavePendingSoon(path: string) {
		const existing = pendingSaveTimers.get(path);
		if (existing) clearTimeout(existing);
		pendingSaveTimers.set(
			path,
			setTimeout(() => {
				pendingSaveTimers.delete(path);
				const next = new Set(pendingFileSavePaths);
				next.delete(path);
				pendingFileSavePaths = next;
			}, 3000),
		);
	}

	function queuePendingDraftTask(
		context: WorkspaceContext,
		path: string,
		task: () => Promise<void>,
	) {
		const key = `${context.spaceId}\0${path}`;
		const previous = pendingDraftTails.get(key) ?? Promise.resolve();
		const next = previous
			.catch(() => undefined)
			.then(task)
			.catch((error) => {
				console.warn("[files] Failed to persist pending draft", {
					spaceId: context.spaceId,
					path,
					error,
				});
			});
		pendingDraftTails.set(key, next);
		void next.finally(() => {
			if (pendingDraftTails.get(key) === next) pendingDraftTails.delete(key);
		});
		return next;
	}

	function persistPendingDraft(
		path: string,
		mutationId: string = crypto.randomUUID(),
		context = getWorkspaceContext(),
	) {
		const tab = inlineFileTabs.find((item) => item.path === path);
		if (!tab?.response || !isTextFileResponse(tab.response))
			return Promise.resolve();
		const input = {
			spaceId: context.spaceId,
			path,
			draft: tab.draft,
			baseContent: tab.response.content,
			baseMtimeMs: tab.response.mtimeMs,
			baseSize: tab.response.size,
			mutationId,
		};
		return queuePendingDraftTask(context, path, async () => {
			await writeFilePendingDraft(input);
		});
	}

	function schedulePendingDraftPersist(path: string) {
		const existing = pendingDraftPersistTimers.get(path);
		if (existing) clearTimeout(existing);
		const context = getWorkspaceContext();
		pendingDraftPersistTimers.set(
			path,
			setTimeout(() => {
				pendingDraftPersistTimers.delete(path);
				void persistPendingDraft(path, crypto.randomUUID(), context);
			}, 200),
		);
	}

	function clearPendingDraft(path: string, context = getWorkspaceContext()) {
		const timer = pendingDraftPersistTimers.get(path);
		if (timer) clearTimeout(timer);
		pendingDraftPersistTimers.delete(path);
		return queuePendingDraftTask(context, path, async () => {
			await deleteFilePendingDraft(context.spaceId, path);
		});
	}

	async function persistInlineFileDrafts() {
		const context = getWorkspaceContext();
		await Promise.all(
			inlineFileTabs
				.filter(
					(tab) =>
						tab.response &&
						isTextFileResponse(tab.response) &&
						tab.draft !== tab.response.content,
				)
				.map((tab) =>
					persistPendingDraft(tab.path, crypto.randomUUID(), context),
				),
		);
	}

	async function restorePendingDraft(
		path: string,
		requestToken: number,
		file: SpaceFsFileResponse,
		context: WorkspaceContext,
	) {
		if (!isTextFileResponse(file) || options.getActiveFsReadonly()) return;
		const pending = await readFilePendingDraft(context.spaceId, path);
		const tab = inlineFileTabs.find((item) => item.path === path);
		if (
			!pending ||
			!tab ||
			tab.requestToken !== requestToken ||
			!isCurrentWorkspaceContext(context)
		)
			return;
		if (pending.draft === file.content) {
			await clearPendingDraft(path, context);
			return;
		}
		const baselineMatches = pending.baseContent === file.content;
		setInlineFileTab(path, (item) => ({
			...item,
			draft: pending.draft,
			syncStatus: baselineMatches ? "dirty" : "conflict",
			saveError: baselineMatches ? null : "Changed elsewhere",
		}));
		if (baselineMatches) {
			// Reuse the persisted mutationId so a retry after reload dedupes on
			// the same job id instead of issuing a second mutation.
			pendingSaveMutationIds.set(path, pending.mutationId);
			fileAutosave.schedule(path);
		}
	}

	function updateInlineFileDraft(path: string, draft: string) {
		if (options.getActiveFsReadonly() || !options.getCanEditFiles()) return;
		fileSaveRetryAttempts.delete(path);
		const tab = inlineFileTabs.find((item) => item.path === path);
		if (!tab?.response || !isTextFileResponse(tab.response)) return;
		const clean = draft === tab.response.content;
		setInlineFileTab(path, (item) => ({
			...item,
			draft,
			syncStatus:
				item.syncStatus === "conflict" ? "conflict" : clean ? "idle" : "dirty",
			saveError: item.syncStatus === "conflict" ? item.saveError : null,
		}));
		if (clean) {
			fileAutosave.cancel(path);
			void clearPendingDraft(path);
			return;
		}
		schedulePendingDraftPersist(path);
		if (tab.syncStatus !== "conflict") fileAutosave.schedule(path);
	}

	function setActiveFileTree(nodes: SpaceFsNode[]) {
		fileTree = nodes;
		fileTreeBySource = {
			...fileTreeBySource,
			[options.getActiveFsSourceKey()]: nodes,
		};
	}

	function updateRootFsEntries(entries: SpaceFsEntry[]) {
		setActiveFileTree(makeFsNodes(entries, fileTree));
	}

	function hasDirtyInlineFiles() {
		return inlineFileTabs.some(
			(tab) =>
				tab.response &&
				isTextFileResponse(tab.response) &&
				tab.draft !== tab.response.content,
		);
	}

	function clearInlinePreviews(context = getWorkspaceContext()) {
		inlineFileRequestToken += 1;
		for (const tab of inlineFileTabs) {
			const timer = pendingDraftPersistTimers.get(tab.path);
			if (timer) clearTimeout(timer);
			pendingDraftPersistTimers.delete(tab.path);
			if (
				tab.response &&
				isTextFileResponse(tab.response) &&
				tab.draft !== tab.response.content
			) {
				void persistPendingDraft(tab.path, crypto.randomUUID(), context);
			}
			fileAutosave.cancel(tab.path);
			fileSaveRetryAttempts.delete(tab.path);
			forcedOverwritePaths.delete(tab.path);
		}
		inlineFileTabs = [];
		clearInlineFileRefreshes();
		activeInlineFilePath = null;
		clearFileDiff();
	}

	/**
	 * Switch FS source. Returns false if blocked by dirty drafts.
	 * When force=true, discards drafts without confirm.
	 */
	function switchSource(
		sourceKey: string,
		optionsArg: { force?: boolean } = {},
	): boolean {
		if (fileTreeSourceKey === sourceKey) return true;
		if (!optionsArg.force && hasDirtyInlineFiles()) {
			const ok = confirm(
				"Discard unsaved file changes before switching files source?",
			);
			if (!ok) return false;
		}
		const previousContext = getWorkspaceContext();
		workspaceGeneration += 1;
		fileTreeBySource = { ...fileTreeBySource, [fileTreeSourceKey]: fileTree };
		fileTreeSourceKey = sourceKey;
		fileTree = fileTreeBySource[sourceKey] ?? [];
		directoryLoadTokenByPath = {};
		fileTreeError = null;
		fileTreeLoading = false;
		fileTreeRequestToken += 1;
		clearInlinePreviews(previousContext);
		void loadFileTree(false);
		return true;
	}

	function clearFileDiff() {
		inlineFileDiff = {
			path: null,
			patch: null,
			loading: false,
			error: null,
			requestToken: inlineFileDiff.requestToken + 1,
		};
	}

	function invalidateFileDiff(path?: string | null) {
		if (!path || inlineFileDiff.path === path) clearFileDiff();
	}

	/** Reset space-scoped FS state. Returns false if blocked by dirty drafts. */
	function resetForSpace(
		nextSpaceId: string,
		optionsArg: { force?: boolean } = {},
	): boolean {
		if (!optionsArg.force && hasDirtyInlineFiles()) {
			const ok = confirm(
				"Discard unsaved file changes before leaving this space?",
			);
			if (!ok) return false;
		}
		const previousContext = getWorkspaceContext();
		workspaceGeneration += 1;
		workspaceSpaceId = nextSpaceId;
		fileTree = [];
		fileTreeBySource = {};
		fileTreeSourceKey = "live";
		fileTreeLoading = false;
		fileTreeError = null;
		directoryLoadTokenByPath = {};
		fileTreeRequestToken += 1;
		clearInlinePreviews(previousContext);
		uploadPaneVisible = false;
		pendingUploadFiles = [];
		pendingUploadEntries = [];
		for (const timer of pendingSaveTimers.values()) clearTimeout(timer);
		pendingSaveTimers.clear();
		pendingSaveMutationIds.clear();
		clearInlineFileRefreshes();
		pendingFileSavePaths = new Set();
		return true;
	}

	function markInlineFileExternalChange(path?: string) {
		const targetPath = path ?? activeInlineFilePath;
		if (!targetPath) return;
		fileAutosave.cancel(targetPath);
		setInlineFileTab(targetPath, (tab) => ({
			...tab,
			saving: false,
			syncStatus: "conflict",
			saveError: "Changed elsewhere",
		}));
		invalidateFileDiff(targetPath);
		const activeTab = getActiveInlineFile();
		if (activeTab?.path === targetPath && activeTab.viewMode === "diff") {
			void ensureInlineFileDiff(true);
		}
	}

	function cancelInlineFileRefresh(path: string) {
		const timer = inlineFileRefreshTimers.get(path);
		if (timer) clearTimeout(timer);
		inlineFileRefreshTimers.delete(path);
		inlineFileRefreshTokens.delete(path);
	}

	function clearInlineFileRefreshes() {
		for (const timer of inlineFileRefreshTimers.values()) clearTimeout(timer);
		inlineFileRefreshTimers.clear();
		inlineFileRefreshTokens.clear();
	}

	function scheduleInlineFileRefresh(
		path: string,
		retryAfterMs: number,
		prepareAttempt: number,
	) {
		const existing = inlineFileRefreshTimers.get(path);
		if (existing) clearTimeout(existing);
		inlineFileRefreshTimers.set(
			path,
			setTimeout(
				() => {
					inlineFileRefreshTimers.delete(path);
					void refreshInlineFile(path, prepareAttempt);
				},
				Math.max(500, Math.min(retryAfterMs, 10_000)),
			),
		);
	}

	async function refreshInlineFile(path: string, prepareAttempt = 0) {
		const scheduled = inlineFileRefreshTimers.get(path);
		if (scheduled) clearTimeout(scheduled);
		inlineFileRefreshTimers.delete(path);
		const initial = inlineFileTabs.find((tab) => tab.path === path);
		if (!initial?.response) return;
		if (isInlineFileDirty(path)) {
			markInlineFileExternalChange(path);
			return;
		}

		const context = getWorkspaceContext();
		const sourceKey = options.getActiveFsSourceKey();
		const requestToken = initial.requestToken;
		const baseline = initial.response;
		const refreshToken = (inlineFileRefreshTokens.get(path) ?? 0) + 1;
		inlineFileRefreshTokens.set(path, refreshToken);

		try {
			const rawFile = await readActiveFsFile(path);
			const current = inlineFileTabs.find((tab) => tab.path === path);
			if (
				!current?.response ||
				current.requestToken !== requestToken ||
				inlineFileRefreshTokens.get(path) !== refreshToken ||
				!isCurrentWorkspaceContext(context) ||
				options.getActiveFsSourceKey() !== sourceKey
			)
				return;
			if (isInlineFileDirty(path)) {
				markInlineFileExternalChange(path);
				return;
			}
			if (!("content" in rawFile)) {
				const retrying = prepareAttempt < 4;
				setInlineFileTab(path, (tab) => ({
					...tab,
					error: retrying
						? "File is being prepared. Retrying..."
						: "File is still being prepared. Retry to refresh.",
				}));
				if (retrying)
					scheduleInlineFileRefresh(
						path,
						rawFile.retryAfterMs,
						prepareAttempt + 1,
					);
				return;
			}

			const { file, error } = await tryResolveTextFileResponse(rawFile);
			const latest = inlineFileTabs.find((tab) => tab.path === path);
			if (
				!latest?.response ||
				latest.requestToken !== requestToken ||
				inlineFileRefreshTokens.get(path) !== refreshToken ||
				!isCurrentWorkspaceContext(context) ||
				options.getActiveFsSourceKey() !== sourceKey
			)
				return;
			if (isInlineFileDirty(path)) {
				markInlineFileExternalChange(path);
				return;
			}
			if (
				!hasSameFileVersion(latest.response, baseline) &&
				!hasSameFileVersion(latest.response, file)
			)
				return;
			if (error) {
				setInlineFileTab(path, (tab) => ({ ...tab, error }));
				return;
			}
			setInlineFileTab(path, (tab) => ({
				...tab,
				response: file,
				draft: isTextFileResponse(file) ? file.content : "",
				saving: false,
				syncStatus: "idle",
				saveError: null,
				error: null,
				tooLarge: false,
			}));
			invalidateFileDiff(path);
		} catch (error) {
			if (
				inlineFileRefreshTokens.get(path) !== refreshToken ||
				!isCurrentWorkspaceContext(context)
			)
				return;
			setInlineFileTab(path, (tab) => ({
				...tab,
				error:
					error instanceof Error ? error.message : "Failed to refresh file",
			}));
		} finally {
			if (inlineFileRefreshTokens.get(path) === refreshToken)
				inlineFileRefreshTokens.delete(path);
		}
	}

	async function patchFsDirectory(
		dirPath: string,
		updater: (entries: SpaceFsEntry[]) => SpaceFsEntry[],
		context = getWorkspaceContext(),
	) {
		let nextEntries = await patchCachedSpaceFsDir(
			context.spaceId,
			dirPath,
			updater,
		);
		if (!isCurrentWorkspaceContext(context)) return nextEntries;
		if (!nextEntries) {
			try {
				nextEntries = await fetchSpaceFsDirWithCache(
					context.spaceId,
					dirPath,
					async () =>
						(await sdk.space(context.spaceId).files.list(dirPath)).entries,
					{ force: true },
				);
			} catch {
				return null;
			}
		}
		if (!isCurrentWorkspaceContext(context)) return nextEntries;
		if (dirPath === "") {
			updateRootFsEntries(nextEntries);
			return nextEntries;
		}
		setActiveFileTree(
			replaceNodeChildren(fileTree, dirPath, makeFsNodes(nextEntries)),
		);
		return nextEntries;
	}

	function getActiveFsClient() {
		return createActiveFsClient({
			spaceId: options.getSpaceId(),
			source: options.getActiveFsSource(),
		});
	}

	function listActiveFsDir(path: string) {
		return getActiveFsClient().list(path);
	}

	function readActiveFsFile(path: string, signal?: AbortSignal) {
		return getActiveFsClient().read(path, signal);
	}

	async function loadFileTree(force = false) {
		const source = options.getActiveFsSource();
		const sourceKey = options.getActiveFsSourceKey();
		const spaceId = options.getSpaceId();
		if (fileTreeLoading && !force) return;
		const requestToken = fileTreeRequestToken + 1;
		fileTreeRequestToken = requestToken;
		if (options.getSpaceHasMinimalAccess()) {
			setActiveFileTree([]);
			fileTreeLoading = false;
			fileTreeError = "Files are not available for this shared session.";
			return;
		}
		if (!force) {
			if (source.kind === "live") {
				const cached = await getCachedSpaceFsDir(spaceId, "");
				if (
					requestToken !== fileTreeRequestToken ||
					sourceKey !== options.getActiveFsSourceKey()
				)
					return;
				if (cached && cached.length > 0)
					setActiveFileTree(makeFsNodes(cached, fileTree));
			} else {
				const cached = fileTreeBySource[sourceKey];
				if (cached) setActiveFileTree(cached);
			}
		}
		const shouldShowLoading = fileTree.length === 0 || force;
		if (shouldShowLoading) fileTreeLoading = true;
		fileTreeError = null;
		try {
			const client = createActiveFsClient({ spaceId, source });
			const entries =
				source.kind === "live"
					? await fetchSpaceFsDirWithCache(
							spaceId,
							"",
							async () => (await client.list("")).entries,
							{ force: true },
						)
					: (await client.list("")).entries;
			if (
				requestToken !== fileTreeRequestToken ||
				sourceKey !== options.getActiveFsSourceKey()
			)
				return;
			setActiveFileTree(makeFsNodes(entries, fileTree));
		} catch (error) {
			if (
				requestToken !== fileTreeRequestToken ||
				sourceKey !== options.getActiveFsSourceKey()
			)
				return;
			fileTreeError =
				error instanceof Error ? error.message : "Failed to load files";
		} finally {
			if (
				requestToken === fileTreeRequestToken &&
				sourceKey === options.getActiveFsSourceKey()
			)
				fileTreeLoading = false;
		}
	}

	async function expandDirectory(node: SpaceFsNode) {
		if (node.type !== "dir") return;
		if (node.isOpen) {
			directoryLoadTokenByPath = {
				...directoryLoadTokenByPath,
				[node.path]: (directoryLoadTokenByPath[node.path] ?? 0) + 1,
			};
			setActiveFileTree(
				updateNodeState(fileTree, node.path, (item) => ({
					...item,
					isOpen: false,
					isLoading: false,
				})),
			);
			return;
		}
		const requestToken = (directoryLoadTokenByPath[node.path] ?? 0) + 1;
		directoryLoadTokenByPath = {
			...directoryLoadTokenByPath,
			[node.path]: requestToken,
		};
		const source = options.getActiveFsSource();
		const sourceKey = options.getActiveFsSourceKey();
		const hasExistingChildren = node.children.length > 0;
		const cached =
			source.kind === "live"
				? await getCachedSpaceFsDir(options.getSpaceId(), node.path)
				: null;
		if (directoryLoadTokenByPath[node.path] !== requestToken) return;
		if (cached) {
			setActiveFileTree(
				replaceNodeChildren(fileTree, node.path, makeFsNodes(cached)),
			);
		} else {
			setActiveFileTree(
				updateNodeState(fileTree, node.path, (item) => ({
					...item,
					isLoading: !hasExistingChildren,
					isOpen: true,
				})),
			);
		}
		try {
			const requestSpaceId = options.getSpaceId();
			const client = createActiveFsClient({
				spaceId: requestSpaceId,
				source,
			});
			const entries =
				source.kind === "live"
					? await fetchSpaceFsDirWithCache(
							requestSpaceId,
							node.path,
							async () => (await client.list(node.path)).entries,
							{ force: true },
						)
					: (await client.list(node.path)).entries;
			if (
				directoryLoadTokenByPath[node.path] !== requestToken ||
				sourceKey !== options.getActiveFsSourceKey()
			)
				return;
			setActiveFileTree(
				replaceNodeChildren(fileTree, node.path, makeFsNodes(entries)),
			);
		} catch (error) {
			if (directoryLoadTokenByPath[node.path] !== requestToken) return;
			setActiveFileTree(
				updateNodeState(fileTree, node.path, (item) => ({
					...item,
					isLoading: false,
				})),
			);
			fileTreeError =
				error instanceof Error ? error.message : "Failed to load directory";
		}
	}

	function refreshFileTree() {
		return loadFileTree(true);
	}

	async function revealPath(path: string) {
		const segments = path.split("/").filter(Boolean);
		let dirPath = "";
		for (const segment of segments.slice(0, -1)) {
			dirPath = dirPath ? `${dirPath}/${segment}` : segment;
			const node = findFsNode(dirPath);
			if (node?.type !== "dir") return;
			if (!node.isOpen) await expandDirectory(node);
		}
	}

	/** Open a file in the unified preview surface (Files column). */
	async function openSpaceFile(path: string) {
		if (
			workspaceFilePreviewKind(path, options.getActiveFsReadonly()) === "board"
		) {
			await options.onOpenInlineBoard(path);
			return;
		}
		await options.onOpenInlineFile(path);
	}

	async function downloadActiveFsFile(
		path: string,
		knownFile: SpaceFsFileResponse | null | undefined,
	) {
		await getActiveFsClient().download(path, knownFile);
	}

	async function downloadInlineFile() {
		const inlineFile = getActiveInlineFile();
		if (!inlineFile) return;
		try {
			await downloadActiveFsFile(inlineFile.path, inlineFile.response);
		} catch (error) {
			setInlineFileTab(inlineFile.path, (tab) => ({
				...tab,
				error:
					error instanceof Error ? error.message : "Failed to download file",
			}));
		}
	}

	async function openInlineFile(
		path: string,
		optionsArg: {
			preserveHistory?: boolean;
			skipHistoryPush?: boolean;
			position?: WorkspaceFilePosition | null;
			activate?: boolean;
			forceReload?: boolean;
		} = {},
	) {
		const existingTab = inlineFileTabs.find((tab) => tab.path === path);
		const currentTab = getActiveInlineFile();
		const nextBackStack =
			optionsArg.preserveHistory &&
			!optionsArg.skipHistoryPush &&
			currentTab?.path &&
			currentTab.path !== path
				? [...(existingTab?.backStack ?? []), currentTab.path]
				: optionsArg.preserveHistory
					? (existingTab?.backStack ?? [])
					: [];
		const sourceKey = options.getActiveFsSourceKey();
		const context = getWorkspaceContext();
		const requestToken = inlineFileRequestToken + 1;
		inlineFileRequestToken = requestToken;
		const shouldActivate = optionsArg.activate ?? true;
		if (shouldActivate) {
			activeInlineFilePath = path;
			// Keep focus/immersive layout when switching tabs; only re-fit width.
			options.onEnsurePreviewPanelFits();
			options.onActivateFilePreview?.();
		}
		if (existingTab) {
			// Re-fetch when forced, errored, or content was never loaded.
			const needsReload =
				optionsArg.forceReload ||
				Boolean(existingTab.error) ||
				!existingTab.response;
			setInlineFileTab(path, (tab) => ({
				...tab,
				position: optionsArg.position ?? tab.position,
				loading: needsReload,
				error: needsReload ? null : tab.error,
				tooLarge: false,
				requestToken,
				backStack: nextBackStack,
			}));
			if (!needsReload) {
				if (shouldActivate && existingTab.viewMode === "diff") {
					void ensureInlineFileDiff();
				} else if (shouldActivate && inlineFileDiff.path !== path) {
					clearFileDiff();
				}
				return;
			}
		} else {
			inlineFileTabs = [
				...inlineFileTabs,
				makeInlineFileTab(
					path,
					optionsArg.position ?? null,
					requestToken,
					nextBackStack,
				),
			];
		}
		try {
			const rawFile = await readActiveFsFile(path);
			const targetTab = inlineFileTabs.find((tab) => tab.path === path);
			if (
				!targetTab ||
				targetTab.requestToken !== requestToken ||
				sourceKey !== options.getActiveFsSourceKey()
			)
				return;
			if (!("content" in rawFile)) {
				// Preparing: keep meta so the panel can offer Download + Retry.
				setInlineFileTab(path, (tab) => ({
					...tab,
					response: {
						path: rawFile.path,
						name: rawFile.name,
						size: rawFile.size,
						mimeType: rawFile.mimeType,
						mtimeMs: rawFile.mtimeMs,
						kind: "binary",
						encoding: "base64",
						content: "",
					},
					draft: "",
					loading: false,
					error: "File is being prepared. Retry in a moment.",
					tooLarge: false,
				}));
				return;
			}
			const { file, error: hydrateError } =
				await tryResolveTextFileResponse(rawFile);
			const hydratedTab = inlineFileTabs.find((tab) => tab.path === path);
			if (
				!hydratedTab ||
				hydratedTab.requestToken !== requestToken ||
				sourceKey !== options.getActiveFsSourceKey()
			)
				return;
			const isText = isTextFileResponse(file);
			// Content ready when text and either inline body present or no hydrate error.
			const textReady = isText && !hydrateError;
			setInlineFileTab(path, (tab) => ({
				...tab,
				response: file,
				draft: textReady ? file.content : "",
				loading: false,
				saving: false,
				syncStatus: "idle",
				saveError: null,
				// Soft-fail: keep response so Download still works.
				error: hydrateError,
				tooLarge: false,
				viewMode: defaultFileViewMode(
					textReady && filePreviewModel(file).hasRenderedPreview,
				),
			}));
			if (textReady)
				await restorePendingDraft(path, requestToken, file, context);
			if (activeInlineFilePath === path) clearFileDiff();
		} catch (error) {
			const targetTab = inlineFileTabs.find((tab) => tab.path === path);
			if (
				!targetTab ||
				targetTab.requestToken !== requestToken ||
				sourceKey !== options.getActiveFsSourceKey()
			)
				return;
			if (error instanceof HttpError && error.status === 413) {
				setInlineFileTab(path, (tab) => ({
					...tab,
					// Keep a minimal response so Download remains available.
					response: tab.response ?? {
						path,
						name: path.split("/").pop() ?? path,
						size: 0,
						mimeType: null,
						mtimeMs: Date.now(),
						kind: "binary",
						encoding: "base64",
						content: "",
					},
					draft: "",
					loading: false,
					error: null,
					tooLarge: true,
				}));
			} else {
				setInlineFileTab(path, (tab) => ({
					...tab,
					// Preserve prior response when reloading fails.
					response: tab.response,
					draft: tab.draft,
					loading: false,
					error: error instanceof Error ? error.message : "Failed to open file",
					tooLarge: false,
				}));
			}
		}
	}

	function closeInlineFile(path = activeInlineFilePath, skipConfirm = false) {
		if (!path) return;
		const tab = inlineFileTabs.find((item) => item.path === path);
		const dirty = Boolean(
			tab?.response &&
				isTextFileResponse(tab.response) &&
				tab.draft !== tab.response.content,
		);
		if (dirty && !skipConfirm) {
			if (tab?.syncStatus === "error" || tab?.syncStatus === "conflict") {
				if (!confirm(`Close ${path} with unsynced changes?`)) return;
			} else {
				// Never drop unsaved work: flush first, then close on the same path so
				// the deferred close still reports itself to the coordinator.
				void fileAutosave.flush(path).then(() => {
					if (!isInlineFileDirty(path)) closeInlineFile(path, true);
				});
				return;
			}
		}
		if (dirty) void persistPendingDraft(path);
		fileAutosave.cancel(path);
		cancelInlineFileRefresh(path);
		inlineFileRequestToken += 1;
		const closingActive = activeInlineFilePath === path;
		const index = inlineFileTabs.findIndex((item) => item.path === path);
		const nextTabs = inlineFileTabs.filter((item) => item.path !== path);
		inlineFileTabs = nextTabs;
		if (closingActive)
			activeInlineFilePath =
				nextTabs[Math.max(0, index - 1)]?.path ?? nextTabs[0]?.path ?? null;
		if (nextTabs.length === 0) options.onClosePreviewFocusMode();
		options.onInlineFileClosed?.(path);
	}

	async function goBackInlineFile(): Promise<string | null> {
		const tab = getActiveInlineFile();
		const previousPath = tab?.backStack.at(-1);
		if (!tab || !previousPath) return null;
		setInlineFileTab(tab.path, (item) => ({
			...item,
			backStack: item.backStack.slice(0, -1),
		}));
		await openInlineFile(previousPath, {
			preserveHistory: true,
			skipHistoryPush: true,
			position: null,
		});
		return previousPath;
	}

	async function loadPendingFileDiff(
		path: string,
	): Promise<SpacePendingDiffFileResponse> {
		return sdk.space(options.getSpaceId()).files.diffFile(path);
	}

	async function ensureInlineFileDiff(force = false) {
		const path = activeInlineFilePath;
		if (!path || options.getActiveFsReadonly()) {
			clearFileDiff();
			return;
		}
		if (
			!force &&
			inlineFileDiff.path === path &&
			(inlineFileDiff.patch || inlineFileDiff.loading)
		) {
			return;
		}
		const requestToken = inlineFileDiff.requestToken + 1;
		inlineFileDiff = {
			path,
			patch: force
				? null
				: inlineFileDiff.path === path
					? inlineFileDiff.patch
					: null,
			loading: true,
			error: null,
			requestToken,
		};
		try {
			const patch = await loadPendingFileDiff(path);
			if (inlineFileDiff.requestToken !== requestToken) return;
			inlineFileDiff = {
				path,
				patch,
				loading: false,
				error: null,
				requestToken,
			};
		} catch (error) {
			if (inlineFileDiff.requestToken !== requestToken) return;
			inlineFileDiff = {
				path,
				patch: null,
				loading: false,
				error: error instanceof Error ? error.message : "Failed to load diff",
				requestToken,
			};
		}
	}

	function setInlineFileViewMode(mode: FileViewMode) {
		if (!activeInlineFilePath) return;
		void fileAutosave.flush(activeInlineFilePath);
		setInlineFileTab(activeInlineFilePath, (tab) => ({
			...tab,
			viewMode: mode,
		}));
		if (mode === "diff") void ensureInlineFileDiff();
	}

	async function saveInlineFilePath(path: string) {
		const context = getWorkspaceContext();
		const inlineFile = inlineFileTabs.find((tab) => tab.path === path);
		const response = inlineFile?.response;
		if (
			options.getActiveFsReadonly() ||
			!options.getCanEditFiles() ||
			!inlineFile ||
			!response ||
			!isTextFileResponse(response)
		)
			return "blocked" as const;
		const requestToken = inlineFile.requestToken;
		const force = forcedOverwritePaths.delete(path);
		if (inlineFile.syncStatus === "conflict" && !force)
			return "blocked" as const;
		if (inlineFile.draft === response.content) {
			setInlineFileTab(path, (tab) => ({
				...tab,
				saving: false,
				syncStatus: "idle",
				saveError: null,
			}));
			await clearPendingDraft(path);
			return "clean" as const;
		}

		const nextContent = inlineFile.draft;
		const baseResponse = response;
		const mutationId = pendingSaveMutationIds.get(path) ?? crypto.randomUUID();
		await persistPendingDraft(path, mutationId, context);
		if (
			!isCurrentWorkspaceContext(context) ||
			inlineFileTabs.find((tab) => tab.path === path)?.requestToken !==
				requestToken
		)
			return "blocked" as const;
		ownFileMutationIds.add(mutationId);
		if (ownFileMutationIds.size > 256) {
			const oldest = ownFileMutationIds.values().next().value;
			if (oldest) ownFileMutationIds.delete(oldest);
		}
		// Sandbox mutations echo through sandbox-watch without a mutationId, so
		// also mark the path as a pending save to keep that echo from being read
		// as an external change.
		markFileSavePending(path);
		setInlineFileTab(path, (tab) => ({
			...tab,
			saving: true,
			syncStatus: "saving",
			saveError: null,
		}));
		const write = (expected?: { mtimeMs: number; size: number }) =>
			sdk.space(context.spaceId).files.write({
				path,
				content: nextContent,
				encoding: "utf-8",
				expected,
				mutationId,
			});
		const markConflict = () => {
			pendingSaveMutationIds.delete(path);
			setInlineFileTab(path, (tab) => ({
				...tab,
				saving: false,
				syncStatus: "conflict",
				saveError: "Changed elsewhere",
			}));
			return "blocked" as const;
		};
		try {
			let saved: {
				size: number;
				mtimeMs: number;
				response?: SpaceFsFileResponse;
			} | null = null;
			try {
				const result = await write(
					force
						? undefined
						: { mtimeMs: baseResponse.mtimeMs, size: baseResponse.size },
				);
				saved = { size: result.size, mtimeMs: result.mtimeMs };
			} catch (error) {
				if (force || !(error instanceof HttpError && error.status === 409))
					throw error;

				// Recover once only when fresh content proves the version conflict was stale.
				const fresh = await readActiveFsFile(path);
				if (
					!isCurrentWorkspaceContext(context) ||
					inlineFileTabs.find((tab) => tab.path === path)?.requestToken !==
						requestToken
				)
					return "blocked" as const;
				if (!("content" in fresh)) throw new Error("File is not ready");
				const resolved = await tryResolveTextFileResponse(fresh);
				if (resolved.error) throw new Error(resolved.error);
				const resolution = classifySaveConflict(
					resolved.file,
					baseResponse.content,
					nextContent,
				);
				if (resolution === "conflict") return markConflict();
				if (resolution === "already-saved") {
					saved = {
						size: resolved.file.size,
						mtimeMs: resolved.file.mtimeMs,
						response: resolved.file,
					};
				} else {
					const result = await write({
						mtimeMs: resolved.file.mtimeMs,
						size: resolved.file.size,
					});
					saved = { size: result.size, mtimeMs: result.mtimeMs };
				}
			}
			if (!saved) throw new Error("File save did not complete");
			pendingSaveMutationIds.delete(path);
			const savedSize = saved.size;
			const savedMtimeMs = saved.mtimeMs;
			const current = inlineFileTabs.find((tab) => tab.path === path);
			if (
				!isCurrentWorkspaceContext(context) ||
				current?.requestToken !== requestToken
			)
				return "saved" as const;
			if (current.syncStatus === "conflict") return "blocked" as const;
			fileSaveRetryAttempts.delete(path);
			setInlineFileTab(path, (tab) => ({
				...tab,
				response:
					saved.response ??
					(tab.response
						? ({
								...tab.response,
								content: nextContent,
								size: savedSize,
								mtimeMs: savedMtimeMs,
							} as SpaceFsFileResponse)
						: tab.response),
				saving: false,
				syncStatus: tab.draft === nextContent ? "idle" : "dirty",
				saveError: null,
			}));
			invalidateFileDiff(path);
			await patchFsDirectory(
				getParentDirPath(path),
				(entries) =>
					entries.map((entry) =>
						entry.path === path
							? {
									...entry,
									size: savedSize,
									mtimeMs: savedMtimeMs,
								}
							: entry,
					),
				context,
			);
			if (!isCurrentWorkspaceContext(context)) return "saved" as const;
			const latest = inlineFileTabs.find(
				(tab) => tab.path === path && tab.requestToken === requestToken,
			);
			if (latest?.syncStatus !== "conflict") {
				if (latest?.draft === nextContent)
					await clearPendingDraft(path, context);
				else await persistPendingDraft(path, crypto.randomUUID(), context);
			}
			if (latest?.path === activeInlineFilePath && latest.viewMode === "diff") {
				void ensureInlineFileDiff(true);
			}
			return "saved" as const;
		} catch (error) {
			if (
				!isCurrentWorkspaceContext(context) ||
				inlineFileTabs.find((tab) => tab.path === path)?.requestToken !==
					requestToken
			)
				return "blocked" as const;
			if (error instanceof HttpError && error.status === 409)
				return markConflict();
			pendingSaveMutationIds.set(path, mutationId);
			setInlineFileTab(path, (tab) => ({
				...tab,
				saving: false,
				syncStatus: "error",
				saveError: "Not saved",
			}));
			const attempt = (fileSaveRetryAttempts.get(path) ?? 0) + 1;
			fileSaveRetryAttempts.set(path, attempt);
			const delays = [2_000, 5_000, 15_000, 30_000];
			fileAutosave.retry(
				path,
				delays[Math.min(attempt - 1, delays.length - 1)],
			);
			return "blocked" as const;
		} finally {
			if (isCurrentWorkspaceContext(context)) {
				clearFileSavePendingSoon(path);
				setInlineFileTab(path, (tab) =>
					tab.requestToken === requestToken && tab.syncStatus === "saving"
						? {
								...tab,
								saving: false,
								syncStatus:
									tab.response &&
									isTextFileResponse(tab.response) &&
									tab.draft === tab.response.content
										? "idle"
										: "dirty",
							}
						: tab,
				);
			}
		}
	}

	function saveInlineFile() {
		return activeInlineFilePath
			? fileAutosave.flush(activeInlineFilePath)
			: Promise.resolve("clean" as const);
	}

	function flushInlineFiles() {
		return Promise.all(
			inlineFileTabs
				.filter((tab) => isInlineFileDirty(tab.path))
				.map((tab) => fileAutosave.flush(tab.path)),
		);
	}

	function retryFailedInlineFiles() {
		for (const tab of inlineFileTabs) {
			if (tab.syncStatus === "error") fileAutosave.retry(tab.path, 0);
		}
	}

	function retryInlineFileSave(path = activeInlineFilePath) {
		if (!path) return Promise.resolve("blocked" as const);
		setInlineFileTab(path, (tab) => ({
			...tab,
			syncStatus: "dirty",
			saveError: null,
		}));
		return fileAutosave.flush(path);
	}

	function overwriteInlineFile(path = activeInlineFilePath) {
		if (!path) return Promise.resolve("blocked" as const);
		forcedOverwritePaths.add(path);
		setInlineFileTab(path, (tab) => ({
			...tab,
			syncStatus: "dirty",
			saveError: null,
		}));
		return fileAutosave.flush(path);
	}

	async function reloadInlineFile(path = activeInlineFilePath) {
		if (!path) return;
		fileAutosave.cancel(path);
		await clearPendingDraft(path);
		await openInlineFile(path, { forceReload: true });
	}

	async function copyInlineFileContent() {
		const inlineFile = getActiveInlineFile();
		if (!inlineFile || !isTextFileResponse(inlineFile.response)) return;
		await navigator.clipboard.writeText(inlineFile.draft);
		setInlineFileTab(inlineFile.path, (tab) => ({ ...tab, copied: true }));
		if (inlineFileCopiedTimer) clearTimeout(inlineFileCopiedTimer);
		const copiedPath = inlineFile.path;
		inlineFileCopiedTimer = setTimeout(() => {
			setInlineFileTab(copiedPath, (tab) => ({
				...tab,
				copied: false,
			}));
		}, 1500);
	}

	function handleUploadFiles(
		files: File[] | { file: File; relativePath: string }[],
		targetDir: string,
	) {
		if (options.getActiveFsReadonly() || !options.getCanEditFiles()) return;
		uploadPaneTargetDir = targetDir;
		if (isLocalUploadEntries(files)) {
			pendingUploadEntries = files;
			pendingUploadFiles = [];
		} else {
			pendingUploadFiles = files;
			pendingUploadEntries = files.map((file) => ({
				file,
				relativePath: file.name,
			}));
		}
		uploadPaneVisible = true;
	}

	async function handleUploadComplete() {
		await refreshFileTree();
	}

	async function handleCreateFile(parentPath: string) {
		if (options.getActiveFsReadonly() || !options.getCanEditFiles()) return;
		const name = prompt("New file name");
		if (!name?.trim()) return;
		const path = parentPath ? `${parentPath}/${name.trim()}` : name.trim();
		try {
			await sdk
				.space(options.getSpaceId())
				.files.write({ path, content: "", encoding: "utf-8" });
			await patchFsDirectory(parentPath, (entries) => [
				...entries,
				buildFsEntry(path, "file"),
			]);
			if (workspaceFilePreviewKind(path, false) === "board")
				await options.onOpenInlineBoard(path);
			else await options.onOpenInlineFile(path);
		} catch (error) {
			fileTreeError =
				error instanceof Error ? error.message : "Failed to create file";
		}
	}

	async function handleCreateBoard(parentPath: string) {
		if (options.getActiveFsReadonly() || !options.getCanEditFiles()) return;
		const name = prompt("New board name", "Untitled.board");
		if (!name?.trim()) return;
		const fileName = ensureBoardExtension(name);
		const path = parentPath ? `${parentPath}/${fileName}` : fileName;
		try {
			await sdk.space(options.getSpaceId()).boards.create({
				path,
				title: fileName,
				mutationId: crypto.randomUUID(),
				items: [],
			});
			await patchFsDirectory(parentPath, (entries) => [
				...entries,
				buildFsEntry(path, "file"),
			]);
			await options.onOpenInlineBoard(path);
		} catch (error) {
			fileTreeError =
				error instanceof Error ? error.message : "Failed to create board";
		}
	}

	async function handleCreateDir(parentPath: string) {
		if (options.getActiveFsReadonly() || !options.getCanEditFiles()) return;
		const name = prompt("New folder name");
		if (!name?.trim()) return;
		const path = parentPath ? `${parentPath}/${name.trim()}` : name.trim();
		try {
			await sdk
				.space(options.getSpaceId())
				.files.createDir(path, crypto.randomUUID());
			await patchFsDirectory(parentPath, (entries) => [
				...entries,
				buildFsEntry(path, "dir"),
			]);
		} catch (error) {
			fileTreeError =
				error instanceof Error ? error.message : "Failed to create folder";
		}
	}

	async function applyMovedNode(
		node: SpaceFsNode,
		fromPath: string,
		toPath: string,
	) {
		const fromParent = getParentDirPath(fromPath);
		const toParent = getParentDirPath(toPath);
		const nextName = toPath.split("/").pop() ?? toPath;

		if (fromParent === toParent) {
			await patchFsDirectory(fromParent, (entries) =>
				entries.map((entry) =>
					entry.path === fromPath
						? {
								...entry,
								name: nextName,
								path: toPath,
								mtimeMs: Date.now(),
							}
						: entry,
				),
			);
		} else {
			await patchFsDirectory(fromParent, (entries) =>
				entries.filter((entry) => entry.path !== fromPath),
			);
			await patchFsDirectory(toParent, (entries) => {
				const withoutClash = entries.filter((entry) => entry.path !== toPath);
				return [
					...withoutClash,
					{
						...buildFsEntry(toPath, node.type),
						size: node.size,
						mimeType: node.mimeType,
						mtimeMs: Date.now(),
					},
				];
			});
		}

		if (node.type === "dir") {
			await clearCachedSpaceFsSubtree(options.getSpaceId(), fromPath);
		}

		renameOpenPaths(fromPath, toPath);
		options.onRenameInlineBoard?.(fromPath, toPath);
	}

	async function moveNodeToPath(node: SpaceFsNode, toPath: string) {
		const fromPath = node.path;
		if (fromPath === toPath) return false;
		const affectedTabs = inlineFileTabs.filter(
			(tab) => tab.path === fromPath || tab.path.startsWith(`${fromPath}/`),
		);
		for (const tab of affectedTabs) {
			await fileAutosave.flush(tab.path);
			if (isInlineFileDirty(tab.path))
				throw new Error("Resolve file sync before moving it.");
		}
		await sdk.space(options.getSpaceId()).files.move({
			fromPath,
			toPath,
			mutationId: crypto.randomUUID(),
		});
		await applyMovedNode(node, fromPath, toPath);
		return true;
	}

	async function handleRenameNode(node: SpaceFsNode) {
		if (options.getActiveFsReadonly() || !options.getCanEditFiles()) return;
		const nextName = prompt("Rename", node.name);
		if (!nextName?.trim() || nextName.trim() === node.name) return;
		const parent = getParentDirPath(node.path);
		const toPath = parent ? `${parent}/${nextName.trim()}` : nextName.trim();
		try {
			await moveNodeToPath(node, toPath);
		} catch (error) {
			fileTreeError =
				error instanceof Error ? error.message : "Failed to rename";
		}
	}

	async function handleMoveNode(node: SpaceFsNode, targetDir: string) {
		if (options.getActiveFsReadonly() || !options.getCanEditFiles()) return;
		const destination = resolveFsMoveDestination(node.path, targetDir);
		if (!destination) return;
		const source =
			findFsNode(destination.fromPath) ??
			({
				...node,
				path: destination.fromPath,
				name: destination.name,
			} satisfies SpaceFsNode);
		try {
			await moveNodeToPath(source, destination.toPath);
		} catch (error) {
			fileTreeError = error instanceof Error ? error.message : "Failed to move";
		}
	}

	async function handleDownloadNode(node: SpaceFsNode) {
		if (node.type !== "file") return;
		try {
			await downloadActiveFsFile(node.path, null);
		} catch (error) {
			fileTreeError =
				error instanceof Error ? error.message : "Failed to download";
		}
	}

	async function handleDeleteNode(node: SpaceFsNode): Promise<boolean> {
		if (
			options.getActiveFsReadonly() ||
			!options.getCanEditFiles() ||
			deletingPaths.has(node.path)
		)
			return false;
		if (!confirm(`Delete ${node.name}?`)) return false;
		const context = getWorkspaceContext();
		const parentPath = getParentDirPath(node.path);
		deletingPaths.add(node.path);
		try {
			await sdk
				.space(context.spaceId)
				.files.delete(node.path, node.type === "dir", crypto.randomUUID());
			await patchFsDirectory(
				parentPath,
				(entries) => entries.filter((entry) => entry.path !== node.path),
				context,
			);
			if (node.type === "dir")
				await clearCachedSpaceFsSubtree(context.spaceId, node.path);
			if (inlineFileTabs.some((tab) => tab.path === node.path))
				closeInlineFile(node.path);
			try {
				const entries = await fetchSpaceFsDirWithCache(
					context.spaceId,
					parentPath,
					async () =>
						(await sdk.space(context.spaceId).files.list(parentPath)).entries,
					{ force: true },
				);
				if (isCurrentWorkspaceContext(context))
					applyDirectoryEntries(parentPath, entries);
			} catch {
				// The confirmed delete remains authoritative; realtime will retry refresh.
			}
			return true;
		} catch (error) {
			fileTreeError =
				error instanceof Error ? error.message : "Failed to delete";
			return false;
		} finally {
			deletingPaths.delete(node.path);
		}
	}

	function findFsNode(
		path: string,
		nodes: SpaceFsNode[] = fileTree,
	): SpaceFsNode | null {
		for (const node of nodes) {
			if (node.path === path) return node;
			const child = findFsNode(path, node.children);
			if (child) return child;
		}
		return null;
	}

	function applyDirectoryEntries(dirPath: string, entries: SpaceFsEntry[]) {
		if (dirPath === "") {
			updateRootFsEntries(entries);
			return;
		}
		setActiveFileTree(
			replaceNodeChildren(fileTree, dirPath, makeFsNodes(entries)),
		);
	}

	function markDirectoryUnloaded(dirPath: string) {
		setActiveFileTree(
			updateNodeState(fileTree, dirPath, (item) => ({
				...item,
				isLoaded: false,
			})),
		);
	}

	function getFileActionNode(path: string): SpaceFsNode {
		const existingNode = findFsNode(path);
		if (existingNode) return existingNode;
		const response =
			getActiveInlineFile()?.response?.path === path
				? getActiveInlineFile()?.response
				: null;
		return {
			...buildFsEntry(path, "file"),
			size: response?.size ?? 0,
			mimeType: response?.mimeType ?? null,
			children: [],
			isOpen: false,
			isLoaded: false,
			isLoading: false,
		};
	}

	function closeReadyCopies() {
		if (inlineFileCopiedTimer) clearTimeout(inlineFileCopiedTimer);
	}

	function isInlineFileDirty(path: string) {
		const tab = inlineFileTabs.find((item) => item.path === path);
		return Boolean(
			tab?.response &&
				isTextFileResponse(tab.response) &&
				tab.draft !== tab.response.content,
		);
	}

	function dispose() {
		closeReadyCopies();
		for (const tab of inlineFileTabs) {
			if (isInlineFileDirty(tab.path)) void persistPendingDraft(tab.path);
		}
		fileAutosave.dispose();
		for (const timer of pendingDraftPersistTimers.values()) clearTimeout(timer);
		pendingDraftPersistTimers.clear();
		for (const timer of pendingSaveTimers.values()) clearTimeout(timer);
		pendingSaveTimers.clear();
		pendingSaveMutationIds.clear();
		clearInlineFileRefreshes();
	}

	function renameOpenPaths(fromPath: string, toPath: string) {
		for (const tab of inlineFileTabs) {
			const nextPath = rewriteFsPathPrefix(tab.path, fromPath, toPath);
			if (!nextPath) continue;
			fileAutosave.cancel(tab.path);
			cancelInlineFileRefresh(tab.path);
			void clearPendingDraft(tab.path);
		}
		inlineFileTabs = inlineFileTabs.map((tab) => {
			const nextPath = rewriteFsPathPrefix(tab.path, fromPath, toPath);
			if (!nextPath) return tab;
			return {
				...tab,
				path: nextPath,
				response: tab.response
					? {
							...tab.response,
							path: nextPath,
							name: nextPath.split("/").pop() ?? nextPath,
						}
					: tab.response,
				backStack: tab.backStack.map(
					(item) => rewriteFsPathPrefix(item, fromPath, toPath) ?? item,
				),
			};
		});
		if (activeInlineFilePath) {
			const nextActive = rewriteFsPathPrefix(
				activeInlineFilePath,
				fromPath,
				toPath,
			);
			if (nextActive) activeInlineFilePath = nextActive;
		}
	}

	function renamePath(fromPath: string, toPath: string) {
		const dirtyTargets = inlineFileTabs.flatMap((tab) => {
			const nextPath = rewriteFsPathPrefix(tab.path, fromPath, toPath);
			return nextPath && isInlineFileDirty(tab.path) ? [nextPath] : [];
		});
		renameOpenPaths(fromPath, toPath);
		for (const path of dirtyTargets) {
			markInlineFileExternalChange(path);
			void persistPendingDraft(path);
		}
	}

	return {
		get fileTree() {
			return fileTree;
		},
		get fileTreeLoading() {
			return fileTreeLoading;
		},
		get fileTreeError() {
			return fileTreeError;
		},
		get inlineFile() {
			return getActiveInlineFile();
		},
		get inlineFileTabs() {
			return inlineFileTabs;
		},
		get activeInlineFilePath() {
			return activeInlineFilePath;
		},
		get inlineFileCanGoBack() {
			return Boolean(getActiveInlineFile()?.backStack.length);
		},
		get inlineFileDirty() {
			const tab = getActiveInlineFile();
			return Boolean(
				tab?.response &&
					isTextFileResponse(tab.response) &&
					tab.draft !== tab.response.content,
			);
		},
		get inlineFileIsMarkdown() {
			return (
				filePreviewModel(getActiveInlineFile()?.response).kind === "markdown"
			);
		},
		get inlineFileIsCsv() {
			return filePreviewModel(getActiveInlineFile()?.response).kind === "csv";
		},
		get inlineFileIsHtml() {
			return filePreviewModel(getActiveInlineFile()?.response).kind === "html";
		},
		get inlineFileHasRenderedPreview() {
			return filePreviewModel(getActiveInlineFile()?.response)
				.hasRenderedPreview;
		},
		get inlineFileIsText() {
			return filePreviewModel(getActiveInlineFile()?.response).isText;
		},
		get inlineFileIsImage() {
			return filePreviewModel(getActiveInlineFile()?.response).kind === "image";
		},
		get inlineFileIsVideo() {
			return filePreviewModel(getActiveInlineFile()?.response).kind === "video";
		},
		get inlineFileIsAudio() {
			return filePreviewModel(getActiveInlineFile()?.response).kind === "audio";
		},
		get inlineFileIsPdf() {
			return filePreviewModel(getActiveInlineFile()?.response).kind === "pdf";
		},
		get inlineFileDataUrl() {
			return filePreviewModel(getActiveInlineFile()?.response).mediaUrl;
		},
		get inlineFileDownloadUrl() {
			const inlineFile = getActiveInlineFile();
			if (!inlineFile) return "";
			return getActiveFsClient().getDownloadUrl(
				inlineFile.path,
				inlineFile.response,
			);
		},
		get inlineFileDownloadName() {
			const inlineFile = getActiveInlineFile();
			return inlineFile ? (inlineFile.path.split("/").pop() ?? "download") : "";
		},
		get inlineFileViewMode() {
			return getActiveInlineFile()?.viewMode ?? "source";
		},
		set inlineFileViewMode(value: FileViewMode) {
			setInlineFileViewMode(value);
		},
		get inlineFileDiff() {
			const path = activeInlineFilePath;
			return path && inlineFileDiff.path === path ? inlineFileDiff.patch : null;
		},
		get inlineFileDiffLoading() {
			const path = activeInlineFilePath;
			return Boolean(
				path && inlineFileDiff.path === path && inlineFileDiff.loading,
			);
		},
		get inlineFileDiffError() {
			const path = activeInlineFilePath;
			return path && inlineFileDiff.path === path ? inlineFileDiff.error : null;
		},
		get inlineFileCopied() {
			return getActiveInlineFile()?.copied ?? false;
		},
		get inlineFileZoom() {
			return getActiveInlineFile()?.zoom ?? 1;
		},
		set inlineFileZoom(value: number) {
			if (activeInlineFilePath)
				setInlineFileTab(activeInlineFilePath, (tab) => ({
					...tab,
					zoom: value,
				}));
		},
		get inlineFilePanX() {
			return getActiveInlineFile()?.panX ?? 0;
		},
		set inlineFilePanX(value: number) {
			if (activeInlineFilePath)
				setInlineFileTab(activeInlineFilePath, (tab) => ({
					...tab,
					panX: value,
				}));
		},
		get inlineFilePanY() {
			return getActiveInlineFile()?.panY ?? 0;
		},
		set inlineFilePanY(value: number) {
			if (activeInlineFilePath)
				setInlineFileTab(activeInlineFilePath, (tab) => ({
					...tab,
					panY: value,
				}));
		},
		get inlineFileDragging() {
			return getActiveInlineFile()?.dragging ?? false;
		},
		set inlineFileDragging(value: boolean) {
			if (activeInlineFilePath)
				setInlineFileTab(activeInlineFilePath, (tab) => ({
					...tab,
					dragging: value,
				}));
		},
		get uploadPaneVisible() {
			return uploadPaneVisible;
		},
		set uploadPaneVisible(value: boolean) {
			uploadPaneVisible = value;
		},
		get uploadPaneTargetDir() {
			return uploadPaneTargetDir;
		},
		get pendingUploadFiles() {
			return pendingUploadFiles;
		},
		get pendingUploadEntries() {
			return pendingUploadEntries;
		},
		get fileTreeSourceKey() {
			return fileTreeSourceKey;
		},
		set fileTreeSourceKey(value: string) {
			fileTreeSourceKey = value;
		},
		get directoryLoadTokenByPath() {
			return directoryLoadTokenByPath;
		},
		get inlineFileRequestToken() {
			return inlineFileRequestToken;
		},
		setActiveFileTree,
		updateRootFsEntries,
		switchSource,
		resetForSpace,
		markInlineFileExternalChange,
		refreshInlineFile,
		isInlineFileDirty,
		hasDirtyInlineFiles,
		loadFileTree,
		expandDirectory,
		refreshFileTree,
		openSpaceFile,
		revealPath,
		openInlineFile,
		closeInlineFile,
		activateInlineFile: (path: string) => {
			if (activeInlineFilePath && activeInlineFilePath !== path)
				void fileAutosave.flush(activeInlineFilePath);
			activeInlineFilePath = path;
			const tab = inlineFileTabs.find((item) => item.path === path);
			if (tab?.viewMode === "diff") void ensureInlineFileDiff();
			else if (inlineFileDiff.path !== path) clearFileDiff();
			options.onActivateFilePreview?.();
		},
		closeInlineFileTab: closeInlineFile,
		goBackInlineFile,
		updateInlineFileDraft,
		saveInlineFile,
		flushInlineFiles,
		persistInlineFileDrafts,
		retryInlineFileSave,
		retryFailedInlineFiles,
		overwriteInlineFile,
		reloadInlineFile,
		copyInlineFileContent,
		downloadInlineFile,
		downloadActiveFsFile,
		handleCreateFile,
		handleCreateBoard,
		handleCreateDir,
		handleRenameNode,
		handleMoveNode,
		handleDownloadNode,
		handleDeleteNode,
		handleUploadFiles,
		handleUploadComplete,
		patchFsDirectory,
		readActiveFsFile,
		listActiveFsDir,
		markFileSavePending,
		clearFileSavePendingSoon,
		isOwnPendingFileSave,
		findFsNode,
		applyDirectoryEntries,
		markDirectoryUnloaded,
		getFileActionNode,
		renamePath,
		dispose,
	};
}
