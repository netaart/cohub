import { normalizeMime, type SpaceFsChangedPayload } from "@cohub/protocol/fs";
import type { SpaceFsEntry, SpaceFsFileResponse } from "@neta-art/cohub";
import { isTextFileResponse } from "$lib/space-file-text";
import type { SpaceFsNode } from "$lib/space-fs";

export const isMarkdownPath = (path: string) => /\.md$/i.test(path);

export const isHtmlPath = (path: string) => /\.html?$/i.test(path);

export const isPdfPath = (path: string) => /\.pdf$/i.test(path);

export const isPdfFile = (
	file: Pick<SpaceFsFileResponse, "path" | "mimeType"> | null | undefined,
) =>
	Boolean(
		file &&
			(normalizeMime(file.mimeType) === "application/pdf" ||
				isPdfPath(file.path)),
	);

export const hasRenderedFilePreview = (file: SpaceFsFileResponse) =>
	isTextFileResponse(file) &&
	(isMarkdownPath(file.path) || isHtmlPath(file.path));

export function makeFsNode(entry: SpaceFsEntry): SpaceFsNode {
	return {
		...entry,
		children: [],
		isOpen: false,
		isLoaded: false,
		isLoading: false,
	};
}

export function buildFsEntry(
	path: string,
	type: SpaceFsEntry["type"],
): SpaceFsEntry {
	const normalizedPath = path.trim().replace(/^\/+|\/+$/g, "");
	const name = normalizedPath.split("/").pop() ?? normalizedPath;
	return {
		name,
		path: normalizedPath,
		type,
		size: 0,
		mimeType: null,
		mtimeMs: Date.now(),
	};
}

export function normalizeFsPath(path: string): string {
	return path.trim().replace(/^\/+|\/+$/g, "");
}

export function getParentDirPath(path: string): string {
	const normalizedPath = normalizeFsPath(path);
	if (!normalizedPath.includes("/")) return "";
	return normalizedPath.slice(0, normalizedPath.lastIndexOf("/"));
}

export function joinFsPath(parentPath: string, name: string): string {
	const parent = normalizeFsPath(parentPath);
	const baseName = normalizeFsPath(name).split("/").pop() ?? "";
	if (!baseName) return parent;
	return parent ? `${parent}/${baseName}` : baseName;
}

/** True when `path` is `ancestor` or nested under it. Empty ancestor never matches. */
export function isSameOrDescendantPath(
	path: string,
	ancestor: string,
): boolean {
	const normalizedPath = normalizeFsPath(path);
	const normalizedAncestor = normalizeFsPath(ancestor);
	if (!normalizedPath || !normalizedAncestor) return false;
	return (
		normalizedPath === normalizedAncestor ||
		normalizedPath.startsWith(`${normalizedAncestor}/`)
	);
}

export function rewriteFsPathPrefix(
	path: string,
	fromPath: string,
	toPath: string,
): string | null {
	const normalizedPath = normalizeFsPath(path);
	const from = normalizeFsPath(fromPath);
	const to = normalizeFsPath(toPath);
	if (!normalizedPath || !from) return null;
	if (normalizedPath === from) return to;
	if (normalizedPath.startsWith(`${from}/`)) {
		return `${to}${normalizedPath.slice(from.length)}`;
	}
	return null;
}

/** Resolve a tree drag-move destination, or null when the move is a no-op / invalid. */
export function resolveFsMoveDestination(
	fromPath: string,
	targetDir: string,
): {
	fromPath: string;
	toPath: string;
	fromParent: string;
	toParent: string;
	name: string;
} | null {
	const from = normalizeFsPath(fromPath);
	if (!from) return null;
	const name = from.split("/").pop() ?? from;
	const fromParent = getParentDirPath(from);
	const toParent = normalizeFsPath(targetDir);
	if (fromParent === toParent) return null;
	// Cannot move a directory into itself or a descendant.
	if (isSameOrDescendantPath(toParent, from)) return null;
	return {
		fromPath: from,
		toPath: joinFsPath(toParent, name),
		fromParent,
		toParent,
		name,
	};
}

