/** Save a Blob under `filename`. The object URL outlives the click for Safari. */
export function triggerBlobDownload(blob: Blob, filename: string) {
	const objectUrl = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = objectUrl;
	link.download = filename;
	document.body.appendChild(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
}

/** Download by URL. Cross-origin servers may ignore `download` and open a tab. */
export function triggerUrlDownload(url: string, filename: string) {
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	link.target = "_blank";
	link.rel = "noopener noreferrer";
	link.referrerPolicy = "no-referrer";
	document.body.appendChild(link);
	link.click();
	link.remove();
}
