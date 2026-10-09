import { getContext, setContext } from "svelte";

const FILE_TREE_MARKS = Symbol("file-tree-marks");

/** Marked paths (files and their ancestors) and the mark label. */
export type FileTreeMarks = { paths: ReadonlySet<string>; label: string };

type MarksGetter = () => FileTreeMarks | null;

export function provideFileTreeMarks(get: MarksGetter) {
	setContext(FILE_TREE_MARKS, get);
}

export function useFileTreeMarks(): MarksGetter {
	return getContext<MarksGetter | undefined>(FILE_TREE_MARKS) ?? (() => null);
}
