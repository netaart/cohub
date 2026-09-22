import { SANDBOX_PUBLIC_PORTS } from "@cohub/protocol/ports";
import { SANDBOX_SPECS, type SandboxSpecId } from "@cohub/sandbox-controller";
import { config } from "../config.js";

type SandboxPodTemplateVariables = {
  SPACE_ID: string;
  USER_ID: string;
  OWNER_USER_ID?: string;
  ENV?: string;
  SPACE_STORAGE_PVC?: string;
  SPACE_STORAGE_SUBPATH?: string;
  SPACE_SYSTEM_PVC?: string;
  SPACE_SYSTEM_SUBPATH?: string;
  CONFIGS_SUBPATH?: string;
  SANDBOX_SPEC_ID?: SandboxSpecId;
};

function assertK8sSafeName(value: string, fieldName: string) {
  if (!/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(value)) {
    throw new Error(
      `${fieldName} must be 1-63 chars of lowercase letters, numbers, or hyphens`,
    );
  }
}

export const SANDBOX_POD_TEMPLATE = {
  apiVersion: "v1",
  kind: "Pod",
  metadata: {
    name: "sandbox-${SPACE_ID}",
    labels: {
      app: "agent-sandbox",
      "space-id": "${SPACE_ID}",
      "user-id": "${USER_ID}",
    },
  },
  spec: {
    restartPolicy: "Always",
    enableServiceLinks: false,
    automountServiceAccountToken: false,
    ...(Object.keys(config.sandboxNodeSelector).length > 0
      ? { nodeSelector: config.sandboxNodeSelector }
      : {}),
    ...(config.sandboxTolerations.length > 0
      ? { tolerations: config.sandboxTolerations }
      : {}),
    ...(config.sandboxImagePullSecret
      ? { imagePullSecrets: [{ name: config.sandboxImagePullSecret }] }
      : {}),
    securityContext: {
      runAsUser: 1000,
      runAsGroup: 1000,
      fsGroup: 1000,
    },
    containers: [
      {
        name: "sandbox",
        image: config.sandboxImage,
        env: [
          {
            name: "POD_IP",
            valueFrom: {
              fieldRef: {
                fieldPath: "status.podIP",
              },
            },
          },
          {
            name: "COHUB_PUBLIC_PORTS",
            value: SANDBOX_PUBLIC_PORTS.join(","),
          },
        ],
        resizePolicy: [
          { resourceName: "cpu", restartPolicy: "NotRequired" },
          { resourceName: "memory", restartPolicy: "NotRequired" },
        ],
        resources: SANDBOX_SPECS.standard.resources,
        readinessProbe: {
          httpGet: { path: "/readyz", port: 8788 },
          initialDelaySeconds: 5,
          periodSeconds: 10,
          timeoutSeconds: 2,
          failureThreshold: 2,
        },
        livenessProbe: {
          httpGet: { path: "/healthz", port: 8788 },
          initialDelaySeconds: 30,
          periodSeconds: 15,
          timeoutSeconds: 3,
          failureThreshold: 4,
        },
        volumeMounts: [
          {
            name: "space-storage",
            mountPath: "/workspace",
            subPath: "${SPACE_STORAGE_SUBPATH}/${SPACE_ID}/workspace",
          },
          {
            name: "space-storage",
            mountPath: "/configs/platform/.agents",
            subPath: "${CONFIGS_SUBPATH}/platform/.agents",
            readOnly: true,
          },
          {
            name: "space-storage",
            mountPath: "/configs/user/.agents",
            subPath: "${CONFIGS_SUBPATH}/users/${OWNER_USER_ID}/.agents",
            readOnly: true,
          },
          {
            name: "space-storage",
            mountPath: "/sessions",
            subPath: (config.env === "prod" ? "sessions/prod/spaces/${SPACE_ID}" : "sessions/dev/spaces/${SPACE_ID}"),
            readOnly: true,
          },
          {
            name: "public-storage",
            mountPath: "/public",
            subPath:
              config.env === "prod"
                ? "s/${SPACE_ID}"
                : "dev/s/${SPACE_ID}",
          },
          {
            name: "system-storage",
            mountPath: "/index",
            subPath: "${SPACE_SYSTEM_SUBPATH}/${SPACE_ID}/index",
          },
        ],
      },
    ],
    volumes: [
      {
        name: "space-storage",
        persistentVolumeClaim: {
          claimName: "${SPACE_STORAGE_PVC}",
        },
      },
      {
        name: "public-storage",
        persistentVolumeClaim: {
          claimName: "cohub-sessions-public-pvc",
        },
      },
      {
        name: "system-storage",
        persistentVolumeClaim: {
          claimName: "${SPACE_SYSTEM_PVC}",
        },
      },
    ],
  },
};

export function validateSandboxPodTemplateVariables(
  variables: SandboxPodTemplateVariables,
) {
  assertK8sSafeName(variables.SPACE_ID, "SPACE_ID");
  assertK8sSafeName(variables.USER_ID, "USER_ID");
  if (variables.OWNER_USER_ID) {
    assertK8sSafeName(variables.OWNER_USER_ID, "OWNER_USER_ID");
  }
  return variables;
}

export type { SandboxPodTemplateVariables };
