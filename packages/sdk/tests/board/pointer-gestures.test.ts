import assert from "node:assert/strict";
import { test } from "node:test";
import { createBoardEditor } from "../../src/board/editor/index.js";
import { worldPoint } from "../../src/board/model/index.js";
import { toBoardPointerEvent } from "../../src/board/stage/pointer.js";
import { createBoardPointerGestures } from "../../src/board/stage/pointer-gestures.js";
import { boardDocument } from "./fixtures.js";

class Pointer extends Event {
	pointerId = 1;
	pointerType = "mouse";
	clientX = 50;
	clientY = 50;
	button = 0;
	buttons = 1;
	pressure = 0;
	constructor(type: string, init: object = {}) {
		super(type);
		for (const key of Object.keys(this)) {
			if (key in init) Reflect.set(this, key, Reflect.get(init, key));
		}
	}
}

for (const ending of ["release", "cancel", "unpressed move"]) {
	const cancelled = ending === "cancel";
	test(`mouse capture loss handles ${ending}`, () => {
		const document = Object.assign(new EventTarget(), { defaultView: Object.assign(new EventTarget(), { PointerEvent: Pointer }) });
		const captured = new Set<number>();
		const host = Object.assign(new EventTarget(), {
			ownerDocument: document,
			setPointerCapture: (id: number) => { captured.add(id); },
			hasPointerCapture: (id: number) => captured.has(id),
			releasePointerCapture: (id: number) => { captured.delete(id); },
		});
		let commits = 0;
		const editor = createBoardEditor({
			document: boardDocument({ items: { a: { type: "shape", size: { width: 100, height: 100 } } } }),
			onCommit() { commits++; },
		});
		const input = (event: PointerEvent) => toBoardPointerEvent(event, { left: 0, top: 0 } as DOMRect, (screen) => worldPoint(screen.x, screen.y));
		const gestures = createBoardPointerGestures(host as unknown as HTMLElement, {
			move: (event) => editor.pointerMove(input(event)),
			end: (event) => {
				assert.equal(event.type, cancelled ? "pointercancel" : "pointerup");
				if (!cancelled) assert.equal(event.buttons, 0);
				editor.pointerUp(input(event));
			},
		});
		try {
			const down = new Pointer("pointerdown") as unknown as PointerEvent;
			gestures.start(down);
			editor.pointerDown(input(down));
			document.dispatchEvent(new Pointer("pointermove", { clientX: 150, clientY: 150 }));
			host.dispatchEvent(new Pointer("lostpointercapture", { buttons: 0 }));
			assert.deepEqual(editor.scene.get("a")?.position, { x: 100, y: 100 });
			if (cancelled) document.defaultView.dispatchEvent(new Event("blur"));
			if (ending === "unpressed move") {
				document.dispatchEvent(new Pointer("pointermove", { clientX: 400, clientY: 400, buttons: 0 }));
				assert.equal(commits, 1);
				assert.equal(gestures.has(1), false);
			}
			document.dispatchEvent(new Pointer("pointerup", { clientX: 150, clientY: 150, buttons: 0 }));
			host.dispatchEvent(new Pointer("lostpointercapture"));
			document.dispatchEvent(new Pointer("pointerup"));
			assert.equal(commits, cancelled ? 0 : 1);
			assert.deepEqual(editor.scene.get("a")?.position, cancelled ? { x: 0, y: 0 } : { x: 100, y: 100 });
			assert.equal(editor.interaction.type, "idle");
			assert.equal(gestures.has(1), false);
			assert.equal(captured.size, 0);
		} finally { gestures.cancel(); editor.destroy(); }
	});
}
