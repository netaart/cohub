import assert from "node:assert/strict";
import test from "node:test";
import { renderSandboxPodTemplate } from "./sandbox-template.js";

test("sandbox pod mounts search index storage without extra provisioning", () => {
  const pod = renderSandboxPodTemplate({
    SPACE_ID: "space-1",
    USER_ID: "user-1",
    OWNER_USER_ID: "user-1",
    SPACE_STORAGE_PVC: "spaces",
    SPACE_STORAGE_SUBPATH: "spaces-dev",
    SPACE_SYSTEM_PVC: "system",
    SPACE_SYSTEM_SUBPATH: "dev",
    CONFIGS_SUBPATH: "configs/dev",
  }) as {
    spec?: {
      containers?: Array<{
        volumeMounts?: Array<{ name?: string; mountPath?: string; subPath?: string }>;
      }>;
      volumes?: Array<{ name?: string; persistentVolumeClaim?: { claimName?: string } }>;
    };
  };

  const container = pod.spec?.containers?.[0];
  assert.ok(container);
  assert.deepEqual(
    container.volumeMounts?.find((mount) => mount.name === "system-storage"),
    {
      name: "system-storage",
      mountPath: "/index",
      subPath: "dev/space-1/index",
    },
  );
  assert.deepEqual(
    pod.spec?.volumes?.find((volume) => volume.name === "system-storage"),
    {
      name: "system-storage",
      persistentVolumeClaim: { claimName: "system" },
    },
  );
});
