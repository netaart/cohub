export { attachComposerFiles } from "./attach/to-composer.ts";
export {
	detectCaptureCapabilities,
	iframeCaptureSupportedMessage,
} from "./capture/capabilities.ts";
export {
	captureIframeElement,
	captureIframeElementFromStream,
	captureViewportFromStream,
	requestDisplayMedia,
} from "./capture/iframe-capture.ts";
export { captureImageSource } from "./capture/image-capture.ts";
export {
	copyMarkedFrameToClipboard,
	exportMarkedFrame,
	exportMarkedPngBlob,
} from "./mark/export.ts";
export { createMarkSession, type MarkSession } from "./mark/session.svelte.ts";
export { strokesAfterCrop } from "./mark/transform.ts";
export {
	type CaptureResult,
	type FrameSource,
	type FrozenFrame,
	type MarkColor,
	type MarkTool,
	type PreviewCaptureTarget,
	type Stroke,
	suggestedMarkedName,
} from "./types.ts";
