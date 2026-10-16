import { mimeTypeForPath } from "../fs/mime.js";

/**
 * 3D model formats generation providers fetch by URL (Meshy takes GLB, glTF, OBJ, FBX and STL). Providers read the
 * format from the URL extension, so a model input is recognized by its filename extension.
 */
export const GENERATION_MODEL_INPUT_EXTENSIONS = ["glb", "gltf", "obj", "fbx", "stl"] as const;

/**
 * The type a 3D model generation input named `filename` uploads with, or null when the name is not one. FBX has no
 * registered type and stays `application/octet-stream`.
 */
export function generationModelInputType(filename: string): string | null {
  const name = filename.split(/[/\\]/).pop()?.trim().toLowerCase() ?? "";
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1) : "";
  return (GENERATION_MODEL_INPUT_EXTENSIONS as readonly string[]).includes(extension)
    ? (mimeTypeForPath(name) ?? "application/octet-stream")
    : null;
}
