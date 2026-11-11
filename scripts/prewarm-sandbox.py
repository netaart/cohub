#!/usr/bin/env python3
"""Temporarily warm sandbox images on the API's sandbox node pools, including placement pools."""

import argparse
import json
import os
import signal
import sys
import subprocess
import time
import uuid

SETTINGS = {"SANDBOX_NODE_SELECTOR", "SANDBOX_TOLERATIONS", "SANDBOX_IMAGE_PULL_SECRET"}


def kubectl(namespace, *args, manifest=None):
    result = subprocess.run(
        [
            os.environ.get("KUBECTL", "kubectl"),
            "--request-timeout=30s",
            "-n",
            namespace,
            *args,
        ],
        input=json.dumps(manifest) if manifest else None,
        text=True,
        capture_output=True,
        check=False,
        timeout=150,
    )
    if result.returncode:
        raise RuntimeError(f"kubectl {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout


def load_settings(namespace, deployment):
    spec = json.loads(kubectl(namespace, "get", "deployment", deployment, "-o", "json"))
    containers = spec["spec"]["template"]["spec"]["containers"]
    if len(containers) != 1:
        raise ValueError("Expected one API container")
    container = containers[0]
    settings = {}
    for source in container.get("envFrom", []):
        if "configMapRef" in source:
            data = json.loads(
                kubectl(
                    namespace,
                    "get",
                    "configmap",
                    source["configMapRef"]["name"],
                    "-o",
                    "json",
                )
            )
            prefix = source.get("prefix", "")
            settings.update(
                {
                    prefix + k: v
                    for k, v in data.get("data", {}).items()
                    if prefix + k in SETTINGS
                }
            )
    for entry in container.get("env", []):
        if entry["name"] in SETTINGS:
            if "valueFrom" in entry:
                raise ValueError(
                    f"{entry['name']} must be a literal API environment value for prewarming"
                )
            settings[entry["name"]] = entry.get("value", "")
    return settings


# Parsed by the API's own module inside its Pod, so prewarming sees exactly what provisioning sees.
PLACEMENT_SCRIPT = """
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseSandboxPlacementConfig } from "@cohub/infra/config-runtime/sandbox-placement";
const path = join(process.env.PLATFORM_CONFIG_ROOT || "/configs", "platform/.cohub/sandbox/placements.yaml");
let text = null;
try { text = await readFile(path, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
const config = text === null ? null : parseSandboxPlacementConfig(text);
const used = new Set(config ? config.users.values() : []);
console.log(JSON.stringify(config ? [...config.pools.values()].filter((pool) => used.has(pool.name)) : []));
"""


def load_placement_pools(namespace, deployment):
    try:
        output = kubectl(
            namespace,
            "exec",
            f"deployment/{deployment}",
            "--",
            "node",
            "--input-type=module",
            "-e",
            PLACEMENT_SCRIPT,
        )
    except RuntimeError as error:
        detail = str(error).rpartition(" failed: ")[2]
        raise RuntimeError(f"kubectl exec deployment/{deployment} failed: {detail}") from None
    return json.loads(output.strip().splitlines()[-1])


def pairs(value):
    result = {}
    for entry in filter(None, (part.strip() for part in value.split(","))):
        key, separator, val = entry.partition("=")
        if not separator or not key.strip() or not val.strip():
            raise ValueError(f"Expected key=value, got {entry!r}")
        result[key.strip()] = val.strip()
    return result


def default_scheduling(settings):
    selector = pairs(settings.get("SANDBOX_NODE_SELECTOR", ""))
    tolerations = []
    for entry in filter(
        None,
        (part.strip() for part in settings.get("SANDBOX_TOLERATIONS", "").split(",")),
    ):
        value, separator, effect = entry.rpartition(":")
        if not separator:
            value, effect = entry, "NoSchedule"
        if effect not in {"NoSchedule", "PreferNoSchedule", "NoExecute"}:
            raise ValueError(f"Invalid toleration effect: {effect}")
        parsed = pairs(value)
        if not parsed:
            raise ValueError(f"Expected key=value:Effect, got {entry!r}")
        for key, val in parsed.items():
            tolerations.append(
                {"key": key, "operator": "Equal", "value": val, "effect": effect}
            )
    return selector, tolerations


def scheduling_targets(settings, pools):
    selector, tolerations = default_scheduling(settings)
    targets = [{"pool": None, "nodeSelector": selector, "tolerations": tolerations}]
    seen = {json.dumps([selector, tolerations], sort_keys=True)}
    for pool in pools:
        target = {
            "pool": pool["name"],
            "nodeSelector": pool.get("nodeSelector") or selector,
            "tolerations": pool.get("tolerations") or tolerations,
        }
        key = json.dumps([target["nodeSelector"], target["tolerations"]], sort_keys=True)
        if key not in seen:
            seen.add(key)
            targets.append(target)
    for target in targets:
        if not target["nodeSelector"]:
            raise ValueError(
                f"Node selector for pool {target['pool'] or 'default'} must be configured; refusing cluster-wide prewarming"
            )
    return targets


def build_manifest(name, namespace, settings, images, target):
    labels = {
        "app.kubernetes.io/name": "sandbox-image-prewarm",
        "cohub.run/prewarm": name,
    }
    containers = [
        {
            "name": f"image-{index}",
            "image": image,
            "imagePullPolicy": "IfNotPresent",
            "command": ["/bin/sleep", "infinity"],
            "resources": {
                "requests": {"cpu": "1m", "memory": "8Mi"},
                "limits": {"memory": "32Mi"},
            },
            "securityContext": {
                "allowPrivilegeEscalation": False,
                "readOnlyRootFilesystem": True,
                "capabilities": {"drop": ["ALL"]},
            },
        }
        for index, image in enumerate(dict.fromkeys(images))
    ]
    pod = {
        "nodeSelector": target["nodeSelector"],
        "tolerations": target["tolerations"],
        "automountServiceAccountToken": False,
        "enableServiceLinks": False,
        "terminationGracePeriodSeconds": 1,
        "securityContext": {
            "runAsNonRoot": True,
            "runAsUser": 1000,
            "runAsGroup": 1000,
            "seccompProfile": {"type": "RuntimeDefault"},
        },
        "containers": containers,
    }
    secret = settings.get("SANDBOX_IMAGE_PULL_SECRET", "gitea-registry").strip()
    if secret:
        pod["imagePullSecrets"] = [{"name": secret}]
    return {
        "apiVersion": "apps/v1",
        "kind": "DaemonSet",
        "metadata": {"name": name, "namespace": namespace, "labels": labels},
        "spec": {
            "selector": {"matchLabels": labels},
            "template": {"metadata": {"labels": labels}, "spec": pod},
        },
    }


def is_ready(resource):
    status = resource.get("status", {})
    desired = status.get("desiredNumberScheduled", 0)
    return (
        status.get("observedGeneration", 0) >= resource["metadata"].get("generation", 1)
        and desired > 0
        and status.get("updatedNumberScheduled", 0) == desired
        and status.get("numberReady", 0) == desired
        and status.get("numberUnavailable", 0) == 0
    )


def is_settled_empty(resource):
    status = resource.get("status", {})
    return (
        status.get("observedGeneration", 0) >= resource["metadata"].get("generation", 1)
        and status.get("desiredNumberScheduled", 0) == 0
    )


def prewarm(jobs, timeout):
    pending = {manifest["metadata"]["name"]: (pool, manifest) for pool, manifest in jobs}
    created = []
    try:
        for _, manifest in jobs:
            print(kubectl(manifest["metadata"]["namespace"], "create", "-f", "-", manifest=manifest), flush=True)
            created.append(manifest)
        deadline = time.monotonic() + timeout
        while pending and time.monotonic() < deadline:
            for name, (pool, manifest) in list(pending.items()):
                namespace = manifest["metadata"]["namespace"]
                resource = json.loads(kubectl(namespace, "get", "daemonset", name, "-o", "json"))
                status = resource.get("status", {})
                label = pool or "default"
                print(
                    f"Prewarm {name} ({label}): {status.get('numberReady', 0)}/{status.get('desiredNumberScheduled', 0)} nodes ready",
                    flush=True,
                )
                if is_ready(resource):
                    print(kubectl(namespace, "get", "pods", "-l", f"cohub.run/prewarm={name}", "-o", "wide"), flush=True)
                    del pending[name]
                elif pool and is_settled_empty(resource):
                    print(f"Prewarm {name} ({label}): no matching nodes; skipped", flush=True)
                    del pending[name]
            if pending:
                time.sleep(5)
        if pending:
            pools = ", ".join(pool or "default" for pool, _ in pending.values())
            raise TimeoutError(
                f"Prewarming timed out after {timeout}s for {pools} (including zero matching nodes)"
            )
    except Exception:
        for name, (_, manifest) in pending.items():
            try:
                print(kubectl(manifest["metadata"]["namespace"], "describe", "pods", "-l", f"cohub.run/prewarm={name}"), flush=True)
            except (OSError, RuntimeError, subprocess.SubprocessError) as error:
                print(f"Unable to collect diagnostics: {error}", flush=True)
        raise
    finally:
        for manifest in created:
            print(
                kubectl(
                    manifest["metadata"]["namespace"],
                    "delete",
                    "daemonset",
                    manifest["metadata"]["name"],
                    "--ignore-not-found",
                    "--cascade=foreground",
                    "--wait=true",
                    "--timeout=120s",
                ),
                flush=True,
            )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env", choices=["dev", "prod"], required=True)
    parser.add_argument(
        "--image",
        action="append",
        required=True,
        help="Exact image reference; repeat for game",
    )
    parser.add_argument(
        "--timeout", type=int, default=600, help="Readiness timeout in seconds"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Read configuration and print the manifest without creating resources",
    )
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    suffix = "-dev" if args.env == "dev" else ""
    namespace, deployment = f"cohub{suffix}", f"cohub-api{suffix}"
    settings = load_settings(namespace, deployment)
    try:
        pools = load_placement_pools(namespace, deployment)
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
        print(f"Warning: unable to read sandbox placement pools; warming the default pool only: {error}", file=sys.stderr, flush=True)
        pools = []
    base = f"sandbox-prewarm-{uuid.uuid4().hex[:12]}"
    jobs = [
        (
            target["pool"],
            build_manifest(
                base if index == 0 else f"{base}-p{index}",
                f"cohub-sessions{suffix}",
                settings,
                args.image,
                target,
            ),
        )
        for index, target in enumerate(scheduling_targets(settings, pools))
    ]
    if args.dry_run:
        print(json.dumps([manifest for _, manifest in jobs], indent=2))
        return

    def interrupt(_signum, _frame):
        raise KeyboardInterrupt("Prewarming interrupted")

    signal.signal(signal.SIGTERM, interrupt)
    prewarm(jobs, args.timeout)


if __name__ == "__main__":
    main()
