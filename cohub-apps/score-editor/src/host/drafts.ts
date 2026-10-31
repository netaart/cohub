import type { DraftStore, DraftWriteResult } from "@neta-art/score-editor";
import { isConflict, statusOf } from "./errors.ts";
import type { CohubFileClient } from "./host.ts";
import { parseFileVersion, versionString } from "./version.ts";

/** Where a task's drafts live in its Space. */
export const DRAFT_DIR = ".cohub/score-drafts";

export function draftPath(key: string): string {
  return `${DRAFT_DIR}/${key}.json`;
}

/**
 * The package's draft storage over one task's Space files: each key is a JSON file under
 * `.cohub/score-drafts/`, and the version is the `{mtimeMs, size}` pair a file read answers.
 */
export function createDraftStore(options: {
  readonly client: CohubFileClient;
  readonly spaceId: string;
}): DraftStore {
  const { client, spaceId } = options;

  return {
    async read(key) {
      try {
        const file = await client.read({ spaceId, path: draftPath(key) });
        return { text: file.text, version: versionString(file.version) };
      } catch (error) {
        if (statusOf(error) === 404) return null;
        throw error;
      }
    },

    async write(key, text, expected) {
      const expectedVersion = expected === null ? null : parseFileVersion(expected);
      if (expected !== null && expectedVersion === null) {
        return { ok: false, reason: "failed" };
      }
      if (expected === null) {
        // `expected: null` is a create; the fs write would replace an existing file, so a
        // draft another window created first is a conflict, not an overwrite.
        try {
          await client.read({ spaceId, path: draftPath(key) });
          return { ok: false, reason: "conflict" };
        } catch (error) {
          if (statusOf(error) === 403) return { ok: false, reason: "no-access" };
          if (statusOf(error) !== 404) return { ok: false, reason: "failed" };
        }
      }
      try {
        const version = await client.write({
          spaceId,
          path: draftPath(key),
          text,
          expected: expectedVersion,
        });
        return { ok: true, version: versionString(version) };
      } catch (error) {
        if (isConflict(error)) return { ok: false, reason: "conflict" };
        return { ok: false, reason: statusOf(error) === 403 ? "no-access" : "failed" };
      }
    },

    async remove(key, expected): Promise<DraftWriteResult> {
      const path = draftPath(key);
      let current: string;
      try {
        const file = await client.read({ spaceId, path });
        current = versionString(file.version);
      } catch (error) {
        if (statusOf(error) === 404) return { ok: true, version: expected ?? "" };
        return { ok: false, reason: "failed" };
      }
      // The fs API deletes without a version, so the version check is the read just above.
      if (expected !== null && expected !== current) return { ok: false, reason: "conflict" };
      try {
        await client.delete({ spaceId, path });
        return { ok: true, version: current };
      } catch (error) {
        if (statusOf(error) === 404) return { ok: true, version: current };
        return { ok: false, reason: "failed" };
      }
    },

    async list() {
      try {
        const entries = await client.list({ spaceId, path: DRAFT_DIR });
        return entries
          .filter((entry) => entry.type === "file" && entry.name.endsWith(".json"))
          .map((entry) => entry.name.slice(0, -".json".length))
          .sort();
      } catch (error) {
        if (statusOf(error) === 404) return [];
        throw error;
      }
    },
  };
}
