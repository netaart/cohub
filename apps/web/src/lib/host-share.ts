import { HOST_SHARE_FILE_MAX_BYTES } from "@cohub/protocol/host-bridge";
import { callHost, readyHost, supportsHostCapability } from "$lib/host-bridge";

const READ_TIMEOUT_MS = 60_000;

function decode(data: string): Uint8Array<ArrayBuffer> {
	const binary = atob(data);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++)
		bytes[index] = binary.charCodeAt(index);
	return bytes;
}

export async function takeHostShare(): Promise<{
	text: string | null;
	files: File[];
	skipped: number;
} | null> {
	if (!(await readyHost()) || !supportsHostCapability("share.incoming"))
		return null;
	const share = await callHost("share.take").catch(() => null);
	if (!share) return null;
	const files: File[] = [];
	let skipped = 0;
	for (const [index, file] of share.files.entries()) {
		const read =
			file.size > HOST_SHARE_FILE_MAX_BYTES
				? null
				: await callHost(
						"share.readFile",
						{ id: share.id, index },
						{ timeoutMs: READ_TIMEOUT_MS },
					).catch(() => null);
		if (read)
			files.push(
				new File([decode(read.data)], file.name, { type: file.mimeType }),
			);
		else skipped += 1;
	}
	return { text: share.text, files, skipped };
}
