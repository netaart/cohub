#!/usr/bin/env python3
"""Temporarily warm sandbox images on the API's configured sandbox node pool."""

import argparse
import json
import os
import signal
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


def pairs(value):
    result = {}
    for entry in filter(None, (part.strip() for part in value.split(","))):
        key, separator, val = entry.partition("=")
        if not separator or not key.strip() or not val.strip():
            raise ValueError(f"Expected key=value, got {entry!r}")
        result[key.strip()] = val.strip()
    return result


def build_manifest(name, namespace, settings, images):
    selector = pairs(settings.get("SANDBOX_NODE_SELECTOR", ""))
    if not selector:
        raise ValueError(
            "SANDBOX_NODE_SELECTOR must be configured; refusing cluster-wide prewarming"
        )
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
        "nodeSelector": selector,
        "tolerations": tolerations,
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


def prewarm(manifest, timeout):
    namespace = manifest["metadata"]["namespace"]
    name = manifest["metadata"]["name"]
    selector = f"cohub.run/prewarm={name}"
    try:
        print(kubectl(namespace, "create", "-f", "-", manifest=manifest), flush=True)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            resource = json.loads(
                kubectl(namespace, "get", "daemonset", name, "-o", "json")
            )
            status = resource.get("status", {})
            print(
                f"Prewarm {name}: {status.get('numberReady', 0)}/{status.get('desiredNumberScheduled', 0)} nodes ready",
                flush=True,
            )
            if is_ready(resource):
                print(
                    kubectl(namespace, "get", "pods", "-l", selector, "-o", "wide"),
                    flush=True,
                )
                return
            time.sleep(5)
        raise TimeoutError(
            f"Prewarming timed out after {timeout}s (including zero matching nodes)"
        )
    except Exception:
        try:
            print(kubectl(namespace, "describe", "pods", "-l", selector), flush=True)
        except (OSError, RuntimeError, subprocess.SubprocessError) as error:
            print(f"Unable to collect diagnostics: {error}", flush=True)
        raise
    finally:
        print(
            kubectl(
                namespace,
                "delete",
                "daemonset",
                name,
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
    settings = load_settings(f"cohub{suffix}", f"cohub-api{suffix}")
    manifest = build_manifest(
        f"sandbox-prewarm-{uuid.uuid4().hex[:12]}",
        f"cohub-sessions{suffix}",
        settings,
        args.image,
    )
    if args.dry_run:
        print(json.dumps(manifest, indent=2))
        return

    def interrupt(_signum, _frame):
        raise KeyboardInterrupt("Prewarming interrupted")

    signal.signal(signal.SIGTERM, interrupt)
    prewarm(manifest, args.timeout)


if __name__ == "__main__":
    main()
