import { setModelDecoders } from "@neta-art/cohub/board/render";

// Served from our origin, so Draco models load where Google's CDN does not.
setModelDecoders({
	draco: {
		jsUrl: "/draco/draco_wasm_wrapper.js",
		wasmUrl: "/draco/draco_decoder.wasm",
	},
});