export function mergeFsNodeLists(
	nodes: SpaceFsNode[],
	previousNodes: SpaceFsNode[] = [],
): SpaceFsNode[] {
	if (previousNodes.length === 0) return nodes;
	const previousByPath = new Map(
		previousNodes.map((node) => [node.path, node]),
	);
	return nodes.map((node) => {
		const previous = previousByPath.get(node.path);
		if (!previous || previous.type !== node.type) return node;
		if (node.type !== "dir") return node;
		return {
			...node,
			children: previous.children,
			isOpen: previous.isOpen,
			isLoaded: previous.isLoaded,
			isLoading: false,
			loadError: previous.loadError,
		};
	});
}

export function makeFsNodes(
	entries: SpaceFsEntry[],
	previousNodes: SpaceFsNode[] = [],
): SpaceFsNode[] {
	return mergeFsNodeLists(entries.map(makeFsNode), previousNodes);
}

export function replaceNodeChildren(
	nodes: SpaceFsNode[],
	nodePath: string,
	children: SpaceFsNode[],
): SpaceFsNode[] {
	return nodes.map((node) => {
		if (node.path === nodePath)
			return {
				...node,
				children: mergeFsNodeLists(children, node.children),
				isLoaded: true,
				isLoading: false,
				loadError: null,
				isOpen: true,
			};
		if (node.children.length > 0)
			return {
				...node,
				children: replaceNodeChildren(node.children, nodePath, children),
			};
		return node;
	});
}

export function updateNodeState(
	nodes: SpaceFsNode[],
	nodePath: string,
	updater: (node: SpaceFsNode) => SpaceFsNode,
): SpaceFsNode[] {
	return nodes.map((node) => {
		if (node.path === nodePath) return updater(node);
		if (node.children.length > 0)
			return {
				...node,
				children: updateNodeState(node.children, nodePath, updater),
			};
		return node;
	});
}

/** Classify a failed optimistic save against the content it started from. */
export function classifySaveConflict(
	fresh: SpaceFsFileResponse | null | undefined,
	baseContent: string,
	attemptedContent: string,
): "already-saved" | "retry" | "conflict" {
	if (!fresh || !isTextFileResponse(fresh)) return "conflict";
	if (fresh.content === attemptedContent) return "already-saved";
	if (fresh.content === baseContent) return "retry";
	return "conflict";
}

export type InlineFileFsChangeDisposition =
	| "acknowledged"
	| "refresh"
	| "conflict"
	| "deleted";

type InlineFileFsChange = SpaceFsChangedPayload["changes"][number];

export function hasSameFileVersion(
	left:
		| Pick<SpaceFsFileResponse, "mtimeMs" | "size">
		| { mtimeMs?: number; size?: number }
		| null
		| undefined,
	right:
		| Pick<SpaceFsFileResponse, "mtimeMs" | "size">
		| { mtimeMs?: number; size?: number }
		| null
		| undefined,
) {
	return Boolean(
		left &&
			right &&
			left.size !== undefined &&
			right.size !== undefined &&
			left.size === right.size &&
			left.mtimeMs !== undefined &&
			right.mtimeMs !== undefined &&
			Math.trunc(left.mtimeMs) === Math.trunc(right.mtimeMs),
	);
}

/** Decide whether an open file needs reconciliation without reading it first. */
export function classifyInlineFileFsChange(input: {
	change: InlineFileFsChange;
	current: SpaceFsFileResponse | null;
	dirty: boolean;
	ownMutation: boolean;
}): InlineFileFsChangeDisposition {
	if (input.ownMutation) return "acknowledged";
	if (input.change.kind === "delete") return "deleted";
	if (
		(input.change.kind === "create" || input.change.kind === "modify") &&
		hasSameFileVersion(input.current, input.change)
	)
		return "acknowledged";
	return input.dirty ? "conflict" : "refresh";
}
