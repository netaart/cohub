export type SpaceFsEntry = {
	name: string;
	path: string;
	type: "file" | "dir" | "symlink";
	size: number;
	mimeType: string | null;
	mtimeMs: number;
};

export type SpaceFsNode = SpaceFsEntry & {
	children: SpaceFsNode[];
	isOpen: boolean;
	isLoaded: boolean;
	isLoading: boolean;
	loadError?: string | null;
};
