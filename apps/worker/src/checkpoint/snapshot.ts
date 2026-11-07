import { rm } from "node:fs/promises";
import { join } from "node:path";
import { uploadAssetIfMissing } from "./assets.js";
import { mapLimit } from "./limit.js";
import { fileMode, isRacy, reusableEntry, type FileIndex, type FileIndexEntry } from "./file-index.js";
import { writeBlobs, type BlobSource, type ObjectBuilder, type TreeEntry } from "./objects.js";
import { CHECKPOINT_ASSET_MANIFEST_PATH, CHECKPOINT_META_PATH, USER_GIT_REPOS_PATH } from "./paths.js";
import { stageFile, type ScannedFile } from "./scan.js";

const ASSET_CONCURRENCY = 4;

export type CheckpointAsset = {
  path: string;
  sha256: string;
  size: number;
  mimeType: string | null;
  objectKey: string;
};

export const assetPointerContent = (asset: CheckpointAsset) => [
  "version https://cohub.run/spec/asset-pointer/v1",
  `sha256 ${asset.sha256}`,
  `size ${asset.size}`,
  ...(asset.mimeType ? [`mime ${asset.mimeType}`] : []),
  `objectKey ${asset.objectKey}`,
  "",
].join("\n");

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Turn a workspace scan into tree entries. Files whose stat matches the
 * previous index reuse their blob (or asset) without being read; everything
 * else is hashed, and large files are uploaded as assets.
 */
export async function buildSnapshot(input: {
  builder: ObjectBuilder;
  files: ScannedFile[];
  previous: FileIndex | null;
  assetThresholdBytes: number;
  scanStartedAtNs: bigint;
  systemFiles: { checkpointMeta: unknown; userGitRepos: unknown };
  onAssetTiming?: (label: "hashAssets" | "uploadAssets", ms: number) => void;
}) {
  const previous = input.previous?.entries ?? new Map<string, FileIndexEntry>();
  const entries = new Map<string, FileIndexEntry>();
  const assets: CheckpointAsset[] = [];
  let hashedFileCount = 0;
  const blobFiles: ScannedFile[] = [];
  const assetFiles: ScannedFile[] = [];

  for (const file of input.files) {
    const isAsset = file.type === "file" && file.size > input.assetThresholdBytes;
    const reused = reusableEntry(previous.get(file.path), file, isAsset);
    if (reused) {
      entries.set(file.path, reused);
      if (reused.asset) assets.push({ path: file.path, size: file.size, ...reused.asset });
      continue;
    }
    hashedFileCount += 1;
    (isAsset ? assetFiles : blobFiles).push(file);
  }

  const uploaded = await mapLimit(assetFiles, ASSET_CONCURRENCY, async (file) => {
    const stagedPath = join(input.builder.tmpDir, `asset-${crypto.randomUUID()}`);
    try {
      let started = performance.now();
      const { sha256, size } = await stageFile(file.absPath, stagedPath);
      input.onAssetTiming?.("hashAssets", performance.now() - started);
      started = performance.now();
      const objectKey = await uploadAssetIfMissing({ filePath: stagedPath, sha256, size, mimeType: file.mimeType });
      input.onAssetTiming?.("uploadAssets", performance.now() - started);
      return { path: file.path, sha256, size, mimeType: file.mimeType, objectKey } satisfies CheckpointAsset;
    } finally {
      await rm(stagedPath, { force: true });
    }
  });
  assets.push(...uploaded);
  assets.sort((a, b) => a.path.localeCompare(b.path));

  const sources: BlobSource[] = [
    ...blobFiles.map((file): BlobSource => ({ kind: file.type, path: file.absPath })),
    ...uploaded.map((asset): BlobSource => ({ kind: "content", content: assetPointerContent(asset) })),
    { kind: "content", content: json({ version: 1, assets }) },
    { kind: "content", content: json(input.systemFiles.checkpointMeta) },
    { kind: "content", content: json(input.systemFiles.userGitRepos) },
  ];
  const oids = await writeBlobs(input.builder, sources);
  const [assetManifestOid, metaOid, userGitReposOid] = oids.slice(-3) as [string, string, string];

  const record = (file: ScannedFile, oid: string, asset: CheckpointAsset | null) => {
    entries.set(file.path, {
      type: file.type,
      mode: fileMode(file),
      size: file.size,
      mtimeNs: file.mtimeNs,
      ctimeNs: file.ctimeNs,
      ino: file.ino,
      oid,
      racy: isRacy(file, input.scanStartedAtNs),
      asset: asset ? { sha256: asset.sha256, objectKey: asset.objectKey, mimeType: asset.mimeType } : null,
    });
  };
  for (const [index, file] of blobFiles.entries()) record(file, oids[index] as string, null);
  for (const [index, file] of assetFiles.entries()) record(file, oids[blobFiles.length + index] as string, uploaded[index] as CheckpointAsset);

  const tree: TreeEntry[] = Array.from(entries, ([path, entry]) => ({ path, mode: entry.mode, oid: entry.oid }));
  tree.push(
    { path: CHECKPOINT_ASSET_MANIFEST_PATH, mode: "100644", oid: assetManifestOid },
    { path: CHECKPOINT_META_PATH, mode: "100644", oid: metaOid },
    { path: USER_GIT_REPOS_PATH, mode: "100644", oid: userGitReposOid },
  );

  return { tree, entries, assets, hashedFileCount };
}
