/** The folder a Space path sits in; a file at the root sits in the empty path. */
export function folderOf(path: string): string {
  const slash = path.replace(/\/+$/, "").lastIndexOf("/");
  return slash > 0 ? path.slice(0, slash) : "";
}

/** The last segment of a Space path, used as a file's name. */
export function fileNameOf(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}
