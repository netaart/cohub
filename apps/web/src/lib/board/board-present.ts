export function enterPresentationFullscreen(element: HTMLElement) {
	if (document.fullscreenElement || !element.requestFullscreen) return;
	void element.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
}

export function holdPresentation(
	element: HTMLElement,
	onLeave: () => void,
): () => void {
	let lock: WakeLockSentinel | null = null;
	let held = true;
	let filled = document.fullscreenElement === element;

	const acquire = () => {
		if (
			!navigator.wakeLock ||
			document.visibilityState !== "visible" ||
			(lock && !lock.released)
		)
			return;
		navigator.wakeLock
			.request("screen")
			.then((sentinel) => {
				if (held) lock = sentinel;
				else void sentinel.release();
			})
			.catch(() => {});
	};
	const fullscreenChange = () => {
		const now = document.fullscreenElement === element;
		if (filled && !now) onLeave();
		filled = now;
	};

	acquire();
	document.addEventListener("visibilitychange", acquire);
	document.addEventListener("fullscreenchange", fullscreenChange);
	return () => {
		held = false;
		document.removeEventListener("visibilitychange", acquire);
		document.removeEventListener("fullscreenchange", fullscreenChange);
		void lock?.release().catch(() => {});
		if (document.fullscreenElement === element)
			void document.exitFullscreen().catch(() => {});
	};
}

type BoardFullscreenRequest = {
	orientation?: "portrait" | "landscape";
	exit?: boolean;
};

let waiting: { cancel(): void; resolve(entered: boolean): void } | null = null;

export function cancelBoardFullscreen() {
	waiting?.cancel();
	waiting?.resolve(false);
	waiting = null;
}

export async function boardFullscreen(
	element: HTMLElement,
	input: unknown,
	whenGesture: (run: () => void) => () => void,
): Promise<boolean> {
	const request = (input ?? {}) as BoardFullscreenRequest;
	const { orientation } = request;
	if (
		orientation !== undefined &&
		orientation !== "portrait" &&
		orientation !== "landscape"
	)
		throw new Error(
			"fullscreen takes { orientation?: portrait | landscape, exit?: true }.",
		);
	cancelBoardFullscreen();
	if (request.exit) {
		if (document.fullscreenElement)
			await document.exitFullscreen().catch(() => {});
		return true;
	}
	if (!element.requestFullscreen) return false;
	const lock = () => {
		const screenOrientation = screen.orientation as ScreenOrientation & {
			lock?: (orientation: string) => Promise<void>;
		};
		if (orientation) void screenOrientation.lock?.(orientation).catch(() => {});
		return true;
	};
	const enter = () =>
		document.fullscreenElement === element
			? Promise.resolve(lock())
			: element.requestFullscreen({ navigationUI: "hide" }).then(lock);
	if (navigator.userActivation?.isActive !== false) {
		const entered = await enter().catch(() => false);
		if (entered) return true;
	}
	return new Promise<boolean>((resolve) => {
		const cancel = whenGesture(() => {
			waiting = null;
			enter().then(resolve, () => resolve(false));
		});
		waiting = { cancel, resolve };
	});
}
