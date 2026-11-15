import { collectBoardAssetReferences, type BoardSnapshot } from "@cohub/protocol";
import { loadBoardScriptSources } from "@cohub/protocol/board-script-modules";
import {
  GLB_HEADER_BYTES,
  glbJsonEnd,
  gltfReferences,
  modelFormatForPath,
  readGlbJson,
  resolveModelReference,
} from "@cohub/protocol/fs";

export type BoardDependencyReader = {
  module(path: string): Promise<string>;
  prefix(path: string, maxBytes: number): Promise<Uint8Array | null>;
};

const MAX_MODEL_JSON_BYTES = 16 * 1024 * 1024;

// Never publish arbitrary paths a model names, such as `../.env`.
const SIDECAR = /\.(bin|png|jpe?g|webp|gif|bmp|tga|ktx2|basis)$/i;

const text = (bytes: Uint8Array | null) => (bytes ? new TextDecoder().decode(bytes) : "");

function resolved(from: string, references: readonly string[]) {
  return references.flatMap((reference) => {
    const path = resolveModelReference(from, reference);
    return path && SIDECAR.test(path) ? [path] : [];
  });
}

async function addModelSidecars(path: string, read: BoardDependencyReader, add: (paths: string[]) => void) {
  switch (modelFormatForPath(path)) {
    case "glb": {
      const end = glbJsonEnd((await read.prefix(path, GLB_HEADER_BYTES)) ?? new Uint8Array());
      if (end === null || end > MAX_MODEL_JSON_BYTES) return;
      const json = readGlbJson((await read.prefix(path, end)) ?? new Uint8Array());
      if (json) add(resolved(path, gltfReferences(json)));
      return;
    }
    case "gltf": {
      let json: unknown;
      try {
        json = JSON.parse(text(await read.prefix(path, MAX_MODEL_JSON_BYTES)));
      } catch {
        return;
      }
      if (json && typeof json === "object") add(resolved(path, gltfReferences(json)));
      return;
    }
  }
}

export async function collectBoardPublishReferences(
  board: Pick<BoardSnapshot, "items" | "board">,
  read: BoardDependencyReader,
  maxFiles: number,
) {
  const references = collectBoardAssetReferences(board);
  const files = new Set(references.files);
  const checkLimit = () => {
    if (files.size > maxFiles) throw new RangeError(`Board references more than ${maxFiles} assets.`);
  };
  checkLimit();
  const add = (paths: string[]) => {
    for (const path of paths) files.add(path);
    checkLimit();
  };
  const modules = new Map<string, Promise<string>>();
  const module = (path: string) => {
    let pending = modules.get(path);
    if (!pending) {
      add([path]);
      pending = read.module(path);
      modules.set(path, pending);
    }
    return pending;
  };
  for (const entry of references.scripts) await loadBoardScriptSources(entry, module);
  for (const path of references.files) await addModelSidecars(path, read, add);
  return { files: [...files].sort(), urls: references.urls };
}
