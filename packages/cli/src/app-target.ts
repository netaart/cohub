import { isHttpErrorCode, type CohubHttpClient } from "@neta-art/cohub";

/**
 * `--file` / `--dir` publish targets are paths inside the target Space's
 * workspace, not local filesystem paths. The publish worker resolves them
 * under `{storageRoot}/{spaceId}/workspace` and snapshots the bytes into an
 * immutable artifact.
 *
 * The worker surfaces a bare "file or directory not found" without context, so
 * the CLI checks the target against the Space files API first and fails with
 * an explicit, self-explanatory error before anything is snapshotted.
 */
export type AppTargetCheckError = {
  status: number;
  code: string;
  message: string;
};

/** Normalize a user-supplied Space path for comparison with fs entries. */
function normalizeSpacePath(path: string): string {
  return path.replace(/^\.(\/|$)/, "").replace(/\/+$/, "");
}

function posixDirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "" : path.slice(0, index);
}

/**
 * Verify a Space-relative publish target exists with the expected node type.
 * An empty or "." targetRef (the Space workspace root, directory publishes only) passes.
 * Returns null when the target is valid or the check itself cannot run —
 * the preflight is advisory and must never block a publish the worker can do.
 */
export async function checkAppTarget(
  client: CohubHttpClient,
  spaceId: string,
  target: { targetType: "file" | "directory"; targetRef: string },
): Promise<AppTargetCheckError | null> {
  const targetPath = normalizeSpacePath(target.targetRef);
  if (!targetPath) return null;

  try {
    const tree = await client.space(spaceId).files.list(posixDirname(targetPath));
    const entry = tree.entries.find((candidate) => candidate.path === targetPath);
    if (!entry) {
      return {
        status: 404,
        code: "path_not_found",
        message: `"${targetPath}" does not exist in the Space workspace`,
      };
    }
    const wanted = target.targetType === "directory" ? "dir" : "file";
    if (entry.type !== wanted) {
      const foundKind = entry.type === "dir" ? "a directory" : entry.type === "symlink" ? "a symlink" : "a file";
      const wantedKind = wanted === "dir" ? "a directory" : "a file";
      return {
        status: 400,
        code: entry.type === "symlink" ? "symlink_not_supported" : wanted === "dir" ? "not_a_directory" : "not_a_file",
        message: `"${targetPath}" is ${foundKind}, but the publish target must be ${wantedKind}`,
      };
    }
    return null;
  } catch (e) {
    // The parent directory itself is missing.
    if (isHttpErrorCode(e, "path_not_found")) {
      return {
        status: 404,
        code: "path_not_found",
        message: `"${targetPath}" does not exist in the Space workspace`,
      };
    }
    // Advisory preflight: ignore auth/visibility/network noise here and let the
    // publish request proceed — the worker still reports real failures.
    return null;
  }
}
