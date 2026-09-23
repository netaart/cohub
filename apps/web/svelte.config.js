import { fileURLToPath, URL } from "node:url";
import adapter from "@sveltejs/adapter-cloudflare";

const protocolDir = fileURLToPath(
	new URL("../../packages/protocol/src", import.meta.url),
);
const sdkDir = fileURLToPath(
	new URL("../../packages/sdk/src", import.meta.url),
);
/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		sourcemap: true,
	},
	kit: {
		// The adapter writes its generated Worker to the `main` path of the config
		// it reads, so point it at a build-only config; the deployment configs
		// declare `main = "src/entry.worker.ts"` to wrap the generated Worker.
		adapter: adapter({ config: "./wrangler.adapter.toml" }),
		output: {
			bundleStrategy: "split",
		},
		alias: {
			// protocol subpaths — must come before bare package alias to avoid prefix matching
			"@cohub/protocol/core": `${protocolDir}/core/index.ts`,
			"@cohub/protocol/fs": `${protocolDir}/fs/index.ts`,
			"@cohub/protocol/gateway/types": `${protocolDir}/gateway/types.ts`,
			"@cohub/protocol/gateway": `${protocolDir}/gateway/index.ts`,
			"@cohub/protocol/model/status": `${protocolDir}/model/status.ts`,
			"@cohub/protocol/model": `${protocolDir}/model/session.ts`,
			"@cohub/protocol/ports": `${protocolDir}/ports/index.ts`,
			"@cohub/protocol/realtime/types": `${protocolDir}/realtime/types.ts`,
			"@cohub/protocol/realtime/schema": `${protocolDir}/realtime/schema.ts`,
			"@cohub/protocol/realtime": `${protocolDir}/realtime/index.ts`,
			"@cohub/protocol/task": `${protocolDir}/task/index.ts`,
			"@cohub/protocol/generation": `${protocolDir}/generation/index.ts`,
			"@cohub/protocol/provenance": `${protocolDir}/provenance.ts`,
			"@cohub/protocol/public-identifiers": `${protocolDir}/public-identifiers.ts`,
			// catch-all for flat protocol modules (board-constants, space-style, …);
			// it also makes the bare alias below match exactly instead of by prefix
			"@cohub/protocol/*": `${protocolDir}/*`,
			"@cohub/protocol": `${protocolDir}/index.ts`,
			// sdk subpaths
			"@neta-art/cohub/debugger": `${sdkDir}/debugger.ts`,
			"@neta-art/cohub/http": `${sdkDir}/http.ts`,
			"@neta-art/cohub/websocket": `${sdkDir}/websocket.ts`,
			// Board subpaths must precede the SDK wildcard alias.
			"@neta-art/cohub/board/render": `${sdkDir}/board/render/index.ts`,
			"@neta-art/cohub/board/export": `${sdkDir}/board/export/index.ts`,
			"@neta-art/cohub/board/headless": `${sdkDir}/board/headless/index.ts`,
			"@neta-art/cohub/board": `${sdkDir}/board/index.ts`,
			"@neta-art/cohub/*": `${sdkDir}/*`,
			// bare package aliases — must be last
			"@neta-art/cohub": `${sdkDir}/index.ts`,
		},
	},
};

export default config;
