export function boardPathMatchesTarget(boardPath: string, targetPath: string, recursive: boolean): boolean {
	return boardPath === targetPath || (recursive && boardPath.startsWith(`${targetPath}/`));
}
