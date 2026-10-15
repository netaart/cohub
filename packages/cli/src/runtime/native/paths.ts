import { posix, win32 } from "node:path";

/** Whether a native path is the root itself or one of its descendants. */
export function containsNativePath(root: string, path: string, platform: NodeJS.Platform = process.platform): boolean {
  const paths = platform === "win32" ? win32 : posix;
  const relative = paths.relative(root, path);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative);
}
