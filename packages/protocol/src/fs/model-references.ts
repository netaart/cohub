export type GltfJson = {
	extensionsUsed?: string[];
	buffers?: { uri?: string }[];
	images?: { uri?: string }[];
};

const GLB_MAGIC = 0x46546c67; // "glTF"
const GLB_JSON_CHUNK = 0x4e4f534a; // "JSON"
export const GLB_HEADER_BYTES = 20;

export function glbJsonEnd(header: Uint8Array): number | null {
	if (header.byteLength < GLB_HEADER_BYTES) return null;
	const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
	if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(16, true) !== GLB_JSON_CHUNK) return null;
	return GLB_HEADER_BYTES + view.getUint32(12, true);
}

export function readGlbJson(bytes: Uint8Array): GltfJson | null {
	const end = glbJsonEnd(bytes);
	if (end === null || end > bytes.byteLength) return null;
	try {
		return JSON.parse(new TextDecoder().decode(bytes.subarray(GLB_HEADER_BYTES, end))) as GltfJson;
	} catch {
		return null;
	}
}

const isEmbedded = (uri: string) => /^(data|blob):/i.test(uri);

export function gltfReferences(json: GltfJson): string[] {
	const uris = new Set<string>();
	const entries = [json.buffers, json.images].flatMap((list) => (Array.isArray(list) ? list : []));
	for (const entry of entries) {
		const uri = (entry as { uri?: unknown } | null)?.uri;
		if (typeof uri === "string" && uri && !isEmbedded(uri)) uris.add(uri);
	}
	return [...uris];
}

export function resolveModelReference(fromPath: string, reference: string): string | null {
	const raw = reference.trim().split(/[?#]/, 1)[0] ?? "";
	if (!raw || isEmbedded(raw) || raw.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(raw)) return null;
	let decoded: string;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		return null;
	}
	if (decoded.includes("\\")) return null;
	if (decoded.startsWith("/")) {
		if (!decoded.startsWith("/workspace/")) return null;
		decoded = decoded.slice("/workspace/".length);
	} else {
		const base = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
		if (base) decoded = `${base}/${decoded}`;
	}
	const parts: string[] = [];
	for (const segment of decoded.split("/")) {
		if (!segment || segment === ".") continue;
		if (segment === "..") {
			if (!parts.length) return null;
			parts.pop();
		} else parts.push(segment);
	}
	return parts.length ? parts.join("/") : null;
}
