import { UPLOAD_MAX_FILE_BYTES } from "@cohub/protocol";
import {
	HOST_SHARE_FILE_MAX_BYTES,
	type HostIncomingShare,
	hostShareFileUrl,
} from "@cohub/protocol/host-bridge";
import {
	callHost,
	hostPlatform,
	readyHost,
	supportsHostCapability,
} from "#lib/host-bridge.ts";

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
	const streamed = supportsHostCapability("share.fileUrl");
	const read = streamed ? fetchFile : readFile;
	const limit = streamed ? UPLOAD_MAX_FILE_BYTES : HOST_SHARE_FILE_MAX_BYTES;
	const files: File[] = [];
	let skipped = 0;
	for (const [index, file] of share.files.entries()) {
		const bytes =
			file.size > limit ? null : await read(share, index).catch(() => null);
		if (bytes)
			files.push(new File([bytes], file.name, { type: file.mimeType }));
		else skipped += 1;
	}
	return { text: share.text, files, skipped };
}

async function fetchFile(
	share: HostIncomingShare,
	index: number,
): Promise<Blob> {
	const url = hostShareFileUrl({
		platform: hostPlatform() ?? "unknown",
		origin: window.location.origin,
		id: share.id,
		index,
	});
	const stalled = new AbortController();
	let timer = setTimeout(() => stalled.abort(), READ_TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			cache: "no-store",
			signal: stalled.signal,
		});
		if (!response.ok || !response.body)
			throw new Error(`HTTP ${response.status}`);
		let size = 0;
		const counted = response.body.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					size += chunk.byteLength;
					if (size > UPLOAD_MAX_FILE_BYTES)
						throw new Error("Shared file too large");
					clearTimeout(timer);
					timer = setTimeout(() => stalled.abort(), READ_TIMEOUT_MS);
					controller.enqueue(chunk);
				},
			}),
		);
		return await new Response(counted).blob();
	} finally {
		clearTimeout(timer);
		stalled.abort();
	}
}

async function readFile(
	share: HostIncomingShare,
	index: number,
): Promise<Uint8Array<ArrayBuffer>> {
	const read = await callHost(
		"share.readFile",
		{ id: share.id, index },
		{ timeoutMs: READ_TIMEOUT_MS },
	);
	return decode(read.data);
}
