export type WorkspaceFilePosition = {
	line: number;
	column?: number;
};

export type WorkspaceFileLinkTarget = {
	path: string;
	position?: WorkspaceFilePosition;
};

export type OpenWorkspaceFileTarget = string | WorkspaceFileLinkTarget;

export type NormalizeWorkspaceFileLinkOptions = {
	/** Current workspace-relative Markdown file path. Used for relative links. */
	basePath?: string | null;
};

const SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
function stripQueryAndHash(value: string) {
	const queryIndex = value.indexOf("?");
	const hashIndex = value.indexOf("#");
	const cutIndex = [queryIndex, hashIndex]
		.filter((index) => index >= 0)
		.sort((a, b) => a - b)[0];
	return cutIndex === undefined ? value : value.slice(0, cutIndex);
}

function safeDecodeUri(value: string) {
	try {
		return decodeURI(value);
	} catch {
		return null;
	}
}

function extractLinePosition(value: string) {
	const match = value.match(/:(\d+)(?::(\d+))?$/);
	if (!match) return { path: value };
	const path = value.slice(0, match.index);
	// Only a path-like prefix (contains a directory or extension) can carry a
	// line suffix; otherwise `tel:123` / `a:1` would be read as a line reference
	// instead of a scheme.
	if (!path.includes("/") && !path.includes(".")) return { path: value };
	const line = Number(match[1]);
	const column = match[2] ? Number(match[2]) : undefined;
	return {
		path,
		position:
			line > 0
				? {
						line,
						...(column && column > 0 ? { column } : {}),
					}
				: undefined,
	};
}

function dirname(path: string) {
	const normalized = normalizeWorkspacePath(path);
	if (!normalized?.includes("/")) return "";
	return normalized.slice(0, normalized.lastIndexOf("/"));
}

function hasControlCharacter(value: string) {
	return Array.from(value).some((char) => {
		const code = char.charCodeAt(0);
		return code <= 0x1f || code === 0x7f;
	});
}

function normalizeWorkspacePath(path: string) {
	if (!path || path.includes("\\") || hasControlCharacter(path)) return null;
	const parts: string[] = [];
	for (const segment of path.split("/")) {
		if (!segment || segment === ".") continue;
		if (segment === "..") {
			if (parts.length === 0) return null;
			parts.pop();
			continue;
		}
		parts.push(segment);
	}
	return parts.length > 0 ? parts.join("/") : null;
}

/**
 * Converts Markdown hrefs that refer to files inside /workspace into the
 * workspace-relative path used by the file tree and preview panel.
 */
export function normalizeWorkspaceFileLinkTarget(
	href: string,
	options: NormalizeWorkspaceFileLinkOptions = {},
): WorkspaceFileLinkTarget | null {
	const raw = href.trim();
	if (!raw || raw.startsWith("#")) return null;
	if (raw.startsWith("//")) return null;

	const withoutQuery = stripQueryAndHash(raw).trim();
	if (!withoutQuery) return null;

	const decoded = safeDecodeUri(withoutQuery)?.trim();
	if (!decoded || decoded.startsWith("#")) return null;
	if (decoded.startsWith("//")) return null;
	if (decoded.includes("\\") || hasControlCharacter(decoded)) return null;

	const { path: pathWithPosition, position } = extractLinePosition(decoded);
	if (!pathWithPosition) return null;
	// A leading scheme (http:, mailto:, cohub:, …) is not a workspace file. This
	// runs after position extraction so `file.ts:12` isn't mistaken for a scheme.
	if (SCHEME_PATTERN.test(pathWithPosition)) return null;
	if (pathWithPosition === "/workspace" || pathWithPosition === "workspace")
		return null;

	if (pathWithPosition.startsWith("/")) {
		if (!pathWithPosition.startsWith("/workspace/")) return null;
		const path = normalizeWorkspacePath(
			pathWithPosition.slice("/workspace/".length),
		);
		return path ? { path, position } : null;
	}

	if (pathWithPosition.startsWith("workspace/")) {
		const path = normalizeWorkspacePath(
			pathWithPosition.slice("workspace/".length),
		);
		return path ? { path, position } : null;
	}

	const baseDir = options.basePath ? dirname(options.basePath) : "";
	const path = normalizeWorkspacePath(
		baseDir ? `${baseDir}/${pathWithPosition}` : pathWithPosition,
	);
	return path ? { path, position } : null;
}

export function normalizeWorkspaceFileLink(
	href: string,
	options: NormalizeWorkspaceFileLinkOptions = {},
) {
	return normalizeWorkspaceFileLinkTarget(href, options)?.path ?? null;
}

const PUBLIC_FILE_HREF_PATTERN = /^\/p\/([^/?#]+)\/(.+)$/;

/** Decode one path segment; reject separators and traversal after decoding. */
function decodePublicPathSegment(segment: string): string | null {
	let decoded: string;
	try {
		decoded = decodeURIComponent(segment);
	} catch {
		return null;
	}
	if (!decoded || decoded === "." || decoded === "..") return null;
	if (
		decoded.includes("/") ||
		decoded.includes("\\") ||
		hasControlCharacter(decoded)
	) {
		return null;
	}
	return decoded;
}

/**
 * Root-relative `/p/{spaceId}/{path}` marks a Space public file. The origin is
 * omitted because the path is authored inside Cohub; it is rewritten to the
 * absolute CDN URL when the markdown HTML is prepared.
 */
export function parsePublicFileHref(
	href: string,
): { spaceId: string; path: string } | null {
	const raw = href.trim();
	if (!raw.startsWith("/p/")) return null;

	const withoutQuery = stripQueryAndHash(raw).trim();
	const match = withoutQuery.match(PUBLIC_FILE_HREF_PATTERN);
	if (!match) return null;

	const spaceId = decodePublicPathSegment(match[1]);
	if (!spaceId) return null;

	const path: string[] = [];
	for (const segment of match[2].split("/")) {
		const decoded = decodePublicPathSegment(segment);
		if (!decoded) return null;
		path.push(decoded);
	}

	return { spaceId, path: path.join("/") };
}
