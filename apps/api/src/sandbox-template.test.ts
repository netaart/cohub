import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import { renderSandboxPodTemplate } from "./sandbox-template.js";

test("sandbox image pull secret preserves the legacy default independently of Gitea", async () => {
  const templateUrl = new URL("./sandbox-template.ts", import.meta.url).href;
  const cases = [
    { secret: undefined, expected: [{ name: "gitea-registry" }] },
    { secret: "", expected: null },
    { secret: "   ", expected: null },
    { secret: " registry-secret ", expected: [{ name: "registry-secret" }] },
  ];
  for (const giteaEnabled of [false, true]) {
    for (const { secret, expected } of cases) {
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.GITEA_BASE_URL;
      delete env.GITEA_TOKEN;
      delete env.SANDBOX_IMAGE_PULL_SECRET;
      if (giteaEnabled) {
        env.GITEA_BASE_URL = "https://git.example.com";
        env.GITEA_TOKEN = "test-only-token";
      }
      if (secret !== undefined) env.SANDBOX_IMAGE_PULL_SECRET = secret;
      const { stdout } = await promisify(execFile)(process.execPath, [
        "--import", "tsx", "--input-type=module", "-e",
        `import { renderSandboxPodTemplate } from ${JSON.stringify(templateUrl)};
         const pod = renderSandboxPodTemplate({ SPACE_ID: "space-1", USER_ID: "user-1" });
         console.log(JSON.stringify(pod.spec.imagePullSecrets ?? null));`,
      ], { env });
      assert.deepEqual(JSON.parse(stdout), expected, `secret=${JSON.stringify(secret)}, gitea=${giteaEnabled}`);
    }
  }
});

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
