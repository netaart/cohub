import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  HOST_BRIDGE_CAPABILITIES,
  HOST_BRIDGE_ERROR,
  HOST_BRIDGE_EVENTS,
  HOST_BRIDGE_GLOBAL,
  HOST_BRIDGE_METHODS,
  HOST_BRIDGE_VERSION,
  HOST_SERVICE_SHELL_EVENTS,
  HOST_SERVICE_VERSION,
  HOST_SERVICE_WORKSPACE_ENDPOINT,
  HOST_WORKSPACE_PATH,
  HOST_WORKSPACE_SCHEME,
} from "../src/host-bridge.js";

export const MANIFEST_URL = new URL("../host-bridge.json", import.meta.url);

export const hostBridgeManifest = () => ({
  version: HOST_BRIDGE_VERSION,
  global: HOST_BRIDGE_GLOBAL,
  capabilities: [...HOST_BRIDGE_CAPABILITIES],
  methods: Object.keys(HOST_BRIDGE_METHODS),
  events: [...HOST_BRIDGE_EVENTS],
  errors: Object.values(HOST_BRIDGE_ERROR),
  service: {
    version: HOST_SERVICE_VERSION,
    shellEvents: Object.values(HOST_SERVICE_SHELL_EVENTS),
    workspaceEndpoint: HOST_SERVICE_WORKSPACE_ENDPOINT,
  },
  workspace: { scheme: HOST_WORKSPACE_SCHEME, path: HOST_WORKSPACE_PATH },
});

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(MANIFEST_URL, `${JSON.stringify(hostBridgeManifest(), null, 2)}\n`);
}
