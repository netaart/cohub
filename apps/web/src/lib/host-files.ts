import { HOST_FILE_DATA_MAX_LENGTH } from "@cohub/protocol/host-bridge";
import { callHost, supportsHostCapability } from "$lib/host-bridge";

export function hostSavesFiles(): boolean {
	return supportsHostCapability("files");
}

const MAX_INLINE_BYTES = Math.floor((HOST_FILE_DATA_MAX_LENGTH * 3) / 4);

/** https URLs are fetched natively; `blob:` and `data:` bytes go inline. */
export async function saveWithHost(href: string, name: string): Promise<void> {
	const url = new URL(href, location.href);
	if (url.protocol === "https:") {
		await callHost("files.save", { name, url: url.href });
		return;
	}
	const blob = await (await fetch(url)).blob();
	if (blob.size > MAX_INLINE_BYTES) {
		throw new Error(`${name} is too large to save inline`);
	}
	await callHost("files.save", {
		name,
		data: await toBase64(blob),
		...(blob.type ? { mimeType: blob.type } : {}),
	});
}

/** Routes every `<a download>` click, markup or programmatic, through the host. */
export function installHostDownloads(): () => void {
	const onClick = (event: MouseEvent) => {
		if (event.defaultPrevented || !hostSavesFiles()) return;
		const target = event.target instanceof Element ? event.target : null;
		const anchor = target?.closest("a[download]");
		if (!(anchor instanceof HTMLAnchorElement) || !anchor.href) return;
		event.preventDefault();
		const name = anchor.download || fileNameOf(anchor.href);
		saveWithHost(anchor.href, name).catch((error: unknown) => {
			console.warn(`Host could not save ${name}`, error);
		});
	};
	document.addEventListener("click", onClick, true);
	return () => document.removeEventListener("click", onClick, true);
}

function fileNameOf(href: string): string {
	try {
		const segment = new URL(href).pathname.split("/").filter(Boolean).pop();
		return segment ? decodeURIComponent(segment) : "download";
	} catch {
		return "download";
	}
}

function toBase64(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const dataUrl = String(reader.result);
			resolve(dataUrl.slice(dataUrl.indexOf(",") + 1));
		};
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(blob);
	});
}
